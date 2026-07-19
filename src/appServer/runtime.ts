import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export const MINIMUM_CODEX_CLI_VERSION = '0.144.4';
export const LATEST_VALIDATED_CODEX_CLI_VERSION = '0.144.4';
export const DEFAULT_CODEX_COMMAND = 'codex';
export const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex@latest';
export const RUNTIME_CHECK_TIMEOUT_MS = 10_000;
export const MCP_LIST_TIMEOUT_MS = 30_000;
export const MCP_LIST_MAX_OUTPUT_BYTES = 512 * 1024;
export const MCP_MAX_SERVER_COUNT = 128;
export const MCP_MAX_SERVER_NAME_BYTES = 1024;
export const MCP_MAX_OVERRIDE_BYTES = 24 * 1024;
export const MCP_SERVERS_EMPTY_OVERRIDE = 'mcp_servers={}';
export const MCP_DISABLED_TRANSPORT_COMMAND = './.codexvs-disabled-mcp';
export const MCP_DISABLED_TRANSPORT_URL = 'http://127.0.0.1:0/';

const VERSION_PREFIX = 'codex-cli ';
const STRIPPED_CREDENTIAL_ENVIRONMENT_VARIABLES = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN'
]);

export type RuntimeFailureKind =
  | 'missing'
  | 'timeout'
  | 'malformed-version'
  | 'unsupported-version'
  | 'exited'
  | 'invalid-command'
  | 'mcp-isolation';

export type McpIsolationFailureReason =
  | 'launch'
  | 'timeout'
  | 'exited'
  | 'malformed'
  | 'oversized'
  | 'capacity'
  | 'configuration-changed'
  | 'not-disabled';

export interface CodexRuntimeInfo {
  readonly command: string;
  readonly version: string;
  readonly newerThanValidated: boolean;
}

export interface CodexRuntimeDiagnostic {
  readonly kind: RuntimeFailureKind;
  readonly message: string;
  readonly detail: string;
  readonly installCommand: string;
  readonly isRemoteExtensionHost: boolean;
  readonly remoteName?: string;
}

export interface ConfigurationInspection<T> {
  readonly defaultValue?: T;
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
  readonly defaultLanguageValue?: T;
  readonly globalLanguageValue?: T;
  readonly workspaceLanguageValue?: T;
  readonly workspaceFolderLanguageValue?: T;
}

export interface RuntimeValidationOptions {
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly spawn?: SpawnCommand;
}

export interface McpIsolationOptions {
  readonly timeoutMs?: number;
  readonly maximumOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly spawn?: SpawnCommand;
}

export interface McpIsolationPlan {
  readonly disableArguments: readonly string[];
  readonly passiveMcpServers: Readonly<Record<string, PassiveMcpServerConfig>>;
}

export interface McpIsolationStrategy {
  prepare(command: string, options?: McpIsolationOptions): Promise<McpIsolationPlan>;
}

export type McpTransportKind = 'stdio' | 'streamableHttp';

export interface McpServerDescriptor {
  readonly name: string;
  readonly transport: McpTransportKind;
  readonly enabled: boolean;
}

export type PassiveMcpServerConfig =
  | { readonly enabled: false; readonly command: string }
  | { readonly enabled: false; readonly url: string };

export type SpawnCommand = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export class CodexRuntimeError extends Error {
  constructor(
    readonly kind: RuntimeFailureKind,
    message: string,
    readonly expectedVersion = MINIMUM_CODEX_CLI_VERSION,
    readonly actualVersion?: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'CodexRuntimeError';
  }
}

export class CodexMcpIsolationError extends CodexRuntimeError {
  constructor(
    readonly reason: McpIsolationFailureReason,
    message = 'CodexVS could not prove that every configured MCP server is disabled.',
    options?: ErrorOptions
  ) {
    super('mcp-isolation', message, MINIMUM_CODEX_CLI_VERSION, undefined, options);
    this.name = 'CodexMcpIsolationError';
  }
}

