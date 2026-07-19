import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codexvs-integration-'));
const bundlePath = path.join(temporaryDirectory, 'vs-code-integration.cjs');
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const settings = new Map();
const updates = [];
const models = [
  { vendor: 'codexvs', id: 'codex::large', name: 'Large', family: 'gpt-large' },
  { vendor: 'codexvs', id: 'codex::mini', name: 'Mini', family: 'gpt-mini' }
];
const backendModels = [{
  id: 'catalog-large',
  model: 'gpt-large',
  displayName: 'Large',
  description: 'Large model',
  hidden: false,
  isDefault: true,
  supportedReasoningEfforts: [
    { effort: 'low', description: 'Low from catalog.' },
    { effort: 'high', description: 'High from catalog.' },
    { effort: 'max', description: 'Max from catalog.' },
    { effort: 'ultra', description: 'Ultra from catalog.' },
    { effort: 'future-mode', description: 'Future from catalog.' }
  ],
  defaultReasoningEffort: 'high',
  inputModalities: ['text'],
  serviceTiers: [],
  catalogHash: 'catalog'
}];
let pickCount = 0;
const logs = [];
const quickPickSnapshots = [];

const vscodeStub = {
  CancellationTokenSource: class {
    token = { isCancellationRequested: false };
    dispose() {}
  },
  ConfigurationTarget: { Global: 1 },
  commands: { executeCommand: async () => undefined },
  env: { remoteName: undefined },
  lm: {
    tools: [{ name: 'read_file' }, { name: 'runSubagent' }],
    selectChatModels: async () => models
  },
  window: {
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showQuickPick: async (items) => {
      quickPickSnapshots.push(items);
      pickCount += 1;
      if (pickCount === 1) {
        return items.find((item) => item.model.id === 'codex::large');
      }
      if (pickCount === 2) {
        return items.find((item) => item.model.id === 'codex::mini');
      }
      return items.find((item) => item.effort === 'high');
    }
  },
  workspace: {
    isTrusted: true,
    getConfiguration(section) {
      return {
        get(key) {
          return settings.get(`${section}.${key}`);
        },
        async update(key, value, target) {
          settings.set(`${section}.${key}`, value);
          updates.push({ section, key, value, target });
        }
      };
    }
  }
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  await build({
    entryPoints: ['src/vsCodeIntegration.ts'],
    absWorkingDir: repositoryRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode']
  });

  const {
    buildReasoningQuickPickItems,
    readReasoningEffortSetting,
    readUtilityModelSettings,
    VsCodeIntegrationAdvisor
  } = require(bundlePath);
  assert.equal(readUtilityModelSettings().configured, false);
  assert.equal(readReasoningEffortSetting(), 'auto');
  settings.set('codexvs.defaultReasoningEffort', 'future-mode');
  assert.equal(
    readReasoningEffortSetting(),
    'future-mode',
    'The global setting accepts future catalog identifiers.'
  );
  settings.set('codexvs.defaultReasoningEffort', 'auto');
  assert.deepEqual(
    buildReasoningQuickPickItems(backendModels).map((item) => item.label),
    ['Auto (model default)', 'Low', 'High', 'Max', 'Ultra (VS Code)', 'future-mode']
  );
  assert.deepEqual(
    buildReasoningQuickPickItems([{
      ...backendModels[0],
      supportedReasoningEfforts: [
        { effort: 'high', description: 'High.' },
        { effort: 'ultra', description: 'Inconsistent Ultra.' }
      ]
    }]).map((item) => item.effort),
    ['auto', 'high'],
    'The configuration command hides Ultra when Max is absent.'
  );

  const advisor = new VsCodeIntegrationAdvisor({
    debug(message, metadata) {
      logs.push({ level: 'debug', message, metadata });
    },
    info(message, metadata) {
      logs.push({ level: 'info', message, metadata });
    },
    show() {}
  });
  await advisor.configureUtilityModels();

  assert.deepEqual(updates, [
    { section: 'chat', key: 'utilityModel', value: 'codexvs/codex::large', target: 1 },
    { section: 'chat', key: 'utilitySmallModel', value: 'codexvs/codex::mini', target: 1 }
  ]);
  assert.equal(readUtilityModelSettings().configured, true);

  await advisor.configureReasoningEffort({
    listModels: async () => backendModels
  });
  assert.deepEqual(
    quickPickSnapshots.at(-1).map((item) => item.label),
    ['Auto (model default)', 'Low', 'High', 'Max', 'Ultra (VS Code)', 'future-mode'],
    'The command builds its choices from the live catalog.'
  );
  assert.equal(readReasoningEffortSetting(), 'high');
  assert.deepEqual(updates.at(-1), {
    section: 'codexvs',
    key: 'defaultReasoningEffort',
    value: 'high',
    target: 1
  });

  await advisor.showDiagnostics({
    runtimeVersion: '0.144.4',
    processGeneration: 3,
    ensureReady: async () => undefined
  });
  assert.equal(logs.some((entry) => entry.message === 'integration diagnostics'), true);
  assert.equal(JSON.stringify(logs).includes('codexvs/codex::large'), false);

  console.log('VS Code integration tests passed.');
} finally {
  Module._load = originalLoad;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
