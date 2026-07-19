import * as vscode from 'vscode';
import type { CodexAppServerBackend } from './appServer/codexBackend';
import type { BackendModel } from './appServer/types';
import type { ProviderIntegrationAdvisor } from './provider';
import {
  getReasoningModeDescription,
  getReasoningModeLabel,
  normalizeCatalogReasoningModes,
  normalizeReasoningMode,
  type ReasoningMode
} from './reasoning';

const UTILITY_MODEL_SETTING = 'utilityModel';
const UTILITY_SMALL_MODEL_SETTING = 'utilitySmallModel';
const REASONING_EFFORT_SETTING = 'defaultReasoningEffort';
const CONFIGURE_ACTION = 'Configure Utility Models';

export type ReasoningEffortSetting = ReasoningMode | 'auto';

export interface UtilityModelSettingsStatus {
  utilityModel?: string;
  utilitySmallModel?: string;
  configured: boolean;
}

interface ModelQuickPickItem extends vscode.QuickPickItem {
  model: vscode.LanguageModelChat;
}

export interface ReasoningQuickPickItem extends vscode.QuickPickItem {
  effort: ReasoningEffortSetting;
}

export class VsCodeIntegrationAdvisor implements ProviderIntegrationAdvisor {
  private warningShown = false;

  constructor(private readonly outputChannel: vscode.LogOutputChannel) {}

  onModelSelected(): void {
    const status = readUtilityModelSettings();
    this.outputChannel.debug('VS Code utility model configuration', {
      utilityModelConfigured: Boolean(status.utilityModel),
      utilitySmallModelConfigured: Boolean(status.utilitySmallModel)
    });
    if (status.configured || this.warningShown) {
      return;
    }

    this.warningShown = true;
    void vscode.window.showWarningMessage(
      'VS Code requires chat.utilityModel and chat.utilitySmallModel when a BYOK model is the main agent. Configure both to stop Copilot utility-tool failures.',
      CONFIGURE_ACTION
    ).then((action) => {
      if (action === CONFIGURE_ACTION) {
        return vscode.commands.executeCommand('codexvs.configureUtilityModels');
      }
      return undefined;
    });
  }

