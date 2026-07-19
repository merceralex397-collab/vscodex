import { createHash } from 'node:crypto';
import type {
  DynamicToolCallOutputContentItem,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  DynamicToolSpec,
  JsonValue,
  RequestId
} from './wireTypes';

export const DEFAULT_TOOL_HANDOFF_TIMEOUT_MS = 10 * 60 * 1000;

export interface VsCodeToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface AliasedDynamicTool {
  originalName: string;
  alias: string;
  description: string;
  inputSchema: JsonValue;
}

export interface DynamicToolCatalog {
  tools: readonly AliasedDynamicTool[];
  dynamicTools: readonly DynamicToolSpec[];
  byAlias: ReadonlyMap<string, AliasedDynamicTool>;
  byOriginalName: ReadonlyMap<string, AliasedDynamicTool>;
}

export interface DynamicToolServerRequest {
  id: RequestId;
  params: DynamicToolCallParams;
  respond(response: DynamicToolCallResponse): void | Promise<void>;
}

export interface ToolCallBoundary {
  callId: string;
  name: string;
  input: Record<string, JsonValue>;
  threadId: string;
  turnId: string;
}

export interface ToolResultSubmission {
  threadId: string;
  turnId: string;
  callId: string;
  content: readonly unknown[];
}

export interface PendingDynamicToolSnapshot {
  requestId: RequestId;
  callId: string;
  threadId: string;
  turnId: string;
  alias: string;
  originalName: string;
  state: 'queued' | 'exposed' | 'responding';
}

export interface DynamicToolBridgeOptions {
  handoffTimeoutMs?: number;
  onToolCallAvailable?: (threadId: string, turnId: string) => void;
  interruptTurn?: (threadId: string, turnId: string, reason: string) => void | Promise<void>;
  onBridgeError?: (error: DynamicToolBridgeError) => void;
}

export interface CancelDynamicToolTurnOptions {
  interrupt?: boolean;
}

interface PendingDynamicToolRequest extends PendingDynamicToolSnapshot {
  arguments: Record<string, JsonValue>;
  request: DynamicToolServerRequest;
  timeout: NodeJS.Timeout;
}

export type DynamicToolBridgeErrorCode =
  | 'invalidArguments'
  | 'unknownTool'
  | 'duplicateCall'
  | 'duplicateResult'
  | 'unknownResult'
  | 'outOfOrderResult'
  | 'missingResult'
  | 'invalidResult'
  | 'handoffTimeout'
  | 'cancelled'
  | 'transportFailure';

export class DynamicToolBridgeError extends Error {
  constructor(
    readonly code: DynamicToolBridgeErrorCode,
    message: string,
    readonly threadId?: string,
    readonly turnId?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'DynamicToolBridgeError';
  }
}

/**
 * Owns the suspended item/tool/call request while VS Code executes the tool in
 * a later provider invocation. It never invokes a host tool itself.
 */
export class SuspendedDynamicToolBridge {
  private readonly catalogs = new Map<string, DynamicToolCatalog>();
  private readonly pendingByTurn = new Map<string, PendingDynamicToolRequest[]>();
  private readonly pendingCallKeys = new Set<string>();
  private readonly settledCallIdsByThread = new Map<string, Map<string, Set<string>>>();
  private readonly handoffTimeoutMs: number;
  private readonly onToolCallAvailable?: DynamicToolBridgeOptions['onToolCallAvailable'];
  private readonly interruptTurn?: DynamicToolBridgeOptions['interruptTurn'];
  private readonly onBridgeError?: DynamicToolBridgeOptions['onBridgeError'];

  constructor(options: DynamicToolBridgeOptions = {}) {
    this.handoffTimeoutMs = options.handoffTimeoutMs ?? DEFAULT_TOOL_HANDOFF_TIMEOUT_MS;
    this.onToolCallAvailable = options.onToolCallAvailable;
    this.interruptTurn = options.interruptTurn;
    this.onBridgeError = options.onBridgeError;

    if (!Number.isFinite(this.handoffTimeoutMs) || this.handoffTimeoutMs <= 0) {
      throw new Error('Dynamic tool handoff timeout must be positive.');
    }
  }

