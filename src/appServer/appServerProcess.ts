import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_JSON_RPC_TIMEOUT_MS,
  DEFAULT_SERVER_REQUEST_TIMEOUT_MS,
  type Disposable,
  type JsonRpcDiagnosticEvent,
  type JsonRpcNotification,
  type JsonRpcRequestOptions,
  type JsonRpcServerRequestContext,
  JsonRpcProtocolError,
  JsonRpcResponseError,
  JsonRpcStdioClient,
  JsonRpcTransportError
} from './jsonRpcStdioClient';
import {
  createSanitizedAppServerEnvironment,
  defaultMcpIsolationStrategy,
  MCP_LIST_TIMEOUT_MS,
  MCP_SERVERS_EMPTY_OVERRIDE,
  type CodexRuntimeInfo,
  type McpIsolationStrategy,
  type PassiveMcpServerConfig,
  type RuntimeValidationOptions,
  type SpawnCommand,
  validateCodexRuntime
} from './runtime';
import { CodexCompatibilityError } from './types';

export const APP_SERVER_STARTUP_TIMEOUT_MS = 10_000;
export const APP_SERVER_SHUTDOWN_TIMEOUT_MS = 1_000;

export const APP_SERVER_ARGUMENTS = Object.freeze([
  '-c', 'web_search="disabled"',
  '-c', MCP_SERVERS_EMPTY_OVERRIDE,
  '-c', 'skills.config=[]',
  '-c', 'project_doc_max_bytes=0',
  '--disable', 'shell_tool',
  '--disable', 'unified_exec',
  '--disable', 'shell_snapshot',
  '--disable', 'apps',
  '--disable', 'browser_use',
  '--disable', 'browser_use_external',
  '--disable', 'computer_use',
  '--disable', 'image_generation',
  '--disable', 'in_app_browser',
  '--disable', 'code_mode_host',
  '--disable', 'multi_agent',
  '--disable', 'multi_agent_v2',
  '--disable', 'plugins',
  '--disable', 'plugin_sharing',
  '--disable', 'remote_plugin',
  '--disable', 'hooks',
  '--disable', 'goals',
  '--disable', 'memories',
  '--disable', 'workspace_dependencies',
  '--disable', 'skill_mcp_dependency_install',
  '--disable', 'tool_suggest',
  'app-server',
  '--stdio'
]);

export function buildAppServerArguments(mcpDisableArguments: readonly string[]): string[] {
  const subcommandIndex = APP_SERVER_ARGUMENTS.indexOf('app-server');
  return [
    ...APP_SERVER_ARGUMENTS.slice(0, subcommandIndex),
    ...mcpDisableArguments,
    ...APP_SERVER_ARGUMENTS.slice(subcommandIndex)
  ];
}

export type AppServerProcessState = 'idle' | 'starting' | 'ready' | 'stopping' | 'stopped';

export interface AppServerProcessOptions {
  readonly command: string | (() => string);
  readonly extensionVersion: string;
  /** Parent directory under extension global storage. */
  readonly storageDirectory: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly startupTimeoutMs?: number;
  readonly mcpIsolationTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly serverRequestTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly spawn?: SpawnCommand;
  readonly validateRuntime?: (
    command: string,
    options: RuntimeValidationOptions
  ) => Promise<CodexRuntimeInfo>;
  readonly mcpIsolationStrategy?: McpIsolationStrategy;
  readonly onDiagnostic?: (event: AppServerDiagnosticEvent) => void;
}

export interface AppServerExitEvent {
  readonly generation: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly duringStartup: boolean;
  readonly status: 'exit' | 'spawn-error' | 'protocol-error';
}

export interface AppServerDiagnosticEvent {
  readonly kind:
    | 'runtime-validated'
    | 'mcp-isolation-verified'
    | 'process-started'
    | 'process-ready'
    | 'process-exited'
    | 'process-stopped'
    | 'generation-changed'
    | 'json-rpc'
    | 'listener-failed';
  readonly generation?: number;
  readonly runtimeVersion?: string;
  readonly durationMs?: number;
  readonly status?: string;
  readonly method?: string;
  readonly stderrBytes?: number;
  readonly stderrLines?: number;
  readonly rpc?: JsonRpcDiagnosticEvent;
}

