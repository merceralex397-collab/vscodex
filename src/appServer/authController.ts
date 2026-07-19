import {
  AccountChangeEvent,
  AccountSnapshot,
  AppServerProtocolError,
  AppServerRpcClient,
  BrowserLoginChallenge,
  ChatGptAccountRequiredError,
  ChatGptPlanType,
  DeviceCodeLoginChallenge,
  DisposableLike,
  EventLike,
  LoginCancelledError,
  LoginChallenge,
  LoginTimeoutError,
  RpcNotification,
  TypedEventEmitter
} from './types';

const DEFAULT_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RPC_TIMEOUT_MS = 30 * 1000;
const MAX_EARLY_COMPLETIONS = 64;
const INVALID_AUTH_MODE = '__invalid_auth_mode__';

type AnnouncedAuthMode = string | null | undefined;

interface AccountUpdate {
  authMode: string | null;
  planType?: ChatGptPlanType;
}

interface AuthStatus {
  authMode: string | null;
}

class AccountStateChangedDuringReadError extends AppServerProtocolError {}

interface PendingLogin {
  resolve(account: AccountSnapshot): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface LoginCompletion {
  loginId: string | null;
  success: boolean;
  error: string | null;
}

export interface AuthControllerOptions {
  loginTimeoutMs?: number;
  rpcTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/** Owns app-server-managed ChatGPT account state without handling credentials. */
export class AuthController implements DisposableLike {
  private readonly accountEmitter = new TypedEventEmitter<AccountChangeEvent>();
  private readonly notificationSubscription: DisposableLike;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private readonly earlyCompletions = new Map<string, LoginCompletion>();
  private readonly loginTimeoutMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private cachedAccount: AccountSnapshot | undefined;
  /** Undefined until app-server has announced its current mode. */
  private announcedAuthMode: AnnouncedAuthMode;
  private suppressNextSignedOutUpdate = false;
  private disposed = false;
  private accountGeneration = 0;

  readonly onDidChangeAccount: EventLike<AccountChangeEvent> = this.accountEmitter.event;

  constructor(
    private readonly rpc: AppServerRpcClient,
    options: AuthControllerOptions = {}
  ) {
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.notificationSubscription = rpc.onNotification((notification) => this.handleNotification(notification));
  }

  get generation(): number {
    return this.accountGeneration;
  }

  get account(): AccountSnapshot | undefined {
    return this.cachedAccount;
  }

  async readAccount(refreshToken = false): Promise<AccountSnapshot | undefined> {
    this.assertNotDisposed();
    const generation = this.accountGeneration;
    await this.ensureAuthModeKnown(generation);
    assertSupportedAuthMode(this.announcedAuthMode);
    const response = await this.rpc.request<unknown>(
      'account/read',
      { refreshToken },
      { timeoutMs: this.rpcTimeoutMs }
    );
    try {
      const account = parseAccountResponse(response, this.announcedAuthMode);
      if (generation !== this.accountGeneration) {
        throw new AccountStateChangedDuringReadError('The Codex account changed while account status was being read.');
      }
      this.cachedAccount = account;
      return account;
    } catch (error) {
      this.cachedAccount = undefined;
      throw error;
    }
  }

  async beginLogin(kind: 'browser' | 'deviceCode'): Promise<LoginChallenge> {
    this.assertNotDisposed();
    this.suppressNextSignedOutUpdate = false;
    const params = kind === 'browser'
      ? {
          type: 'chatgpt',
          useHostedLoginSuccessPage: true,
          appBrand: 'chatgpt'
        }
      : { type: 'chatgptDeviceCode' };
    const response = await this.rpc.request<unknown>(
      'account/login/start',
      params,
      { timeoutMs: this.rpcTimeoutMs }
    );

    const parsed = parseLoginResponse(response, kind);
    let resolveCompletion!: (account: AccountSnapshot) => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<AccountSnapshot>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    // Login can fail before command UI attaches a completion handler.
    void completion.catch(() => undefined);

    const timer = this.setTimer(() => {
      const pending = this.pendingLogins.get(parsed.loginId);
      if (!pending) {
        return;
      }
      this.pendingLogins.delete(parsed.loginId);
      pending.reject(new LoginTimeoutError());
      void this.rpc.request(
        'account/login/cancel',
        { loginId: parsed.loginId },
        { timeoutMs: this.rpcTimeoutMs }
      ).catch(() => undefined);
    }, this.loginTimeoutMs);

    this.pendingLogins.set(parsed.loginId, {
      resolve: resolveCompletion,
      reject: rejectCompletion,
      timer
    });

    const earlyCompletion = this.earlyCompletions.get(parsed.loginId);
    if (earlyCompletion) {
      this.earlyCompletions.delete(parsed.loginId);
      void this.completeLogin(earlyCompletion);
    }

    if (kind === 'browser') {
      const challenge: BrowserLoginChallenge = {
        kind,
        loginId: parsed.loginId,
        authUrl: parsed.url,
        completion
      };
      return challenge;
    }

    const challenge: DeviceCodeLoginChallenge = {
      kind,
      loginId: parsed.loginId,
      verificationUrl: parsed.url,
      userCode: parsed.userCode,
      completion
    };
    return challenge;
  }

