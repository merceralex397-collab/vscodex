import spawn from 'cross-spawn';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MINIMUM_CODEX_VERSION = '0.144.4';
const RPC_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const command = process.env.CODEX_CI_COMMAND?.trim() || 'codex';
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'vscodex-ci-'));
const codexHome = path.join(temporaryRoot, 'codex-home');
const passiveDirectory = path.join(temporaryRoot, 'passive-cwd');
let appServer;

try {
  await Promise.all([
    mkdir(codexHome, { recursive: true }),
    mkdir(passiveDirectory, { recursive: true })
  ]);

  const environment = createIsolatedEnvironment(process.env, codexHome);
  const versionOutput = await runVersionCheck(command, environment, passiveDirectory);
  const version = parseStableVersion(versionOutput);
  if (!version || compareVersions(version, MINIMUM_CODEX_VERSION) < 0) {
    throw new Error(
      `Codex CLI must report a stable version at or above ${MINIMUM_CODEX_VERSION}.`
    );
  }

  appServer = spawn(command, passiveAppServerArguments(), {
    cwd: passiveDirectory,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  appServer.stderr.resume();
  await waitForSpawn(appServer, RPC_TIMEOUT_MS);

  const rpc = createJsonLineRpc(appServer, RPC_TIMEOUT_MS);
  const initialized = await rpc.request('initialize', {
    clientInfo: {
      name: 'vscodex_ci',
      title: 'vsCodex CI',
      version: '0.2.1'
    },
    capabilities: {
      experimentalApi: true
    }
  });
  assertInitializeResponse(initialized);
  await rpc.notify('initialized');

  const account = await rpc.request('account/read', { refreshToken: false });
  if (!isRecord(account)
    || account.account !== null
    || typeof account.requiresOpenaiAuth !== 'boolean') {
    throw new Error('Isolated public CI unexpectedly observed an authenticated Codex account.');
  }

  await stopProcess(appServer, SHUTDOWN_TIMEOUT_MS);
  appServer = undefined;
  process.stdout.write(`Unauthenticated app-server lifecycle passed for codex-cli ${version}.\n`);
} finally {
  if (appServer) {
    await stopProcess(appServer, SHUTDOWN_TIMEOUT_MS);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

function createIsolatedEnvironment(source, isolatedCodexHome) {
  const environment = {};
  const forbidden = new Set([
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_HOME'
  ]);

  for (const [key, value] of Object.entries(source)) {
    if (!forbidden.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }
  environment.CODEX_HOME = isolatedCodexHome;
  return environment;
}

async function runVersionCheck(executable, environment, cwd) {
  const child = spawn(executable, ['--version'], {
    cwd,
    env: environment,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.resume();
  const chunks = [];
  let bytes = 0;
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 16 * 1024) {
      chunks.push(chunk);
    }
  });

  const { code, signal } = await waitForClose(child, RPC_TIMEOUT_MS);
  if (code !== 0 || signal || bytes > 16 * 1024) {
    throw new Error('The Codex CLI version check failed.');
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function createJsonLineRpc(child, timeoutMs) {
  let input = '';
  let nextId = 1;
  let closedError;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    input += chunk.toString('utf8');
    while (input.includes('\n')) {
      const newline = input.indexOf('\n');
      const frame = input.slice(0, newline).replace(/\r$/, '');
      input = input.slice(newline + 1);
      if (!frame.trim()) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(frame);
      } catch {
        failAll(new Error('Codex app-server emitted malformed JSONL during public CI.'));
        child.kill();
        return;
      }

      if (typeof message?.method === 'string' && message.id !== undefined) {
        void writeMessage({
          id: message.id,
          error: {
            code: -32601,
            message: 'Public lifecycle CI does not handle server requests.'
          }
        });
        continue;
      }
      if (message?.id === undefined) {
        continue;
      }

      const waiter = pending.get(String(message.id));
      if (!waiter) {
        continue;
      }
      pending.delete(String(message.id));
      clearTimeout(waiter.timer);
      if (isRecord(message.error)) {
        waiter.reject(new Error('Codex app-server returned an RPC error during public CI.'));
      } else {
        waiter.resolve(message.result);
      }
    }
  });

  child.once('error', () => failAll(new Error('Codex app-server failed during public CI.')));
  child.once('exit', () => failAll(new Error('Codex app-server exited during public CI.')));

  return {
    async request(method, params) {
      if (closedError) {
        throw closedError;
      }
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(id));
          reject(new Error(`Codex app-server ${method} timed out during public CI.`));
        }, timeoutMs);
        pending.set(String(id), { resolve, reject, timer });
      });
      await writeMessage({ method, id, params });
      return await response;
    },
    async notify(method, params) {
      await writeMessage({ method, params });
    }
  };

  async function writeMessage(message) {
    if (closedError) {
      throw closedError;
    }
    await new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
        if (error) {
          reject(new Error('Could not write to Codex app-server during public CI.'));
        } else {
          resolve();
        }
      });
    });
  }

  function failAll(error) {
    if (closedError) {
      return;
    }
    closedError = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  }
}

function passiveAppServerArguments() {
  return [
    '-c', 'web_search="disabled"',
    '-c', 'mcp_servers={}',
    '-c', 'skills.config=[]',
    '-c', 'project_doc_max_bytes=0',
    '--disable', 'shell_tool',
    '--disable', 'unified_exec',
    '--disable', 'shell_snapshot',
    '--disable', 'apps',
    '--disable', 'browser_use',
    '--disable', 'browser_use_external',
    '--disable', 'computer_use',
    '--disable', 'image_generation',
    '--disable', 'in_app_browser',
    '--disable', 'code_mode_host',
    '--disable', 'multi_agent',
    '--disable', 'plugins',
    '--disable', 'plugin_sharing',
    '--disable', 'remote_plugin',
    '--disable', 'hooks',
    '--disable', 'goals',
    '--disable', 'memories',
    '--disable', 'workspace_dependencies',
    '--disable', 'skill_mcp_dependency_install',
    '--disable', 'tool_suggest',
    'app-server',
    '--stdio'
  ];
}

function assertInitializeResponse(value) {
  if (!isRecord(value)
    || typeof value.userAgent !== 'string'
    || typeof value.codexHome !== 'string'
    || typeof value.platformFamily !== 'string'
    || typeof value.platformOs !== 'string') {
    throw new Error('Codex app-server returned an invalid initialize response during public CI.');
  }
}

async function waitForSpawn(child, timeoutMs) {
  if (child.pid !== undefined) {
    return;
  }
  await withTimeout(new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new Error('Could not spawn Codex CLI.')));
  }), timeoutMs, 'Timed out while spawning Codex CLI.');
}

async function waitForClose(child, timeoutMs) {
  return await withTimeout(new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('Codex CLI could not be started.')));
    child.once('close', (code, signal) => resolve({ code, signal }));
  }), timeoutMs, 'Codex CLI did not exit in time.');
}

async function stopProcess(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (!child.stdin.destroyed) {
    child.stdin.end();
  }
  try {
    await withTimeout(exited, timeoutMs, 'Codex app-server did not shut down in time.');
  } catch {
    child.kill();
    await withTimeout(exited, timeoutMs, 'Codex app-server could not be terminated.');
  }
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseStableVersion(value) {
  return /^codex-cli (\d+\.\d+\.\d+)$/.exec(value)?.[1];
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
