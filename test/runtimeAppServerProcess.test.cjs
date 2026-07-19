const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve, sep } = require('node:path');
const { PassThrough } = require('node:stream');
const { build } = require('esbuild');

void (async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-process-test-'));
  const bundlePath = join(tempDirectory, 'app-server-process.cjs');
  const storageDirectory = join(tempDirectory, 'global-storage');

  try {
    await build({
      entryPoints: ['src/appServer/appServerProcess.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: bundlePath,
      external: ['cross-spawn']
    });
    const processModule = require(bundlePath);
    const spawned = [];
    const mcpChecks = [];
    const configuredMcpName = 'configured.server "quoted"';
    const diagnostics = [];

    const manager = new processModule.AppServerProcess({
      command: 'codex.cmd',
      extensionVersion: '0.2.1',
      storageDirectory,
      startupTimeoutMs: 100,
      mcpIsolationTimeoutMs: 500,
      env: {
        PATH: 'path',
        CODEX_HOME: 'shared-home',
        OPENAI_API_KEY: 'secret',
        CODEX_API_KEY: 'secret',
        CODEX_ACCESS_TOKEN: 'secret'
      },
      validateRuntime: async (command) => ({ command, version: '0.144.4' }),
      spawn(command, args, options) {
        if (args.includes('mcp') && args.includes('list')) {
          mcpChecks.push({ command, args, options });
          const child = createCommandChild(formatMcpList([{
            name: configuredMcpName,
            transport: 'stdio',
            enabled: mcpChecks.length === 1
          }]), 0, mcpChecks.length === 1 ? 150 : 0);
          return child;
        }
        const child = createFakeAppServer();
        spawned.push({ command, args, options, child });
        return child;
      },
      onDiagnostic: (event) => diagnostics.push(event)
    });

    await manager.ensureReady();
    assert.equal(manager.state, 'ready');
    assert.equal(manager.generation, 1);
    assert.deepEqual(
      JSON.parse(JSON.stringify(manager.passiveMcpServers)),
      {
        [configuredMcpName]: {
          enabled: false,
          command: './.vscodex-disabled-mcp'
        }
      }
    );
    assert.equal(spawned.length, 1);
    assert.equal(mcpChecks.length, 2);
    assert.deepEqual(mcpChecks[0].args, ['mcp', 'list']);
    const expectedMcpDisable = `mcp_servers={${JSON.stringify(configuredMcpName)}={enabled=false,command="./.vscodex-disabled-mcp"}}`;
    assert.deepEqual(mcpChecks[1].args, [
      '-c', 'mcp_servers={}', '-c', expectedMcpDisable, 'mcp', 'list'
    ]);
    assert.equal(mcpChecks.some((check) => check.args.includes('--json')), false);
    assert.equal(mcpChecks.every((check) => check.options.shell === false), true);
    assert.equal(mcpChecks.every((check) => check.options.env.OPENAI_API_KEY === undefined), true);
    assert.equal(spawned[0].command, 'codex.cmd');
    assert.deepEqual(
      spawned[0].args,
      processModule.buildAppServerArguments(['-c', expectedMcpDisable])
    );
    assert(
      spawned[0].args.indexOf('-c') < spawned[0].args.indexOf('app-server'),
      'global config overrides must precede the app-server subcommand on CLI 0.144.4'
    );
    assert.equal(spawned[0].args.includes('--analytics-default-enabled'), false);
    assert.equal(spawned[0].options.shell, false);
    assert.equal(spawned[0].options.env.CODEX_HOME, 'shared-home');
    assert.equal(spawned[0].options.env.OPENAI_API_KEY, undefined);
    assert.equal(spawned[0].options.env.CODEX_API_KEY, undefined);
    assert.equal(spawned[0].options.env.CODEX_ACCESS_TOKEN, undefined);
    assert.equal(
      resolve(spawned[0].options.cwd).startsWith(`${resolve(storageDirectory)}${sep}`),
      true
    );
    assert.deepEqual(await readdir(spawned[0].options.cwd), []);
    spawned[0].child.stderr.write('private app-server diagnostic\n');

    const initialize = spawned[0].child.received[0];
    assert.equal(initialize.method, 'initialize');
    assert.deepEqual(initialize.params.clientInfo, {
      name: 'vscodex',
      title: 'vsCodex',
      version: '0.2.1'
    });
    assert.deepEqual(initialize.params.capabilities, { experimentalApi: true });
    assert.equal(spawned[0].child.received[1].method, 'initialized');

    const account = await manager.request('account/read', { refreshToken: false });
    assert.deepEqual(account, { account: null });
    await assert.rejects(
      manager.request('unsupported/operation'),
      (error) => error.name === 'CodexCompatibilityError'
        && error.cliVersion === '0.144.4'
        && error.methodOrEvent === 'unsupported/operation'
        && error.category === 'method-not-found'
    );
    await assert.rejects(
      manager.request('invalid/params', { future: true }),
      (error) => error.name === 'CodexCompatibilityError'
        && error.cliVersion === '0.144.4'
        && error.methodOrEvent === 'invalid/params'
        && error.category === 'invalid-params'
    );

    const notifications = [];
    manager.onNotification((notification) => notifications.push(notification));
    spawned[0].child.send({ method: 'account/updated', params: { authMode: null } });
    await immediate();
    assert.equal(notifications[0].method, 'account/updated');

    const exits = [];
    manager.onDidExit((event) => exits.push(event));
    spawned[0].child.crash(9);
    await immediate();
    assert.equal(manager.state, 'idle');
    assert.equal(manager.generation, 2);
    assert.equal(exits[0].code, 9);
    assert.equal(exits[0].duringStartup, false);
    const exitDiagnostic = diagnostics.find((event) => event.kind === 'process-exited');
    assert.equal(exitDiagnostic.stderrLines, 1);
    assert.equal(exitDiagnostic.stderrBytes > 0, true);
    assert.equal(
      JSON.stringify(diagnostics).includes('private app-server diagnostic'),
      false,
      'raw app-server stderr must never enter extension diagnostics'
    );

    await manager.ensureReady();
    assert.equal(spawned.length, 2);
    assert.equal(manager.generation, 3);
    assert.equal(manager.state, 'ready');

    await manager.shutdown();
    assert.equal(manager.state, 'idle');
    assert.equal(manager.generation, 4);
    assert.equal(diagnostics.some((event) => event.kind === 'process-ready'), true);
    manager.dispose();

    let unsafeMcpChecks = 0;
    let unsafeAppServerSpawned = false;
    const unsafeManager = new processModule.AppServerProcess({
      command: 'codex.cmd',
      extensionVersion: '0.2.1',
      storageDirectory: join(tempDirectory, 'unsafe-global-storage'),
      validateRuntime: async (command) => ({ command, version: '0.144.4' }),
      spawn(_command, args) {
        if (args.includes('mcp') && args.includes('list')) {
          unsafeMcpChecks += 1;
          return createCommandChild(formatMcpList([{
            name: 'configured', transport: 'streamableHttp', enabled: true
          }]), 0);
        }
        unsafeAppServerSpawned = true;
        return createFakeAppServer();
      }
    });
    await assert.rejects(
      unsafeManager.ensureReady(),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'not-disabled'
    );
    assert.equal(unsafeMcpChecks, 2);
    assert.equal(unsafeAppServerSpawned, false, 'unsafe MCP verification must prevent app-server launch');
    assert.equal(unsafeManager.state, 'idle');
    unsafeManager.dispose();

    const stubbornStorageDirectory = join(tempDirectory, 'stubborn-global-storage');
    const stubbornSpawned = [];
    const stubbornDiagnostics = [];
    const stubbornManager = new processModule.AppServerProcess({
      command: 'codex.cmd',
      extensionVersion: '0.2.1',
      storageDirectory: stubbornStorageDirectory,
      shutdownTimeoutMs: 10,
      validateRuntime: async (command) => ({ command, version: '0.144.4' }),
      spawn(_command, args) {
        if (args.includes('mcp') && args.includes('list')) {
          return createCommandChild(formatMcpList([]), 0);
        }
        const child = createFakeAppServer({ resistShutdown: stubbornSpawned.length === 0 });
        stubbornSpawned.push(child);
        return child;
      },
      onDiagnostic: (event) => stubbornDiagnostics.push(event)
    });

    await stubbornManager.ensureReady();
    assert.equal(stubbornManager.generation, 1);
    await assert.rejects(
      stubbornManager.shutdown(),
      /did not exit after graceful shutdown and a kill request/
    );
    assert.equal(stubbornManager.state, 'stopping');
    assert.equal(stubbornManager.generation, 1);
    assert.equal(
      stubbornDiagnostics.some((event) => event.kind === 'process-stopped'),
      false,
      'a live child must not be reported as stopped'
    );
    await assert.rejects(
      stubbornManager.ensureReady(),
      /previous Codex app-server process is still stopping/
    );
    assert.equal(stubbornSpawned.length, 1, 'shutdown failure must not allow a concurrent restart');

    stubbornSpawned[0].crash(0);
    await immediate();
    assert.equal(stubbornManager.state, 'idle');
    assert.equal(stubbornManager.generation, 2);
    assert.equal(
      stubbornDiagnostics.filter((event) => event.kind === 'process-stopped').length,
      1,
      'the eventual child exit finalizes shutdown exactly once'
    );

    await stubbornManager.ensureReady();
    assert.equal(stubbornSpawned.length, 2);
    assert.equal(stubbornManager.generation, 3);
    await stubbornManager.shutdown();
    assert.equal(stubbornManager.state, 'idle');
    assert.equal(stubbornManager.generation, 4);
    stubbornManager.dispose();

    console.log('App-server process lifecycle tests passed.');
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function formatMcpList(entries) {
  if (entries.length === 0) {
    return 'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.\n';
  }
  const blocks = [];
  const statusWidth = 'disabled'.length;
  for (const transport of ['stdio', 'streamableHttp']) {
    const group = entries.filter((entry) => entry.transport === transport);
    if (group.length === 0) {
      continue;
    }
    const nameWidth = Math.max('Name'.length, ...group.map((entry) => entry.name.length));
    if (transport === 'stdio') {
      blocks.push([
        `${'Name'.padEnd(nameWidth)}  Command  Args  Env  Cwd  ${'Status'.padEnd(statusWidth)}  Auth`,
        ...group.map((entry) =>
          `${entry.name.padEnd(nameWidth)}  fixture  -     -    -    ${(entry.enabled ? 'enabled' : 'disabled').padEnd(statusWidth)}  Unsupported`)
      ].join('\n'));
    } else {
      const url = 'http://127.0.0.1:0/';
      const bearerWidth = 'Bearer Token Env Var'.length;
      blocks.push([
        `${'Name'.padEnd(nameWidth)}  ${'Url'.padEnd(url.length)}  ${'Bearer Token Env Var'}  ${'Status'.padEnd(statusWidth)}  Auth`,
        ...group.map((entry) =>
          `${entry.name.padEnd(nameWidth)}  ${url}  ${'-'.padEnd(bearerWidth)}  ${(entry.enabled ? 'enabled' : 'disabled').padEnd(statusWidth)}  Unsupported`)
      ].join('\n'));
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

function createFakeAppServer(options = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.received = [];
  let input = '';
  let exited = false;

  child.stdin.on('data', (chunk) => {
    input += chunk.toString('utf8');
    while (input.includes('\n')) {
      const newline = input.indexOf('\n');
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      if (!line) {
        continue;
      }
      const message = JSON.parse(line);
      child.received.push(message);
      if (message.method === 'initialize') {
        child.send({
          id: message.id,
          result: {
            userAgent: 'fake',
            codexHome: 'C:\\fake-codex-home',
            platformFamily: 'windows',
            platformOs: 'windows'
          }
        });
      } else if (message.method === 'account/read') {
        child.send({ id: message.id, result: { account: null } });
      } else if (message.id !== undefined && message.method !== 'initialized') {
        child.send({
          id: message.id,
          error: message.method === 'invalid/params'
            ? { code: -32602, message: 'Invalid params.' }
            : { code: -32601, message: 'Method not found.' }
        });
      }
    }
  });

  child.send = (message) => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.crash = (code) => {
    if (exited) {
      return;
    }
    exited = true;
    child.exitCode = code;
    child.emit('exit', code, null);
    child.stdout.end();
  };
  child.kill = () => {
    if (!options.resistShutdown) {
      child.crash(null);
    }
    return true;
  };
  child.stdin.on('finish', () => {
    if (!options.resistShutdown) {
      child.crash(0);
    }
  });
  return child;
}

function createCommandChild(output, exitCode, delayMs = 0) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const complete = () => {
    child.stdout.write(output);
    child.exitCode = exitCode;
    child.emit('exit', exitCode, null);
    child.emit('close', exitCode, null);
  };
  if (delayMs > 0) {
    setTimeout(complete, delayMs);
  } else {
    queueMicrotask(complete);
  }
  return child;
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}
