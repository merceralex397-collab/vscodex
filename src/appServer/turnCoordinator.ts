import type { RequestId, ThreadTokenUsage } from './wireTypes';
import {
  AppServerEventRouter,
  extractEventScope,
  type RoutedAppServerEvent,
  type RoutedTurnSubscription
} from './eventRouter';
import {
  DynamicToolBridgeError,
  SuspendedDynamicToolBridge,
  type DynamicToolServerRequest,
  type ToolCallBoundary,
  type ToolResultSubmission
} from './toolBridge';

export interface TurnStreamSink {
  onText(value: string): void;
  onThinking?(value: string): void;
  onToolCall(value: ToolCallBoundary): void;
  onUsage?(value: ThreadTokenUsage): void;
}

export type TurnInvocationResult =
  | { kind: 'completed'; usage?: ThreadTokenUsage }
  | { kind: 'toolBoundary'; callId: string };

export interface BeginTurnOptions {
  requiredToolMode?: boolean;
}

export interface TurnSessionHandle {
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly result: Promise<TurnInvocationResult>;
  bindTurn(turnId: string): void;
  cancel(): Promise<void>;
}

export interface AppServerInitiatedRequest {
  id: RequestId;
  method: string;
  params: unknown;
  respond(result: unknown): void | Promise<void>;
  reject?(code: number, message: string): void | Promise<void>;
}

export interface TurnCoordinatorOptions {
  eventRouter: AppServerEventRouter;
  toolBridge: SuspendedDynamicToolBridge;
  interruptTurn(threadId: string, turnId: string): void | Promise<void>;
  onTurnCompleted?: (threadId: string, turnId: string) => void;
  onContextWindow?: (threadId: string, modelContextWindow: number) => void;
}

export interface FailTurnOptions {
  interruptRemote?: boolean;
}

export interface InvalidateTurnsOptions {
  interruptRemote?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
  settled: boolean;
}

interface PendingEmission {
  type: 'text' | 'thinking';
  value: string;
}

interface ActiveTurnState {
  threadId: string;
  turnId?: string;
  subscription?: RoutedTurnSubscription;
  sink?: TurnStreamSink;
  invocation?: Deferred<TurnInvocationResult>;
  requiredToolMode: boolean;
  hasDynamicToolCall: boolean;
  requiredTextBuffer: string[];
  pendingEmissions: PendingEmission[];
  itemPhases: Map<string, 'commentary' | 'final_answer' | undefined>;
  itemsWithAgentDelta: Set<string>;
  latestUsage?: ThreadTokenUsage;
  usageEmitted: boolean;
  visibleOutput: boolean;
  hostCancellationRequested: boolean;
  hostCancellationInterrupt?: Promise<void>;
  nonRetryingError?: unknown;
  terminalResult?: TurnInvocationResult;
  terminalError?: Error;
  terminal: boolean;
}

const PASSIVE_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
  'hookPrompt',
  'enteredReviewMode',
  'exitedReviewMode'
]);

const PASSIVE_NOTIFICATION_METHODS = new Set([
  'command/exec/outputDelta',
  'process/outputDelta',
  'process/exited',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'item/mcpToolCall/progress',
  'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed',
  'turn/diff/updated',
  'hook/started',
  'hook/completed'
]);

export class PassivePolicyViolationError extends Error {
  constructor(
    readonly methodOrItemType: string,
    readonly invariant?: string
  ) {
    super('Codex app-server attempted an operation forbidden by passive provider policy.');
    this.name = 'PassivePolicyViolationError';
  }
}

export class RequiredToolModeError extends Error {
  constructor() {
    super('The model completed without calling a tool required by the caller.');
    this.name = 'RequiredToolModeError';
  }
}

export class HostTurnCancellationError extends Error {
  constructor() {
    super('The language model request was cancelled.');
    this.name = 'HostTurnCancellationError';
  }
}

export class AppServerTurnError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'AppServerTurnError';
  }
}

/**
 * Coordinates app-server events and suspended tool calls while remaining
 * independent of VS Code classes. provider.ts adapts TurnStreamSink emissions
 * into LanguageModel response parts and maps the exported errors.
 */
