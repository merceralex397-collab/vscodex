'use strict';

const { execFileSync } = require('node:child_process');
const { chmod, mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { existsSync, readFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

const repositoryRoot = path.resolve(__dirname, '..');
const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const extensionId = `${packageJson.publisher}.${packageJson.name}`;
const vscodeVersion = process.env.CODEX_TEST_VSCODE_VERSION || '1.104.0';
const sensitiveEnvironment = new Map();
const keepAlive = setInterval(() => undefined, 1_000);

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));

async function main() {
  compileExtension();

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-extension-host-'));
  try {
    const userDataDirectory = path.join(temporaryDirectory, 'user-data');
    const extensionsDirectory = path.join(temporaryDirectory, 'extensions');
    const workspaceDirectory = path.join(temporaryDirectory, 'workspace');
    const codexHome = path.join(temporaryDirectory, 'codex-home');
    await Promise.all([
      mkdir(path.join(userDataDirectory, 'User'), { recursive: true }),
      mkdir(extensionsDirectory, { recursive: true }),
      mkdir(path.join(workspaceDirectory, '.vscode'), { recursive: true }),
      mkdir(codexHome, { recursive: true })
    ]);

    const launcher = await createFakeCodexLauncher(temporaryDirectory);
    await writeFile(path.join(userDataDirectory, 'User', 'settings.json'), JSON.stringify({
      'codexvs.appServer.command': launcher,
      'telemetry.telemetryLevel': 'off',
      'workbench.startupEditor': 'none'
    }, null, 2), 'utf8');
    await writeFile(path.join(workspaceDirectory, '.vscode', 'settings.json'), JSON.stringify({
      'codexvs.appServer.command': 'malicious-workspace-command'
    }, null, 2), 'utf8');

    removeSensitiveEnvironment();
    await runTests({
      version: vscodeVersion,
      extensionDevelopmentPath: repositoryRoot,
      extensionTestsPath: path.join(repositoryRoot, 'test', 'extensionHost', 'suite.cjs'),
      extensionTestsEnv: {
        CODEX_HOME: codexHome,
        CODEX_TEST_EXTENSION_ID: extensionId,
        CODEX_TEST_FAKE_COMMAND: launcher,
        CODEX_TEST_WORKSPACE: workspaceDirectory
      },
      launchArgs: [
        workspaceDirectory,
        `--user-data-dir=${userDataDirectory}`,
        `--extensions-dir=${extensionsDirectory}`,
        '--disable-extensions'
      ]
    });
  } finally {
    restoreSensitiveEnvironment();
    await rm(temporaryDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200
    });
  }
}

function compileExtension() {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && existsSync(npmExecPath)) {
    execFileSync(process.execPath, [npmExecPath, 'run', 'compile'], {
      cwd: repositoryRoot,
      stdio: 'inherit',
      windowsHide: true
    });
    return;
  }

  if (!existsSync(path.join(repositoryRoot, 'out', 'extension.js'))) {
    throw new Error('Compile the extension with `npm run compile` before running extension-host tests directly.');
  }
}

async function createFakeCodexLauncher(directory) {
  const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'fakeCodexAppServer.cjs');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'fake-codex.cmd');
    await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
    return launcher;
  }

  const launcher = path.join(directory, 'fake-codex');
  await writeFile(
    launcher,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
    'utf8'
  );
  await chmod(launcher, 0o755);
  return launcher;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function removeSensitiveEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!isSensitiveEnvironmentKey(key)) {
      continue;
    }
    sensitiveEnvironment.set(key, process.env[key]);
    delete process.env[key];
  }
}

function restoreSensitiveEnvironment() {
  for (const [key, value] of sensitiveEnvironment) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
  sensitiveEnvironment.clear();
}

function isSensitiveEnvironmentKey(key) {
  switch (key.toUpperCase()) {
    case 'OPENAI_API_KEY':
    case 'CODEX_API_KEY':
    case 'CODEX_ACCESS_TOKEN':
    case 'ELECTRON_RUN_AS_NODE':
      return true;
    default:
      return false;
  }
}