  async configureUtilityModels(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'codexvs' });
    if (models.length === 0) {
      await vscode.window.showErrorMessage(
        'No CodexVS model is currently available. Sign in to ChatGPT and retry.'
      );
      return;
    }

    const modelItems: ModelQuickPickItem[] = models.map((model) => ({
        label: model.name,
        description: model.family,
        detail: `${model.vendor}/${model.id}`,
        model
      }));
    const utilityModel = await vscode.window.showQuickPick(
      modelItems,
      {
        title: 'Choose the general VS Code utility model',
        placeHolder: 'Used for titles, summaries, settings search, and Git review.'
      }
    );
    if (!utilityModel) {
      return;
    }

    const utilitySmallModel = await vscode.window.showQuickPick(
      [...modelItems].sort((left, right) =>
        smallModelPreference(left.model) - smallModelPreference(right.model)),
      {
        title: 'Choose the small VS Code utility model',
        placeHolder: 'A fast, inexpensive model is best for intent and lightweight tasks.'
      }
    );
    if (!utilitySmallModel) {
      return;
    }

    const utilityIdentifier = `${utilityModel.model.vendor}/${utilityModel.model.id}`;
    const utilitySmallIdentifier = `${utilitySmallModel.model.vendor}/${utilitySmallModel.model.id}`;
    const configuration = vscode.workspace.getConfiguration('chat');
    await configuration.update(
      UTILITY_MODEL_SETTING,
      utilityIdentifier,
      vscode.ConfigurationTarget.Global
    );
    await configuration.update(
      UTILITY_SMALL_MODEL_SETTING,
      utilitySmallIdentifier,
      vscode.ConfigurationTarget.Global
    );
    await vscode.window.showInformationMessage(
      `VS Code utility models now use ${utilityModel.model.name} and ${utilitySmallModel.model.name}.`
    );
  }

  async configureReasoningEffort(backend: CodexAppServerBackend): Promise<void> {
    const current = readReasoningEffortSetting();
    const cancellation = new vscode.CancellationTokenSource();
    let models: BackendModel[];
    try {
      models = await backend.listModels(cancellation.token);
    } catch {
      await vscode.window.showErrorMessage(
        'The live Codex model catalog is unavailable. Check the app-server runtime and retry.'
      );
      return;
    } finally {
      cancellation.dispose();
    }
    const items = buildReasoningQuickPickItems(models);
    if (items.length === 1) {
      await vscode.window.showErrorMessage(
        'The live Codex model catalog does not advertise any reasoning modes.'
      );
      return;
    }
    const selected = await vscode.window.showQuickPick(
      items.map((item) => ({
        ...item,
        picked: item.effort === current
      })),
      {
        title: 'Choose the default Codex thinking effort',
        placeHolder: 'The per-chat model picker can override this default on supported VS Code versions.'
      }
    );
    if (!selected) {
      return;
    }

    await vscode.workspace.getConfiguration('codexvs').update(
      REASONING_EFFORT_SETTING,
      selected.effort,
      vscode.ConfigurationTarget.Global
    );
    await vscode.window.showInformationMessage(
      `Default Codex thinking effort is now ${selected.label}. Per-chat model picker choices override it.`
    );
  }

  async showDiagnostics(backend: CodexAppServerBackend): Promise<void> {
    let runtimeStatus = 'unavailable';
    try {
      await backend.ensureReady();
      runtimeStatus = backend.runtimeVersion ?? 'unknown';
    } catch (error) {
      runtimeStatus = error instanceof Error ? error.name : 'failed';
    }

    const [models, tools] = await Promise.all([
      vscode.lm.selectChatModels({ vendor: 'codexvs' }),
      Promise.resolve(vscode.lm.tools)
    ]);
    const utility = readUtilityModelSettings();
    const defaultReasoningEffort = readReasoningEffortSetting();
    const diagnostic = {
      codexCli: runtimeStatus,
      processGeneration: backend.processGeneration,
      discoveredModels: models.length,
      registeredVsCodeTools: tools.length,
      utilityModelConfigured: Boolean(utility.utilityModel),
      utilitySmallModelConfigured: Boolean(utility.utilitySmallModel),
      defaultReasoningEffort,
      workspaceTrusted: vscode.workspace.isTrusted,
      extensionHost: vscode.env.remoteName ?? 'local'
    };
    this.outputChannel.info('integration diagnostics', diagnostic);
    this.outputChannel.show(true);

    const summary = `Codex ${runtimeStatus}; ${models.length} model(s); ${tools.length} VS Code tool(s); utility models ${utility.configured ? 'configured' : 'missing'}; workspace ${vscode.workspace.isTrusted ? 'trusted' : 'restricted'}.`;
    const action = utility.configured
      ? await vscode.window.showInformationMessage(summary)
      : await vscode.window.showWarningMessage(summary, CONFIGURE_ACTION);
    if (action === CONFIGURE_ACTION) {
      await this.configureUtilityModels();
    }
  }
}

export function readUtilityModelSettings(): UtilityModelSettingsStatus {
  const configuration = vscode.workspace.getConfiguration('chat');
  const utilityModel = normalizeSetting(configuration.get<string>(UTILITY_MODEL_SETTING));
  const utilitySmallModel = normalizeSetting(configuration.get<string>(UTILITY_SMALL_MODEL_SETTING));
  return {
    utilityModel,
    utilitySmallModel,
    configured: Boolean(utilityModel && utilitySmallModel)
  };
}

export function readReasoningEffortSetting(): ReasoningEffortSetting {
  const configured = vscode.workspace.getConfiguration('codexvs')
    .get<unknown>(REASONING_EFFORT_SETTING, 'auto');
  return configured === 'auto' ? 'auto' : normalizeReasoningMode(configured) ?? 'auto';
}

export function buildReasoningQuickPickItems(
  models: readonly BackendModel[]
): ReasoningQuickPickItem[] {
  const items: ReasoningQuickPickItem[] = [{
    label: 'Auto (model default)',
    detail: 'Use the reasoning mode advertised as the selected model\'s default.',
    effort: 'auto'
  }];
  const seen = new Set<string>();
  for (const model of models.filter((candidate) => !candidate.hidden)) {
    for (const option of normalizeCatalogReasoningModes(model.supportedReasoningEfforts)) {
      if (seen.has(option.id)) {
        continue;
      }
      seen.add(option.id);
      items.push({
        label: getReasoningModeLabel(option.id),
        detail: option.description || getReasoningModeDescription(option.id),
        effort: option.id
      });
    }
  }
  return items;
}

function normalizeSetting(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function smallModelPreference(model: vscode.LanguageModelChat): number {
  return /(?:mini|small|spark|nano|fast)/i.test(`${model.id} ${model.name} ${model.family}`)
    ? 0
    : 1;
}
