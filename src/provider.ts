import * as vscode from 'vscode';
import { MINIMUM_CODEX_CLI_VERSION } from './appServer/runtime';
import type {
  BackendUsage,
  CodexBackend,
  OrchestrationMode
} from './appServer/backend';
import {
  AppServerProtocolError,
  ChatGptAccountRequiredError,
  OperationCancelledError
} from './appServer/types';
import {
  AppServerTurnError,
  HostTurnCancellationError,
  PassivePolicyViolationError,
  RequiredToolModeError
} from './appServer/turnCoordinator';
import {
  convertMessageToUserInput,
  convertMessagesToResponsesInput,
  estimateTokenCount,
  projectResponsesInputForContinuation
} from './convertMessages';
import { getProviderConfig, type ProviderConfig } from './config';
import {
  buildProviderModels,
  resolveProviderModel,
  type ResolvedProviderModel
} from './models';
import { normalizeReasoningMode, type ReasoningMode } from './reasoning';

type RuntimeProvideLanguageModelChatResponseOptions = vscode.ProvideLanguageModelChatResponseOptions & {
  readonly modelConfiguration?: Record<string, unknown>;
  readonly configuration?: Record<string, unknown>;
};

type VSCodeWithThinkingPart = typeof vscode & {
  LanguageModelThinkingPart?: new (
    value: string | string[],
    id?: string,
    metadata?: { readonly [key: string]: any }
  ) => unknown;
};

type VSCodeWithDataPart = typeof vscode & {
  LanguageModelDataPart?: {
    json(value: unknown, mime?: string): unknown;
  };
};

const USAGE_DATA_PART_MIME = 'usage';
const NATIVE_VSCODE_SUBAGENT_TOOL_NAMES = new Set(['runSubagent', 'agent/runSubagent']);

export interface ResolvedReasoningRequest {
  requestedMode?: ReasoningMode;
  backendEffort?: ReasoningMode;
  orchestrationMode: OrchestrationMode;
  vsCodeSubagentToolName?: string;
}

export interface SelectedModelSink {
  setSelectedModel(model: string): void;
}

export interface ProviderIntegrationAdvisor {
  onModelSelected(): void;
}