export class AppServerTurnCoordinator {
  private readonly statesByThread = new Map<string, ActiveTurnState>();
  private readonly statesByTurn = new Map<string, ActiveTurnState>();
  private readonly eventRouter: AppServerEventRouter;
  private readonly toolBridge: SuspendedDynamicToolBridge;
  private readonly interruptTurn: TurnCoordinatorOptions['interruptTurn'];
  private readonly onTurnCompleted?: TurnCoordinatorOptions['onTurnCompleted'];
  private readonly onContextWindow?: TurnCoordinatorOptions['onContextWindow'];

  constructor(options: TurnCoordinatorOptions) {
    this.eventRouter = options.eventRouter;
    this.toolBridge = options.toolBridge;
    this.interruptTurn = options.interruptTurn;
    this.onTurnCompleted = options.onTurnCompleted;
    this.onContextWindow = options.onContextWindow;
  }

  beginTurn(
    threadId: string,
    sink: TurnStreamSink,
    options: BeginTurnOptions = {}
  ): TurnSessionHandle {
    if (this.statesByThread.has(threadId)) {
      throw new Error('This app-server thread already has an active turn.');
    }

    const state: ActiveTurnState = {
      threadId,
      requiredToolMode: options.requiredToolMode ?? false,
      hasDynamicToolCall: false,
      requiredTextBuffer: [],
      pendingEmissions: [],
      itemPhases: new Map(),
      itemsWithAgentDelta: new Set(),
      usageEmitted: false,
      visibleOutput: false,
      hostCancellationRequested: false,
      terminal: false
    };
    this.statesByThread.set(threadId, state);
    try {
      state.subscription = this.eventRouter.beginTurn(threadId, (event) => {
        this.handleEvent(state, event);
      });
      if (state.terminal) {
        state.subscription.dispose();
      }
    } catch (error) {
      this.statesByThread.delete(threadId);
      throw error;
    }
    const invocation = this.attachInvocation(state, sink);
    // turn/start can emit a terminal notification before its RPC response is
    // returned and before the backend begins awaiting this promise. Mark the
    // rejection as observed immediately; the original promise still rejects
    // for the caller when it awaits the turn outcome.
    void invocation.promise.catch(() => undefined);
    return this.createHandle(state, invocation);
  }

  bindTurn(threadId: string, turnId: string): void {
    const state = this.requireThreadState(threadId);
    this.bindState(state, turnId);
  }

  async resumeWithToolResult(
    submission: ToolResultSubmission,
    sink: TurnStreamSink
  ): Promise<TurnInvocationResult> {
    const state = this.requireTurnState(submission.threadId, submission.turnId);
    const invocation = this.attachInvocation(state, sink);
    try {
      await this.toolBridge.submitResult(submission);
      this.exposeNextToolBoundary(state);
      this.settleStoredTerminal(state);
    } catch (error) {
      this.rejectInvocation(state, error);
      throw error;
    }
    return invocation.promise;
  }

  async failMissingToolResult(threadId: string, turnId: string): Promise<never> {
    const state = this.requireTurnState(threadId, turnId);
    try {
      await this.toolBridge.failMissingResult(threadId, turnId);
    } finally {
      this.rejectInvocation(state, new DynamicToolBridgeError(
        'missingResult',
        'The expected dynamic tool result was not supplied.',
        threadId,
        turnId
      ));
      this.cleanupState(state);
    }
    throw new Error('Unreachable dynamic tool result failure.');
  }

