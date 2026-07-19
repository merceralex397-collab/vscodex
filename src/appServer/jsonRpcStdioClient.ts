import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export const DEFAULT_JSON_RPC_TIMEOUT_MS = 30_000;
export const DEFAULT_SERVER_REQUEST_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_MAXIMUM_JSONL_FRAME_BYTES = 16 * 1024 * 1024;

export type JsonRpcId = number | string;

export interface Disposable {
  dispose(): void;
}

export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface JsonRpcStdioClientOptions {
  readonly requestTimeoutMs?: number;
  readonly serverRequestTimeoutMs?: number;
  readonly maximumFrameBytes?: number;
  readonly onDiagnostic?: (event: JsonRpcDiagnosticEvent) => void;
}

export interface JsonRpcDiagnosticEvent {
  readonly kind:
    | 'request-completed'
    | 'request-failed'
    | 'request-timeout'
    | 'notification'
    | 'server-request'
    | 'server-request-completed'
    | 'server-request-timeout'
    | 'listener-failed'
    | 'transport-closed';
  readonly method?: string;
  readonly durationMs?: number;
  readonly status?: string;
}

export interface JsonRpcServerRequestContext {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
  readonly signal: AbortSignal;
  readonly settled: boolean;

  respond(result?: unknown): Promise<void>;
  reject(error: JsonRpcErrorObject): Promise<void>;
}

interface PendingClientRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly startedAt: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup?: () => void;
}

interface WireMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export class JsonRpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
    this.name = 'JsonRpcResponseError';
  }
}

export class JsonRpcTimeoutError extends Error {
  constructor(readonly method: string, readonly timeoutMs: number) {
    super(`JSON-RPC request ${method} timed out after ${timeoutMs} ms.`);
    this.name = 'JsonRpcTimeoutError';
  }
}

export class JsonRpcRequestCancelledError extends Error {
  constructor(readonly method: string) {
    super(`JSON-RPC request ${method} was cancelled.`);
    this.name = 'JsonRpcRequestCancelledError';
  }
}

export class JsonRpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonRpcProtocolError';
  }
}

export class JsonRpcTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JsonRpcTransportError';
  }
}

export class JsonRpcStdioClient implements Disposable {
  private readonly decoder = new StringDecoder('utf8');
  private readonly pendingRequests = new Map<string, PendingClientRequest>();
  private readonly pendingServerRequests = new Map<string, DeferredServerRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void | Promise<void>>();
  private readonly serverRequestListeners = new Set<(request: JsonRpcServerRequestContext) => void | Promise<void>>();
  private readonly closeListeners = new Set<(error: Error) => void | Promise<void>>();
  private readonly ignoredResponseIds = new Set<string>();
  private readonly ignoredResponseIdOrder: string[] = [];
  private readonly activeWriteRejectors = new Set<(error: Error) => void>();
  private readonly requestTimeoutMs: number;
  private readonly serverRequestTimeoutMs: number;
  private readonly maximumFrameBytes: number;
  private readonly onDiagnostic?: (event: JsonRpcDiagnosticEvent) => void;
  private inputBuffer = '';
  private nextRequestId = 1;
  private writeTail: Promise<void> = Promise.resolve();
  private closeError?: Error;
  private inputEnded = false;

  private readonly handleData = (chunk: Buffer | string): void => {
    if (this.closeError) {
      return;
    }

    const text = typeof chunk === 'string'
      ? chunk
      : this.decoder.write(chunk);
    this.inputBuffer += text;
    this.consumeFrames();
  };

  private readonly handleInputEnd = (): void => {
    if (this.inputEnded || this.closeError) {
      return;
    }
    this.inputEnded = true;
    this.inputBuffer += this.decoder.end();

    if (this.inputBuffer.trim()) {
      this.processFrame(this.inputBuffer.replace(/\r$/, ''));
      this.inputBuffer = '';
    }

    if (!this.closeError) {
      this.close(new JsonRpcTransportError('The app-server output stream ended.'));
    }
  };