export class VsCodexProvider implements vscode.LanguageModelChatProvider {
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>;
  private readonly modelInfoChangedEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly outputChannel: vscode.LogOutputChannel,
    private readonly backend: CodexBackend,
    private readonly selectedModelSink?: SelectedModelSink,
    private readonly integrationAdvisor?: ProviderIntegrationAdvisor
  ) {
    this.onDidChangeLanguageModelChatInformation = this.modelInfoChangedEmitter.event;
    this.disposables.push(
      this.modelInfoChangedEmitter,
      this.backend.onDidChangeAccount(() => this.modelInfoChangedEmitter.fire()),
      this.backend.onDidChangeModels(() => this.modelInfoChangedEmitter.fire()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('vsCodex')) {
          this.modelInfoChangedEmitter.fire();
        }
      })
    );
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const startedAt = Date.now();
    try {
      let models = await this.discoverModels(token);
      if (models.length === 0 && !options.silent) {
        const account = await this.backend.readAccount(false);
        if (!account) {
          const didSignIn = await promptForChatGptSignIn(
            'Sign in with ChatGPT to use Codex models in VS Code.'
          );
          if (didSignIn) {
            models = await this.discoverModels(token);
          }
        }
      }

      this.outputChannel.debug('language model catalog request', {
        status: 'completed',
        durationMs: Date.now() - startedAt,
        processGeneration: this.backend.processGeneration,
        runtimeVersion: this.backend.runtimeVersion
      });
      return models.map((model) => model.info);
    } catch (error) {
      this.outputChannel.debug('language model catalog request', {
        status: error instanceof Error ? error.name : 'failed',
        durationMs: Date.now() - startedAt,
        processGeneration: this.backend.processGeneration,
        runtimeVersion: this.backend.runtimeVersion
      });
      if (token.isCancellationRequested || error instanceof OperationCancelledError) {
        throw new vscode.CancellationError();
      }
      if (options.silent) {
        return [];
      }
      if (error instanceof ChatGptAccountRequiredError) {
        await promptForChatGptSignIn(
          'Codex is using an unsupported authentication mode. Sign in with ChatGPT to use this provider.'
        );
        return [];
      }
      if (error instanceof AppServerProtocolError) {
        await vscode.window.showErrorMessage(
          `Codex model discovery is incompatible with the installed app-server (${error.message}) Check the vsCodex logs or update Codex CLI.`
        );
        return [];
      }
      await vscode.window.showErrorMessage(
        'Codex app-server is unavailable. Run “Codex: Check App-server Runtime” for installation or version guidance.'
      );
      return [];
    }
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      const config = getProviderConfig();
      const availableModels = await this.discoverModels(token);
      if (availableModels.length === 0) {
        const account = await this.backend.readAccount(false);
        if (!account) {
          throw vscode.LanguageModelError.NoPermissions('Sign in with ChatGPT to use Codex.');
        }
      }
      const selected = resolveProviderModel(model.id, config, availableModels);
      if (!selected) {
        throw vscode.LanguageModelError.NotFound('The selected Codex model is no longer available.');
      }
      this.selectedModelSink?.setSelectedModel(selected.requestModel);
      this.integrationAdvisor?.onModelSelected();

      const reasoning = resolveReasoningRequest(
        selected,
        options as RuntimeProvideLanguageModelChatResponseOptions,
        config.defaultReasoningEffort,
        options.tools ?? []
      );
      this.outputChannel.info('language model request shape', {
        ...summarizeRequestShape(messages, options),
        requestedMode: reasoning.requestedMode ?? 'model-default',
        backendEffort: reasoning.backendEffort ?? 'model-default',
        orchestrationMode: reasoning.orchestrationMode,
        vsCodeDelegationAvailable: reasoning.vsCodeSubagentToolName !== undefined
      });
      const serviceTier = getServiceTier(selected, config);
      const fullHistory = convertMessagesToResponsesInput(messages);
      const currentMessage = messages.at(-1);
      const historyBeforeCurrent = convertMessagesToResponsesInput(messages.slice(0, -1));
      const currentInput = currentMessage ? convertMessageToUserInput(currentMessage) : [];
      const toolResults = currentMessage
        ? currentMessage.content
            .filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
            .map((part) => ({ callId: part.callId, content: part.content }))
        : [];
      let usageReported = false;

      await this.backend.runChat({
        model: selected.requestModel,
        requestedMode: reasoning.requestedMode,
        backendEffort: reasoning.backendEffort,
        orchestrationMode: reasoning.orchestrationMode,
        vsCodeSubagentToolName: reasoning.vsCodeSubagentToolName,
        serviceTier,
        developerInstructions: config.instructions,
        toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
        tools: (options.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        fullHistory,
        historyBeforeCurrent,
        projectedHistory: projectResponsesInputForContinuation(fullHistory),
        currentInput,
        toolResults
      }, {
        text: (delta) => progress.report(new vscode.LanguageModelTextPart(delta)),
        thinking: (delta) => {
          const thinkingPart = createThinkingPart(delta);
          if (thinkingPart) {
            progress.report(thinkingPart);
          }
        },
        toolCall: (callId, name, input) => {
          progress.report(new vscode.LanguageModelToolCallPart(callId, name, input));
        },
        usage: (usage) => {
          if (usageReported) {
            return;
          }
          usageReported = true;
          const usagePart = createUsageDataPart(usage);
          if (usagePart) {
            progress.report(usagePart);
          }
        }
      }, token);

      this.outputChannel.debug('language model turn', {
        status: 'completed',
        durationMs: Date.now() - startedAt,
        processGeneration: this.backend.processGeneration,
        runtimeVersion: this.backend.runtimeVersion
      });
    } catch (error) {
      this.outputChannel.debug('language model turn', {
        status: error instanceof Error ? error.name : 'failed',
        durationMs: Date.now() - startedAt,
        processGeneration: this.backend.processGeneration,
        runtimeVersion: this.backend.runtimeVersion
      });
      throw mapProviderError(error);
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }
    return estimateTokenCount(text);
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async discoverModels(token: vscode.CancellationToken): Promise<ResolvedProviderModel[]> {
    const config = getProviderConfig();
    const models = await this.backend.listModels(token);
    return buildProviderModels(
      config,
      models,
      this.backend.runtimeVersion ?? MINIMUM_CODEX_CLI_VERSION
    );
  }
}

