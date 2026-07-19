const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { PassThrough } = require('node:stream');
const { build } = require('esbuild');

void (async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'codex-runtime-test-'));
  const bundlePath = join(tempDirectory, 'runtime.cjs');

  try {
    await build({
      entryPoints: ['src/appServer/runtime.ts'],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile: bundlePath,
      external: ['cross-spawn']
    });

    const runtime = require(bundlePath);

    assert.equal(runtime.MCP_LIST_TIMEOUT_MS, 30_000);
    assert.equal(runtime.parseCodexCliVersion('codex-cli 0.144.4\n'), '0.144.4');
    assert.equal(runtime.parseCodexCliVersion('codex-cli 0.144.4-alpha.1'), undefined);
    assert.equal(runtime.parseCodexCliVersion('warning\ncodex-cli 0.144.4'), undefined);
    assert.throws(
      () => runtime.assertSupportedCodexCliVersion('codex-cli 0.144.3'),
      (error) => error.kind === 'unsupported-version' && error.actualVersion === '0.144.3'
    );
    assert.equal(runtime.assertSupportedCodexCliVersion('codex-cli 0.144.4'), '0.144.4');
    assert.equal(runtime.assertSupportedCodexCliVersion('codex-cli 0.145.0'), '0.145.0');
    assert.throws(
      () => runtime.assertSupportedCodexCliVersion('codex-cli 0.145.0-alpha.1'),
      (error) => error.kind === 'malformed-version'
    );

    assert.equal(runtime.resolveMachineScopedCodexCommand({
      defaultValue: 'codex',
      globalValue: 'C:\\Tools\\codex.cmd',
      workspaceValue: 'C:\\malicious\\codex.cmd',
      workspaceFolderValue: 'C:\\also-malicious\\codex.cmd'
    }), 'C:\\Tools\\codex.cmd');
    assert.equal(runtime.resolveMachineScopedCodexCommand({
      defaultValue: 'codex',
      workspaceValue: 'workspace-command'
    }), 'codex');

    const sanitized = runtime.createSanitizedAppServerEnvironment({
      PATH: 'path',
      CODEX_HOME: 'shared-home',
      OPENAI_API_KEY: 'one',
      codex_api_key: 'two',
      Codex_Access_Token: 'three'
    });
    assert.deepEqual(sanitized, {
      PATH: 'path',
      CODEX_HOME: 'shared-home'
    });

    let captured;
    const runtimeInfo = await runtime.validateCodexRuntime('codex.cmd', {
      env: { PATH: 'path', OPENAI_API_KEY: 'secret' },
      spawn(command, args, options) {
        captured = { command, args, options };
        return createVersionChild('codex-cli 0.144.4\n', 0);
      }
    });
    assert.deepEqual(runtimeInfo, {
      command: 'codex.cmd',
      version: '0.144.4',
      newerThanValidated: false
    });
    assert.equal(captured.command, 'codex.cmd');
    assert.deepEqual(captured.args, ['--version']);
    assert.equal(captured.options.shell, false);
    assert.equal(captured.options.windowsHide, true);
    assert.equal(captured.options.env.OPENAI_API_KEY, undefined);

    assert.deepEqual(await runtime.validateCodexRuntime('codex', {
      spawn: () => createVersionChild('codex-cli 0.145.0\n', 0)
    }), {
      command: 'codex',
      version: '0.145.0',
      newerThanValidated: true
    });

    await assert.rejects(
      runtime.validateCodexRuntime('missing-codex', {
        spawn: () => createErrorChild('ENOENT')
      }),
      (error) => error.kind === 'missing'
    );

    const punctuatedName = 'name.with "quotes" \\ and ; punctuation';
    const punctuatedServer = { name: punctuatedName, transport: 'stdio', enabled: true };
    const disableArguments = runtime.createMcpDisableArguments([punctuatedServer]);
    assert.deepEqual(disableArguments, [
      '-c',
      `mcp_servers={${JSON.stringify(punctuatedName)}={enabled=false,command="./.vscodex-disabled-mcp"}}`
    ]);
    assert.deepEqual(runtime.createMcpDisableArguments([
      { name: 'beta', transport: 'streamableHttp', enabled: true },
      { name: 'alpha', transport: 'stdio', enabled: true }
    ]), [
      '-c',
      'mcp_servers={"alpha"={enabled=false,command="./.vscodex-disabled-mcp"},"beta"={enabled=false,url="http://127.0.0.1:0/"}}'
    ]);

    const mcpSpawns = [];
    const mcpOutputs = [
      formatMcpList([punctuatedServer]),
      formatMcpList([{ ...punctuatedServer, enabled: false }])
    ];
    const isolation = await runtime.prepareMcpIsolation('codex.cmd', {
      cwd: tempDirectory,
      env: { PATH: 'path', CODEX_HOME: 'shared-home', OPENAI_API_KEY: 'secret' },
      spawn(command, args, options) {
        mcpSpawns.push({ command, args, options });
        return createVersionChild(mcpOutputs.shift(), 0);
      }
    });
    assert.deepEqual(isolation.disableArguments, disableArguments);
    assert.deepEqual(
      JSON.parse(JSON.stringify(isolation.passiveMcpServers)),
      {
        [punctuatedName]: {
          enabled: false,
          command: './.vscodex-disabled-mcp'
        }
      }
    );
    assert.deepEqual(mcpSpawns[0].args, ['mcp', 'list']);
    assert.deepEqual(mcpSpawns[1].args, [
      '-c', 'mcp_servers={}', ...disableArguments, 'mcp', 'list'
    ]);
    assert.equal(mcpSpawns.some((entry) => entry.args.includes('--json')), false);
    assert.equal(mcpSpawns.every((entry) => entry.command === 'codex.cmd'), true);
    assert.equal(mcpSpawns.every((entry) => entry.options.shell === false), true);
    assert.equal(mcpSpawns.every((entry) => entry.options.cwd === tempDirectory), true);
    assert.equal(mcpSpawns.every((entry) => entry.options.env.CODEX_HOME === 'shared-home'), true);
    assert.equal(mcpSpawns.every((entry) => entry.options.env.OPENAI_API_KEY === undefined), true);

    const emptyOutputs = [formatMcpList([]), formatMcpList([])];
    const emptyIsolation = await runtime.prepareMcpIsolation('codex', {
      spawn: () => createVersionChild(emptyOutputs.shift(), 0)
    });
    assert.deepEqual(emptyIsolation.disableArguments, []);
    assert.deepEqual(JSON.parse(JSON.stringify(emptyIsolation.passiveMcpServers)), {});

    const mixedServers = [
      { name: 'local stdio', transport: 'stdio', enabled: true },
      { name: 'remote.http', transport: 'streamableHttp', enabled: true }
    ];
    const mixedOutputs = [
      formatMcpList(mixedServers),
      formatMcpList(mixedServers.map((server) => ({ ...server, enabled: false })))
    ];
    const mixedIsolation = await runtime.prepareMcpIsolation('codex', {
      spawn: () => createVersionChild(mixedOutputs.shift(), 0)
    });
    assert.equal(Object.keys(mixedIsolation.passiveMcpServers).length, 2);

    const extendedTable = formatMcpList([{ name: 'future-format', transport: 'stdio', enabled: true }])
      .replace('  Auth\n', '  Auth  Notes\n')
      .replace('  Unsupported\n', '  Unsupported  ignored\n');
    const extendedDisabledTable = extendedTable.replace('enabled ', 'disabled');
    const extendedOutputs = [extendedTable, extendedDisabledTable];
    await runtime.prepareMcpIsolation('codex', {
      spawn: () => createVersionChild(extendedOutputs.shift(), 0)
    });

    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        spawn: () => createVersionChild('not a Codex MCP table\n', 0)
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'malformed'
    );

    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        maximumOutputBytes: 8,
        spawn: () => createVersionChild('123456789\n', 0)
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'oversized'
    );

    const hanging = createChild();
    let hangingKilled = false;
    hanging.kill = () => {
      hangingKilled = true;
      return true;
    };
    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        timeoutMs: 5,
        spawn: () => hanging
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'timeout'
    );
    assert.equal(hangingKilled, true);

    let unsafeCall = 0;
    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        spawn: () => createVersionChild(formatMcpList([{
          name: 'configured', transport: 'stdio', enabled: unsafeCall++ > 0
        }]), 0)
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'not-disabled'
    );

    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        spawn: () => createVersionChild(
          'Name        Command  Args  Env  Cwd  Status   Auth\n'
          + 'configured fixture  -     -    -    unknown  Unsupported\n',
          0
        )
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'malformed'
    );

    let changedSetCall = 0;
    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        spawn: () => createVersionChild(formatMcpList([{
          name: changedSetCall++ === 0 ? 'configured' : 'replacement',
          transport: 'streamableHttp',
          enabled: changedSetCall <= 1
        }]), 0)
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'configuration-changed'
    );

    await assert.rejects(
      runtime.prepareMcpIsolation('codex', {
        spawn: () => createVersionChild('\u001b[31munsafe\u001b[0m\n', 0)
      }),
      (error) => error.kind === 'mcp-isolation' && error.reason === 'malformed'
    );

    const diagnostic = runtime.createRuntimeDiagnostic(
      new runtime.CodexRuntimeError('missing', 'missing'),
      'ssh-remote'
    );
    assert.equal(diagnostic.isRemoteExtensionHost, true);
    assert.match(diagnostic.detail, /ssh-remote extension host/);
    assert.match(diagnostic.installCommand, /@openai\/codex@latest/);

    console.log('Runtime validation tests passed.');
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
  const stdio = entries.filter((entry) => entry.transport === 'stdio');
  const http = entries.filter((entry) => entry.transport === 'streamableHttp');
  if (stdio.length > 0) {
    const nameWidth = Math.max('Name'.length, ...stdio.map((entry) => entry.name.length));
    const commandWidth = 'Command'.length;
    const statusWidth = 'disabled'.length;
    blocks.push([
      `${'Name'.padEnd(nameWidth)}  Command  Args  Env  Cwd  ${'Status'.padEnd(statusWidth)}  Auth`,
      ...stdio.map((entry) =>
        `${entry.name.padEnd(nameWidth)}  fixture  -     -    -    ${(entry.enabled ? 'enabled' : 'disabled').padEnd(statusWidth)}  Unsupported`)
    ].join('\n'));
  }
  if (http.length > 0) {
    const nameWidth = Math.max('Name'.length, ...http.map((entry) => entry.name.length));
    const url = 'http://127.0.0.1:0/';
    const urlWidth = Math.max('Url'.length, url.length);
    const bearerWidth = 'Bearer Token Env Var'.length;
    const statusWidth = 'disabled'.length;
    blocks.push([
      `${'Name'.padEnd(nameWidth)}  ${'Url'.padEnd(urlWidth)}  ${'Bearer Token Env Var'.padEnd(bearerWidth)}  ${'Status'.padEnd(statusWidth)}  Auth`,
      ...http.map((entry) =>
        `${entry.name.padEnd(nameWidth)}  ${url.padEnd(urlWidth)}  ${'-'.padEnd(bearerWidth)}  ${(entry.enabled ? 'enabled' : 'disabled').padEnd(statusWidth)}  Unsupported`)
    ].join('\n'));
  }
  return `${blocks.join('\n\n')}\n`;
}

function createVersionChild(version, exitCode) {
  const child = createChild();
  queueMicrotask(() => {
    child.stdout.write(version ?? '');
    child.exitCode = exitCode;
    child.emit('exit', exitCode, null);
    child.emit('close', exitCode, null);
  });
  return child;
}

function createErrorChild(code) {
  const child = createChild();
  queueMicrotask(() => {
    const error = new Error('spawn failed');
    error.code = code;
    child.emit('error', error);
  });
  return child;
}

function createChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}
