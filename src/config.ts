import * as vscode from 'vscode';
import { normalizeReasoningMode, type ReasoningMode } from './reasoning';

export type PreferredServiceTier = 'default' | 'fast';

export interface ProviderConfig {
  appServerCommand: string;
  model: string;
  disabledModels: string[];
  modelAliases: Record<string, string>;
  instructions: string;
  defaultServiceTier?: PreferredServiceTier;
  defaultReasoningEffort?: ReasoningMode;
}

export const APP_SERVER_COMMAND_SETTING = 'codexvs.appServer.command';

export function getProviderConfig(): ProviderConfig {
  const config = vscode.workspace.getConfiguration('codexvs');

  return {
    appServerCommand: getMachineScopedAppServerCommand(config),
    model: normalizeOptionalString(config.get('model')) ?? 'gpt-5.5',
    disabledModels: normalizeStringList(config.get('disabledModels', [])),
    modelAliases: normalizeModelAliases(config.get('modelAliases', {})),
    instructions: normalizeOptionalString(config.get('instructions')) ?? 'You are a helpful coding assistant integrated with VS Code.',
    defaultServiceTier: normalizeDefaultServiceTier(config.get('defaultServiceTier', 'auto')),
    defaultReasoningEffort: normalizeDefaultReasoningEffort(config.get('defaultReasoningEffort', 'auto'))
  };
}

export function getMachineScopedAppServerCommand(
  config = vscode.workspace.getConfiguration('codexvs')
): string {
  const inspected = config.inspect<string>('appServer.command');
  return normalizeOptionalString(inspected?.globalValue)
    ?? normalizeOptionalString(inspected?.defaultValue)
    ?? 'codex';
}

function normalizeDefaultServiceTier(value: unknown): ProviderConfig['defaultServiceTier'] {
  switch (value) {
    case 'default':
    case 'fast':
      return value;
    default:
      return undefined;
  }
}

function normalizeDefaultReasoningEffort(value: unknown): ProviderConfig['defaultReasoningEffort'] {
  const mode = normalizeReasoningMode(value);
  return mode === 'auto' ? undefined : mode;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0))];
}

function normalizeModelAliases(value: unknown): Record<string, string> {
  if (!isObjectRecord(value)) {
    return {};
  }

  const aliases: Record<string, string> = {};
  for (const [source, target] of Object.entries(value)) {
    const normalizedSource = source.trim();
    const normalizedTarget = normalizeOptionalString(target);
    if (normalizedSource && normalizedTarget && normalizedSource !== normalizedTarget) {
      aliases[normalizedSource] = normalizedTarget;
    }
  }

  return aliases;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