  async cancelLogin(loginId: string): Promise<void> {
    this.assertNotDisposed();
    try {
      await this.rpc.request(
        'account/login/cancel',
        { loginId },
        { timeoutMs: this.rpcTimeoutMs }
      );
    } finally {
      const pending = this.takePendingLogin(loginId);
      pending?.reject(new LoginCancelledError());
    }
  }

  async logout(): Promise<void> {
    this.assertNotDisposed();
    const generation = this.accountGeneration;
    await this.rpc.request('account/logout', undefined, { timeoutMs: this.rpcTimeoutMs });
    this.cachedAccount = undefined;
    const receivedSignedOutUpdate = generation !== this.accountGeneration
      && this.announcedAuthMode === null;
    this.announcedAuthMode = null;
    if (!receivedSignedOutUpdate) {
      // Some app-server builds omit account/updated after logout. Emit the
      // invalidation ourselves, then suppress a late equivalent notification.
      this.suppressNextSignedOutUpdate = true;
      this.invalidateAccount(null, undefined);
    }
  }

  /**
   * Clears all process-bound authentication state without contacting the new
   * process. Returns true when an account generation was invalidated.
   */
  invalidateProcess(): boolean {
    this.assertNotDisposed();
    const hadProcessBoundState = this.cachedAccount !== undefined
      || this.announcedAuthMode !== undefined
      || this.suppressNextSignedOutUpdate
      || this.pendingLogins.size > 0
      || this.earlyCompletions.size > 0;

    this.cachedAccount = undefined;
    this.announcedAuthMode = undefined;
    this.suppressNextSignedOutUpdate = false;
    for (const [loginId] of this.pendingLogins) {
      const pending = this.takePendingLogin(loginId);
      pending?.reject(new LoginCancelledError(
        'ChatGPT sign-in was interrupted because the Codex app-server process changed. Start sign-in again.'
      ));
    }
    this.earlyCompletions.clear();

    if (hadProcessBoundState) {
      // The backend already owns process-change fan-out. Increment the auth
      // generation here without firing an account notification that could
      // eagerly launch a replacement process through a usage refresh.
      this.accountGeneration += 1;
    }
    return hadProcessBoundState;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.notificationSubscription.dispose();
    for (const [loginId] of this.pendingLogins) {
      const pending = this.takePendingLogin(loginId);
      pending?.reject(new LoginCancelledError());
    }
    this.earlyCompletions.clear();
    this.accountEmitter.dispose();
  }

  private handleNotification(notification: RpcNotification): void {
    if (notification.method === 'account/login/completed') {
      const completion = parseLoginCompletion(notification.params);
      if (!completion?.loginId) {
        return;
      }
      if (this.pendingLogins.has(completion.loginId)) {
        void this.completeLogin(completion);
      } else {
        this.storeEarlyCompletion(completion);
      }
      return;
    }

    if (notification.method === 'account/updated') {
      const update = parseAccountUpdate(notification.params);
      if (this.suppressNextSignedOutUpdate && update?.authMode === null) {
        this.suppressNextSignedOutUpdate = false;
        this.cachedAccount = undefined;
        this.announcedAuthMode = null;
        return;
      }
      this.suppressNextSignedOutUpdate = false;
      this.announcedAuthMode = update ? update.authMode : INVALID_AUTH_MODE;
      this.cachedAccount = undefined;
      this.invalidateAccount(update?.authMode, update?.planType);
    }
  }

  private async completeLogin(completion: LoginCompletion): Promise<void> {
    if (!completion.loginId) {
      return;
    }
    const pending = this.takePendingLogin(completion.loginId);
    if (!pending) {
      return;
    }

    if (!completion.success) {
      pending.reject(new Error(formatLoginFailure(completion.error)));
      return;
    }

    try {
      // A successful extension-owned browser/device flow establishes the only
      // authentication mode this provider accepts. The corresponding account
      // update may arrive after login/completed, so do not retain a previously
      // announced unsupported mode while validating the completed login.
      this.announcedAuthMode = 'chatgpt';
      const account = await this.readAccountAfterLogin();
      if (!account) {
        throw new ChatGptAccountRequiredError('ChatGPT sign-in completed, but app-server did not return a ChatGPT account.');
      }
      pending.resolve(account);
    } catch (error) {
      pending.reject(toError(error));
    }
  }

  private takePendingLogin(loginId: string): PendingLogin | undefined {
    const pending = this.pendingLogins.get(loginId);
    if (pending) {
      this.pendingLogins.delete(loginId);
      this.clearTimer(pending.timer);
    }
    return pending;
  }