function summarizeRequestShape(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions
): Record<string, number | string> {
  let userMessages = 0;
  let assistantMessages = 0;
  let textParts = 0;
  let textCharacters = 0;
  let toolCallParts = 0;
  let toolResultParts = 0;
  let otherParts = 0;

  for (const message of messages) {
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      userMessages += 1;
    } else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      assistantMessages += 1;
    }
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textParts += 1;
        textCharacters += part.value.length;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCallParts += 1;
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        toolResultParts += 1;
      } else {
        otherParts += 1;
      }
    }
  }

  return {
    messageCount: messages.length,
    userMessages,
    assistantMessages,
    textParts,
    textCharacters,
    toolCallParts,
    toolResultParts,
    otherParts,
    toolDefinitions: options.tools?.length ?? 0,
    toolMode: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto'
  };
}

async function promptForChatGptSignIn(message: string): Promise<boolean> {
  const action = await vscode.window.showWarningMessage(
    message,
    'Sign in with ChatGPT',
    ...(vscode.env.remoteName ? [] : ['Use Device Code']),
    'Cancel'
  );
  if (action === 'Sign in with ChatGPT') {
    await vscode.commands.executeCommand('vsCodex.signInWithChatGPT');
    return true;
  }
  if (action === 'Use Device Code') {
    await vscode.commands.executeCommand('vsCodex.signInWithDeviceCode');
    return true;
  }
  return false;
}

function getServiceTier(
  selected: ResolvedProviderModel,
  config: ProviderConfig
): string | undefined {
  if (config.defaultServiceTier
    && selected.supportedServiceTiers.includes(config.defaultServiceTier)) {
    return config.defaultServiceTier;
  }
  return selected.defaultServiceTier
    && selected.supportedServiceTiers.includes(selected.defaultServiceTier)
    ? selected.defaultServiceTier
    : undefined;
}

export function resolveReasoningRequest(
  selected: ResolvedProviderModel,
  options: RuntimeProvideLanguageModelChatResponseOptions,
  defaultReasoningEffort: ReasoningMode | undefined,
  tools: readonly { readonly name: string }[]
): ResolvedReasoningRequest {
  const candidates = [
    normalizeReasoningMode(options.modelOptions?.reasoningEffort),
    normalizeReasoningMode(
      (options.modelOptions?.reasoning as { effort?: unknown } | undefined)?.effort
    ),
    normalizeReasoningMode(
      options.modelConfiguration?.reasoningEffort ?? options.configuration?.reasoningEffort
    ),
    defaultReasoningEffort,
    selected.reasoningEffort
  ];
  const requestedMode = candidates.find((effort): effort is ReasoningMode =>
    effort !== undefined
    && selected.supportedReasoningEfforts.includes(effort)
    && (effort !== 'ultra' || selected.supportedReasoningEfforts.includes('max')));
  const vsCodeSubagentToolName = tools.find((tool) =>
    NATIVE_VSCODE_SUBAGENT_TOOL_NAMES.has(tool.name))?.name;
  const orchestrationMode: OrchestrationMode = requestedMode === 'ultra'
    && vsCodeSubagentToolName
    ? 'vscodeProactive'
    : 'standard';

  return {
    requestedMode,
    backendEffort: requestedMode === 'ultra' ? 'max' : requestedMode,
    orchestrationMode,
    vsCodeSubagentToolName
  };
}

function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
  const ThinkingPart = (vscode as VSCodeWithThinkingPart).LanguageModelThinkingPart;
  return typeof ThinkingPart === 'function'
    ? new ThinkingPart(text) as vscode.LanguageModelResponsePart
    : undefined;
}

function createUsageDataPart(usage: BackendUsage): vscode.LanguageModelResponsePart | undefined {
  const DataPart = (vscode as VSCodeWithDataPart).LanguageModelDataPart;
  if (typeof DataPart?.json !== 'function') {
    return undefined;
  }
  return DataPart.json({
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: {
      cached_tokens: usage.cachedInputTokens
    },
    completion_tokens_details: {
      reasoning_tokens: usage.reasoningOutputTokens
    }
  }, USAGE_DATA_PART_MIME) as vscode.LanguageModelResponsePart;
}

function mapProviderError(error: unknown): Error {
  if (error instanceof vscode.CancellationError
    || error instanceof HostTurnCancellationError
    || error instanceof OperationCancelledError) {
    return new vscode.CancellationError();
  }
  if (error instanceof ChatGptAccountRequiredError) {
    return vscode.LanguageModelError.NoPermissions(error.message);
  }
  if (error instanceof PassivePolicyViolationError) {
    return vscode.LanguageModelError.Blocked(error.message);
  }
  if (error instanceof RequiredToolModeError) {
    return error;
  }
  if (error instanceof AppServerTurnError) {
    return error;
  }
  return error instanceof Error ? error : new Error('The Codex app-server request failed.');
}