  private readonly handleInputClose = (): void => {
    if (!this.inputEnded && !this.closeError) {
      this.close(new JsonRpcTransportError('The app-server output stream closed unexpectedly.'));
    }
  };

  private readonly handleOutputClose = (): void => {
    if (!this.closeError) {
      this.close(new JsonRpcTransportError('The app-server input stream closed unexpectedly.'));
    }
  };

  private readonly handleStreamError = (error: Error): void => {
    this.close(new JsonRpcTransportError('The app-server stdio transport failed.', {
      cause: error
    }));
  };

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    options: JsonRpcStdioClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_JSON_RPC_TIMEOUT_MS;
    this.serverRequestTimeoutMs = options.serverRequestTimeoutMs ?? DEFAULT_SERVER_REQUEST_TIMEOUT_MS;
    this.maximumFrameBytes = options.maximumFrameBytes ?? DEFAULT_MAXIMUM_JSONL_FRAME_BYTES;
    this.onDiagnostic = options.onDiagnostic;

    if (this.requestTimeoutMs <= 0 || this.serverRequestTimeoutMs <= 0 || this.maximumFrameBytes <= 0) {
      throw new RangeError('JSON-RPC timeouts and maximum frame size must be positive.');
    }

    this.readable.on('data', this.handleData);
    this.readable.once('end', this.handleInputEnd);
    this.readable.once('close', this.handleInputClose);
    this.readable.once('error', this.handleStreamError);
    this.writable.once('close', this.handleOutputClose);
    this.writable.once('error', this.handleStreamError);
  }

  get isClosed(): boolean {
    return this.closeError !== undefined;
  }

  get pendingRequestCount(): number {
    return this.pendingRequests.size;
  }

  get pendingServerRequestCount(): number {
    return this.pendingServerRequests.size;
  }

  onNotification(listener: (notification: JsonRpcNotification) => void | Promise<void>): Disposable {
    this.notificationListeners.add(listener);
    return createDisposable(() => this.notificationListeners.delete(listener));
  }

  onServerRequest(listener: (request: JsonRpcServerRequestContext) => void | Promise<void>): Disposable {
    this.serverRequestListeners.add(listener);
    return createDisposable(() => this.serverRequestListeners.delete(listener));
  }

  onDidClose(listener: (error: Error) => void | Promise<void>): Disposable {
    if (this.closeError) {
      queueMicrotask(() => safelyInvoke(
        listener,
        this.closeError as Error,
        () => this.emitDiagnostic({ kind: 'listener-failed', status: 'close' })
      ));
      return createDisposable(() => undefined);
    }

    this.closeListeners.add(listener);
    return createDisposable(() => this.closeListeners.delete(listener));
  }

  async request<TResult>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {}
  ): Promise<TResult> {
    this.assertOpen();
    assertMethod(method);

    if (options.signal?.aborted) {
      throw new JsonRpcRequestCancelledError(method);
    }

    const id = this.nextRequestId++;
    const key = idKey(id);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (timeoutMs <= 0) {
      throw new RangeError('JSON-RPC request timeout must be positive.');
    }

    return await new Promise<TResult>((resolve, reject) => {
      let abortCleanup: (() => void) | undefined;
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(key);
        if (!pending) {
          return;
        }
        this.pendingRequests.delete(key);
        pending.abortCleanup?.();
        this.rememberIgnoredResponse(key);
        const error = new JsonRpcTimeoutError(method, timeoutMs);
        this.emitDiagnostic({ kind: 'request-timeout', method, durationMs: elapsed(pending.startedAt) });
        reject(error);
      }, timeoutMs);

      if (options.signal) {
        const handleAbort = (): void => {
          const pending = this.pendingRequests.get(key);
          if (!pending) {
            return;
          }
          this.pendingRequests.delete(key);
          clearTimeout(pending.timer);
          pending.abortCleanup?.();
          this.rememberIgnoredResponse(key);
          this.emitDiagnostic({ kind: 'request-failed', method, durationMs: elapsed(pending.startedAt), status: 'cancelled' });
          reject(new JsonRpcRequestCancelledError(method));
        };
        options.signal.addEventListener('abort', handleAbort, { once: true });
        abortCleanup = () => options.signal?.removeEventListener('abort', handleAbort);
      }

      const pending: PendingClientRequest = {
        id,
        method,
        startedAt: Date.now(),
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
        abortCleanup
      };
      this.pendingRequests.set(key, pending);

      const message = params === undefined
        ? { method, id }
        : { method, id, params };
      void this.sendMessage(message).catch((error: unknown) => {
        const current = this.pendingRequests.get(key);
        if (!current) {
          return;
        }
        this.pendingRequests.delete(key);
        clearTimeout(current.timer);
        current.abortCleanup?.();
        reject(error);
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.assertOpen();
    assertMethod(method);
    const message = params === undefined
      ? { method }
      : { method, params };
    await this.sendMessage(message);
  }

  close(error: Error = new JsonRpcTransportError('The JSON-RPC client was closed.')): void {
    if (this.closeError) {
      return;
    }
    this.closeError = error;

    this.readable.removeListener('data', this.handleData);
    this.readable.removeListener('end', this.handleInputEnd);
    this.readable.removeListener('close', this.handleInputClose);
    this.readable.removeListener('error', this.handleStreamError);
    this.writable.removeListener('close', this.handleOutputClose);
    this.writable.removeListener('error', this.handleStreamError);

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const request of this.pendingServerRequests.values()) {
      request.abort(error);
    }
    this.pendingServerRequests.clear();

    for (const reject of this.activeWriteRejectors) {
      reject(error);
    }
    this.activeWriteRejectors.clear();

    this.emitDiagnostic({ kind: 'transport-closed', status: error.name });
    for (const listener of [...this.closeListeners]) {
      safelyInvoke(listener, error, () => this.emitDiagnostic({ kind: 'listener-failed', status: 'close' }));
    }
    this.closeListeners.clear();
  }

  dispose(): void {
    this.close();
    this.notificationListeners.clear();
    this.serverRequestListeners.clear();
  }

  private consumeFrames(): void {
    if (Buffer.byteLength(this.inputBuffer, 'utf8') > this.maximumFrameBytes && !this.inputBuffer.includes('\n')) {
      this.close(new JsonRpcProtocolError('The app-server emitted a JSONL frame larger than the configured limit.'));
      return;
    }

    while (!this.closeError) {
      const newlineIndex = this.inputBuffer.indexOf('\n');
      if (newlineIndex < 0) {
        break;
      }

      const frame = this.inputBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
      if (!frame.trim()) {
        continue;
      }
      if (Buffer.byteLength(frame, 'utf8') > this.maximumFrameBytes) {
        this.close(new JsonRpcProtocolError('The app-server emitted a JSONL frame larger than the configured limit.'));
        return;
      }
      this.processFrame(frame);
    }

    if (
      !this.closeError
      && Buffer.byteLength(this.inputBuffer, 'utf8') > this.maximumFrameBytes
    ) {
      this.close(new JsonRpcProtocolError('The app-server emitted a JSONL frame larger than the configured limit.'));
    }
  }

  private processFrame(frame: string): void {
    if (this.closeError) {
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch (error) {
      this.close(new JsonRpcProtocolError('The app-server emitted malformed JSONL.', {
        cause: error
      }));
      return;
    }

    if (!isRecord(value) || Array.isArray(value)) {
      this.close(new JsonRpcProtocolError('The app-server emitted a non-object JSON-RPC message.'));
      return;
    }

    const message = value as WireMessage;
    if (typeof message.method === 'string') {
      if (message.id === undefined || message.id === null) {
        this.handleNotification(message.method, message.params);
      } else if (isJsonRpcId(message.id)) {
        this.handleServerRequest(message.id, message.method, message.params);
      } else {
        this.close(new JsonRpcProtocolError('The app-server emitted a request with an invalid id.'));
      }
      return;
    }

    if (isJsonRpcId(message.id)) {
      this.handleResponse(message.id, message);
      return;
    }

    this.close(new JsonRpcProtocolError('The app-server emitted an unrecognized JSON-RPC message.'));
  }

  private handleResponse(id: JsonRpcId, message: WireMessage): void {
    const key = idKey(id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      if (this.ignoredResponseIds.delete(key)) {
        return;
      }
      this.close(new JsonRpcProtocolError('The app-server replied with an unknown JSON-RPC id.'));
      return;
    }

    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (hasResult === hasError) {
      this.close(new JsonRpcProtocolError('The app-server response must contain exactly one of result or error.'));
      return;
    }

    this.pendingRequests.delete(key);
    clearTimeout(pending.timer);
    pending.abortCleanup?.();

    if (hasError) {
      if (!isJsonRpcErrorObject(message.error)) {
        const protocolError = new JsonRpcProtocolError('The app-server emitted an invalid JSON-RPC error object.');
        pending.reject(protocolError);
        this.close(protocolError);
        return;
      }
      const responseError = new JsonRpcResponseError(
        message.error.code,
        message.error.message,
        message.error.data
      );
      this.emitDiagnostic({ kind: 'request-failed', method: pending.method, durationMs: elapsed(pending.startedAt), status: String(message.error.code) });
      pending.reject(responseError);
      return;
    }

    this.emitDiagnostic({ kind: 'request-completed', method: pending.method, durationMs: elapsed(pending.startedAt), status: 'ok' });
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    this.emitDiagnostic({ kind: 'notification', method });
    const notification: JsonRpcNotification = params === undefined
      ? { method }
      : { method, params };
    for (const listener of [...this.notificationListeners]) {
      safelyInvoke(listener, notification, () => this.emitDiagnostic({ kind: 'listener-failed', method, status: 'notification' }));
    }
  }

  private handleServerRequest(id: JsonRpcId, method: string, params: unknown): void {
    const key = idKey(id);
    if (this.pendingServerRequests.has(key)) {
      this.close(new JsonRpcProtocolError('The app-server reused an active server-request id.'));
      return;
    }

    const request = new DeferredServerRequest(
      id,
      method,
      params,
      this.serverRequestTimeoutMs,
      (message) => this.sendMessage(message),
      () => this.pendingServerRequests.delete(key),
      (event) => this.emitDiagnostic(event)
    );
    this.pendingServerRequests.set(key, request);
    this.emitDiagnostic({ kind: 'server-request', method });

    if (this.serverRequestListeners.size === 0) {
      void request.reject({
        code: -32601,
        message: 'The client does not handle this server request.'
      }).catch(() => undefined);
      return;
    }

    for (const listener of [...this.serverRequestListeners]) {
      safelyInvoke(listener, request, () => {
        this.emitDiagnostic({ kind: 'listener-failed', method, status: 'server-request' });
        if (!request.settled) {
          void request.reject({
            code: -32603,
            message: 'The client failed to handle this server request.'
          }).catch(() => undefined);
        }
      });
    }
  }

  private sendMessage(message: unknown): Promise<void> {
    if (this.closeError) {
      return Promise.reject(this.closeError);
    }

    let frame: string;
    try {
      frame = `${JSON.stringify(message)}\n`;
    } catch (error) {
      return Promise.reject(new JsonRpcProtocolError('The JSON-RPC message could not be serialized.', {
        cause: error
      }));
    }

    const task = this.writeTail.then(async () => {
      this.assertOpen();
      await this.writeFrame(frame);
    });
    this.writeTail = task.catch(() => undefined);
    return task;
  }

  private async writeFrame(frame: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let callbackCompleted = false;
      let drainCompleted = true;
      let settled = false;

      function handleDrain(): void {
        drainCompleted = true;
        finish();
      }

      const rejectForClose = (error: Error): void => finish(error);

      const cleanup = (): void => {
        this.activeWriteRejectors.delete(rejectForClose);
        this.writable.removeListener('drain', handleDrain);
      };

      const finish = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        if (error) {
          settled = true;
          cleanup();
          reject(error);
          return;
        }
        if (callbackCompleted && drainCompleted) {
          settled = true;
          cleanup();
          resolve();
        }
      };

      this.activeWriteRejectors.add(rejectForClose);
      try {
        const accepted = this.writable.write(frame, 'utf8', (error?: Error | null) => {
          callbackCompleted = true;
          finish(error);
        });
        if (!accepted) {
          drainCompleted = false;
          this.writable.once('drain', handleDrain);
        }
      } catch (error) {
        finish(asError(error, 'The app-server input stream rejected a write.'));
      }
    }).catch((error: unknown) => {
      const transportError = error instanceof Error
        ? error
        : new JsonRpcTransportError('The app-server input stream rejected a write.');
      this.close(transportError);
      throw transportError;
    });
  }

  private assertOpen(): void {
    if (this.closeError) {
      throw this.closeError;
    }
  }

  private rememberIgnoredResponse(key: string): void {
    this.ignoredResponseIds.add(key);
    this.ignoredResponseIdOrder.push(key);
    while (this.ignoredResponseIdOrder.length > 256) {
      const removed = this.ignoredResponseIdOrder.shift();
      if (removed) {
        this.ignoredResponseIds.delete(removed);
      }
    }
  }

  private emitDiagnostic(event: JsonRpcDiagnosticEvent): void {
    if (!this.onDiagnostic) {
      return;
    }
    safelyInvoke(this.onDiagnostic, event, () => undefined);
  }
}

