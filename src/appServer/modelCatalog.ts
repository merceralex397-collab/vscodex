import { createHash } from 'node:crypto';
import {
  AppServerProtocolError,
  AppServerRpcClient,
  BackendModel,
  BackendReasoningEffort,
  BackendServiceTier,
  CancellationLike,
  DisposableLike,
  EventLike,
  ModelContextWindowUpdate,
  OperationCancelledError,
  TypedEventEmitter
} from './types';

const DEFAULT_RPC_TIMEOUT_MS = 30 * 1000;
const MAX_MODEL_PAGES = 1000;

export interface ModelCatalogOptions {
  runtimeVersion: string | (() => string);
  rpcTimeoutMs?: number;
  pageSize?: number;
}

/** Pages and normalizes the app-server model catalog without inventing fallbacks. */
export class ModelCatalog implements DisposableLike {
  private readonly contextWindowEmitter = new TypedEventEmitter<ModelContextWindowUpdate>();
  private readonly contextWindows = new Map<string, number>();
  private readonly runtimeVersion: () => string;
  private readonly rpcTimeoutMs: number;
  private readonly pageSize: number | undefined;

  readonly onDidUpdateContextWindow: EventLike<ModelContextWindowUpdate> = this.contextWindowEmitter.event;

  constructor(
    private readonly rpc: AppServerRpcClient,
    options: ModelCatalogOptions
  ) {
    this.runtimeVersion = typeof options.runtimeVersion === 'function'
      ? options.runtimeVersion
      : () => options.runtimeVersion as string;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.pageSize = normalizePositiveInteger(options.pageSize);
  }

  async listModels(token?: CancellationLike): Promise<BackendModel[]> {
    const controller = new AbortController();
    const cancellation = token?.onCancellationRequested?.(() => controller.abort());
    try {
      if (token?.isCancellationRequested) {
        throw new OperationCancelledError();
      }

      const models = new Map<string, BackendModel>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let pageCount = 0;

      do {
        if (token?.isCancellationRequested || controller.signal.aborted) {
          throw new OperationCancelledError();
        }
        if (pageCount >= MAX_MODEL_PAGES) {
          throw new AppServerProtocolError('App-server model pagination exceeded the safety limit.', 'model/list', this.runtimeVersion());
        }
        pageCount += 1;

        const response = await this.rpc.request<unknown>(
          'model/list',
          {
            cursor,
            ...(this.pageSize ? { limit: this.pageSize } : {})
          },
          {
            timeoutMs: this.rpcTimeoutMs,
            signal: controller.signal
          }
        );
        const page = parseModelPage(response, this.runtimeVersion());
        for (const entry of page.data) {
          const model = mapModel(entry, this.getContextWindow(entry.model));
          models.set(model.id, model);
        }

        cursor = page.nextCursor;
        if (cursor) {
          if (seenCursors.has(cursor)) {
            throw new AppServerProtocolError('App-server returned a repeated model pagination cursor.', 'model/list', this.runtimeVersion());
          }
          seenCursors.add(cursor);
        }
      } while (cursor !== null);

      return [...models.values()];
    } catch (error) {
      if (token?.isCancellationRequested || controller.signal.aborted) {
        throw new OperationCancelledError();
      }
      throw error;
    } finally {
      cancellation?.dispose();
    }
  }

  updateContextWindow(model: string, value: number): boolean {
    const normalizedModel = model.trim();
    const normalizedValue = normalizePositiveInteger(value);
    if (!normalizedModel || !normalizedValue) {
      return false;
    }
    const key = this.contextWindowKey(normalizedModel);
    if (this.contextWindows.get(key) === normalizedValue) {
      return false;
    }
    this.contextWindows.set(key, normalizedValue);
    this.contextWindowEmitter.fire({
      model: normalizedModel,
      contextWindow: normalizedValue
    });
    return true;
  }

  getContextWindow(model: string): number | undefined {
    return this.contextWindows.get(this.contextWindowKey(model.trim()));
  }