/**
 * Resolve only the machine/global value of the executable setting. Workspace,
 * folder, and language-scoped workspace values are deliberately ignored.
 */
export function resolveMachineScopedCodexCommand(
  inspection?: ConfigurationInspection<string>,
  fallback = DEFAULT_CODEX_COMMAND
): string {
  const configured = inspection?.globalValue ?? inspection?.defaultValue ?? fallback;
  const command = configured.trim();

  if (!command || command.includes('\0')) {
    throw new CodexRuntimeError(
      'invalid-command',
      'The configured Codex executable is empty or invalid.'
    );
  }

  return command;
}

export function parseCodexCliVersion(output: string): string | undefined {
  const normalized = output.trim();
  const match = /^codex-cli ([0-9]+\.[0-9]+\.[0-9]+)$/.exec(normalized);
  return match?.[1];
}

export function assertSupportedCodexCliVersion(output: string): string {
  const version = parseCodexCliVersion(output);
  if (!version) {
    throw new CodexRuntimeError(
      'malformed-version',
      `The Codex executable did not report a valid ${VERSION_PREFIX}<version> string.`
    );
  }

  if (compareStableVersions(version, MINIMUM_CODEX_CLI_VERSION) < 0) {
    throw new CodexRuntimeError(
      'unsupported-version',
      `Codex CLI ${version} is older than the minimum supported version ${MINIMUM_CODEX_CLI_VERSION}.`,
      MINIMUM_CODEX_CLI_VERSION,
      version
    );
  }

  return version;
}

export function createSanitizedAppServerEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(source)) {
    if (!STRIPPED_CREDENTIAL_ENVIRONMENT_VARIABLES.has(key.toUpperCase())) {
      environment[key] = value;
    }
  }

  return environment;
}

export async function validateCodexRuntime(
  command: string,
  options: RuntimeValidationOptions = {}
): Promise<CodexRuntimeInfo> {
  const normalizedCommand = resolveMachineScopedCodexCommand(
    { globalValue: command },
    DEFAULT_CODEX_COMMAND
  );
  const timeoutMs = options.timeoutMs ?? RUNTIME_CHECK_TIMEOUT_MS;
  const spawn = options.spawn ?? loadCrossSpawn();

  return await new Promise<CodexRuntimeInfo>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(normalizedCommand, ['--version'], {
        cwd: options.cwd,
        env: createSanitizedAppServerEnvironment(options.env),
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      reject(createLaunchError(error));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;
    const maximumVersionOutputBytes = 16 * 1024;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new CodexRuntimeError(
          'timeout',
          `Timed out while checking Codex CLI after ${timeoutMs} ms.`
        ));
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes <= maximumVersionOutputBytes) {
        stdout.push(buffer);
      }
    });

    // Consume stderr so a wrapper cannot block on a full pipe. Its contents may
    // include local paths and are intentionally never retained or surfaced.
    child.stderr.resume();

    child.once('error', (error) => {
      finish(() => reject(createLaunchError(error)));
    });

    child.once('close', (code, signal) => {
      finish(() => {
        if (code !== 0) {
          reject(new CodexRuntimeError(
            'exited',
            `The Codex version check exited unsuccessfully (${formatExitStatus(code, signal)}).`
          ));
          return;
        }

        if (stdoutBytes > maximumVersionOutputBytes) {
          reject(new CodexRuntimeError(
            'malformed-version',
            'The Codex executable returned an unexpectedly large version response.'
          ));
          return;
        }

        try {
          const version = assertSupportedCodexCliVersion(Buffer.concat(stdout).toString('utf8'));
          resolve({
            command: normalizedCommand,
            version,
            newerThanValidated: compareStableVersions(version, LATEST_VALIDATED_CODEX_CLI_VERSION) > 0
          });
        } catch (error) {
          reject(error);
        }
      });
    });
  });
}

