import {
  AccountTokenActivitySnapshot,
  AppServerProtocolError,
  AppServerRpcClient,
  ChatGptPlanType,
  CodexAccountUsageSnapshot,
  CodexRateLimitWindow,
  DisposableLike,
  EventLike,
  RpcNotification,
  TokenCount,
  TypedEventEmitter
} from './types';

const DEFAULT_RPC_TIMEOUT_MS = 30 * 1000;

type RawRecord = Record<string, unknown>;

export interface AccountUsageAdapterOptions {
  rpcTimeoutMs?: number;
  now?: () => number;
}

/** Maps app-server account limit/activity RPCs and merges sparse live updates. */
export class AccountUsageAdapter implements DisposableLike {
  private readonly updateEmitter = new TypedEventEmitter<CodexAccountUsageSnapshot>();
  private readonly notificationSubscription: DisposableLike;
  private readonly rawLimits = new Map<string, RawRecord>();
  private readonly rpcTimeoutMs: number;
  private readonly now: () => number;
  private currentSnapshot: CodexAccountUsageSnapshot | undefined;
  private primaryLimitKey: string | undefined;
  private invalidationGeneration = 0;

  readonly onDidUpdateRateLimits: EventLike<CodexAccountUsageSnapshot> = this.updateEmitter.event;

  constructor(
    private readonly rpc: AppServerRpcClient,
    options: AccountUsageAdapterOptions = {}
  ) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.notificationSubscription = rpc.onNotification((notification) => this.handleNotification(notification));
  }

  get snapshot(): CodexAccountUsageSnapshot | undefined {
    return this.currentSnapshot;
  }

  async readRateLimits(): Promise<CodexAccountUsageSnapshot> {
    const generation = this.invalidationGeneration;
    const response = await this.rpc.request<unknown>(
      'account/rateLimits/read',
      undefined,
      { timeoutMs: this.rpcTimeoutMs }
    );
    if (generation !== this.invalidationGeneration) {
      throw new AppServerProtocolError('Codex rate-limit state changed while it was being read.');
    }
    this.replaceRawLimits(response);
    const snapshot = this.buildSnapshot();
    this.currentSnapshot = snapshot;
    this.updateEmitter.fire(snapshot);
    return snapshot;
  }

  async readTokenActivity(): Promise<AccountTokenActivitySnapshot> {
    const generation = this.invalidationGeneration;
    const response = await this.rpc.request<unknown>(
      'account/usage/read',
      undefined,
      { timeoutMs: this.rpcTimeoutMs }
    );
    if (generation !== this.invalidationGeneration) {
      throw new AppServerProtocolError('Codex account activity changed while it was being read.');
    }
    return parseTokenActivity(response, this.now());
  }

  invalidate(): void {
    this.invalidationGeneration += 1;
    this.rawLimits.clear();
    this.primaryLimitKey = undefined;
    this.currentSnapshot = undefined;
  }

  dispose(): void {
    this.notificationSubscription.dispose();
    this.invalidate();
    this.updateEmitter.dispose();
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method !== 'account/rateLimits/updated') {
      return;
    }
    const params = asRecord(notification.params);
    const update = asRecord(params?.rateLimits);
    if (!update) {
      return;
    }

    const announcedKey = getLimitKey(update, '__primary__');
    const existingKey = this.findExistingLimitKey(update, announcedKey);
    const previous = existingKey ? this.rawLimits.get(existingKey) : undefined;
    const hasIdentity = readNonEmptyString(update.limitId) !== undefined
      || readNonEmptyString(update.limitName) !== undefined;
    const targetKey = !hasIdentity && existingKey ? existingKey : announcedKey;
    if (existingKey && existingKey !== targetKey) {
      this.rawLimits.delete(existingKey);
    }
    this.rawLimits.set(targetKey, mergeSparseRecord(previous, update));
    if (!this.primaryLimitKey || this.primaryLimitKey === existingKey) {
      this.primaryLimitKey = targetKey;
    }
    const snapshot = this.buildSnapshot();
    this.currentSnapshot = snapshot;
    this.updateEmitter.fire(snapshot);
  }

  private replaceRawLimits(value: unknown): void {
    const response = asRecord(value);
    const primary = asRecord(response?.rateLimits);
    if (!response || !primary) {
      throw new AppServerProtocolError('App-server returned an invalid account/rateLimits/read response.');
    }

    this.rawLimits.clear();
    this.primaryLimitKey = getLimitKey(primary, '__primary__');
    this.rawLimits.set(this.primaryLimitKey, primary);

    const byId = asRecord(response.rateLimitsByLimitId);
    if (byId) {
      for (const [limitId, raw] of Object.entries(byId)) {
        const record = asRecord(raw);
        if (!record) {
          continue;
        }
        const normalized = record.limitId === null || record.limitId === undefined
          ? { ...record, limitId }
          : record;
        this.rawLimits.set(getLimitKey(normalized, limitId), normalized);
      }
    }
  }

  private buildSnapshot(): CodexAccountUsageSnapshot {
    const limits: CodexRateLimitWindow[] = [];
    let planType: ChatGptPlanType | undefined;
    let creditsBalance: number | undefined;

    for (const raw of this.rawLimits.values()) {
      planType ??= parsePlanType(raw.planType);
      creditsBalance ??= parseCreditsBalance(raw.credits);
      const limitId = readNonEmptyString(raw.limitId);
      const limitName = readNonEmptyString(raw.limitName);
      const primary = parseWindow(raw.primary, limitId, limitName);
      const secondary = parseWindow(raw.secondary, limitId, limitName);
      if (primary) {
        limits.push(primary);
      }
      if (secondary) {
        limits.push(secondary);
      }
    }

    return {
      fetchedAt: this.now(),
      planType,
      creditsBalance,
      limits: dedupeLimits(limits)
    };
  }

  private findExistingLimitKey(update: RawRecord, announcedKey: string): string | undefined {
    if (this.rawLimits.has(announcedKey)) {
      return announcedKey;
    }

    const updateId = readNonEmptyString(update.limitId);
    const updateName = readNonEmptyString(update.limitName);
    if (!updateId && !updateName && this.primaryLimitKey && this.rawLimits.has(this.primaryLimitKey)) {
      return this.primaryLimitKey;
    }
    for (const [key, current] of this.rawLimits) {
      if (
        (updateId && updateId === readNonEmptyString(current.limitId))
        || (updateName && updateName === readNonEmptyString(current.limitName))
      ) {
        return key;
      }
    }

    return this.rawLimits.size === 1
      ? this.rawLimits.keys().next().value as string | undefined
      : undefined;
  }
}

