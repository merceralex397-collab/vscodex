import * as vscode from 'vscode';
import { resolve } from 'node:path';
import { projectResponsesInputForContinuation, stableSerialize, type ResponsesInputMessage } from '../convertMessages';
import { getProviderConfig } from '../config';
import { AccountUsageAdapter } from './accountUsageAdapter';
import { AppServerProcess, type AppServerDiagnosticEvent } from './appServerProcess';
import { AuthController } from './authController';
import type {
  BackendChatRequest,
  BackendChatResult,
  BackendStreamSink,
  BackendUsage,
  CodexBackend
} from './backend';
import {
  ConversationThreadStore,
  hashConversationEnvelope,
  type ConversationBranch,
  type ConversationEnvelope,
  type ConversationReusePlan
} from './conversationThreadStore';
import { AppServerEventRouter } from './eventRouter';
import {
  JsonRpcResponseError,
  type JsonRpcServerRequestContext
} from './jsonRpcStdioClient';
import { ModelCatalog } from './modelCatalog';
import {
  isCodexCliVersionNewerThanValidated,
  LATEST_VALIDATED_CODEX_CLI_VERSION,
  MINIMUM_CODEX_CLI_VERSION
} from './runtime';
import {
  createDynamicToolCatalog,
  SuspendedDynamicToolBridge,
  type DynamicToolCatalog
} from './toolBridge';
import {
  AppServerTurnCoordinator,
  HostTurnCancellationError,
  PassivePolicyViolationError,
  type TurnInvocationResult,
  type TurnSessionHandle,
  type TurnStreamSink
} from './turnCoordinator';
import { AppServerProtocolError, ChatGptAccountRequiredError } from './types';
import type {
  AccountSnapshot,
  AccountTokenActivitySnapshot,
  BackendModel,
  CodexAccountUsageSnapshot,
  LoginChallenge
} from './types';
import type { ThreadTokenUsage, UserInput } from './wireTypes';

export const PASSIVE_POLICY_VERSION = '3';
export const PASSIVE_PROVIDER_INSTRUCTIONS = `You are the reasoning backend for a VS Code LanguageModelChatProvider.
VS Code and its calling agent own context selection, workspace permissions,
tool execution, file changes, commands, approvals, and subagents. The app-server
cwd, sandbox, and approval policy protect this passive backend only; they do not
describe or restrict the caller's VS Code workspace. Never report that VS Code
is read-only based on backend metadata. Call only supplied dynamic tools whose
names begin with vscode_. Never invoke Codex built-in tools, including shell,
filesystem, MCP, web, or collaboration/spawn_agent tools. For subagent work,
use a supplied dynamic VS Code agent or subagent tool. Return normal assistant
text and dynamic tool calls.`;

const REQUIRED_TOOL_INSTRUCTION = 'The caller requires at least one supplied dynamic-tool call before any final answer. Do not complete this turn before a dynamic-tool call has succeeded or failed.';
const PASSIVE_MULTI_AGENT_MODE_HINT = 'Codex built-in collaboration is prohibited in this passive provider. Do not call spawn_agent or any Codex collaboration tool. VS Code alone owns subagent orchestration through caller-supplied dynamic tools.';
const TOOL_RECOVERY_INPUT: UserInput[] = [{
  type: 'text',
  text: 'Continue from the preceding tool result and complete the response.',
  text_elements: []
}];
const MODEL_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_REFRESH_THROTTLE_MS = 60_000;

const PASSIVE_APP_SERVER_CONFIG = {
  web_search: 'disabled',
  mcp_servers: {},
  skills: { config: [] },
  project_doc_max_bytes: 0,
  include_environment_context: false,
  include_permissions_instructions: false,
  include_collaboration_mode_instructions: false,
  features: {
    shell_tool: false,
    unified_exec: false,
    shell_snapshot: false,
    apps: false,
    browser_use: false,
    browser_use_external: false,
    computer_use: false,
    image_generation: false,
    in_app_browser: false,
    code_mode_host: false,
    multi_agent: false,
    multi_agent_v2: {
      enabled: false,
      max_concurrent_threads_per_session: 1,
      usage_hint_text: '',
      root_agent_usage_hint_text: '',
      subagent_usage_hint_text: '',
      multi_agent_mode_hint_text: PASSIVE_MULTI_AGENT_MODE_HINT
    },
    plugins: false,
    plugin_sharing: false,
    remote_plugin: false,
    hooks: false,
    goals: false,
    memories: false,
    workspace_dependencies: false,
    skill_mcp_dependency_install: false,
    tool_suggest: false
  }
};

interface CachedModels {
  expiresAt: number;
  processGeneration: number;
  accountGeneration: number;
  models: BackendModel[];
}

interface ThreadResponse {
  thread?: { id?: unknown };
}

interface TurnResponse {
  turn?: { id?: unknown };
}

interface PendingCallBinding {
  branchId: string;
  threadId: string;
  turnId: string;
  callId: string;
}

export class CodexAppServerBackend implements CodexBackend {
  private readonly accountEmitter = new vscode.EventEmitter<void>();
  private readonly modelsEmitter = new vscode.EventEmitter<void>();
  private readonly rateLimitsEmitter = new vscode.EventEmitter<CodexAccountUsageSnapshot>();
  private readonly process: AppServerProcess;
  private readonly auth: AuthController;
  private readonly models: ModelCatalog;
  private readonly accountUsage: AccountUsageAdapter;
  private readonly eventRouter = new AppServerEventRouter();
  private readonly toolBridge: SuspendedDynamicToolBridge;
  private readonly turnCoordinator: AppServerTurnCoordinator;
  private readonly branches: ConversationThreadStore<ResponsesInputMessage>;
  private readonly threadModels = new Map<string, string>();
  private readonly pendingCallsByBranch = new Map<string, PendingCallBinding>();
  private readonly reservedContinuationBranches = new Set<string>();
  private readonly reservedToolResumeBranches = new Set<string>();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private effectiveAppServerCommand: string;
  private cachedModels?: CachedModels;
  private rateLimitsBootstrap?: Promise<void>;
  private lastRateLimitRefreshAt = 0;
  private warnedNewerRuntimeVersion?: string;
  private disposed = false;