  registerThread(threadId: string, catalog: DynamicToolCatalog): void {
    if (this.pendingForThread(threadId).length > 0) {
      throw new Error('Cannot replace dynamic tools while a thread has pending calls.');
    }
    this.catalogs.set(threadId, catalog);
  }

  async receive(request: DynamicToolServerRequest): Promise<'queued' | 'rejected'> {
    const { params } = request;
    const catalog = this.catalogs.get(params.threadId);
    const tool = params.namespace === null ? catalog?.byAlias.get(params.tool) : undefined;

    if (!tool) {
      await this.rejectRequest(
        request,
        new DynamicToolBridgeError(
          'unknownTool',
          'Codex requested a dynamic tool that was not registered for this thread.',
          params.threadId,
          params.turnId
        )
      );
      return 'rejected';
    }

    if (!isJsonObject(params.arguments)) {
      await this.rejectRequest(
        request,
        new DynamicToolBridgeError(
          'invalidArguments',
          'Dynamic tool arguments must be a JSON object.',
          params.threadId,
          params.turnId
        )
      );
      return 'rejected';
    }

    const callKey = dynamicToolCallKey(params.threadId, params.turnId, params.callId);
    if (this.pendingCallKeys.has(callKey)
      || this.hasSettledCall(params.threadId, params.turnId, params.callId)) {
      await this.rejectRequest(
        request,
        new DynamicToolBridgeError(
          'duplicateCall',
          'Codex reused a dynamic tool call identifier.',
          params.threadId,
          params.turnId
        )
      );
      return 'rejected';
    }

    const key = turnKey(params.threadId, params.turnId);
    const queue = this.pendingByTurn.get(key) ?? [];
    const timeout = setTimeout(() => {
      void this.abortTurn(
        params.threadId,
        params.turnId,
        new DynamicToolBridgeError(
          'handoffTimeout',
          'The host did not return the dynamic tool result before the handoff timeout.',
          params.threadId,
          params.turnId
        )
      );
    }, this.handoffTimeoutMs);
    timeout.unref?.();

    queue.push({
      requestId: request.id,
      callId: params.callId,
      threadId: params.threadId,
      turnId: params.turnId,
      alias: params.tool,
      originalName: tool.originalName,
      arguments: params.arguments,
      state: 'queued',
      request,
      timeout
    });
    this.pendingByTurn.set(key, queue);
    this.pendingCallKeys.add(callKey);
    this.onToolCallAvailable?.(params.threadId, params.turnId);
    return 'queued';
  }

  takeNextBoundary(threadId: string, turnId: string): ToolCallBoundary | undefined {
    const queue = this.pendingByTurn.get(turnKey(threadId, turnId));
    const next = queue?.[0];
    if (!next || next.state !== 'queued') {
      return undefined;
    }

    next.state = 'exposed';
    return {
      callId: next.callId,
      name: next.originalName,
      input: next.arguments,
      threadId,
      turnId
    };
  }