interface ProcessSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly passiveDirectory: string;
  readonly startedAt: number;
  readonly passiveMcpServers: Readonly<Record<string, PassiveMcpServerConfig>>;
  client?: JsonRpcStdioClient;
  stderrBytes: number;
  stderrLines: number;
  ready: boolean;
  intentional: boolean;
  reportedFailure: boolean;
  clientCloseTimer?: NodeJS.Timeout;
  stopFinalization?: Promise<void>;
}

export class AppServerProcess implements Disposable {
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: JsonRpcServerRequestContext) => void>();
  private readonly exitListeners = new Set<(event: AppServerExitEvent) => void>();
  private readonly generationListeners = new Set<(generation: number) => void>();
  private readonly startupTimeoutMs: number;
  private readonly mcpIsolationTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly serverRequestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly runtimeValidator: NonNullable<AppServerProcessOptions['validateRuntime']>;
  private stateValue: AppServerProcessState = 'idle';
  private generationValue = 0;
  private startPromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private session?: ProcessSession;
  private runtimeInfoValue?: CodexRuntimeInfo;
  private disposed = false;

  constructor(private readonly options: AppServerProcessOptions) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? APP_SERVER_STARTUP_TIMEOUT_MS;
    this.mcpIsolationTimeoutMs = options.mcpIsolationTimeoutMs ?? MCP_LIST_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_JSON_RPC_TIMEOUT_MS;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? APP_SERVER_SHUTDOWN_TIMEOUT_MS;
    this.runtimeValidator = options.validateRuntime ?? validateCodexRuntime;

    if (!options.extensionVersion.trim()) {
      throw new TypeError('The extension version is required to initialize app-server.');
    }
    if (!options.storageDirectory.trim()) {
      throw new TypeError('An extension-controlled storage directory is required.');
    }
    if (
      this.startupTimeoutMs <= 0
      || this.mcpIsolationTimeoutMs <= 0
      || this.requestTimeoutMs <= 0
      || this.serverRequestTimeoutMs <= 0
      || this.shutdownTimeoutMs <= 0
    ) {
      throw new RangeError('App-server lifecycle timeouts must be positive.');
    }
  }

  get state(): AppServerProcessState {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get runtimeInfo(): CodexRuntimeInfo | undefined {
    return this.runtimeInfoValue;
  }

  get passiveDirectory(): string | undefined {
    return this.session?.passiveDirectory;
  }

  get passiveMcpServers(): Readonly<Record<string, PassiveMcpServerConfig>> | undefined {
    return this.session?.passiveMcpServers;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): Disposable {
    this.notificationListeners.add(listener);
    return createDisposable(() => this.notificationListeners.delete(listener));
  }

  onServerRequest(listener: (request: JsonRpcServerRequestContext) => void): Disposable {
    this.serverRequestListeners.add(listener);
    return createDisposable(() => this.serverRequestListeners.delete(listener));
  }

  onDidExit(listener: (event: AppServerExitEvent) => void): Disposable {
    this.exitListeners.add(listener);
    return createDisposable(() => this.exitListeners.delete(listener));
  }

  onDidChangeGeneration(listener: (generation: number) => void): Disposable {
    this.generationListeners.add(listener);
    return createDisposable(() => this.generationListeners.delete(listener));
  }

  async ensureReady(): Promise<void> {
    if (this.disposed) {
      throw new JsonRpcTransportError('The app-server process manager has been disposed.');
    }
    const pendingShutdown = this.shutdownPromise;
    if (pendingShutdown) {
      await pendingShutdown;
      if (this.disposed) {
        throw new JsonRpcTransportError('The app-server process manager has been disposed.');
      }
    }
    if (this.stateValue === 'stopping') {
      throw new JsonRpcTransportError(
        'The previous Codex app-server process is still stopping. Terminate it before retrying.'
      );
    }
    if (this.stateValue === 'ready' && this.session?.client && !this.session.client.isClosed) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.stateValue = 'starting';
    const startPromise = this.start();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) {
        this.startPromise = undefined;
      }
    }
  }

  async request<TResult>(
    method: string,
    params?: unknown,
    options?: JsonRpcRequestOptions
  ): Promise<TResult> {
    await this.ensureReady();
    const client = this.session?.client;
    if (!client || client.isClosed) {
      throw new JsonRpcTransportError('The app-server process exited before the request could start.');
    }
    try {
      return await client.request<TResult>(method, params, options);
    } catch (error) {
      if (error instanceof JsonRpcResponseError && (error.code === -32601 || error.code === -32602)) {
        throw new CodexCompatibilityError(
          this.runtimeInfoValue?.version ?? 'unknown',
          method,
          error.code === -32601 ? 'method-not-found' : 'invalid-params',
          'The installed Codex app-server does not support this required operation.',
          { cause: error }
        );
      }
      throw error;
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureReady();
    const client = this.session?.client;
    if (!client || client.isClosed) {
      throw new JsonRpcTransportError('The app-server process exited before the notification could be sent.');
    }
    await client.notify(method, params);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    const task = this.stopCurrentSession();
    this.shutdownPromise = task;
    try {
      await task;
    } finally {
      if (this.shutdownPromise === task) {
        this.shutdownPromise = undefined;
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    void this.shutdown().catch(() => undefined);
    this.notificationListeners.clear();
    this.serverRequestListeners.clear();
    this.exitListeners.clear();
    this.generationListeners.clear();
  }

  private async start(): Promise<void> {
    const command = typeof this.options.command === 'function'
      ? this.options.command()
      : this.options.command;
    let passiveDirectory: string;
    try {
      await mkdir(this.options.storageDirectory, { recursive: true });
      passiveDirectory = await mkdtemp(join(this.options.storageDirectory, 'app-server-passive-'));
    } catch (error) {
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      throw new JsonRpcTransportError('The passive app-server directory could not be created.', {
        cause: error
      });
    }

    const runtimeStartedAt = Date.now();
    let runtimeInfo: CodexRuntimeInfo;
    try {
      runtimeInfo = await this.runtimeValidator(command, {
        timeoutMs: this.startupTimeoutMs,
        env: this.options.env,
        cwd: passiveDirectory,
        spawn: this.options.spawn
      });
    } catch (error) {
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      await removeEmptyPassiveDirectory(passiveDirectory);
      throw error;
    }
    this.runtimeInfoValue = runtimeInfo;
    this.emitDiagnostic({
      kind: 'runtime-validated',
      runtimeVersion: runtimeInfo.version,
      durationMs: elapsed(runtimeStartedAt),
      status: 'ok'
    });
    let mcpDisableArguments: readonly string[];
    let passiveMcpServers: Readonly<Record<string, PassiveMcpServerConfig>>;
    try {
      const isolation = await (this.options.mcpIsolationStrategy ?? defaultMcpIsolationStrategy).prepare(runtimeInfo.command, {
        timeoutMs: this.mcpIsolationTimeoutMs,
        env: this.options.env,
        cwd: passiveDirectory,
        spawn: this.options.spawn
      });
      mcpDisableArguments = isolation.disableArguments;
      passiveMcpServers = isolation.passiveMcpServers;
    } catch (error) {
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      await removeEmptyPassiveDirectory(passiveDirectory);
      throw error;
    }
    this.emitDiagnostic({
      kind: 'mcp-isolation-verified',
      runtimeVersion: runtimeInfo.version,
      status: 'disabled'
    });
    const spawn = this.options.spawn ?? loadCrossSpawn();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(runtimeInfo.command, buildAppServerArguments(mcpDisableArguments), {
        cwd: passiveDirectory,
        env: createSanitizedAppServerEnvironment(this.options.env),
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      this.stateValue = 'idle';
      await removeEmptyPassiveDirectory(passiveDirectory);
      throw new JsonRpcTransportError('The Codex app-server process could not be started.', {
        cause: error
      });
    }

    const session: ProcessSession = {
      child,
      passiveDirectory,
      startedAt: Date.now(),
      passiveMcpServers,
      stderrBytes: 0,
      stderrLines: 0,
      ready: false,
      intentional: false,
      reportedFailure: false
    };
    this.session = session;
    this.attachProcessLifecycle(session);
    child.stderr.on('data', (chunk: Buffer | string) => {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      session.stderrBytes += value.byteLength;
      for (const byte of value) {
        if (byte === 0x0a) {
          session.stderrLines += 1;
        }
      }
    });
    child.stderr.resume();

    try {
      const startupDeadline = Date.now() + this.startupTimeoutMs;
      await waitForSpawn(child, this.startupTimeoutMs);
      this.emitDiagnostic({ kind: 'process-started', durationMs: elapsed(session.startedAt), status: 'spawned' });

      const client = new JsonRpcStdioClient(child.stdout, child.stdin, {
        requestTimeoutMs: this.requestTimeoutMs,
        serverRequestTimeoutMs: this.serverRequestTimeoutMs,
        onDiagnostic: (rpc) => this.emitDiagnostic({
          kind: 'json-rpc',
          method: rpc.method,
          durationMs: rpc.durationMs,
          status: rpc.status,
          rpc
        })
      });
      session.client = client;
      client.onNotification((notification) => this.forwardNotification(notification));
      client.onServerRequest((request) => this.forwardServerRequest(request));
      client.onDidClose((error) => this.deferClientFailure(session, error));

      let initializeResult: unknown;
      try {
        initializeResult = await client.request<unknown>('initialize', {
          clientInfo: {
            name: 'vscodex',
            title: 'vsCodex',
            version: this.options.extensionVersion
          },
          capabilities: {
            experimentalApi: true
          }
        }, { timeoutMs: remainingMilliseconds(startupDeadline) });
      } catch (error) {
        if (error instanceof JsonRpcResponseError && (error.code === -32601 || error.code === -32602)) {
          throw new CodexCompatibilityError(
            runtimeInfo.version,
            'initialize',
            error.code === -32601 ? 'method-not-found' : 'invalid-params',
            'The installed Codex app-server cannot initialize the passive provider.',
            { cause: error }
          );
        }
        throw error;
      }
      assertInitializeResponse(initializeResult, runtimeInfo.version);
      await withTimeout(
        client.notify('initialized'),
        remainingMilliseconds(startupDeadline),
        'Timed out while acknowledging Codex app-server initialization.'
      );

      if (session.reportedFailure || client.isClosed || this.session !== session) {
        throw new JsonRpcTransportError('The Codex app-server process exited during initialization.');
      }

      session.ready = true;
      this.stateValue = 'ready';
      this.bumpGeneration();
      this.emitDiagnostic({
        kind: 'process-ready',
        generation: this.generationValue,
        runtimeVersion: runtimeInfo.version,
        durationMs: elapsed(session.startedAt),
        stderrBytes: session.stderrBytes,
        stderrLines: session.stderrLines,
        status: 'ready'
      });
    } catch (error) {
      if (!session.reportedFailure) {
        this.reportFailure(session, null, null, classifyStartupFailure(error));
      }
      session.child.kill();
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      throw error;
    }
  }

  private attachProcessLifecycle(session: ProcessSession): void {
    session.child.once('error', () => {
      this.reportFailure(session, null, null, 'spawn-error');
    });
    session.child.once('exit', (code, signal) => {
      if (session.clientCloseTimer) {
        clearTimeout(session.clientCloseTimer);
      }
      if (session.intentional) {
        session.client?.close(new JsonRpcTransportError('The app-server process was stopped.'));
        void this.finalizeStoppedSession(session);
        return;
      }
      this.reportFailure(session, code, signal, 'exit');
    });
  }

  private deferClientFailure(session: ProcessSession, error: Error): void {
    if (session.intentional || session.reportedFailure || session.clientCloseTimer) {
      return;
    }
    session.clientCloseTimer = setTimeout(() => {
      session.clientCloseTimer = undefined;
      if (session.intentional || session.reportedFailure) {
        return;
      }
      this.reportFailure(session, null, null, 'protocol-error');
      session.child.kill();
    }, 25);
    session.clientCloseTimer.unref?.();
    void error;
  }

  private reportFailure(
    session: ProcessSession,
    code: number | null,
    signal: NodeJS.Signals | null,
    status: AppServerExitEvent['status']
  ): void {
    if (session.reportedFailure || session.intentional) {
      return;
    }
    session.reportedFailure = true;
    if (session.clientCloseTimer) {
      clearTimeout(session.clientCloseTimer);
      session.clientCloseTimer = undefined;
    }
    session.client?.close(new JsonRpcTransportError('The Codex app-server process exited unexpectedly.'));

    if (this.session === session) {
      this.session = undefined;
      this.stateValue = this.disposed ? 'stopped' : 'idle';
    }

    if (session.ready) {
      this.bumpGeneration();
    }

    const event: AppServerExitEvent = {
      generation: this.generationValue,
      code,
      signal,
      duringStartup: !session.ready,
      status
    };
    this.emitDiagnostic({
      kind: 'process-exited',
      generation: this.generationValue,
      durationMs: elapsed(session.startedAt),
      stderrBytes: session.stderrBytes,
      stderrLines: session.stderrLines,
      status
    });
    for (const listener of [...this.exitListeners]) {
      safelyInvoke(listener, event, () => this.emitDiagnostic({ kind: 'listener-failed', status: 'exit' }));
    }
    void removeEmptyPassiveDirectory(session.passiveDirectory);
  }

  private async stopCurrentSession(): Promise<void> {
    const pendingStart = this.startPromise;
    if (pendingStart) {
      try {
        await pendingStart;
      } catch {
        // A failed start already cleaned up its process session.
      }
    }

    const session = this.session;
    if (!session) {
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      return;
    }

    session.intentional = true;
    this.stateValue = 'stopping';
    if (session.clientCloseTimer) {
      clearTimeout(session.clientCloseTimer);
      session.clientCloseTimer = undefined;
    }
    session.client?.close(new JsonRpcTransportError('The app-server process was stopped.'));

    const exited = waitForExit(session.child);
    if (!session.child.stdin.destroyed) {
      session.child.stdin.end();
    }

    const didExit = await Promise.race([
      exited.then(() => true),
      delay(this.shutdownTimeoutMs).then(() => false)
    ]);
    if (!didExit) {
      session.child.kill();
      const didExitAfterKill = await Promise.race([
        exited.then(() => true),
        delay(this.shutdownTimeoutMs).then(() => false)
      ]);
      if (!didExitAfterKill) {
        throw new JsonRpcTransportError(
          'Codex app-server did not exit after graceful shutdown and a kill request. Terminate the process before retrying.'
        );
      }
    }

    await this.finalizeStoppedSession(session);
  }

  private finalizeStoppedSession(session: ProcessSession): Promise<void> {
    if (session.stopFinalization) {
      return session.stopFinalization;
    }

    const finalization = (async () => {
      if (this.session === session) {
        this.session = undefined;
      }
      this.stateValue = this.disposed ? 'stopped' : 'idle';
      if (session.ready) {
        this.bumpGeneration();
      }
      this.emitDiagnostic({
        kind: 'process-stopped',
        generation: this.generationValue,
        durationMs: elapsed(session.startedAt),
        stderrBytes: session.stderrBytes,
        stderrLines: session.stderrLines,
        status: 'stopped'
      });
      await removeEmptyPassiveDirectory(session.passiveDirectory);
    })();
    session.stopFinalization = finalization;
    return finalization;
  }

  private forwardNotification(notification: JsonRpcNotification): void {
    for (const listener of [...this.notificationListeners]) {
      safelyInvoke(listener, notification, () => this.emitDiagnostic({
        kind: 'listener-failed',
        method: notification.method,
        status: 'notification'
      }));
    }
  }

  private forwardServerRequest(request: JsonRpcServerRequestContext): void {
    if (this.serverRequestListeners.size === 0) {
      void request.reject({
        code: -32601,
        message: 'The client does not handle this server request.'
      }).catch(() => undefined);
      return;
    }

    for (const listener of [...this.serverRequestListeners]) {
      safelyInvoke(listener, request, () => {
        this.emitDiagnostic({
          kind: 'listener-failed',
          method: request.method,
          status: 'server-request'
        });
        if (!request.settled) {
          void request.reject({
            code: -32603,
            message: 'The client failed to handle this server request.'
          }).catch(() => undefined);
        }
      });
    }
  }

  private bumpGeneration(): void {
    this.generationValue += 1;
    this.emitDiagnostic({
      kind: 'generation-changed',
      generation: this.generationValue,
      status: 'changed'
    });
    for (const listener of [...this.generationListeners]) {
      safelyInvoke(listener, this.generationValue, () => this.emitDiagnostic({
        kind: 'listener-failed',
        status: 'generation'
      }));
    }
  }

  private emitDiagnostic(event: AppServerDiagnosticEvent): void {
    if (!this.options.onDiagnostic) {
      return;
    }
    safelyInvoke(this.options.onDiagnostic, event, () => undefined);
  }
}

function loadCrossSpawn(): SpawnCommand {
  const imported = require('cross-spawn') as SpawnCommand | { default: SpawnCommand };
  return typeof imported === 'function' ? imported : imported.default;
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<void> {
  if (child.pid !== undefined) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', handleSpawn);
      child.removeListener('error', handleError);
      child.removeListener('exit', handleExit);
      callback();
    };
    const handleSpawn = (): void => finish(resolve);
    const handleError = (error: Error): void => finish(() => reject(new JsonRpcTransportError(
      'The Codex app-server process could not be started.',
      { cause: error }
    )));
    const handleExit = (): void => finish(() => reject(new JsonRpcTransportError(
      'The Codex app-server process exited before initialization.'
    )));
    const timer = setTimeout(() => finish(() => reject(new JsonRpcTransportError(
      `Timed out while starting Codex app-server after ${timeoutMs} ms.`
    ))), timeoutMs);

    child.once('spawn', handleSpawn);
    child.once('error', handleError);
    child.once('exit', handleExit);
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

function assertInitializeResponse(value: unknown, runtimeVersion: string): void {
  if (
    !isRecord(value)
    || typeof value.userAgent !== 'string'
    || typeof value.platformFamily !== 'string'
    || typeof value.platformOs !== 'string'
    || typeof value.codexHome !== 'string'
  ) {
    throw new CodexCompatibilityError(
      runtimeVersion,
      'initialize',
      'malformed-required-response',
      'Codex app-server returned an invalid initialize response.'
    );
  }
}

function classifyStartupFailure(error: unknown): AppServerExitEvent['status'] {
  return error instanceof JsonRpcProtocolError || error instanceof CodexCompatibilityError
    ? 'protocol-error'
    : 'spawn-error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function createDisposable(dispose: () => void): Disposable {
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      dispose();
    }
  };
}

function safelyInvoke<T>(
  listener: (value: T) => void | Promise<void>,
  value: T,
  onError: () => void
): void {
  try {
    const result = listener(value);
    if (result && typeof result.then === 'function') {
      void result.catch(onError);
    }
  } catch {
    onError();
  }
}

async function removeEmptyPassiveDirectory(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch {
    // Never recursively remove runtime state. A non-empty directory is left in
    // global storage for the user or extension cleanup to inspect safely.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function remainingMilliseconds(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JsonRpcTransportError(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