/**
 * Discover configured MCP server names through the CLI's redacted
 * human-readable table, then prove that command-line overrides disable every
 * effective entry. Never request the JSON form: it can contain raw MCP headers
 * and environment values. Table rows are reduced immediately to name,
 * transport kind, and enabled state and are never logged.
 */
export class EnumeratingMcpIsolationStrategy implements McpIsolationStrategy {
  async prepare(
    command: string,
    options: McpIsolationOptions = {}
  ): Promise<McpIsolationPlan> {
    return await prepareEnumeratedMcpIsolation(command, options);
  }
}

export function isCodexCliVersionNewerThanValidated(version: string): boolean {
  return compareStableVersions(version, LATEST_VALIDATED_CODEX_CLI_VERSION) > 0;
}

export const defaultMcpIsolationStrategy: McpIsolationStrategy = new EnumeratingMcpIsolationStrategy();

export async function prepareMcpIsolation(
  command: string,
  options: McpIsolationOptions = {}
): Promise<McpIsolationPlan> {
  return await defaultMcpIsolationStrategy.prepare(command, options);
}

async function prepareEnumeratedMcpIsolation(
  command: string,
  options: McpIsolationOptions
): Promise<McpIsolationPlan> {
  const normalizedCommand = resolveMachineScopedCodexCommand(
    { globalValue: command },
    DEFAULT_CODEX_COMMAND
  );
  const servers = await runMcpList(
    normalizedCommand,
    [],
    options
  );
  const disableArguments = createMcpDisableArguments(servers);
  const passiveMcpServers = createPassiveMcpServers(servers);

  const verifiedServers = await runMcpList(
    normalizedCommand,
    ['-c', MCP_SERVERS_EMPTY_OVERRIDE, ...disableArguments],
    options
  );
  assertEveryMcpServerDisabled(verifiedServers, servers);

  return { disableArguments, passiveMcpServers };
}

export function createPassiveMcpServers(
  servers: readonly McpServerDescriptor[]
): Readonly<Record<string, PassiveMcpServerConfig>> {
  const result = Object.create(null) as Record<string, PassiveMcpServerConfig>;
  for (const server of servers) {
    assertSafeMcpServerName(server.name);
    if (Object.hasOwn(result, server.name)) {
      throw new CodexMcpIsolationError('capacity');
    }
    Object.defineProperty(result, server.name, {
      enumerable: true,
      configurable: false,
      writable: false,
      value: server.transport === 'stdio'
        ? { enabled: false, command: MCP_DISABLED_TRANSPORT_COMMAND }
        : { enabled: false, url: MCP_DISABLED_TRANSPORT_URL }
    });
  }
  return Object.freeze(result);
}

export function createMcpDisableArguments(servers: readonly McpServerDescriptor[]): string[] {
  const uniqueNames = new Set(servers.map((server) => server.name));
  if (uniqueNames.size !== servers.length || servers.length > MCP_MAX_SERVER_COUNT) {
    throw new CodexMcpIsolationError('capacity');
  }

  const sortedServers = [...servers].sort((left, right) => left.name.localeCompare(right.name));
  const entries: string[] = [];
  for (const server of sortedServers) {
    assertSafeMcpServerName(server.name);
    // The minimum-supported CLI splits override *paths* on every dot, including dots
    // inside quotes. A quoted key in a TOML inline-table value is therefore the
    // only safe exact-name representation for punctuation-bearing names.
    // Disabled entries are still transport-validated. Replace only the
    // transport identity with a harmless type-matched target: an absent command
    // in the empty passive cwd or an unusable loopback URL. The second listing
    // must then prove that every exact entry is disabled before app-server runs.
    const transport = server.transport === 'stdio'
      ? `command=${JSON.stringify(MCP_DISABLED_TRANSPORT_COMMAND)}`
      : `url=${JSON.stringify(MCP_DISABLED_TRANSPORT_URL)}`;
    entries.push(`${JSON.stringify(server.name)}={enabled=false,${transport}}`);
  }
  if (entries.length === 0) {
    return [];
  }

  // Repeating a root mcp_servers override replaces the previous value inside
  // the CLI override layer, so all exact-name entries must share one table.
  const override = `mcp_servers={${entries.join(',')}}`;
  if (Buffer.byteLength(override, 'utf8') > MCP_MAX_OVERRIDE_BYTES) {
    throw new CodexMcpIsolationError('capacity');
  }
  return ['-c', override];
}