  invalidateContextWindows(): void {
    this.contextWindows.clear();
  }

  dispose(): void {
    this.contextWindows.clear();
    this.contextWindowEmitter.dispose();
  }

  private contextWindowKey(model: string): string {
    return `${this.runtimeVersion()}\u0000${model}`;
  }
}

interface ParsedModelPage {
  data: ParsedModel[];
  nextCursor: string | null;
}

interface ParsedModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: BackendReasoningEffort[];
  defaultReasoningEffort: string;
  inputModalities: Array<'text' | 'image'>;
  serviceTiers: BackendServiceTier[];
  defaultServiceTier?: string;
}

function parseModelPage(value: unknown, runtimeVersion: string): ParsedModelPage {
  const response = asRecord(value);
  if (!response || !Array.isArray(response.data)) {
    throw new AppServerProtocolError('App-server returned an invalid model/list response.', 'model/list', runtimeVersion);
  }
  if (response.nextCursor !== null && response.nextCursor !== undefined && typeof response.nextCursor !== 'string') {
    throw new AppServerProtocolError('App-server returned an invalid model pagination cursor.', 'model/list', runtimeVersion);
  }

  return {
    data: response.data.map((entry) => parseModel(entry, runtimeVersion)),
    nextCursor: response.nextCursor ?? null
  };
}

function parseModel(value: unknown, runtimeVersion: string): ParsedModel {
  const model = asRecord(value);
  const id = readNonEmptyString(model?.id);
  const requestModel = readNonEmptyString(model?.model);
  const displayName = readNonEmptyString(model?.displayName);
  const description = readString(model?.description);
  const defaultReasoningEffort = readNonEmptyString(model?.defaultReasoningEffort);
  if (!model || !id || !requestModel || !displayName || description === undefined || !defaultReasoningEffort) {
    throw new AppServerProtocolError('App-server returned an incomplete model catalog entry.', 'model/list', runtimeVersion);
  }

  return {
    id,
    model: requestModel,
    displayName,
    description,
    hidden: model.hidden === true,
    isDefault: model.isDefault === true,
    supportedReasoningEfforts: parseReasoningEfforts(model.supportedReasoningEfforts),
    defaultReasoningEffort,
    inputModalities: parseInputModalities(model.inputModalities),
    serviceTiers: parseServiceTiers(model.serviceTiers),
    defaultServiceTier: readNonEmptyString(model.defaultServiceTier)
  };
}

function mapModel(model: ParsedModel, contextWindow: number | undefined): BackendModel {
  const hashInput = {
    id: model.id,
    model: model.model,
    displayName: model.displayName,
    description: model.description,
    hidden: model.hidden,
    isDefault: model.isDefault,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    defaultReasoningEffort: model.defaultReasoningEffort,
    inputModalities: model.inputModalities,
    serviceTiers: model.serviceTiers,
    defaultServiceTier: model.defaultServiceTier
  };
  return {
    ...hashInput,
    contextWindow,
    catalogHash: createHash('sha256').update(stableStringify(hashInput)).digest('hex').slice(0, 16)
  };
}

function parseReasoningEfforts(value: unknown): BackendReasoningEffort[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const options: BackendReasoningEffort[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    const effort = readNonEmptyString(record?.reasoningEffort);
    const description = readString(record?.description);
    if (!effort || description === undefined || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    options.push({ effort, description });
  }
  return options;
}

function parseInputModalities(value: unknown): Array<'text' | 'image'> {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry): entry is 'text' | 'image' => entry === 'text' || entry === 'image'))];
}

function parseServiceTiers(value: unknown): BackendServiceTier[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const tiers: BackendServiceTier[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const record = asRecord(entry);
    const id = readNonEmptyString(record?.id);
    const name = readNonEmptyString(record?.name);
    const description = readString(record?.description);
    if (!id || !name || description === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    tiers.push({ id, name, description });
  }
  return tiers;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
