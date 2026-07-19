import * as vscode from 'vscode';
import type { BackendModel } from './appServer/types';
import type { ProviderConfig } from './config';
import {
  getReasoningModeDescription,
  getReasoningModeLabel,
  normalizeCatalogReasoningModes,
  normalizeReasoningMode,
  type CatalogReasoningMode,
  type ReasoningMode
} from './reasoning';

const PROVIDER_MODEL_ID_PREFIX = 'codex::';
const DEFAULT_CONTEXT_WINDOW = 272_000;
const INTERNAL_MAX_OUTPUT_TOKENS = 8_192;
const FIXED_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'gpt-5.5': 272_000,
  'gpt-5.4': 272_000,
  'gpt-5.4-mini': 272_000,
  'gpt-5.3-codex-spark-preview': 128_000,
  'codex-auto-review': 272_000
};

interface ReasoningConfigurationSchema {
  readonly type: 'object';
  readonly properties: {
    readonly reasoningEffort: {
      readonly type: 'string';
      readonly title: string;
      readonly description: string;
      readonly group: 'navigation';
      readonly default: ReasoningMode;
      readonly enum: readonly ReasoningMode[];
      readonly enumItemLabels: readonly string[];
      readonly enumDescriptions: readonly string[];
    };
  };
}

interface ConfigurableLanguageModelChatInformation extends vscode.LanguageModelChatInformation {
  readonly configurationSchema?: ReasoningConfigurationSchema;
}

export interface ResolvedProviderModel {
  info: ConfigurableLanguageModelChatInformation;
  catalogId: string;
  requestModel: string;
  reasoningEffort?: ReasoningMode;
  supportedReasoningEfforts: ReasoningMode[];
  supportedServiceTiers: string[];
  defaultServiceTier?: string;
}

export interface ParsedModelIdentifier {
  catalogId: string;
}

export function buildProviderModels(
  config: ProviderConfig,
  backendModels: readonly BackendModel[],
  appServerVersion: string
): ResolvedProviderModel[] {
  const visibleModels = backendModels.filter((model) => !model.hidden);
  const availableNames = new Set(visibleModels.flatMap((model) => [model.id, model.model]));
  const aliasedSources = new Set(Object.entries(config.modelAliases)
    .filter(([, target]) => availableNames.has(target))
    .map(([source]) => source));
  const disabled = new Set(config.disabledModels);
  const preferredModel = config.modelAliases[config.model] ?? config.model;

  return visibleModels
    .filter((model) => !disabled.has(model.id) && !disabled.has(model.model))
    .filter((model) => !aliasedSources.has(model.id) && !aliasedSources.has(model.model))
    .sort((left, right) => modelPreference(left, preferredModel) - modelPreference(right, preferredModel))
    .map((model) => buildDiscoveredModel(model, appServerVersion, config.defaultReasoningEffort));
}

export function parseModelIdentifier(modelId: string): ParsedModelIdentifier {
  return {
    catalogId: modelId.startsWith(PROVIDER_MODEL_ID_PREFIX)
      ? modelId.slice(PROVIDER_MODEL_ID_PREFIX.length)
      : modelId
  };
}

export function resolveProviderModel(
  modelId: string | undefined,
  config: ProviderConfig,
  availableModels: readonly ResolvedProviderModel[]
): ResolvedProviderModel | undefined {
  const hasExplicitModel = typeof modelId === 'string' && modelId.length > 0;
  const requested = parseModelIdentifier(modelId ?? config.model).catalogId;
  const aliasTarget = config.modelAliases[requested];
  const candidates = [
    aliasTarget,
    requested,
    ...(hasExplicitModel ? [] : [config.model])
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const matched = availableModels.find((model) =>
      model.catalogId === candidate || model.requestModel === candidate);
    if (matched) {
      return matched;
    }
  }

  const exactProviderModel = availableModels.find((model) => model.info.id === modelId)
    ?? availableModels.find((model) => model.info.id === `${PROVIDER_MODEL_ID_PREFIX}${requested}`);
  if (exactProviderModel || hasExplicitModel) {
    return exactProviderModel;
  }
  return availableModels[0];
}