  async handleServerRequest(request: AppServerInitiatedRequest): Promise<void> {
    if (request.method !== 'item/tool/call') {
      await this.declineUnexpectedRequest(request);
      return;
    }

    if (!isDynamicToolCallParams(request.params)) {
      await request.reject?.(-32602, 'Invalid dynamic tool call parameters.');
      await this.blockAllActiveTurns('item/tool/call');
      return;
    }

    const state = this.statesByThread.get(request.params.threadId);
    if (!state) {
      await request.respond({
        success: false,
        contentItems: [{ type: 'inputText', text: 'The target turn is no longer active.' }]
      });
      await this.interruptTurn(request.params.threadId, request.params.turnId);
      return;
    }

    try {
      this.bindState(state, request.params.turnId);
    } catch (cause) {
      const knownTurnId = state.turnId;
      const error = new AppServerTurnError(
        'App-server dynamic tool request crossed turn boundaries.',
        cause
      );
      const settleKnownTurn = this.failTurn(state.threadId, knownTurnId, error)
        .catch(() => undefined);
      try {
        if (request.reject) {
          await request.reject(-32602, 'Dynamic tool request crossed turn boundaries.');
        } else {
          await request.respond({
            success: false,
            contentItems: [{ type: 'inputText', text: 'Dynamic tool request crossed turn boundaries.' }]
          });
        }
      } finally {
        await settleKnownTurn;
        if (knownTurnId !== request.params.turnId) {
          await Promise.resolve(
            this.interruptTurn(request.params.threadId, request.params.turnId)
          ).catch(() => undefined);
        }
      }
      return;
    }
    if (state.hostCancellationRequested) {
      await request.respond({
        success: false,
        contentItems: [{ type: 'inputText', text: 'The host cancelled this turn.' }]
      });
      await this.requestHostCancellationInterrupt(state);
      return;
    }
    const result = await this.toolBridge.receive({
      id: request.id,
      params: request.params,
      respond: (response) => request.respond(response)
    } satisfies DynamicToolServerRequest);
    if (result === 'queued') {
      if (state.hostCancellationRequested) {
        await this.toolBridge.cancelTurn(state.threadId, request.params.turnId, { interrupt: false });
        await this.requestHostCancellationInterrupt(state);
        return;
      }
      state.hasDynamicToolCall = true;
      this.flushRequiredText(state);
      this.exposeNextToolBoundary(state);
    }
  }

  async cancelTurn(threadId: string, turnId?: string): Promise<void> {
    const state = turnId
      ? this.statesByTurn.get(turnKey(threadId, turnId))
      : this.statesByThread.get(threadId);
    if (!state || state.terminal) {
      return;
    }

    state.hostCancellationRequested = true;
    if (state.turnId) {
      if (this.toolBridge.hasPending(state.threadId, state.turnId)) {
        await this.toolBridge.cancelTurn(state.threadId, state.turnId, { interrupt: false });
      }
      await this.requestHostCancellationInterrupt(state);
    }
  }

  async failTurn(
    threadId: string,
    turnId: string | undefined,
    error: unknown,
    options: FailTurnOptions = {}
  ): Promise<void> {
    const state = turnId
      ? this.statesByTurn.get(turnKey(threadId, turnId))
      : this.statesByThread.get(threadId);
    if (!state) {
      return;
    }

    const boundTurnId = state.turnId;
    const hadPendingToolRequest = boundTurnId
      ? this.toolBridge.hasPending(state.threadId, boundTurnId)
      : false;

    // Settle the provider invocation before yielding to app-server. A malformed
    // tool request can otherwise race a successful turn/completed notification
    // emitted while the interrupt RPC is in flight.
    this.rejectInvocation(state, error);
    this.cleanupState(state);

    if (boundTurnId) {
      if (hadPendingToolRequest) {
        await this.toolBridge.cancelTurn(state.threadId, boundTurnId, { interrupt: false });
      }
      if (options.interruptRemote !== false) {
        await this.interruptTurn(state.threadId, boundTurnId);
      }
    }
  }

  async invalidateAll(
    reason = 'App-server turn state was invalidated.',
    options: InvalidateTurnsOptions = {}
  ): Promise<void> {
    for (const state of [...this.statesByThread.values()]) {
      const turnId = state.turnId;
      const hadPendingToolRequest = turnId
        ? this.toolBridge.hasPending(state.threadId, turnId)
        : false;
      this.rejectInvocation(state, new AppServerTurnError(reason));
      this.cleanupState(state);

      if (!turnId) {
        continue;
      }
      if (options.interruptRemote === false) {
        this.toolBridge.discardTurn(state.threadId, turnId);
        continue;
      }
      try {
        if (hadPendingToolRequest) {
          await this.toolBridge.cancelTurn(state.threadId, turnId, { interrupt: false });
        }
        await this.interruptTurn(state.threadId, turnId);
      } catch {
        // State is already settled locally; invalidation must continue for the
        // remaining turns even if app-server cannot acknowledge interruption.
      }
    }
  }