  async submitResult(submission: ToolResultSubmission): Promise<void> {
    const key = turnKey(submission.threadId, submission.turnId);
    const queue = this.pendingByTurn.get(key) ?? [];
    const expected = queue[0];

    if (!expected) {
      const code: DynamicToolBridgeErrorCode = this.hasSettledCall(
        submission.threadId,
        submission.turnId,
        submission.callId
      )
        ? 'duplicateResult'
        : 'unknownResult';
      const error = new DynamicToolBridgeError(
        code,
        code === 'duplicateResult'
          ? 'The host supplied the same dynamic tool result more than once.'
          : 'The host supplied a result for an unknown dynamic tool call.',
        submission.threadId,
        submission.turnId
      );
      await this.interrupt(error);
      throw error;
    }

    if (expected.callId !== submission.callId || expected.state !== 'exposed') {
      const code: DynamicToolBridgeErrorCode = queue.some((entry) => entry.callId === submission.callId)
        ? 'outOfOrderResult'
        : this.hasSettledCall(submission.threadId, submission.turnId, submission.callId)
          ? 'duplicateResult'
          : 'unknownResult';
      const error = new DynamicToolBridgeError(
        code,
        'The host supplied a dynamic tool result out of order.',
        submission.threadId,
        submission.turnId
      );
      await this.abortTurn(submission.threadId, submission.turnId, error);
      throw error;
    }

    let contentItems: DynamicToolCallOutputContentItem[];
    try {
      contentItems = convertToolResultContent(submission.content);
    } catch (cause) {
      const error = new DynamicToolBridgeError(
        'invalidResult',
        'The host supplied dynamic tool content that could not be serialized.',
        submission.threadId,
        submission.turnId,
        { cause }
      );
      await this.abortTurn(submission.threadId, submission.turnId, error);
      throw error;
    }

    expected.state = 'responding';
    try {
      await expected.request.respond({ success: true, contentItems });
    } catch (cause) {
      const error = new DynamicToolBridgeError(
        'transportFailure',
        'The app-server dynamic tool response could not be delivered.',
        submission.threadId,
        submission.turnId,
        { cause }
      );
      await this.abortTurn(submission.threadId, submission.turnId, error);
      throw error;
    }

    clearTimeout(expected.timeout);
    queue.shift();
    this.pendingCallKeys.delete(dynamicToolCallKey(
      expected.threadId,
      expected.turnId,
      expected.callId
    ));
    this.markSettledCall(expected.threadId, expected.turnId, expected.callId);
    if (queue.length === 0) {
      this.pendingByTurn.delete(key);
    }
  }

  async failMissingResult(threadId: string, turnId: string): Promise<void> {
    const error = new DynamicToolBridgeError(
      'missingResult',
      'The next provider invocation did not contain the expected dynamic tool result.',
      threadId,
      turnId
    );
    await this.abortTurn(threadId, turnId, error);
    throw error;
  }

  getPending(threadId: string, turnId: string): PendingDynamicToolSnapshot[] {
    return (this.pendingByTurn.get(turnKey(threadId, turnId)) ?? [])
      .map(({ requestId, callId, alias, originalName, state }) => ({
        requestId,
        callId,
        threadId,
        turnId,
        alias,
        originalName,
        state
      }));
  }

  hasPending(threadId: string, turnId: string): boolean {
    return (this.pendingByTurn.get(turnKey(threadId, turnId))?.length ?? 0) > 0;
  }

  async cancelTurn(
    threadId: string,
    turnId: string,
    options: CancelDynamicToolTurnOptions = {}
  ): Promise<void> {
    await this.abortTurn(
      threadId,
      turnId,
      new DynamicToolBridgeError(
        'cancelled',
        'The dynamic tool handoff was cancelled.',
        threadId,
        turnId
      ),
      options
    );
  }

  discardTurn(threadId: string, turnId: string): void {
    const key = turnKey(threadId, turnId);
    const queue = this.pendingByTurn.get(key) ?? [];
    this.pendingByTurn.delete(key);
    for (const pending of queue) {
      clearTimeout(pending.timeout);
      this.pendingCallKeys.delete(dynamicToolCallKey(
        pending.threadId,
        pending.turnId,
        pending.callId
      ));
    }
    this.clearSettledTurn(threadId, turnId);
  }

  clearSettledTurn(threadId: string, turnId: string): void {
    const settledByTurn = this.settledCallIdsByThread.get(threadId);
    if (!settledByTurn) {
      return;
    }

    settledByTurn.delete(turnId);
    if (settledByTurn.size === 0) {
      this.settledCallIdsByThread.delete(threadId);
    }
  }

  async clearThread(threadId: string): Promise<void> {
    const turns = [...this.pendingByTurn.values()]
      .flatMap((queue) => queue)
      .filter((request) => request.threadId === threadId)
      .map((request) => request.turnId);
    for (const turnId of new Set(turns)) {
      await this.cancelTurn(threadId, turnId);
    }
    this.settledCallIdsByThread.delete(threadId);
    this.catalogs.delete(threadId);
  }

