import * as vscode from 'vscode';
import type { ResponsesInputMessage } from '../convertMessages';
import type {
  AccountSnapshot,
  AccountTokenActivitySnapshot,
  BackendModel,
  CodexAccountUsageSnapshot,
  LoginChallenge
} from './types';
import type { UserInput } from './wireTypes';
import type { VsCodeToolDefinition } from './toolBridge';

export interface BackendUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  modelContextWindow?: number;
}

export interface BackendToolResult {
  callId: string;
  content: readonly unknown[];
}

export type OrchestrationMode = 'standard' | 'vscodeProactive';

export interface BackendChatRequest {
  model: string;
  requestedMode?: string;
  backendEffort?: string;
  orchestrationMode: OrchestrationMode;
  vsCodeSubagentToolName?: string;
  serviceTier?: string;
  developerInstructions: string;
  toolMode: 'auto' | 'required';
  tools: readonly VsCodeToolDefinition[];
  fullHistory: readonly ResponsesInputMessage[];
  historyBeforeCurrent: readonly ResponsesInputMessage[];
  projectedHistory: readonly ResponsesInputMessage[];
  currentInput: readonly UserInput[];
  toolResults: readonly BackendToolResult[];
}

export interface BackendStreamSink {
  text(delta: string): void;
  thinking(delta: string): void;
  toolCall(callId: string, name: string, input: object): void;
  usage(usage: BackendUsage): void;
}

export type BackendChatResult =
  | { kind: 'completed'; usage?: BackendUsage }
  | { kind: 'toolBoundary'; callId: string };

export interface CodexBackend extends vscode.Disposable {
  readonly onDidChangeAccount: vscode.Event<void>;
  readonly onDidChangeModels: vscode.Event<void>;
  readonly onDidUpdateRateLimits: vscode.Event<CodexAccountUsageSnapshot>;

  readonly processGeneration: number;
  readonly accountGeneration: number;
  readonly runtimeVersion: string | undefined;

  ensureReady(): Promise<void>;
  readAccount(refreshToken?: boolean): Promise<AccountSnapshot | undefined>;
  beginLogin(kind: 'browser' | 'deviceCode'): Promise<LoginChallenge>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;

  listModels(token: vscode.CancellationToken): Promise<BackendModel[]>;
  readRateLimits(): Promise<CodexAccountUsageSnapshot>;
  readTokenActivity(): Promise<AccountTokenActivitySnapshot>;
  runChat(
    request: BackendChatRequest,
    sink: BackendStreamSink,
    token: vscode.CancellationToken
  ): Promise<BackendChatResult>;
}