  route(notification: { method: string; params: unknown }): boolean {
    const scope = extractEventScope(notification.params);
    const passiveItemType = getPassiveLifecycleItemType(notification);
    if (passiveItemType) {
      if (scope.threadId && scope.turnId
        && this.eventRouter.isTurnClosed(scope.threadId, scope.turnId)) {
        return false;
      }
      return this.routePassiveItemViolation(scope, passiveItemType);
    }

    const routed = this.eventRouter.route(notification);
    if (routed) {
      return true;
    }

    if (scope.threadId && scope.turnId
      && this.eventRouter.isTurnClosed(scope.threadId, scope.turnId)) {
      return false;
    }

    if (PASSIVE_NOTIFICATION_METHODS.has(notification.method)) {
      const state = this.findScopedState(scope.threadId, scope.turnId);
      if (state) {
        void this.blockState(state, new PassivePolicyViolationError(notification.method));
        return true;
      }
      if (scope.threadId && scope.turnId) {
        void this.interruptTurn(scope.threadId, scope.turnId);
        return false;
      }
      if (scope.threadId || scope.turnId) {
        return false;
      }
      const hadActiveTurns = this.statesByThread.size > 0;
      void this.blockAllActiveTurns(notification.method);
      return hadActiveTurns;
    }

    if (notification.method === 'turn/completed') {
      const states = this.findCompletionFallbackStates(scope.threadId, scope.turnId);
      for (const state of states) {
        this.handleEvent(state, {
          ...notification,
          ...scope,
          receivedAt: Date.now()
        });
      }
      return states.length > 0;
    }

    return false;
  }

  private routePassiveItemViolation(
    scope: { threadId?: string; turnId?: string },
    itemType: string
  ): boolean {
    if (!scope.threadId && !scope.turnId) {
      const hadActiveTurns = this.statesByThread.size > 0;
      void this.blockAllActiveTurns(itemType);
      return hadActiveTurns;
    }

    const state = scope.threadId
      ? this.statesByThread.get(scope.threadId)
      : this.findScopedState(undefined, scope.turnId);
    if (!state) {
      if (scope.threadId && scope.turnId) {
        void Promise.resolve(this.interruptTurn(scope.threadId, scope.turnId))
          .catch(() => undefined);
      }
      return false;
    }

    const knownTurnId = state.turnId;
    const claimedDifferentTurn = Boolean(
      scope.threadId
      && scope.turnId
      && (scope.threadId !== state.threadId || scope.turnId !== knownTurnId)
    );
    const blockKnownTurn = this.blockState(state, new PassivePolicyViolationError(itemType))
      .catch(() => undefined);
    const interruptClaimedTurn = claimedDifferentTurn
      ? Promise.resolve(this.interruptTurn(scope.threadId!, scope.turnId!)).catch(() => undefined)
      : Promise.resolve();
    void Promise.all([blockKnownTurn, interruptClaimedTurn]);
    return true;
  }

  private createHandle(
    state: ActiveTurnState,
    invocation: Deferred<TurnInvocationResult>
  ): TurnSessionHandle {
    const coordinator = this;
    return {
      get threadId() {
        return state.threadId;
      },
      get turnId() {
        return state.turnId;
      },
      result: invocation.promise,
      bindTurn(turnId: string) {
        coordinator.bindState(state, turnId);
      },
      cancel() {
        return coordinator.cancelTurn(state.threadId, state.turnId);
      }
    };
  }

  private attachInvocation(
    state: ActiveTurnState,
    sink: TurnStreamSink
  ): Deferred<TurnInvocationResult> {
    if (state.sink || (state.invocation && !state.invocation.settled)) {
      throw new Error('A provider invocation is already attached to this turn.');
    }

    const invocation = createDeferred<TurnInvocationResult>();
    state.sink = sink;
    state.invocation = invocation;
    for (const emission of state.pendingEmissions.splice(0)) {
      this.writeEmission(state, emission);
    }
    this.exposeNextToolBoundary(state);
    this.settleStoredTerminal(state);
    return invocation;
  }