  async dispose(): Promise<void> {
    const turns = [...this.pendingByTurn.values()]
      .flatMap((queue) => queue)
      .map((request) => ({ threadId: request.threadId, turnId: request.turnId }));
    for (const { threadId, turnId } of uniqueTurns(turns)) {
      await this.cancelTurn(threadId, turnId);
    }
    this.pendingCallKeys.clear();
    this.catalogs.clear();
    this.settledCallIdsByThread.clear();
  }

  private pendingForThread(threadId: string): PendingDynamicToolRequest[] {
    return [...this.pendingByTurn.values()]
      .flatMap((queue) => queue)
      .filter((request) => request.threadId === threadId);
  }

  private async rejectRequest(
    request: DynamicToolServerRequest,
    error: DynamicToolBridgeError
  ): Promise<void> {
    this.onBridgeError?.(error);
    try {
      await request.respond({
        success: false,
        contentItems: [{ type: 'inputText', text: error.message }]
      });
    } finally {
      await this.interrupt(error);
    }
  }

  private async abortTurn(
    threadId: string,
    turnId: string,
    error: DynamicToolBridgeError,
    options: CancelDynamicToolTurnOptions = {}
  ): Promise<void> {
    const key = turnKey(threadId, turnId);
    const queue = this.pendingByTurn.get(key) ?? [];
    this.pendingByTurn.delete(key);
    this.onBridgeError?.(error);

    await Promise.allSettled(queue.map(async (pending) => {
      clearTimeout(pending.timeout);
      this.pendingCallKeys.delete(dynamicToolCallKey(
        pending.threadId,
        pending.turnId,
        pending.callId
      ));
      this.markSettledCall(pending.threadId, pending.turnId, pending.callId);
      await pending.request.respond({
        success: false,
        contentItems: [{ type: 'inputText', text: error.message }]
      });
    }));

    if (options.interrupt !== false) {
      await this.interrupt(error);
    }
  }

  private async interrupt(error: DynamicToolBridgeError): Promise<void> {
    if (error.threadId && error.turnId) {
      await this.interruptTurn?.(error.threadId, error.turnId, error.code);
    }
  }

  private hasSettledCall(threadId: string, turnId: string, callId: string): boolean {
    return this.settledCallIdsByThread.get(threadId)?.get(turnId)?.has(callId) ?? false;
  }

  private markSettledCall(threadId: string, turnId: string, callId: string): void {
    const settledByTurn = this.settledCallIdsByThread.get(threadId) ?? new Map<string, Set<string>>();
    const callIds = settledByTurn.get(turnId) ?? new Set<string>();
    callIds.add(callId);
    settledByTurn.set(turnId, callIds);
    this.settledCallIdsByThread.set(threadId, settledByTurn);
  }
}

export function createDynamicToolCatalog(
  definitions: readonly VsCodeToolDefinition[]
): DynamicToolCatalog {
  const byAlias = new Map<string, AliasedDynamicTool>();
  const byOriginalName = new Map<string, AliasedDynamicTool>();

  for (const definition of definitions) {
    if (!definition.name.trim()) {
      throw new Error('Dynamic tool names cannot be empty.');
    }
    if (byOriginalName.has(definition.name)) {
      throw new Error(`Dynamic tool '${definition.name}' was registered more than once.`);
    }

    const inputSchema = toJsonValue(definition.inputSchema ?? {
      type: 'object',
      properties: {}
    });
    const callerDescription = definition.description?.trim() ?? '';
    const description = [
      `VS Code caller tool '${definition.name}'. VS Code executes this tool under caller-controlled permissions.`,
      callerDescription
    ].filter(Boolean).join(' ');
    const alias = createDynamicToolAlias(definition.name, description, inputSchema);
    if (byAlias.has(alias)) {
      throw new Error('Dynamic tool aliases collided after canonicalization.');
    }

    const tool: AliasedDynamicTool = {
      originalName: definition.name,
      alias,
      description,
      inputSchema
    };
    byAlias.set(alias, tool);
    byOriginalName.set(definition.name, tool);
  }

  const tools = [...byAlias.values()]
    .sort((left, right) => left.alias.localeCompare(right.alias));
  return {
    tools,
    dynamicTools: tools.map((tool) => ({
      type: 'function',
      name: tool.alias,
      description: tool.description,
      inputSchema: tool.inputSchema
    })),
    byAlias,
    byOriginalName
  };
}