export function createRuntimeDiagnostic(
  error: unknown,
  remoteName?: string
): CodexRuntimeDiagnostic {
  const runtimeError = error instanceof CodexRuntimeError
    ? error
    : createLaunchError(error);
  const isRemoteExtensionHost = Boolean(remoteName);
  const hostGuidance = isRemoteExtensionHost
    ? ` Install Codex CLI ${MINIMUM_CODEX_CLI_VERSION} or newer on the ${remoteName} extension host, not only on the local computer.`
    : '';

  let detail: string;
  if (runtimeError.kind === 'unsupported-version') {
    detail = `${runtimeError.message} Run \`${CODEX_INSTALL_COMMAND}\` on the extension host, configure the executable if needed, then retry.${hostGuidance}`;
  } else if (runtimeError.kind === 'missing') {
    detail = `Codex CLI was not found. Run \`${CODEX_INSTALL_COMMAND}\` on the extension host, configure the executable if needed, then retry.${hostGuidance}`;
  } else if (runtimeError.kind === 'mcp-isolation') {
    const reason = runtimeError instanceof CodexMcpIsolationError ? runtimeError.reason : undefined;
    if (reason === 'timeout') {
      detail = `CodexVS timed out while reading the redacted MCP list. Confirm \`codex mcp list\` completes on this extension host, then retry. Your global MCP configuration was not changed.${hostGuidance}`;
    } else if (reason === 'malformed') {
      detail = `CodexVS could not safely parse the redacted plain-text MCP list. Update Codex CLI or repair invalid MCP configuration, then retry. Valid global MCP servers do not need to be removed.${hostGuidance}`;
    } else if (reason === 'configuration-changed') {
      detail = `The configured MCP server set changed during isolation verification. Wait for configuration changes to finish, then retry. Your global MCP configuration was not changed.${hostGuidance}`;
    } else if (reason === 'not-disabled') {
      detail = `CodexVS could not prove that every discovered MCP server was disabled for its passive app-server child. Update Codex CLI and retry; your global MCP configuration was not changed.${hostGuidance}`;
    } else {
      detail = `${runtimeError.message} Verify that \`codex mcp list\` works on this extension host, then retry. Your global MCP configuration was not changed.${hostGuidance}`;
    }
  } else {
    detail = `${runtimeError.message} Verify the configured executable, install \`@openai/codex@latest\`, then retry.${hostGuidance}`;
  }

  return {
    kind: runtimeError.kind,
    message: runtimeError.message,
    detail,
    installCommand: CODEX_INSTALL_COMMAND,
    isRemoteExtensionHost,
    remoteName
  };
}

