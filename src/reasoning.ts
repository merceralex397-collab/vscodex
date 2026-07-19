export type ReasoningMode = string;

export interface CatalogReasoningMode {
  id: ReasoningMode;
  description: string;
}

const REASONING_MODE_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
  ultra: 'Ultra (VS Code)'
};

const REASONING_MODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  none: 'Skip extra reasoning.',
  minimal: 'Use a very light reasoning pass.',
  low: 'Prefer faster, lighter reasoning.',
  medium: 'Balance speed and reasoning depth.',
  high: 'Use greater reasoning depth.',
  xhigh: 'Use extra-high reasoning depth.',
  max: 'Use maximum single-agent reasoning.',
  ultra: 'Use maximum reasoning with proactive VS Code subagent delegation when available.'
};

export function normalizeReasoningMode(value: unknown): ReasoningMode | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeCatalogReasoningModes(
  options: readonly { effort: unknown; description?: unknown }[]
): CatalogReasoningMode[] {
  const normalized: CatalogReasoningMode[] = [];
  for (const option of options) {
    const id = normalizeReasoningMode(option.effort);
    if (!id || normalized.some((candidate) => candidate.id === id)) {
      continue;
    }
    normalized.push({
      id,
      description: typeof option.description === 'string' ? option.description.trim() : ''
    });
  }

  const hasMax = normalized.some((option) => option.id === 'max');
  return normalized.filter((option) => option.id !== 'ultra' || hasMax);
}

export function getReasoningModeLabel(mode: ReasoningMode): string {
  return REASONING_MODE_LABELS[mode] ?? mode;
}

export function getReasoningModeDescription(mode: ReasoningMode): string {
  return REASONING_MODE_DESCRIPTIONS[mode]
    ?? `Use the catalog-advertised '${mode}' reasoning mode.`;
}
