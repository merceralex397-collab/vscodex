export interface DisposableLike {
  dispose(): void;
}

export type EventLike<T> = (listener: (event: T) => void) => DisposableLike;

export class TypedEventEmitter<T> implements DisposableLike {
  private readonly listeners = new Set<(event: T) => void>();

  readonly event: EventLike<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: () => this.listeners.delete(listener)
    };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) {
      listener(event);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Narrow process-independent surface used by app-server domain adapters.
 * The stdio client owns framing and request IDs; adapters only name methods.
 */
export interface AppServerRpcClient {
  readonly onNotification: EventLike<RpcNotification>;
  request<T>(method: string, params?: unknown, options?: RpcRequestOptions): Promise<T>;
}

export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?(listener: () => void): DisposableLike;
}

export type ChatGptPlanType =
  | 'free'
  | 'go'
  | 'plus'
  | 'pro'
  | 'prolite'
  | 'team'
  | 'self_serve_business_usage_based'
  | 'business'
  | 'enterprise_cbp_usage_based'
  | 'enterprise'
  | 'edu'
  | 'unknown';

export interface AccountSnapshot {
  type: 'chatgpt';
  planType: ChatGptPlanType;
}

export type LoginChallenge = BrowserLoginChallenge | DeviceCodeLoginChallenge;

interface LoginChallengeBase {
  loginId: string;
  completion: Promise<AccountSnapshot>;
}

export interface BrowserLoginChallenge extends LoginChallengeBase {
  kind: 'browser';
  authUrl: string;
}

export interface DeviceCodeLoginChallenge extends LoginChallengeBase {
  kind: 'deviceCode';
  verificationUrl: string;
  userCode: string;
}

export interface AccountChangeEvent {
  generation: number;
  authMode?: string | null;
  planType?: ChatGptPlanType;
}

export interface BackendReasoningEffort {
  effort: string;
  description: string;
}

export interface BackendServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface BackendModel {
  /** Catalog identity shown to VS Code. */
  id: string;
  /** Model value supplied to thread/start. */
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
  contextWindow?: number;
  /** Stable hash of the catalog fields that affect provider metadata. */
  catalogHash: string;
}

export interface ModelContextWindowUpdate {
  model: string;
  contextWindow: number;
}

export interface CodexRateLimitWindow {
  limitId?: string;
  limitName?: string;
  windowMinutes: number;
  usedPercent: number;
  remainingPercent: number;
  /** Unix epoch time in milliseconds. */
  resetAt?: number;
}

export interface CodexAccountUsageSnapshot {
  fetchedAt: number;
  planType?: ChatGptPlanType;
  creditsBalance?: number;
  limits: CodexRateLimitWindow[];
}

export type TokenCount = number | bigint;

export interface AccountTokenActivitySnapshot {
  fetchedAt: number;
  lifetimeTokens?: TokenCount;
  peakDailyTokens?: TokenCount;
  longestRunningTurnSeconds?: TokenCount;
  currentStreakDays?: TokenCount;
  longestStreakDays?: TokenCount;
  dailyUsage: Array<{
    startDate: string;
    tokens: TokenCount;
  }>;
}

export interface AccountUsageUpdateEvent {
  source: 'read' | 'notification';
  snapshot: CodexAccountUsageSnapshot;
}

export type CodexCompatibilityFailureCategory =
  | 'method-not-found'
  | 'invalid-params'
  | 'malformed-required-response';

export class CodexCompatibilityError extends Error {
  constructor(
    readonly cliVersion: string,
    readonly methodOrEvent: string,
    readonly category: CodexCompatibilityFailureCategory,
    message: string,
    options?: ErrorOptions
  ) {
    super(
      `${message} Codex CLI ${cliVersion}; app-server operation ${methodOrEvent}; category ${category}.`,
      options
    );
    this.name = 'CodexCompatibilityError';
  }
}

/** Compatibility alias retained internally while validators migrate by method. */
export class AppServerProtocolError extends CodexCompatibilityError {
  constructor(
    message: string,
    methodOrEvent = 'unknown',
    cliVersion = 'unknown',
    options?: ErrorOptions
  ) {
    super(cliVersion, methodOrEvent, 'malformed-required-response', message, options);
    this.name = 'AppServerProtocolError';
  }
}

export class ChatGptAccountRequiredError extends Error {
  constructor(message = 'Sign in with ChatGPT to use vsCodex.') {
    super(message);
    this.name = 'ChatGptAccountRequiredError';
  }
}

export class LoginCancelledError extends Error {
  constructor(message = 'ChatGPT sign-in was cancelled.') {
    super(message);
    this.name = 'LoginCancelledError';
  }
}

export class LoginTimeoutError extends Error {
  constructor() {
    super('ChatGPT sign-in timed out. Start sign-in again to retry.');
    this.name = 'LoginTimeoutError';
  }
}

export class OperationCancelledError extends Error {
  constructor() {
    super('The operation was cancelled.');
    this.name = 'OperationCancelledError';
  }
}