async function runMcpList(
  command: string,
  overrideArguments: readonly string[],
  options: McpIsolationOptions
): Promise<McpServerDescriptor[]> {
  const timeoutMs = options.timeoutMs ?? MCP_LIST_TIMEOUT_MS;
  const maximumOutputBytes = options.maximumOutputBytes ?? MCP_LIST_MAX_OUTPUT_BYTES;
  const spawn = options.spawn ?? loadCrossSpawn();
  if (timeoutMs <= 0 || maximumOutputBytes <= 0) {
    throw new CodexMcpIsolationError('capacity');
  }

  return await new Promise<McpServerDescriptor[]>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...overrideArguments, 'mcp', 'list'], {
        cwd: options.cwd,
        env: createSanitizedAppServerEnvironment(options.env),
        windowsHide: true,
        shell: false
      });
    } catch (error) {
      reject(new CodexMcpIsolationError('launch', undefined, { cause: error }));
      return;
    }

    const parser = new McpListTableParser();
    let stdoutBytes = 0;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new CodexMcpIsolationError('timeout'));
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer | string) => {
      if (settled) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > maximumOutputBytes) {
        finish(() => {
          child.kill();
          reject(new CodexMcpIsolationError('oversized'));
        });
        return;
      }
      try {
        parser.push(buffer);
      } catch (error) {
        finish(() => {
          child.kill();
          reject(asMcpIsolationError(error));
        });
      }
    });
    child.stderr.resume();
    child.once('error', (error) => {
      finish(() => {
        reject(new CodexMcpIsolationError('launch', undefined, { cause: error }));
      });
    });
    child.once('close', (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new CodexMcpIsolationError('exited'));
          return;
        }
        try {
          resolve(parser.finish());
        } catch (error) {
          reject(asMcpIsolationError(error));
        }
      });
    });
  });
}

function assertEveryMcpServerDisabled(
  actual: readonly McpServerDescriptor[],
  expected: readonly McpServerDescriptor[]
): void {
  if (actual.length !== expected.length) {
    throw new CodexMcpIsolationError('configuration-changed');
  }
  const expectedByName = new Map(expected.map((server) => [server.name, server.transport]));
  for (const server of actual) {
    if (!expectedByName.has(server.name) || expectedByName.get(server.name) !== server.transport) {
      throw new CodexMcpIsolationError('configuration-changed');
    }
    if (server.enabled) {
      throw new CodexMcpIsolationError('not-disabled');
    }
    expectedByName.delete(server.name);
  }
  if (expectedByName.size > 0) {
    throw new CodexMcpIsolationError('configuration-changed');
  }
}

const EMPTY_MCP_LIST_MESSAGE = 'No MCP servers configured yet. Try `codex mcp add my-tool -- my-command`.';

interface McpTableBlock {
  readonly transport: McpTransportKind;
  readonly transportColumn: number;
  readonly statusColumn: number;
  readonly authColumn: number;
  rows: number;
}

/** Incrementally retains at most one redacted CLI table line at a time. */
class McpListTableParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly entries: McpServerDescriptor[] = [];
  private readonly names = new Set<string>();
  private pending = '';
  private block: McpTableBlock | undefined;
  private sawEmptyMessage = false;
  private sawOtherContent = false;

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    this.consumeCompleteLines();
  }

  finish(): McpServerDescriptor[] {
    this.pending += this.decoder.end();
    if (this.pending.length > 0) {
      this.consumeLine(this.pending.replace(/\r$/, ''));
      this.pending = '';
    }
    this.finishBlock();
    if (this.sawEmptyMessage) {
      if (this.sawOtherContent || this.entries.length > 0) {
        throw new CodexMcpIsolationError('malformed');
      }
      return [];
    }
    if (!this.sawOtherContent || this.entries.length === 0) {
      throw new CodexMcpIsolationError('malformed');
    }
    return [...this.entries];
  }

  private consumeCompleteLines(): void {
    for (;;) {
      const newline = this.pending.indexOf('\n');
      if (newline < 0) {
        return;
      }
      const line = this.pending.slice(0, newline).replace(/\r$/, '');
      this.pending = this.pending.slice(newline + 1);
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (/[\u0000-\u001f\u007f]/u.test(line)) {
      throw new CodexMcpIsolationError('malformed');
    }
    if (line.trim().length === 0) {
      this.finishBlock();
      return;
    }
    if (line === EMPTY_MCP_LIST_MESSAGE) {
      if (this.sawOtherContent || this.sawEmptyMessage) {
        throw new CodexMcpIsolationError('malformed');
      }
      this.sawEmptyMessage = true;
      return;
    }
    if (this.sawEmptyMessage) {
      throw new CodexMcpIsolationError('malformed');
    }

    const header = parseMcpTableHeader(line);
    if (header) {
      this.finishBlock();
      this.block = header;
      this.sawOtherContent = true;
      return;
    }
    if (!this.block || line.length < this.block.authColumn) {
      throw new CodexMcpIsolationError('malformed');
    }

    const name = line.slice(0, this.block.transportColumn).trim();
    const statusMatches = [...line.matchAll(/(?:^| {2,})(enabled|disabled)(?= {2,})/g)];
    const status = statusMatches.at(-1)?.[1];
    assertSafeMcpServerName(name);
    if (!name || this.names.has(name) || (status !== 'enabled' && status !== 'disabled')) {
      throw new CodexMcpIsolationError('malformed');
    }
    if (this.entries.length >= MCP_MAX_SERVER_COUNT) {
      throw new CodexMcpIsolationError('capacity');
    }
    this.names.add(name);
    this.entries.push({
      name,
      transport: this.block.transport,
      enabled: status === 'enabled'
    });
    this.block.rows += 1;
    // The remainder of the redacted CLI row is deliberately not retained.
  }

  private finishBlock(): void {
    if (this.block && this.block.rows === 0) {
      throw new CodexMcpIsolationError('malformed');
    }
    this.block = undefined;
  }
}