class DeferredServerRequest implements JsonRpcServerRequestContext {
  private readonly abortController = new AbortController();
  private readonly startedAt = Date.now();
  private readonly timer: NodeJS.Timeout;
  private didSettle = false;

  constructor(
    readonly id: JsonRpcId,
    readonly method: string,
    readonly params: unknown,
    timeoutMs: number,
    private readonly send: (message: unknown) => Promise<void>,
    private readonly didFinish: () => void,
    private readonly emitDiagnostic: (event: JsonRpcDiagnosticEvent) => void
  ) {
    this.timer = setTimeout(() => {
      if (this.didSettle) {
        return;
      }
      this.emitDiagnostic({ kind: 'server-request-timeout', method, durationMs: elapsed(this.startedAt) });
      void this.reject({
        code: -32000,
        message: 'The client timed out while waiting to complete this server request.'
      }).catch(() => undefined);
    }, timeoutMs);
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get settled(): boolean {
    return this.didSettle;
  }

  async respond(result: unknown = null): Promise<void> {
    await this.settle({ id: this.id, result });
  }

  async reject(error: JsonRpcErrorObject): Promise<void> {
    if (!isJsonRpcErrorObject(error)) {
      throw new TypeError('A server-request rejection requires a valid JSON-RPC error object.');
    }
    await this.settle({ id: this.id, error });
  }

  abort(error: Error): void {
    if (this.didSettle) {
      return;
    }
    this.didSettle = true;
    clearTimeout(this.timer);
    this.abortController.abort(error);
    this.didFinish();
  }

  private async settle(message: unknown): Promise<void> {
    if (this.didSettle) {
      throw new JsonRpcProtocolError('The server request has already been completed.');
    }
    this.didSettle = true;
    clearTimeout(this.timer);
    this.didFinish();

    try {
      await this.send(message);
      this.emitDiagnostic({ kind: 'server-request-completed', method: this.method, durationMs: elapsed(this.startedAt), status: 'ok' });
    } catch (error) {
      this.abortController.abort(error);
      throw error;
    }
  }
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

function assertMethod(method: string): void {
  if (!method.trim()) {
    throw new TypeError('JSON-RPC method must be a non-empty string.');
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isJsonRpcErrorObject(value: unknown): value is JsonRpcErrorObject {
  return isRecord(value)
    && typeof value.code === 'number'
    && Number.isFinite(value.code)
    && typeof value.message === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