  private async readAccountAfterLogin(): Promise<AccountSnapshot | undefined> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.readAccount(false);
      } catch (error) {
        if (!(error instanceof AccountStateChangedDuringReadError)
          || this.announcedAuthMode !== 'chatgpt'
          || attempt > 0) {
          throw error;
        }
      }
    }
    return undefined;
  }

  private async ensureAuthModeKnown(generation: number): Promise<void> {
    if (this.announcedAuthMode !== undefined) {
      return;
    }
    const response = await this.rpc.request<unknown>(
      'getAuthStatus',
      { includeToken: false, refreshToken: false },
      { timeoutMs: this.rpcTimeoutMs }
    );
    const status = parseAuthStatus(response);
    if (generation === this.accountGeneration && this.announcedAuthMode === undefined) {
      this.announcedAuthMode = status.authMode;
    }
  }

  private storeEarlyCompletion(completion: LoginCompletion): void {
    if (!completion.loginId) {
      return;
    }
    this.earlyCompletions.set(completion.loginId, completion);
    while (this.earlyCompletions.size > MAX_EARLY_COMPLETIONS) {
      const first = this.earlyCompletions.keys().next().value as string | undefined;
      if (!first) {
        break;
      }
      this.earlyCompletions.delete(first);
    }
  }

  private invalidateAccount(authMode: string | null | undefined, planType: ChatGptPlanType | undefined): void {
    this.accountGeneration += 1;
    this.accountEmitter.fire({
      generation: this.accountGeneration,
      authMode,
      planType
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Auth controller is disposed.');
    }
  }
}

function parseAccountResponse(value: unknown, announcedAuthMode: AnnouncedAuthMode): AccountSnapshot | undefined {
  const response = asRecord(value);
  const account = asRecord(response?.account);
  assertSupportedAuthMode(announcedAuthMode);
  if (!account) {
    return undefined;
  }
  if (announcedAuthMode === null || account.type !== 'chatgpt') {
    throw new ChatGptAccountRequiredError();
  }

  return {
    type: 'chatgpt',
    planType: parsePlanType(account.planType) ?? 'unknown'
  };
}

function assertSupportedAuthMode(authMode: AnnouncedAuthMode): void {
  if (authMode !== undefined && authMode !== null && authMode !== 'chatgpt') {
    throw new ChatGptAccountRequiredError(
      'Codex app-server is using an unsupported authentication mode. Sign in with ChatGPT to use this provider.'
    );
  }
}

function parseLoginResponse(value: unknown, expectedKind: 'browser' | 'deviceCode'): {
  loginId: string;
  url: string;
  userCode: string;
} {
  const response = asRecord(value);
  const expectedType = expectedKind === 'browser' ? 'chatgpt' : 'chatgptDeviceCode';
  if (!response || response.type !== expectedType) {
    throw new AppServerProtocolError(`App-server returned an unexpected ${expectedKind} login response.`);
  }
  const loginId = readNonEmptyString(response.loginId);
  const url = readNonEmptyString(expectedKind === 'browser' ? response.authUrl : response.verificationUrl);
  const userCode = expectedKind === 'deviceCode' ? readNonEmptyString(response.userCode) : '';
  if (!loginId || !url || (expectedKind === 'deviceCode' && !userCode)) {
    throw new AppServerProtocolError(`App-server returned an incomplete ${expectedKind} login response.`);
  }
  return { loginId, url, userCode: userCode ?? '' };
}

function parseLoginCompletion(value: unknown): LoginCompletion | undefined {
  const record = asRecord(value);
  if (!record || typeof record.success !== 'boolean') {
    return undefined;
  }
  return {
    loginId: readNonEmptyString(record.loginId) ?? null,
    success: record.success,
    error: typeof record.error === 'string' ? record.error : null
  };
}

function parseAccountUpdate(value: unknown): AccountUpdate | undefined {
  const record = asRecord(value);
  if (!record || !('authMode' in record)) {
    return undefined;
  }
  const authMode = record.authMode;
  if (authMode !== null && !isKnownAuthMode(authMode)) {
    return undefined;
  }
  return {
    authMode,
    planType: parsePlanType(record.planType)
  };
}

function parseAuthStatus(value: unknown): AuthStatus {
  const record = asRecord(value);
  if (!record || !('authMethod' in record)) {
    throw new AppServerProtocolError('App-server returned an invalid token-free authentication status response.');
  }
  if (record.authToken !== null) {
    throw new AppServerProtocolError('App-server unexpectedly returned credential material for a token-free authentication status request.');
  }
  const authMode = record.authMethod;
  if (authMode !== null && !isKnownAuthMode(authMode)) {
    throw new AppServerProtocolError('App-server returned an unknown authentication mode.');
  }
  return { authMode };
}

function isKnownAuthMode(value: unknown): value is string {
  switch (value) {
    case 'apikey':
    case 'chatgpt':
    case 'chatgptAuthTokens':
    case 'headers':
    case 'agentIdentity':
    case 'personalAccessToken':
    case 'bedrockApiKey':
      return true;
    default:
      return false;
  }
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

function formatLoginFailure(value: string | null): string {
  const sanitized = value
    ?.replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted account]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[redacted path]')
    .trim()
    .slice(0, 240);
  return sanitized ? `ChatGPT sign-in failed: ${sanitized}` : 'ChatGPT sign-in failed.';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('ChatGPT sign-in failed.');
}