  private bindState(state: ActiveTurnState, turnId: string): void {
    if (state.terminal) {
      return;
    }
    if (state.turnId && state.turnId !== turnId) {
      throw new Error('App-server events crossed turn boundaries.');
    }
    if (state.turnId === turnId) {
      return;
    }

    state.subscription?.bindTurn(turnId);
    if (state.turnId === turnId || state.terminal) {
      return;
    }
    if (state.turnId && state.turnId !== turnId) {
      throw new Error('App-server events crossed turn boundaries.');
    }
    state.turnId = turnId;
    this.statesByTurn.set(turnKey(state.threadId, turnId), state);
    if (state.hostCancellationRequested) {
      void this.requestHostCancellationInterrupt(state);
    }
  }

  private handleEvent(state: ActiveTurnState, event: RoutedAppServerEvent): void {
    if (state.terminal) {
      return;
    }
    if (event.turnId) {
      try {
        this.bindState(state, event.turnId);
      } catch (error) {
        void this.failTurn(
          state.threadId,
          state.turnId,
          new AppServerTurnError('App-server events crossed turn boundaries.', error)
        );
        return;
      }
    }

    if (PASSIVE_NOTIFICATION_METHODS.has(event.method)) {
      void this.blockState(state, new PassivePolicyViolationError(event.method));
      return;
    }

    switch (event.method) {
      case 'item/started':
      case 'item/completed':
        this.handleItemLifecycle(state, event.method, event.params);
        break;
      case 'item/agentMessage/delta':
        this.handleAgentDelta(state, event.params);
        break;
      case 'item/reasoning/summaryTextDelta':
      case 'item/plan/delta':
        this.handleThinkingDelta(state, event.params);
        break;
      case 'item/reasoning/textDelta':
        break;
      case 'thread/tokenUsage/updated':
        this.handleTokenUsage(state, event.params);
        break;
      case 'error':
        this.handleErrorNotification(state, event.params);
        break;
      case 'turn/completed':
        this.handleTurnCompleted(state, event.params);
        break;
      default:
        break;
    }
  }

  private handleItemLifecycle(
    state: ActiveTurnState,
    method: string,
    params: unknown
  ): void {
    const item = isRecord(params) && isRecord(params.item) ? params.item : undefined;
    const itemType = item && typeof item.type === 'string' ? item.type : undefined;
    if (!item || !itemType) {
      return;
    }

    if (PASSIVE_ITEM_TYPES.has(itemType)) {
      void this.blockState(state, new PassivePolicyViolationError(itemType));
      return;
    }

    if (itemType === 'agentMessage' && typeof item.id === 'string') {
      const phase = item.phase === 'commentary' || item.phase === 'final_answer'
        ? item.phase
        : undefined;
      state.itemPhases.set(item.id, phase);

      if (method === 'item/completed'
        && !state.itemsWithAgentDelta.has(item.id)
        && typeof item.text === 'string'
        && item.text.length > 0) {
        this.emitAgentText(state, item.text, phase);
      }
    }
  }

  private handleAgentDelta(state: ActiveTurnState, params: unknown): void {
    if (!isRecord(params)
      || typeof params.itemId !== 'string'
      || typeof params.delta !== 'string') {
      return;
    }
    state.itemsWithAgentDelta.add(params.itemId);
    this.emitAgentText(state, params.delta, state.itemPhases.get(params.itemId));
  }

  private emitAgentText(
    state: ActiveTurnState,
    value: string,
    phase: 'commentary' | 'final_answer' | undefined
  ): void {
    if (phase === 'commentary') {
      this.emit(state, { type: 'thinking', value });
      return;
    }

    if (state.requiredToolMode && !state.hasDynamicToolCall) {
      state.requiredTextBuffer.push(value);
      return;
    }
    this.emit(state, { type: 'text', value });
  }

  private handleThinkingDelta(state: ActiveTurnState, params: unknown): void {
    if (isRecord(params) && typeof params.delta === 'string') {
      this.emit(state, { type: 'thinking', value: params.delta });
    }
  }

