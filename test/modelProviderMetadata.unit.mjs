import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-model-metadata-'));
const bundlePath = path.join(temporaryDirectory, 'models.cjs');
const require = createRequire(import.meta.url);
const originalLoad = Module._load;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  await build({
    entryPoints: ['src/models.ts'],
    absWorkingDir: repositoryRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode']
  });

  const { buildProviderModels, resolveProviderModel } = require(bundlePath);
  const config = {
    appServerCommand: 'codex',
    model: 'gpt-5.5',
    disabledModels: [],
    modelAliases: { retired: 'gpt-5.5' },
    instructions: 'Be concise.',
    defaultReasoningEffort: 'low'
  };
  const models = buildProviderModels(config, [{
    id: 'gpt-5.5-entry',
    model: 'gpt-5.5',
    displayName: 'GPT-5.5 Codex',
    description: 'Discovered catalog entry.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { effort: 'low', description: 'Faster.' },
      { effort: 'high', description: 'Deeper.' }
    ],
    defaultReasoningEffort: 'high',
    inputModalities: ['text', 'image'],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Low latency.' }],
    defaultServiceTier: 'fast',
    contextWindow: 400_000,
    catalogHash: '0123456789abcdef'
  }], '0.144.4');

  assert.equal(models.length, 1);
  assert.equal(models[0].info.id, 'codex::gpt-5.5-entry');
  assert.equal(models[0].info.version, '0.144.4-0123456789ab');
  assert.equal(models[0].info.maxInputTokens, 391_808);
  assert.equal(models[0].info.maxOutputTokens, 8192);
  assert.equal(
    models[0].info.maxInputTokens + models[0].info.maxOutputTokens,
    400_000,
    'Advertised input and output limits must add up to the real context window.'
  );
  assert.equal(models[0].info.capabilities.imageInput, true);
  assert.deepEqual(models[0].info.configurationSchema, {
    type: 'object',
    properties: {
      reasoningEffort: {
        type: 'string',
        title: 'Thinking Effort',
        description: 'How much reasoning Codex uses for this model.',
        group: 'navigation',
        default: 'low',
        enum: ['low', 'high'],
        enumItemLabels: ['Low', 'High'],
        enumDescriptions: ['Faster.', 'Deeper.']
      }
    }
  });
  assert.match(models[0].info.detail, /reasoning: low, high/);
  assert.equal(models[0].reasoningEffort, 'high');
  assert.deepEqual(models[0].supportedReasoningEfforts, ['low', 'high']);
  assert.equal(resolveProviderModel('codex::gpt-5.5-entry', config, models), models[0]);
  assert.equal(resolveProviderModel('retired', config, models), models[0]);
  assert.equal(
    resolveProviderModel('codex::removed-model', config, models),
    undefined,
    'An explicitly selected model must not silently fall back to another catalog entry.'
  );

  const futureModels = buildProviderModels({
    ...config,
    model: 'gpt-future',
    modelAliases: {},
    defaultReasoningEffort: 'ultra'
  }, [{
    id: 'future-entry',
    model: 'gpt-future',
    displayName: 'GPT Future',
    description: 'Future catalog entry.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { effort: 'low', description: 'Catalog low.' },
      { effort: 'max', description: 'Catalog max.' },
      { effort: 'ultra', description: 'Catalog ultra.' },
      { effort: 'future-mode', description: 'Catalog future mode.' },
      { effort: 'max', description: 'Duplicate max must be ignored.' }
    ],
    defaultReasoningEffort: 'max',
    inputModalities: ['text'],
    serviceTiers: [],
    contextWindow: 272_000,
    catalogHash: 'future-catalog-hash'
  }], '0.144.4');
  assert.deepEqual(
    futureModels[0].supportedReasoningEfforts,
    ['low', 'max', 'ultra', 'future-mode'],
    'Reasoning modes preserve catalog order while removing duplicates.'
  );
  assert.deepEqual(
    futureModels[0].info.configurationSchema.properties.reasoningEffort.enumItemLabels,
    ['Low', 'Max', 'Ultra (VS Code)', 'future-mode']
  );
  assert.deepEqual(
    futureModels[0].info.configurationSchema.properties.reasoningEffort.enumDescriptions,
    ['Catalog low.', 'Catalog max.', 'Catalog ultra.', 'Catalog future mode.'],
    'Catalog descriptions are preserved verbatim.'
  );
  assert.equal(
    futureModels[0].info.configurationSchema.properties.reasoningEffort.default,
    'ultra',
    'A supported global setting takes precedence over the catalog default.'
  );

  const inconsistentModels = buildProviderModels({
    ...config,
    model: 'gpt-inconsistent',
    modelAliases: {},
    defaultReasoningEffort: 'ultra'
  }, [{
    id: 'inconsistent-entry',
    model: 'gpt-inconsistent',
    displayName: 'GPT Inconsistent',
    description: 'Inconsistent catalog entry.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { effort: 'high', description: 'Catalog high.' },
      { effort: 'ultra', description: 'Ultra without max.' }
    ],
    defaultReasoningEffort: 'ultra',
    inputModalities: ['text'],
    serviceTiers: [],
    contextWindow: 272_000,
    catalogHash: 'inconsistent-catalog-hash'
  }], '0.144.4');
  assert.deepEqual(
    inconsistentModels[0].supportedReasoningEfforts,
    ['high'],
    'Ultra is hidden when the same model does not advertise Max.'
  );
  assert.equal(inconsistentModels[0].reasoningEffort, 'high');

  console.log('Model provider metadata tests passed.');
} finally {
  Module._load = originalLoad;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