  readonly onDidChangeAccount = this.accountEmitter.event;
  readonly onDidChangeModels = this.modelsEmitter.event;
  readonly onDidUpdateRateLimits = this.rateLimitsEmitter.event;

  constructor(
    context: vscode.ExtensionContext,
    private readonly outputChannel: vscode.LogOutputChannel
  ) {
    this.effectiveAppServerCommand = getProviderConfig().appServerCommand;
    this.process = new AppServerProcess({
      command: () => this.effectiveAppServerCommand,
      extensionVersion: String(context.extension.packageJSON.version),
      storageDirectory: context.globalStorageUri.fsPath,
      onDiagnostic: (event) => this.logDiagnostic(event)
    });
    this.auth = new AuthController(this.process);
    this.models = new ModelCatalog(this.process, {
      runtimeVersion: () => this.process.runtimeInfo?.version ?? MINIMUM_CODEX_CLI_VERSION
    });
    this.accountUsage = new AccountUsageAdapter(this.process);

    const interruptTurn = async (threadId: string, turnId: string): Promise<void> => {
      await this.process.request('turn/interrupt', { threadId, turnId });
    };
    this.toolBridge = new SuspendedDynamicToolBridge({
      interruptTurn,
      onBridgeError: (error) => {
        this.outputChannel.warn('dynamic tool bridge failure', { status: error.code });
        if (error.code !== 'cancelled' && error.threadId && error.turnId) {
          void this.handleDynamicToolBridgeFailure(error.threadId, error.turnId, error);
        }
      }
    });
    this.turnCoordinator = new AppServerTurnCoordinator({
      eventRouter: this.eventRouter,
      toolBridge: this.toolBridge,
      interruptTurn,
      onContextWindow: (threadId, contextWindow) => {
        const model = this.threadModels.get(threadId);
        if (model) {
          this.models.updateContextWindow(model, contextWindow);
        }
      }
    });
    this.branches = new ConversationThreadStore({
      itemIdentity: (item) => stableSerialize(item),
      onEvict: (branch) => {
        void this.cleanupBranch(branch);
      }
    });

    this.disposables.push(
      this.process.onNotification((notification) => {
        this.turnCoordinator.route({
          method: notification.method,
          params: notification.params
        });
      }),
      this.process.onServerRequest((request) => {
        void this.handleServerRequest(request);
      }),
      this.process.onDidChangeGeneration((generation) => {
        void this.handleProcessGenerationChanged(generation);
      }),
      this.auth.onDidChangeAccount((event) => {
        void this.handleAccountChanged(event.generation);
      }),
      this.accountUsage.onDidUpdateRateLimits((snapshot) => {
        if (this.auth.account) {
          this.rateLimitsEmitter.fire(snapshot);
        } else {
          this.accountUsage.invalidate();
        }
      }),
      this.models.onDidUpdateContextWindow(() => {
        this.cachedModels = undefined;
        this.modelsEmitter.fire();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('codexvs.appServer.command')) {
          const nextCommand = getProviderConfig().appServerCommand;
          if (nextCommand !== this.effectiveAppServerCommand) {
            this.effectiveAppServerCommand = nextCommand;
            void this.handleRuntimeCommandChanged().catch((error) => {
              this.outputChannel.warn('app-server runtime change failed', {
                status: error instanceof Error ? error.name : 'unknown'
              });
            });
          }
        }
      })
    );
  }

  get processGeneration(): number {
    return this.process.generation;
  }

  get accountGeneration(): number {
    return this.auth.generation;
  }

  get runtimeVersion(): string | undefined {
    return this.process.runtimeInfo?.version;
  }

  async ensureReady(): Promise<void> {
    this.assertNotDisposed();
    await this.process.ensureReady();
  }

  async readAccount(refreshToken = false): Promise<AccountSnapshot | undefined> {
    this.assertNotDisposed();
    return this.auth.readAccount(refreshToken);
  }

  async beginLogin(kind: 'browser' | 'deviceCode'): Promise<LoginChallenge> {
    this.assertNotDisposed();
    return this.auth.beginLogin(kind);
  }

  async cancelLogin(loginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.auth.cancelLogin(loginId);
  }

  async logout(): Promise<void> {
    this.assertNotDisposed();
    await this.auth.logout();
  }

  async listModels(token: vscode.CancellationToken): Promise<BackendModel[]> {
    this.assertNotDisposed();
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    const account = await this.auth.readAccount(false);
    if (!account) {
      return [];
    }
    const processGeneration = this.process.generation;
    const accountGeneration = this.auth.generation;
    this.bootstrapRateLimits();

    const now = Date.now();
    if (this.cachedModels
      && this.cachedModels.expiresAt > now
      && this.cachedModels.processGeneration === processGeneration
      && this.cachedModels.accountGeneration === accountGeneration) {
      return this.cachedModels.models.map((model) => ({ ...model }));
    }

    const models = await this.models.listModels({
      get isCancellationRequested() {
        return token.isCancellationRequested;
      },
      onCancellationRequested: (listener) => token.onCancellationRequested(listener)
    });
    if (processGeneration !== this.process.generation
      || accountGeneration !== this.auth.generation) {
      throw new AppServerProtocolError('Codex model discovery was invalidated by a process or account change.');
    }
    this.cachedModels = {
      expiresAt: now + MODEL_CACHE_TTL_MS,
      processGeneration,
      accountGeneration,
      models
    };
    return models.map((model) => ({ ...model }));
  }

  async readRateLimits(): Promise<CodexAccountUsageSnapshot> {
    this.assertNotDisposed();
    return this.runAuthenticatedAccountUsage(() => this.accountUsage.readRateLimits());
  }

  async readTokenActivity(): Promise<AccountTokenActivitySnapshot> {
    this.assertNotDisposed();
    return this.runAuthenticatedAccountUsage(() => this.accountUsage.readTokenActivity());
  }

  async runChat(
    request: BackendChatRequest,
    sink: BackendStreamSink,
    token: vscode.CancellationToken
  ): Promise<BackendChatResult> {
    this.assertNotDisposed();
    if (request.backendEffort?.trim().toLowerCase() === 'ultra') {
      throw new Error('Raw Ultra reasoning must not be sent to the Codex app-server.');
    }
    if (request.toolMode === 'required' && request.tools.length === 0) {
      throw new Error('Required tool mode cannot be used without tools.');
    }

    await this.ensureReady();
    const account = await this.auth.readAccount(false);
    if (!account) {
      throw vscode.LanguageModelError.NoPermissions('Sign in with ChatGPT to use Codex.');
    }

    const catalog = createDynamicToolCatalog(request.tools);
    const envelope = this.createEnvelope(request, catalog);

    if (request.toolResults.length === 1) {
      const pendingResult = request.toolResults[0];
      const pendingBranches = this.findPendingBranches(
        pendingResult.callId,
        envelope,
        request.projectedHistory
      );
      const pendingBranch = pendingBranches.length === 1 ? pendingBranches[0] : undefined;
      if (pendingBranch?.activeTurn && !this.reservedToolResumeBranches.has(pendingBranch.id)) {
        this.reservedToolResumeBranches.add(pendingBranch.id);
        try {
          const resumed = await this.tryResumeToolTurn(pendingBranch, request, sink, token);
          if (resumed) {
            return resumed;
          }
        } catch (error) {
          this.branches.remove(pendingBranch.id, 'invalidated');
          throw error;
        } finally {
          this.reservedToolResumeBranches.delete(pendingBranch.id);
        }
        this.branches.remove(pendingBranch.id, 'invalidated');
      } else if (pendingBranches.length === 0) {
        const incompatibleBranches = this.getMappedPendingBranches(pendingResult.callId);
        if (incompatibleBranches.length === 1
          && !this.reservedToolResumeBranches.has(incompatibleBranches[0].id)) {
          await this.abandonPendingBranch(
            incompatibleBranches[0],
            'The request history or envelope changed during a dynamic tool handoff.'
          );
        }
      }
    } else if (request.toolResults.length > 1) {
      const branchesToAbandon = new Map<string, ConversationBranch<ResponsesInputMessage>>();
      for (const result of request.toolResults) {
        const mappedBranches = this.getMappedPendingBranches(result.callId);
        if (mappedBranches.length === 1
          && !this.reservedToolResumeBranches.has(mappedBranches[0].id)) {
          branchesToAbandon.set(mappedBranches[0].id, mappedBranches[0]);
        }
      }
      await Promise.all([...branchesToAbandon.values()].map((branch) => this.abandonPendingBranch(
        branch,
        'The host supplied multiple or out-of-order dynamic tool results.'
      )));
    }

    let plan: ConversationReusePlan<ResponsesInputMessage> = request.toolResults.length > 0
      ? {
          kind: 'cold',
          projectedHistory: [...request.projectedHistory],
          reason: 'historyDiverged'
        }
      : this.branches.plan(envelope, request.projectedHistory);

    if (plan.kind === 'continue'
      && (plan.branch.activeTurn
        || this.reservedContinuationBranches.has(plan.branch.id)
        || this.reservedToolResumeBranches.has(plan.branch.id))) {
      // Two simultaneous chats can have identical histories. Only the exact
      // pending call-id map is allowed to resume an active app-server turn.
      if (plan.branch.activeTurn?.visibleOutput
        && !this.reservedToolResumeBranches.has(plan.branch.id)) {
        await this.abandonPendingBranch(
          plan.branch,
          request.toolResults.length > 0
            ? 'The host supplied an unknown or out-of-order dynamic tool result.'
            : 'The host did not supply the result for the pending dynamic tool call.'
        );
      }
      plan = {
        kind: 'cold',
        projectedHistory: [...request.projectedHistory],
        reason: 'historyDiverged'
      };
    }

    if (plan.kind === 'continue' && !isExactCurrentUserAppend(plan.appendedHistory, request)) {
      plan = {
        kind: 'cold',
        projectedHistory: [...request.projectedHistory],
        reason: 'historyDiverged'
      };
    }

    const reservedBranchId = plan.kind === 'continue' ? plan.branch.id : undefined;
    if (reservedBranchId) {
      this.reservedContinuationBranches.add(reservedBranchId);
    }

    try {
      const branch = await this.prepareBranch(plan, request, catalog, envelope);
      if (envelope.processGeneration !== this.process.generation
        || envelope.accountGeneration !== this.auth.generation) {
        this.branches.remove(branch.id, 'invalidated');
        throw new AppServerProtocolError(
          'The Codex process or account changed while the conversation thread was being prepared.'
        );
      }
      const input = request.toolResults.length > 0 ? TOOL_RECOVERY_INPUT : request.currentInput;
      if (input.length === 0) {
        this.branches.remove(branch.id, 'invalidated');
        throw new Error('The request did not contain user text, an image, or a tool result.');
      }

      try {
        return await this.startTurn(branch, request, input, sink, token);
      } catch (error) {
        this.branches.remove(branch.id, 'invalidated');
        throw error;
      }
    } finally {
      if (reservedBranchId) {
        this.reservedContinuationBranches.delete(reservedBranchId);
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pendingCallsByBranch.clear();
    this.reservedContinuationBranches.clear();
    this.reservedToolResumeBranches.clear();
    this.branches.dispose();
    void this.turnCoordinator.invalidateAll('The extension was deactivated.');
    void this.toolBridge.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.accountUsage.dispose();
    this.models.dispose();
    this.auth.dispose();
    this.process.dispose();
    this.accountEmitter.dispose();
    this.modelsEmitter.dispose();
    this.rateLimitsEmitter.dispose();
  }

  private createEnvelope(request: BackendChatRequest, catalog: DynamicToolCatalog): ConversationEnvelope {
    const developerInstructions = this.getDeveloperInstructions(request, catalog);
    return {
      processGeneration: this.process.generation,
      accountGeneration: this.auth.generation,
      appServerVersion: this.process.runtimeInfo?.version ?? MINIMUM_CODEX_CLI_VERSION,
      passivePolicyVersion: PASSIVE_POLICY_VERSION,
      model: request.model,
      requestedMode: request.requestedMode,
      backendEffort: request.backendEffort,
      orchestrationMode: request.orchestrationMode,
      serviceTier: request.serviceTier,
      baseInstructions: PASSIVE_PROVIDER_INSTRUCTIONS,
      developerInstructions,
      toolMode: request.toolMode,
      tools: catalog.tools.map((tool) => ({
        originalName: tool.originalName,
        alias: tool.alias,
        description: tool.description,
        inputSchema: tool.inputSchema
      }))
    };
  }

  private async prepareBranch(
    plan: ConversationReusePlan<ResponsesInputMessage>,
    request: BackendChatRequest,
    catalog: DynamicToolCatalog,
    envelope: ConversationEnvelope
  ): Promise<ConversationBranch<ResponsesInputMessage>> {
    if (plan.kind === 'continue') {
      return plan.branch;
    }

    let threadId: string | undefined;
    try {
      if (plan.kind === 'fork') {
        try {
          threadId = await this.forkThread(
            plan.branch.threadId,
            plan.checkpoint.turnId,
            request,
            catalog
          );
          const injection = getHistoryAfterProjectedPrefix(
            request.historyBeforeCurrent,
            plan.checkpoint.projectedHistoryLength
          );
          await this.injectHistory(threadId, injection, catalog);
        } catch (error) {
          // Codex CLI 0.144.4 documents ephemeral forks but can still reject an
          // in-memory source with "no rollout found" because it consults only
          // persisted rollout storage. No output or new thread is visible at
          // this point, so preserve the requested branch via a full cold seed.
          if (!isMissingEphemeralForkRollout(error)) {
            throw error;
          }
          threadId = await this.startThread(request, catalog);
          await this.injectHistory(threadId, request.historyBeforeCurrent, catalog);
        }
      } else {
        threadId = await this.startThread(request, catalog);
        await this.injectHistory(
          threadId,
          request.toolResults.length > 0 ? request.fullHistory : request.historyBeforeCurrent,
          catalog
        );
      }

      this.toolBridge.registerThread(threadId, catalog);
      this.threadModels.set(threadId, request.model);
      return this.branches.register({
        envelope,
        projectedHistory: request.projectedHistory,
        threadId
      });
    } catch (error) {
      if (threadId) {
        await this.discardThread(threadId);
      }
      throw error;
    }
  }

  private async startThread(request: BackendChatRequest, catalog: DynamicToolCatalog): Promise<string> {
    const passiveDirectory = this.requirePassiveDirectory();
    const response = await this.process.request<ThreadResponse>('thread/start', {
      model: request.model,
      modelProvider: 'openai',
      allowProviderModelFallback: false,
      serviceTier: request.serviceTier ?? null,
      cwd: passiveDirectory,
      runtimeWorkspaceRoots: [],
      environments: [],
      selectedCapabilityRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ephemeral: true,
      personality: 'none',
      baseInstructions: PASSIVE_PROVIDER_INSTRUCTIONS,
      developerInstructions: this.getDeveloperInstructions(request, catalog),
      dynamicTools: catalog.dynamicTools,
      config: this.getPassiveAppServerConfig()
    });
    return requirePassiveThreadResponse(
      response,
      'thread/start',
      passiveDirectory,
      request.model,
      request.serviceTier,
      this.runtimeVersion ?? 'unknown'
    );
  }

  private async forkThread(
    sourceThreadId: string,
    lastTurnId: string,
    request: BackendChatRequest,
    catalog: DynamicToolCatalog
  ): Promise<string> {
    const response = await this.process.request<ThreadResponse>('thread/fork', {
      threadId: sourceThreadId,
      lastTurnId,
      model: request.model,
      modelProvider: 'openai',
      serviceTier: request.serviceTier ?? null,
      cwd: this.requirePassiveDirectory(),
      runtimeWorkspaceRoots: [],
      approvalPolicy: 'never',
      sandbox: 'read-only',
      config: this.getPassiveAppServerConfig(),
      baseInstructions: PASSIVE_PROVIDER_INSTRUCTIONS,
      developerInstructions: this.getDeveloperInstructions(request, catalog),
      personality: 'none',
      ephemeral: true,
      excludeTurns: true
    });
    return requirePassiveThreadResponse(
      response,
      'thread/fork',
      this.requirePassiveDirectory(),
      request.model,
      request.serviceTier,
      this.runtimeVersion ?? 'unknown'
    );
  }

  private async injectHistory(
    threadId: string,
    items: readonly ResponsesInputMessage[],
    catalog: DynamicToolCatalog
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }
    await this.process.request('thread/inject_items', {
      threadId,
      items: aliasInjectedFunctionCalls(items, catalog)
    });
  }

  private getPassiveAppServerConfig(): typeof PASSIVE_APP_SERVER_CONFIG {
    const passiveMcpServers = this.process.passiveMcpServers;
    if (!passiveMcpServers) {
      throw new AppServerProtocolError('The verified passive MCP configuration is unavailable.');
    }
    return {
      ...PASSIVE_APP_SERVER_CONFIG,
      mcp_servers: passiveMcpServers
    };
  }

  private async startTurn(
    branch: ConversationBranch<ResponsesInputMessage>,
    request: BackendChatRequest,
    input: readonly UserInput[],
    sink: BackendStreamSink,
    token: vscode.CancellationToken
  ): Promise<BackendChatResult> {
    const handoff = { visible: false };
    const streamSink = this.createTurnSink(sink, () => {
      handoff.visible = true;
    });
    const handle = this.turnCoordinator.beginTurn(branch.threadId, streamSink, {
      requiredToolMode: request.toolMode === 'required'
    });
    const cancellation = this.watchHostCancellation(token, handoff, () => handle.cancel());
    let turnId: string | undefined;

    try {
      const response = await this.process.request<TurnResponse>('turn/start', {
        threadId: branch.threadId,
        input,
        environments: [],
        cwd: this.requirePassiveDirectory(),
        runtimeWorkspaceRoots: [],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        model: request.model,
        serviceTier: request.serviceTier ?? null,
        effort: request.backendEffort ?? null,
        summary: 'auto',
        personality: 'none'
      });
      turnId = requireTurnId(response, this.runtimeVersion ?? 'unknown');
      handle.bindTurn(turnId);
      this.branches.setActiveTurn(branch.id, { turnId, visibleOutput: false });
    } catch (error) {
      cancellation.dispose();
      await this.turnCoordinator.failTurn(branch.threadId, turnId, error);
      this.branches.remove(branch.id, 'invalidated');
      throw error;
    }

    return this.awaitTurnOutcome(branch, request, handle, handoff, token, cancellation);
  }

  private async tryResumeToolTurn(
    branch: ConversationBranch<ResponsesInputMessage>,
    request: BackendChatRequest,
    sink: BackendStreamSink,
    token: vscode.CancellationToken
  ): Promise<BackendChatResult | undefined> {
    const active = branch.activeTurn;
    if (!active) {
      return undefined;
    }
    const pending = this.toolBridge.getPending(branch.threadId, active.turnId);
    const exposed = pending[0];
    const result = request.toolResults.length === 1
      ? request.toolResults[0]
      : undefined;
    if (!exposed
      || exposed.state !== 'exposed'
      || !result
      || result.callId !== exposed.callId
      || request.currentInput.length > 0
      || !isExactToolResultAppend(branch.projectedHistory, request.projectedHistory, exposed.callId)) {
      try {
        await this.turnCoordinator.failMissingToolResult(branch.threadId, active.turnId);
      } catch {
        // The old turn is intentionally abandoned before cold reconstruction.
      }
      await this.turnCoordinator.failTurn(
        branch.threadId,
        active.turnId,
        new Error('The host tool result did not match the suspended Codex tool call.')
      );
      return undefined;
    }

    const handoff = { visible: false };
    const outcomePromise = this.turnCoordinator.resumeWithToolResult({
      threadId: branch.threadId,
      turnId: active.turnId,
      callId: result.callId,
      content: result.content
    }, this.createTurnSink(sink, () => {
      handoff.visible = true;
    }));

    const outcome = await this.awaitCoordinatorResult(
      branch.threadId,
      active.turnId,
      outcomePromise,
      token,
      undefined,
      handoff
    );
    return this.finishOutcome(branch, request, active.turnId, outcome);
  }

  private async awaitTurnOutcome(
    branch: ConversationBranch<ResponsesInputMessage>,
    request: BackendChatRequest,
    handle: TurnSessionHandle,
    handoff: { visible: boolean },
    token: vscode.CancellationToken,
    cancellation: vscode.Disposable
  ): Promise<BackendChatResult> {
    const outcome = await this.awaitCoordinatorResult(
      branch.threadId,
      handle.turnId,
      handle.result,
      token,
      handle,
      handoff,
      cancellation
    );
    return this.finishOutcome(branch, request, handle.turnId, outcome);
  }

  private async awaitCoordinatorResult(
    threadId: string,
    turnId: string | undefined,
    result: Promise<TurnInvocationResult>,
    token: vscode.CancellationToken,
    handle?: TurnSessionHandle,
    handoff?: { visible: boolean },
    existingCancellation?: vscode.Disposable
  ): Promise<TurnInvocationResult> {
    const cancellation = existingCancellation ?? this.watchHostCancellation(
      token,
      handoff ?? { visible: false },
      () => handle?.cancel() ?? this.turnCoordinator.cancelTurn(threadId, turnId)
    );

    try {
      return await result;
    } catch (error) {
      if (error instanceof HostTurnCancellationError) {
        throw new vscode.CancellationError();
      }
      throw error;
    } finally {
      cancellation.dispose();
    }
  }

  private watchHostCancellation(
    token: vscode.CancellationToken,
    handoff: { visible: boolean },
    cancel: () => void | Promise<void>
  ): vscode.Disposable {
    const requestCancellation = (): void => {
      if (handoff.visible) {
        return;
      }
      void Promise.resolve(cancel()).catch((error) => {
        this.outputChannel.debug('app-server host cancellation failed', {
          status: error instanceof Error ? error.name : 'unknown'
        });
      });
    };
    const listener = token.onCancellationRequested(requestCancellation);
    if (token.isCancellationRequested) {
      requestCancellation();
    }
    return listener;
  }

  private finishOutcome(
    branch: ConversationBranch<ResponsesInputMessage>,
    request: BackendChatRequest,
    turnId: string | undefined,
    outcome: TurnInvocationResult
  ): BackendChatResult {
    if (!turnId) {
      this.branches.remove(branch.id, 'invalidated');
      throw new Error('App-server completed a turn without a turn identifier.');
    }

    if (outcome.kind === 'toolBoundary') {
      this.branches.setActiveTurn(branch.id, { turnId, visibleOutput: true });
      this.branches.updateProjectedHistory(branch.id, request.projectedHistory);
      this.branches.setPendingTools(
        branch.id,
        this.toolBridge.getPending(branch.threadId, turnId).map((tool) => ({
          callId: tool.callId,
          turnId
        }))
      );
      this.setPendingCallBinding(branch, turnId, outcome.callId);
      return outcome;
    }

    this.branches.recordCheckpoint(branch.id, request.projectedHistory, turnId);
    this.branches.setPendingTools(branch.id, []);
    this.deletePendingCallMappings(branch.id);
    this.refreshRateLimitsAfterTurn();
    return {
      kind: 'completed',
      usage: outcome.usage ? mapUsage(outcome.usage) : undefined
    };
  }

  private createTurnSink(sink: BackendStreamSink, beforeToolCall?: () => void): TurnStreamSink {
    return {
      onText: (value) => sink.text(value),
      onThinking: (value) => sink.thinking(value),
      onToolCall: (value) => {
        beforeToolCall?.();
        sink.toolCall(value.callId, value.name, value.input);
      },
      onUsage: (value) => sink.usage(mapUsage(value))
    };
  }

  private getDeveloperInstructions(
    request: BackendChatRequest,
    catalog: DynamicToolCatalog
  ): string {
    const configured = request.developerInstructions.trim();
    const orchestrationInstruction = request.orchestrationMode === 'vscodeProactive'
      ? this.getVsCodeProactiveInstruction(request, catalog)
      : undefined;
    return [
      configured,
      orchestrationInstruction,
      request.toolMode === 'required' ? REQUIRED_TOOL_INSTRUCTION : undefined
    ].filter((value): value is string => Boolean(value)).join('\n\n');
  }

  private getVsCodeProactiveInstruction(
    request: BackendChatRequest,
    catalog: DynamicToolCatalog
  ): string {
    const originalName = request.vsCodeSubagentToolName;
    const tool = originalName ? catalog.byOriginalName.get(originalName) : undefined;
    if (!tool) {
      throw new Error(
        'VS Code proactive orchestration requires the caller-supplied native subagent tool.'
      );
    }
    return `Ultra (VS Code) orchestration is active at backend effort max. Proactively call the supplied VS Code subagent tool '${tool.alias}' when delegating bounded, independent work is materially useful. Issue only one subagent call at a time, inspect its result, and synthesize that result into the response. Do not delegate trivial or tightly coupled work. Never call Codex collaboration tools, spawn_agent, or any other built-in multi-agent tool. If VS Code rejects or cannot complete the delegated call, continue with single-agent reasoning instead of failing solely because delegation was unavailable.`;
  }

  private requirePassiveDirectory(): string {
    const directory = this.process.passiveDirectory;
    if (!directory) {
      throw new Error('The app-server passive directory is unavailable.');
    }
    return directory;
  }

  private async handleServerRequest(request: JsonRpcServerRequestContext): Promise<void> {
    try {
      await this.turnCoordinator.handleServerRequest({
        id: request.id,
        method: request.method,
        params: request.params,
        respond: (result) => request.respond(result),
        reject: (code, message) => request.reject({ code, message })
      });
    } catch (error) {
      if (!request.settled) {
        await request.reject({
          code: -32000,
          message: 'App-server request handling failed.'
        }).catch(() => undefined);
      }
      this.outputChannel.warn('app-server request handler failed', {
        method: request.method,
        status: error instanceof Error ? error.name : 'unknown'
      });
    }
  }

  private async handleDynamicToolBridgeFailure(
    threadId: string,
    turnId: string,
    error: unknown
  ): Promise<void> {
    await this.turnCoordinator.failTurn(threadId, turnId, error, {
      interruptRemote: false
    }).catch(() => undefined);
    const branch = this.branches.findByActiveTurn(threadId, turnId);
    if (branch) {
      this.deletePendingCallMappings(branch.id);
      this.branches.remove(branch.id, 'invalidated');
    }
  }

  private async handleProcessGenerationChanged(generation: number): Promise<void> {
    const accountInvalidated = this.auth.invalidateProcess();
    this.cachedModels = undefined;
    this.accountUsage.invalidate();
    this.rateLimitsBootstrap = undefined;
    this.lastRateLimitRefreshAt = 0;
    if (accountInvalidated) {
      this.accountEmitter.fire();
    }
    await this.turnCoordinator.invalidateAll('The Codex app-server process changed.', {
      interruptRemote: false
    });
    if (generation !== this.process.generation) {
      return;
    }
    this.branches.invalidateProcessGeneration(generation);
    this.models.invalidateContextWindows();
    this.modelsEmitter.fire();
  }

  private async handleRuntimeCommandChanged(): Promise<void> {
    this.cachedModels = undefined;
    this.reservedContinuationBranches.clear();
    await this.turnCoordinator.invalidateAll('The configured Codex executable changed.');
    this.branches.invalidateAll('processChanged');
    this.threadModels.clear();
    this.pendingCallsByBranch.clear();
    this.reservedToolResumeBranches.clear();
    this.eventRouter.clearAll();
    this.models.invalidateContextWindows();
    await this.process.shutdown();
    this.modelsEmitter.fire();
  }

  private async handleAccountChanged(generation: number): Promise<void> {
    this.cachedModels = undefined;
    this.accountUsage.invalidate();
    await this.turnCoordinator.invalidateAll('The shared Codex account changed.');
    if (generation !== this.auth.generation) {
      return;
    }
    this.branches.invalidateAccountGeneration(generation);
    this.models.invalidateContextWindows();
    this.accountEmitter.fire();
    this.modelsEmitter.fire();
    void this.readRateLimits().catch(() => undefined);
  }

  private async cleanupBranch(branch: ConversationBranch<ResponsesInputMessage>): Promise<void> {
    if (branch.activeTurn) {
      await this.turnCoordinator.failTurn(
        branch.threadId,
        branch.activeTurn.turnId,
        new Error('The conversation branch was evicted.')
      ).catch(() => undefined);
    }
    await this.toolBridge.clearThread(branch.threadId).catch(() => undefined);
    this.eventRouter.clearThread(branch.threadId);
    this.threadModels.delete(branch.threadId);
    this.deletePendingCallMappings(branch.id);
    if (branch.processGeneration === this.process.generation && this.process.state === 'ready') {
      await this.process.request('thread/unsubscribe', { threadId: branch.threadId }).catch(() => undefined);
    }
  }

  private async discardThread(threadId: string): Promise<void> {
    await this.toolBridge.clearThread(threadId).catch(() => undefined);
    this.eventRouter.clearThread(threadId);
    this.threadModels.delete(threadId);
    if (this.process.state === 'ready') {
      await this.process.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
  }

  private async abandonPendingBranch(
    branch: ConversationBranch<ResponsesInputMessage>,
    reason: string
  ): Promise<void> {
    if (branch.activeTurn) {
      await this.turnCoordinator.failMissingToolResult(
        branch.threadId,
        branch.activeTurn.turnId
      ).catch(() => undefined);
      await this.turnCoordinator.failTurn(
        branch.threadId,
        branch.activeTurn.turnId,
        new Error(reason)
      ).catch(() => undefined);
    }
    this.branches.remove(branch.id, 'invalidated');
  }

  private findPendingBranches(
    callId: string,
    envelope: ConversationEnvelope,
    projectedHistory: readonly ResponsesInputMessage[]
  ): ConversationBranch<ResponsesInputMessage>[] {
    const envelopeHash = hashConversationEnvelope(envelope);
    const candidates: ConversationBranch<ResponsesInputMessage>[] = [];
    for (const [branchId, binding] of this.pendingCallsByBranch) {
      if (binding.callId !== callId) {
        continue;
      }
      const branch = this.branches.get(branchId);
      if (!branch
        || !branch.activeTurn
        || branch.threadId !== binding.threadId
        || branch.activeTurn.turnId !== binding.turnId) {
        this.pendingCallsByBranch.delete(branchId);
        continue;
      }
      if (branch.envelopeHash === envelopeHash
        && isExactToolResultAppend(branch.projectedHistory, projectedHistory, callId)) {
        candidates.push(branch);
      }
    }
    return candidates.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  private getMappedPendingBranches(callId: string): ConversationBranch<ResponsesInputMessage>[] {
    const branches: ConversationBranch<ResponsesInputMessage>[] = [];
    for (const [branchId, binding] of this.pendingCallsByBranch) {
      if (binding.callId !== callId) {
        continue;
      }
      const branch = this.branches.get(branchId);
      if (branch?.activeTurn
        && branch.threadId === binding.threadId
        && branch.activeTurn.turnId === binding.turnId) {
        branches.push(branch);
      } else {
        this.pendingCallsByBranch.delete(branchId);
      }
    }
    return branches;
  }

  private setPendingCallBinding(
    branch: ConversationBranch<ResponsesInputMessage>,
    turnId: string,
    callId: string
  ): void {
    this.pendingCallsByBranch.set(branch.id, {
      branchId: branch.id,
      threadId: branch.threadId,
      turnId,
      callId
    });
  }

  private deletePendingCallMappings(branchId: string): void {
    this.pendingCallsByBranch.delete(branchId);
    this.reservedToolResumeBranches.delete(branchId);
  }

  private refreshRateLimitsAfterTurn(): void {
    const now = Date.now();
    if (now - this.lastRateLimitRefreshAt < RATE_LIMIT_REFRESH_THROTTLE_MS) {
      return;
    }
    this.lastRateLimitRefreshAt = now;
    void this.readRateLimits().catch(() => undefined);
  }

  private bootstrapRateLimits(): void {
    if (this.accountUsage.snapshot || this.rateLimitsBootstrap) {
      return;
    }
    const pending = this.readRateLimits()
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (this.rateLimitsBootstrap === pending) {
          this.rateLimitsBootstrap = undefined;
        }
      });
    this.rateLimitsBootstrap = pending;
  }

  private async runAuthenticatedAccountUsage<T>(operation: () => Promise<T>): Promise<T> {
    let account: AccountSnapshot | undefined;
    try {
      account = await this.auth.readAccount(false);
    } catch (error) {
      if (error instanceof ChatGptAccountRequiredError) {
        throw vscode.LanguageModelError.NoPermissions(error.message);
      }
      throw error;
    }
    if (!account) {
      throw vscode.LanguageModelError.NoPermissions('Sign in with ChatGPT to read Codex account usage.');
    }

    const accountGeneration = this.auth.generation;
    const result = await operation();
    if (accountGeneration !== this.auth.generation || !this.auth.account) {
      this.accountUsage.invalidate();
      throw new AppServerProtocolError('The shared Codex account changed while account usage was being read.');
    }
    return result;
  }

  private logDiagnostic(event: AppServerDiagnosticEvent): void {
    this.outputChannel.debug('app-server lifecycle', {
      status: event.status ?? event.kind,
      generation: event.generation,
      runtimeVersion: event.runtimeVersion,
      method: event.method ?? event.rpc?.method,
      durationMs: event.durationMs ?? event.rpc?.durationMs,
      stderrBytes: event.stderrBytes,
      stderrLines: event.stderrLines,
      retryState: undefined
    });
    if (event.kind === 'runtime-validated'
      && event.runtimeVersion
      && event.runtimeVersion !== this.warnedNewerRuntimeVersion
      && isCodexCliVersionNewerThanValidated(event.runtimeVersion)) {
      this.warnedNewerRuntimeVersion = event.runtimeVersion;
      void vscode.window.showWarningMessage(
        `Codex CLI ${event.runtimeVersion} is newer than ${LATEST_VALIDATED_CODEX_CLI_VERSION}, the latest version validated for this CodexVS release. Compatibility will be checked as features are used.`
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('The Codex app-server backend is disposed.');
    }
  }
}

function requirePassiveThreadResponse(
  response: ThreadResponse,
  method: string,
  passiveDirectory: string,
  requestedModel: string,
  requestedServiceTier: string | undefined,
  runtimeVersion: string
): string {
  const record = response as Record<string, unknown>;
  const thread = isRecord(record.thread) ? record.thread : undefined;
  const sandbox = isRecord(record.sandbox) ? record.sandbox : undefined;
  const threadId = thread?.id;
  const invariants: Array<[string, boolean]> = [
    ['threadId', typeof threadId === 'string' && threadId.length > 0],
    ['model', record.model === requestedModel],
    ['modelProvider', record.modelProvider === 'openai'],
    ['serviceTier', requestedServiceTier === undefined
      || (record.serviceTier ?? null) === requestedServiceTier],
    ['cwd', samePath(record.cwd, passiveDirectory)],
    ['runtimeWorkspaceRoots', Array.isArray(record.runtimeWorkspaceRoots)
      && record.runtimeWorkspaceRoots.length === 0],
    ['instructionSources', Array.isArray(record.instructionSources)
      && record.instructionSources.length === 0],
    ['approvalPolicy', record.approvalPolicy === 'never'],
    ['sandbox', sandbox?.type === 'readOnly' && sandbox.networkAccess === false],
    ['threadEphemeral', thread?.ephemeral === true],
    ['threadModelProvider', thread?.modelProvider === 'openai'],
    ['threadCwd', samePath(thread?.cwd, passiveDirectory)]
  ];
  const failed = invariants.filter(([, valid]) => !valid).map(([name]) => name);
  if (!thread || typeof threadId !== 'string' || !threadId) {
    throw new AppServerProtocolError(
      `App-server returned an incomplete ${method} response.`,
      method,
      runtimeVersion
    );
  }
  if (failed.length > 0) {
    throw new PassivePolicyViolationError(`${method} response`, failed.join(','));
  }
  return threadId;
}

function requireTurnId(response: TurnResponse, runtimeVersion: string): string {
  const turnId = response.turn?.id;
  if (typeof turnId !== 'string' || !turnId) {
    throw new AppServerProtocolError(
      'App-server returned an invalid turn/start response.',
      'turn/start',
      runtimeVersion
    );
  }
  return turnId;
}

function mapUsage(usage: ThreadTokenUsage): BackendUsage {
  return {
    inputTokens: usage.last.inputTokens,
    cachedInputTokens: usage.last.cachedInputTokens,
    outputTokens: usage.last.outputTokens,
    reasoningOutputTokens: usage.last.reasoningOutputTokens,
    totalTokens: usage.last.totalTokens,
    modelContextWindow: usage.modelContextWindow ?? undefined
  };
}

function getHistoryAfterProjectedPrefix(
  fullHistory: readonly ResponsesInputMessage[],
  projectedPrefixLength: number
): ResponsesInputMessage[] {
  if (projectedPrefixLength <= 0) {
    return [...fullHistory];
  }

  let projectedCount = 0;
  for (let index = 0; index < fullHistory.length; index += 1) {
    const item = fullHistory[index];
    if (projectResponsesInputForContinuation([item]).length > 0) {
      if (projectedCount === projectedPrefixLength) {
        return fullHistory.slice(index);
      }
      projectedCount += 1;
    }
  }
  return [];
}

function aliasInjectedFunctionCalls(
  items: readonly ResponsesInputMessage[],
  catalog: DynamicToolCatalog
): ResponsesInputMessage[] {
  return items.map((item) => {
    if (item.type !== 'function_call') {
      return item;
    }
    const registered = catalog.byOriginalName.get(item.name);
    return registered ? { ...item, name: registered.alias } : item;
  });
}

function historyIsPrefix(
  prefix: readonly ResponsesInputMessage[],
  history: readonly ResponsesInputMessage[]
): boolean {
  if (prefix.length > history.length) {
    return false;
  }
  return prefix.every((item, index) => stableSerialize(item) === stableSerialize(history[index]));
}

function isExactToolResultAppend(
  previousHistory: readonly ResponsesInputMessage[],
  currentHistory: readonly ResponsesInputMessage[],
  callId: string
): boolean {
  if (currentHistory.length !== previousHistory.length + 1
    || !historyIsPrefix(previousHistory, currentHistory)) {
    return false;
  }
  const appended = currentHistory.at(-1);
  return appended?.type === 'function_call_output' && appended.call_id === callId;
}

function isExactCurrentUserAppend(
  appendedHistory: readonly ResponsesInputMessage[],
  request: BackendChatRequest
): boolean {
  if (request.toolResults.length > 0 || request.currentInput.length === 0) {
    return false;
  }

  const currentHistory = request.fullHistory.slice(request.historyBeforeCurrent.length);
  const currentProjectedHistory = projectResponsesInputForContinuation(currentHistory);
  const appended = appendedHistory[0];
  const current = currentProjectedHistory[0];
  return appendedHistory.length === 1
    && currentProjectedHistory.length === 1
    && appended?.type === 'message'
    && appended.role === 'user'
    && current?.type === 'message'
    && current.role === 'user'
    && stableSerialize(appended) === stableSerialize(current);
}

function samePath(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const actualPath = resolve(value);
  const expectedPath = resolve(expected);
  return process.platform === 'win32'
    ? actualPath.toLowerCase() === expectedPath.toLowerCase()
    : actualPath === expectedPath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingEphemeralForkRollout(error: unknown): boolean {
  return error instanceof JsonRpcResponseError
    && error.code === -32600
    && /^no rollout found for thread id\b/i.test(error.message);
}