function parseMcpTableHeader(line: string): McpTableBlock | undefined {
  const commandColumn = line.indexOf('Command');
  const urlColumn = line.indexOf('Url');
  const hasCommand = commandColumn > 0;
  const hasUrl = urlColumn > 0;
  if (hasCommand === hasUrl) {
    return undefined;
  }
  const transportColumn = hasCommand ? commandColumn : urlColumn;
  if (line.slice(0, transportColumn).trim() !== 'Name') {
    return undefined;
  }
  const transportLabel = hasCommand ? 'Command' : 'Url';
  const statusColumn = line.indexOf('Status', transportColumn + transportLabel.length);
  const authColumn = line.indexOf('Auth', statusColumn + 'Status'.length);
  if (statusColumn <= transportColumn || authColumn <= statusColumn) {
    throw new CodexMcpIsolationError('malformed');
  }
  return {
    transport: hasCommand ? 'stdio' : 'streamableHttp',
    transportColumn,
    statusColumn,
    authColumn,
    rows: 0
  };
}

function asMcpIsolationError(error: unknown): CodexMcpIsolationError {
  return error instanceof CodexMcpIsolationError
    ? error
    : new CodexMcpIsolationError('malformed', undefined, { cause: error });
}

function assertSafeMcpServerName(name: string): void {
  if (Buffer.byteLength(name, 'utf8') > MCP_MAX_SERVER_NAME_BYTES || hasLoneSurrogate(name)) {
    throw new CodexMcpIsolationError('capacity');
  }
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function loadCrossSpawn(): SpawnCommand {
  // cross-spawn is required at runtime so Windows npm .cmd launchers work
  // without enabling a shell or interpolating a command string.
  const imported = require('cross-spawn') as SpawnCommand | { default: SpawnCommand };
  return typeof imported === 'function' ? imported : imported.default;
}

function createLaunchError(error: unknown): CodexRuntimeError {
  const code = isNodeError(error) ? error.code : undefined;
  const kind: RuntimeFailureKind = code === 'ENOENT' ? 'missing' : 'exited';
  const message = kind === 'missing'
    ? 'The configured Codex executable could not be found.'
    : 'The configured Codex executable could not be started.';
  return new CodexRuntimeError(kind, message, MINIMUM_CODEX_CLI_VERSION, undefined, {
    cause: error
  });
}

function compareStableVersions(left: string, right: string): number {
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

function formatExitStatus(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `exit code ${code}`;
  }
  return signal ? `signal ${signal}` : 'unknown status';
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