export function createDynamicToolAlias(
  originalName: string,
  description = '',
  inputSchema: unknown = {}
): string {
  const slug = originalName.toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'tool';
  const signature = stableSerialize({ originalName, description, inputSchema });
  const hash = createHash('sha256').update(signature).digest('hex').slice(0, 8);
  const maxSlugLength = 64 - 'vscode_'.length - 1 - hash.length;
  return `vscode_${slug.slice(0, maxSlugLength)}_${hash}`;
}

export function convertToolResultContent(
  content: readonly unknown[]
): DynamicToolCallOutputContentItem[] {
  return content.flatMap((part) => convertToolResultPart(part));
}

function convertToolResultPart(part: unknown): DynamicToolCallOutputContentItem[] {
  if (isDataPart(part)) {
    if (part.mimeType.toLowerCase().startsWith('image/')) {
      return [{
        type: 'inputImage',
        imageUrl: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`
      }];
    }

    const text = isTextLikeMimeType(part.mimeType)
      ? new TextDecoder().decode(part.data)
      : `[binary data: ${part.mimeType}, ${part.data.byteLength} bytes]`;
    return [{ type: 'inputText', text }];
  }

  if (typeof part === 'string') {
    if (isImageDataUrl(part)) {
      return [{ type: 'inputImage', imageUrl: part.trim() }];
    }
    return [{ type: 'inputText', text: part }];
  }

  if (isValuePart(part)) {
    if (typeof part.value === 'string') {
      if (isImageDataUrl(part.value)) {
        return [{ type: 'inputImage', imageUrl: part.value.trim() }];
      }
      return [{ type: 'inputText', text: part.value }];
    }
    if (part.value === undefined) {
      return [{ type: 'inputText', text: 'undefined' }];
    }
    return [{ type: 'inputText', text: stableSerialize(part.value) }];
  }

  if (part instanceof Uint8Array) {
    return [{ type: 'inputText', text: `[binary data: ${part.byteLength} bytes]` }];
  }

  if (typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint') {
    return [{ type: 'inputText', text: String(part) }];
  }

  if (part === null) {
    return [{ type: 'inputText', text: 'null' }];
  }

  if (part === undefined) {
    return [{ type: 'inputText', text: 'undefined' }];
  }

  return [{ type: 'inputText', text: stableSerialize(part) }];
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = stableSerialize(value);
  if (serialized === undefined) {
    throw new Error('Dynamic tool schema is not JSON serializable.');
  }
  return JSON.parse(serialized) as JsonValue;
}

function stableSerialize(value: unknown): string {
  const serialized = JSON.stringify(sortForStableSerialization(value));
  if (serialized === undefined) {
    throw new Error('Value is not JSON serializable.');
  }
  return serialized;
}

function sortForStableSerialization(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Cyclic value.');
    }
    seen.add(value);
    const result = value.map((entry) => sortForStableSerialization(entry, seen));
    seen.delete(value);
    return result;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('Cyclic value.');
    }
    seen.add(value);
    const result = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableSerialization(entryValue, seen)]));
    seen.delete(value);
    return result;
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  return value;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValuePart(value: unknown): value is { value: unknown } {
  return typeof value === 'object' && value !== null && 'value' in value;
}

function isDataPart(value: unknown): value is { mimeType: string; data: Uint8Array } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.mimeType === 'string' && record.data instanceof Uint8Array;
}

function isTextLikeMimeType(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('javascript');
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i.test(value.trim());
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function dynamicToolCallKey(threadId: string, turnId: string, callId: string): string {
  return JSON.stringify([threadId, turnId, callId]);
}

function uniqueTurns(
  turns: readonly { threadId: string; turnId: string }[]
): { threadId: string; turnId: string }[] {
  const result = new Map<string, { threadId: string; turnId: string }>();
  for (const turn of turns) {
    result.set(turnKey(turn.threadId, turn.turnId), turn);
  }
  return [...result.values()];
}