function buildDiscoveredModel(
  model: BackendModel,
  appServerVersion: string,
  configuredReasoningEffort: ReasoningMode | undefined
): ResolvedProviderModel {
  const reasoningOptionDetails = normalizeCatalogReasoningModes(model.supportedReasoningEfforts);
  const reasoningOptions = reasoningOptionDetails.map((option) => option.id);
  const catalogDefaultReasoningEffort = normalizeReasoningMode(model.defaultReasoningEffort);
  const defaultReasoningEffort = catalogDefaultReasoningEffort
    && reasoningOptions.includes(catalogDefaultReasoningEffort)
    ? catalogDefaultReasoningEffort
    : reasoningOptions[0];
  const contextWindow = model.contextWindow
    ?? FIXED_MODEL_CONTEXT_WINDOWS[model.model]
    ?? DEFAULT_CONTEXT_WINDOW;
  const serviceTierNames = model.serviceTiers.map((tier) => tier.id);
  const detailParts = [`${contextWindow.toLocaleString()} context`];
  if (reasoningOptions.length > 0) {
    detailParts.push(`reasoning: ${reasoningOptions.join(', ')}`);
  }
  if (serviceTierNames.length > 0) {
    detailParts.push(`tiers: ${serviceTierNames.join(', ')}`);
  }

  const configurationDefaultReasoningEffort = configuredReasoningEffort
    && reasoningOptions.includes(configuredReasoningEffort)
    ? configuredReasoningEffort
    : defaultReasoningEffort;
  const configurationSchema = configurationDefaultReasoningEffort && reasoningOptions.length > 1
    ? buildReasoningConfigurationSchema(
        reasoningOptionDetails,
        configurationDefaultReasoningEffort
      )
    : undefined;

  const info: ConfigurableLanguageModelChatInformation = {
    id: `${PROVIDER_MODEL_ID_PREFIX}${model.id}`,
    name: model.displayName || formatDisplayName(model.model),
    family: model.model,
    version: `${appServerVersion}-${model.catalogHash.slice(0, 12)}`,
    maxInputTokens: Math.max(1, contextWindow - INTERNAL_MAX_OUTPUT_TOKENS),
    maxOutputTokens: INTERNAL_MAX_OUTPUT_TOKENS,
    tooltip: model.description || `Codex model ${model.displayName || model.model}.`,
    detail: detailParts.join(' · '),
    capabilities: {
      imageInput: model.inputModalities.includes('image'),
      toolCalling: true
    },
    ...(configurationSchema ? { configurationSchema } : {})
  };

  return {
    info,
    catalogId: model.id,
    requestModel: model.model,
    reasoningEffort: defaultReasoningEffort,
    supportedReasoningEfforts: reasoningOptions,
    supportedServiceTiers: serviceTierNames,
    defaultServiceTier: model.defaultServiceTier
  };
}

function buildReasoningConfigurationSchema(
  options: readonly CatalogReasoningMode[],
  defaultReasoningEffort: ReasoningMode
): ReasoningConfigurationSchema {
  return {
    type: 'object',
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        description: 'How much reasoning Codex uses for this model.',
        group: 'navigation',
        default: defaultReasoningEffort,
        enum: options.map((option) => option.id),
        enumItemLabels: options.map((option) => getReasoningModeLabel(option.id)),
        enumDescriptions: options.map((option) =>
          option.description || getReasoningModeDescription(option.id))
      }
    }
  };
}

function modelPreference(model: BackendModel, preferredModel: string): number {
  if (model.id === preferredModel || model.model === preferredModel) {
    return 0;
  }
  return model.isDefault ? 1 : 2;
}

function formatDisplayName(value: string): string {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.toUpperCase() === 'GPT' ? 'GPT' : `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}