function parseWindow(value: unknown, limitId: string | undefined, limitName: string | undefined): CodexRateLimitWindow | undefined {
  const window = asRecord(value);
  const usedPercent = readFiniteNumber(window?.usedPercent);
  const windowMinutes = readFiniteNumber(window?.windowDurationMins);
  if (!window || usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) {
    return undefined;
  }
  const normalizedUsed = clamp(usedPercent, 0, 100);
  return {
    limitId,
    limitName,
    windowMinutes,
    usedPercent: normalizedUsed,
    remainingPercent: clamp(100 - normalizedUsed, 0, 100),
    resetAt: parseEpochMilliseconds(window.resetsAt)
  };
}

function parseTokenActivity(value: unknown, fetchedAt: number): AccountTokenActivitySnapshot {
  const response = asRecord(value);
  const summary = asRecord(response?.summary);
  if (!response || !summary) {
    throw new AppServerProtocolError('App-server returned an invalid account/usage/read response.');
  }
  const buckets = response.dailyUsageBuckets;
  if (buckets !== null && buckets !== undefined && !Array.isArray(buckets)) {
    throw new AppServerProtocolError('App-server returned invalid daily account usage buckets.');
  }

  return {
    fetchedAt,
    lifetimeTokens: parseTokenCount(summary.lifetimeTokens),
    peakDailyTokens: parseTokenCount(summary.peakDailyTokens),
    longestRunningTurnSeconds: parseTokenCount(summary.longestRunningTurnSec),
    currentStreakDays: parseTokenCount(summary.currentStreakDays),
    longestStreakDays: parseTokenCount(summary.longestStreakDays),
    dailyUsage: (buckets ?? []).flatMap((entry) => {
      const record = asRecord(entry);
      const startDate = readNonEmptyString(record?.startDate);
      const tokens = parseTokenCount(record?.tokens);
      return startDate && tokens !== undefined ? [{ startDate, tokens }] : [];
    })
  };
}

function parseTokenCount(value: unknown): TokenCount | undefined {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
  }
  return undefined;
}

function mergeSparseRecord(previous: RawRecord | undefined, update: RawRecord): RawRecord {
  if (!previous) {
    return { ...update };
  }
  const merged: RawRecord = { ...previous };
  for (const [key, value] of Object.entries(update)) {
    if (value === null || value === undefined) {
      continue;
    }
    const priorRecord = asRecord(previous[key]);
    const updateRecord = asRecord(value);
    merged[key] = priorRecord && updateRecord
      ? mergeSparseRecord(priorRecord, updateRecord)
      : value;
  }
  return merged;
}

function getLimitKey(value: RawRecord, fallback: string): string {
  return readNonEmptyString(value.limitId) ?? readNonEmptyString(value.limitName) ?? fallback;
}

function dedupeLimits(limits: CodexRateLimitWindow[]): CodexRateLimitWindow[] {
  const byKey = new Map<string, CodexRateLimitWindow>();
  for (const limit of limits) {
    const key = [limit.limitId ?? '', limit.limitName ?? '', limit.windowMinutes].join('\u0000');
    byKey.set(key, limit);
  }
  return [...byKey.values()];
}

function parseCreditsBalance(value: unknown): number | undefined {
  const credits = asRecord(value);
  const balance = credits?.balance;
  if (typeof balance === 'number' && Number.isFinite(balance)) {
    return balance;
  }
  if (typeof balance === 'string' && balance.trim()) {
    const parsed = Number(balance);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseEpochMilliseconds(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  if (number === undefined || number < 0) {
    return undefined;
  }
  return number < 10_000_000_000 ? number * 1000 : number;
}

function parsePlanType(value: unknown): ChatGptPlanType | undefined {
  switch (value) {
    case 'free':
    case 'go':
    case 'plus':
    case 'pro':
    case 'prolite':
    case 'team':
    case 'self_serve_business_usage_based':
    case 'business':
    case 'enterprise_cbp_usage_based':
    case 'enterprise':
    case 'edu':
    case 'unknown':
      return value;
    default:
      return undefined;
  }
}

function asRecord(value: unknown): RawRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RawRecord
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