  private handleTokenUsage(state: ActiveTurnState, params: unknown): void {
    if (!isRecord(params) || !isThreadTokenUsage(params.tokenUsage)) {
      return;
    }
    state.latestUsage = params.tokenUsage;
    if (params.tokenUsage.modelContextWindow !== null
      && Number.isFinite(params.tokenUsage.modelContextWindow)) {
      this.onContextWindow?.(state.threadId, params.tokenUsage.modelContextWindow);
    }
  }

  private handleErrorNotification(state: ActiveTurnState, params: unknown): void {
    if (isRecord(params) && params.willRetry === false) {
      state.nonRetryingError = params.error;
    }
  }

  private handleTurnCompleted(state: ActiveTurnState, params: unknown): void {
    if (!isRecord(params)
      || params.threadId !== state.threadId
      || !isRecord(params.turn)
      || typeof params.turn.id !== 'string'
      || params.turn.id.length === 0
      || typeof params.turn.status !== 'string') {
      void this.failMalformedCompletion(state, new AppServerTurnError(
        'App-server emitted a malformed turn/completed notification.',
        params
      ));
      return;
    }

    const turn = params.turn;
    const turnId = turn.id as string;
    const status = turn.status as string;
    try {
      this.bindState(state, turnId);
    } catch (error) {
      void this.failMalformedCompletion(state, new AppServerTurnError(
        'App-server turn/completed crossed turn boundaries.',
        error
      ));
      return;
    }

    if (status === 'completed') {
      if (state.hostCancellationRequested) {
        this.completeWithError(state, new HostTurnCancellationError());
        return;
      }
      if (state.requiredToolMode && !state.hasDynamicToolCall) {
        state.requiredTextBuffer.length = 0;
        this.completeWithError(state, new RequiredToolModeError());
        return;
      }
      this.flushRequiredText(state);
      this.emitUsage(state);
      state.terminalResult = { kind: 'completed', usage: state.latestUsage };
      state.terminal = true;
      this.onTurnCompleted?.(state.threadId, state.turnId ?? '');
      this.settleStoredTerminal(state);
      return;
    }

    if (status === 'interrupted') {
      this.completeWithError(state, state.hostCancellationRequested
        ? new HostTurnCancellationError()
        : new AppServerTurnError('The Codex turn was interrupted unexpectedly.'));
      return;
    }

    if (status === 'failed') {
      const detail = turn?.error ?? state.nonRetryingError;
      this.completeWithError(state, new AppServerTurnError(
        extractTurnErrorMessage(detail) ?? 'The Codex turn failed.',
        detail
      ));
      return;
    }

    void this.failMalformedCompletion(state, new AppServerTurnError(
      status === 'inProgress'
        ? 'App-server emitted turn/completed for a nonterminal turn.'
        : 'App-server emitted turn/completed with an unknown turn status.',
      status
    ));
  }

  private exposeNextToolBoundary(state: ActiveTurnState): void {
    if (!state.sink || !state.invocation || state.invocation.settled || !state.turnId) {
      return;
    }
    if (state.hostCancellationRequested) {
      if (this.toolBridge.hasPending(state.threadId, state.turnId)) {
        void this.toolBridge.cancelTurn(state.threadId, state.turnId, { interrupt: false }).catch((error) => {
          void this.failTurn(state.threadId, state.turnId, error);
        });
      }
      void this.requestHostCancellationInterrupt(state);
      return;
    }
    const boundary = this.toolBridge.takeNextBoundary(state.threadId, state.turnId);
    if (!boundary) {
      return;
    }

    state.sink.onToolCall(boundary);
    state.visibleOutput = true;
    state.invocation.resolve({ kind: 'toolBoundary', callId: boundary.callId });
    state.sink = undefined;
    state.invocation = undefined;
  }

  private flushRequiredText(state: ActiveTurnState): void {
    for (const value of state.requiredTextBuffer.splice(0)) {
      this.emit(state, { type: 'text', value });
    }
  }

  private emit(state: ActiveTurnState, emission: PendingEmission): void {
    if (!state.sink) {
      state.pendingEmissions.push(emission);
      return;
    }
    this.writeEmission(state, emission);
  }

