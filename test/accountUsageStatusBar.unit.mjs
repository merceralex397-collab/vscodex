import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-account-status-'));
const bundlePath = path.join(temporaryDirectory, 'status.cjs');
const require = createRequire(import.meta.url);
const originalLoad = Module._load;
const statusBarItem = {
  visible: false,
  text: '',
  tooltip: '',
  show() { this.visible = true; },
  hide() { this.visible = false; },
  dispose() { this.visible = false; }
};

const vscodeStub = {
  StatusBarAlignment: { Right: 2 },
  Disposable: {
    from: (...disposables) => ({ dispose: () => disposables.forEach((value) => value.dispose()) })
  },
  window: {
    createStatusBarItem: () => statusBarItem,
    showInformationMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key, fallback) => fallback,
      inspect: () => ({ defaultValue: 'codex' })
    }),
    onDidChangeConfiguration: () => ({ dispose() {} })
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
    entryPoints: ['src/accountUsageStatusBar.ts'],
    absWorkingDir: repositoryRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode']
  });

  const { CodexAccountUsageStatusBar } = require(bundlePath);
  const rateLimits = createEventSource();
  const accountChanges = createEventSource();
  const source = {
    onDidUpdateRateLimits: rateLimits.event,
    onDidChangeAccount: accountChanges.event,
    async readRateLimits() {
      throw new Error('Not used.');
    }
  };
  const statusBar = new CodexAccountUsageStatusBar({ debug() {}, warn() {} }, source);
  rateLimits.fire({
    fetchedAt: Date.now(),
    planType: 'pro',
    limits: [{
      limitId: 'codex',
      limitName: 'Codex',
      windowMinutes: 300,
      usedPercent: 25,
      remainingPercent: 75
    }]
  });
  assert.equal(statusBarItem.visible, true);

  accountChanges.fire();
  assert.equal(statusBarItem.visible, false, 'Account invalidation must hide the previous account\'s limits immediately.');

  statusBar.dispose();
  console.log('Account usage status-bar tests passed.');
} finally {
  Module._load = originalLoad;
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function createEventSource() {
  const listeners = new Set();
  return {
    event: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: (value) => {
      for (const listener of listeners) {
        listener(value);
      }
    }
  };
}