  private writeEmission(state: ActiveTurnState, emission: PendingEmission): void {
    if (!state.sink) {
      state.pendingEmissions.push(emission);
      return;
    }
    if (emission.type === 'text') {
      state.sink.onText(emission.value);
    } else {
      state.sink.onThinking?.(emission.value);
    }
    state.visibleOutput = true;
  }

  private emitUsage(state: ActiveTurnState): void {
    if (!state.latestUsage || state.usageEmitted) {
      return;
    }
    state.usageEmitted = true;
    state.sink?.onUsage?.(state.latestUsage);
  }

  private completeWithError(state: ActiveTurnState, error: Error): void {
    state.terminalError = error;
    state.terminal = true;
    this.settleStoredTerminal(state);
  }

  private settleStoredTerminal(state: ActiveTurnState): void {
    if (!state.terminal || !state.invocation || state.invocation.settled) {
      return;
    }
    if (state.terminalError) {
      state.invocation.reject(state.terminalError);
    } else if (state.terminalResult) {
      state.invocation.resolve(state.terminalResult);
    }
    state.sink = undefined;
    state.invocation = undefined;
    this.cleanupState(state);
  }

  private rejectInvocation(state: ActiveTurnState, error: unknown): void {
    state.invocation?.reject(error);
    state.sink = undefined;
    state.invocation = undefined;
  }

  private async declineUnexpectedRequest(request: AppServerInitiatedRequest): Promise<void> {
    const response = declinedResponse(request.method);
    if (response !== undefined) {
      await request.respond(response);
    } else if (request.reject) {
      await request.reject(-32000, 'Request denied by passive provider policy.');
    } else {
      await request.respond({});
    }

    const scope = extractRequestScope(request.params);
    if (scope.threadId && scope.turnId) {
      const state = this.statesByTurn.get(turnKey(scope.threadId, scope.turnId));
      if (state) {
        await this.blockState(state, new PassivePolicyViolationError(request.method));
      } else {
        await this.interruptTurn(scope.threadId, scope.turnId);
      }
      return;
    }
    await this.blockAllActiveTurns(request.method);
  }

  private async blockAllActiveTurns(method: string): Promise<void> {
    await Promise.all([...this.statesByThread.values()]
      .map((state) => this.blockState(state, new PassivePolicyViolationError(method))));
  }

  private async blockState(state: ActiveTurnState, error: PassivePolicyViolationError): Promise<void> {
    if (state.terminal) {
      return;
    }
    state.terminal = true;
    state.terminalError = error;
    try {
      if (state.turnId) {
        if (this.toolBridge.hasPending(state.threadId, state.turnId)) {
          await this.toolBridge.cancelTurn(state.threadId, state.turnId, { interrupt: false });
        }
        await this.interruptTurn(state.threadId, state.turnId);
      }
    } finally {
      this.rejectInvocation(state, error);
      this.cleanupState(state);
    }
  }

  private async failMalformedCompletion(
    state: ActiveTurnState,
    error: AppServerTurnError
  ): Promise<void> {
    if (state.terminal) {
      return;
    }
    state.terminal = true;
    state.terminalError = error;
    try {
      if (state.turnId) {
        if (this.toolBridge.hasPending(state.threadId, state.turnId)) {
          await this.toolBridge.cancelTurn(state.threadId, state.turnId, { interrupt: false });
        }
        await this.interruptTurn(state.threadId, state.turnId);
      }
    } finally {
      this.rejectInvocation(state, error);
      this.cleanupState(state);
    }
  }

  private requestHostCancellationInterrupt(state: ActiveTurnState): Promise<void> {
    if (!state.turnId) {
      return Promise.resolve();
    }
    if (!state.hostCancellationInterrupt) {
      state.hostCancellationInterrupt = Promise.resolve()
        .then(() => this.interruptTurn(state.threadId, state.turnId!))
        .catch(() => undefined);
    }
    return state.hostCancellationInterrupt;
  }

  private findScopedState(
    threadId: string | undefined,
    turnId: string | undefined
  ): ActiveTurnState | undefined {
    if (threadId && turnId) {
      return this.statesByTurn.get(turnKey(threadId, turnId));
    }
    if (threadId) {
      return this.statesByThread.get(threadId);
    }
    if (turnId) {
      const matches = [...this.statesByThread.values()]
        .filter(state => state.turnId === turnId);
      return matches.length === 1 ? matches[0] : undefined;
    }
    return this.statesByThread.size === 1
      ? this.statesByThread.values().next().value
      : undefined;
  }

  private findCompletionFallbackStates(
    threadId: string | undefined,
    turnId: string | undefined
  ): ActiveTurnState[] {
    const scoped = this.findScopedState(threadId, turnId);
    if (scoped) {
      return [scoped];
    }
    if (!threadId && !turnId) {
      return [...this.statesByThread.values()];
    }
    return [];
  }

  private cleanupState(state: ActiveTurnState): void {
    state.subscription?.dispose();
    this.statesByThread.delete(state.threadId);
    if (state.turnId) {
      this.toolBridge.clearSettledTurn(state.threadId, state.turnId);
      this.statesByTurn.delete(turnKey(state.threadId, state.turnId));
    }
  }

  private requireThreadState(threadId: string): ActiveTurnState {
    const state = this.statesByThread.get(threadId);
    if (!state) {
      throw new Error('The app-server thread does not have an active turn.');
    }
    return state;
  }

  private requireTurnState(threadId: string, turnId: string): ActiveTurnState {
    const state = this.statesByTurn.get(turnKey(threadId, turnId));
    if (!state) {
      throw new Error('The app-server turn is no longer active.');
    }
    return state;
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const deferred: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve(value) {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      resolvePromise(value);
    },
    reject(reason) {
      if (deferred.settled) {
        return;
      }
      deferred.settled = true;
      rejectPromise(reason);
    },
    settled: false
  };
  return deferred;
}

function declinedResponse(method: string): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' };
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { decision: 'denied' };
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null };
    case 'item/tool/requestUserInput':
      return { answers: {} };
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn', strictAutoReview: true };
    default:
      return undefined;
  }
}

function extractRequestScope(params: unknown): { threadId?: string; turnId?: string } {
  if (!isRecord(params)) {
    return {};
  }
  return {
    threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
    turnId: typeof params.turnId === 'string' ? params.turnId : undefined
  };
}

function isDynamicToolCallParams(value: unknown): value is DynamicToolServerRequest['params'] {
  return isRecord(value)
    && typeof value.threadId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.callId === 'string'
    && (value.namespace === null || typeof value.namespace === 'string')
    && typeof value.tool === 'string'
    && 'arguments' in value;
}

function getPassiveLifecycleItemType(
  notification: { method: string; params: unknown }
): string | undefined {
  if (notification.method !== 'item/started' && notification.method !== 'item/completed') {
    return undefined;
  }
  const item = isRecord(notification.params) && isRecord(notification.params.item)
    ? notification.params.item
    : undefined;
  const itemType = item && typeof item.type === 'string' ? item.type : undefined;
  return itemType && PASSIVE_ITEM_TYPES.has(itemType) ? itemType : undefined;
}

function isThreadTokenUsage(value: unknown): value is ThreadTokenUsage {
  return isRecord(value)
    && isTokenUsageBreakdown(value.total)
    && isTokenUsageBreakdown(value.last)
    && (value.modelContextWindow === null
      || isFiniteNumber(value.modelContextWindow) && value.modelContextWindow > 0);
}

function isTokenUsageBreakdown(value: unknown): boolean {
  return isRecord(value)
    && isFiniteNonnegativeNumber(value.totalTokens)
    && isFiniteNonnegativeNumber(value.inputTokens)
    && isFiniteNonnegativeNumber(value.cachedInputTokens)
    && isFiniteNonnegativeNumber(value.outputTokens)
    && isFiniteNonnegativeNumber(value.reasoningOutputTokens);
}

function isFiniteNonnegativeNumber(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractTurnErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === 'string' && value.message.length > 0) {
    return value.message;
  }
  if (typeof value.error === 'string' && value.error.length > 0) {
    return value.error;
  }
  return undefined;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
