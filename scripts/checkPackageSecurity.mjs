import { createRequire } from 'node:module';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yauzl = require('yauzl');
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repositoryRoot, 'package.json');
const bundlePath = path.join(repositoryRoot, 'out', 'extension.js');
const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
const errors = [];

checkManifest(manifest);
await checkSourceLicense();
await checkRemovedSourcePaths();
await checkMcpIsolationSource();
await checkBundle(bundlePath);
await checkIgnoreFile();

const vsixArgument = readArgument('--vsix');
if (vsixArgument !== undefined) {
  const vsixPath = path.resolve(repositoryRoot, vsixArgument || defaultVsixName(manifest.version));
  await checkVsix(vsixPath);
}

if (errors.length > 0) {
  throw new Error(`Package security acceptance failed:\n- ${errors.join('\n- ')}`);
}

process.stdout.write(vsixArgument === undefined
  ? 'Source, manifest, and compiled bundle security acceptance passed.\n'
  : 'Source, manifest, compiled bundle, and VSIX security acceptance passed.\n');

function checkManifest(packageJson) {
  reject(packageJson.name !== 'codexvs', 'Package name must be codexvs.');
  reject(packageJson.displayName !== 'CodexVS', 'Display name must be CodexVS.');
  reject(packageJson.publisher !== 'merceralex397-collab', 'Publisher must be merceralex397-collab.');
  reject(packageJson.version !== '0.2.1', 'Release manifest version must be 0.2.1.');
  reject(packageJson.license !== 'MIT', 'CodexVS must declare the MIT source license.');
  reject(packageJson.private !== true, 'The package must be private to prevent accidental npm publication.');
  reject(packageJson.homepage !== 'https://github.com/merceralex397-collab/vscodex#readme',
    'Manifest homepage must point to the public repository README.');
  reject(packageJson.bugs?.url !== 'https://github.com/merceralex397-collab/vscodex/issues',
    'Manifest bugs URL must point to the public issue tracker.');
  reject(packageJson.repository?.url !== 'https://github.com/merceralex397-collab/vscodex.git',
    'Repository URL is not the CodexVS repository.');
  reject(packageJson.icon !== 'assets/vscodex.png', 'Manifest must use the original CodexVS icon.');
  const allDependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies
  };
  for (const dependency of ['openai', 'ws']) {
    reject(dependency in allDependencies, `Forbidden direct transport dependency remains: ${dependency}.`);
  }
  reject(!('cross-spawn' in (packageJson.dependencies ?? {})), 'cross-spawn must remain a production dependency.');

  const properties = packageJson.contributes?.configuration?.properties ?? {};
  reject(Object.keys(properties).some((key) => !key.startsWith('codexvs.')),
    'Every extension setting must use the CodexVS namespace.');
  const forbiddenSettings = [
    'codexvs.baseURL',
    'codexvs.clientVersion',
    'codexvs.credentialsSource',
    'codexvs.transport',
    'codexvs.maxOutputTokens',
    'codexvs.modelPricingUsdPerMTok',
    'codexvs.apiKey'
  ];
  for (const setting of forbiddenSettings) {
    reject(setting in properties, `Removed direct-backend setting remains in package.json: ${setting}.`);
  }

  const commandSetting = properties['codexvs.appServer.command'];
  reject(!commandSetting, 'The machine-scoped app-server executable setting is missing.');
  reject(commandSetting?.scope !== 'machine', 'The app-server executable setting must have machine scope.');
  reject(commandSetting?.default !== 'codex', 'The app-server executable setting must default to codex.');

  const commandIds = new Set((packageJson.contributes?.commands ?? []).map((entry) => entry.command));
  reject([...commandIds].some((command) => !command.startsWith('codexvs.')),
    'Every command must use the CodexVS namespace.');
  for (const command of [
    'codexvs.setApiKey',
    'codexvs.clearApiKey',
    'codexForCopilot.auth.importAuthJson'
  ]) {
    reject(commandIds.has(command), `Removed credential command remains in package.json: ${command}.`);
  }

  reject(packageJson.main !== './out/extension.js', 'The packaged extension entry point must be out/extension.js.');
  reject(packageJson.contributes?.languageModelChatProviders?.[0]?.vendor !== 'codexvs',
    'Language model provider vendor must be codexvs.');
  reject(!Array.isArray(packageJson.extensionKind) || !packageJson.extensionKind.includes('workspace'),
    'The extension must run in a desktop or remote workspace extension host.');
}

async function checkSourceLicense() {
  const licensePath = path.join(repositoryRoot, 'LICENSE');
  if (!await exists(licensePath)) {
    errors.push('MIT LICENSE file is missing.');
    return;
  }
  const source = await readFile(licensePath, 'utf8');
  reject(!/^MIT License\r?\n/.test(source), 'LICENSE must contain the MIT License.');
  reject(!source.includes('Copyright (c) 2026 merceralex397-collab'),
    'LICENSE must contain the expected copyright holder.');
}

async function checkRemovedSourcePaths() {
  const removedFiles = [
    'src/responsesClient.ts',
    'src/secrets.ts',
    'src/responseBranchStore.ts'
    ,'src/migration.ts'
  ];
  for (const relativePath of removedFiles) {
    reject(await exists(path.join(repositoryRoot, relativePath)),
      `Removed direct-backend source path still exists: ${relativePath}.`);
  }
  reject(await directoryContainsFiles(path.join(repositoryRoot, 'src', 'auth')),
    'Removed direct-backend source path still contains files: src/auth.');
  reject(await directoryContainsFiles(path.join(repositoryRoot, 'src', 'appServer', 'protocol', 'generated')),
    'Version-specific generated protocol bindings must not be checked in.');
}

async function checkMcpIsolationSource() {
  const runtimePath = path.join(repositoryRoot, 'src', 'appServer', 'runtime.ts');
  const processPath = path.join(repositoryRoot, 'src', 'appServer', 'appServerProcess.ts');
  const runtimeSource = await readFile(runtimePath, 'utf8');
  const processSource = await readFile(processPath, 'utf8');
  reject(/['"]--json['"]/.test(runtimeSource),
    'Production MCP isolation must never request the credential-bearing JSON listing.');
  reject(!runtimeSource.includes("'mcp', 'list'"),
    'Production MCP isolation must use the redacted text listing.');
  reject(!runtimeSource.includes('interface McpIsolationStrategy'),
    'MCP isolation must remain behind a replaceable strategy interface.');
  reject(!processSource.includes("APP_SERVER_ARGUMENTS.indexOf('app-server')"),
    'App-server launch must place global passive overrides before the subcommand.');
}

async function checkBundle(filePath) {
  if (!await exists(filePath)) {
    errors.push('Compiled extension bundle is missing; run npm run compile before security acceptance.');
    return;
  }
  const source = await readFile(filePath, 'utf8');
  const forbidden = [
    ['direct ChatGPT backend URL', /chatgpt\.com\/backend-api/i],
    ['OpenAI Responses SDK import', /openai\/resources\/responses/i],
    ['legacy Responses transport module', /responsesClient/],
    ['legacy Codex auth manager', /CodexAuthManager/],
    ['auth.json credential import', /importAuthJson|auth\.json/],
    ['API-key command', /codexvs\.(?:setApiKey|clearApiKey)/],
    ['custom backend setting', /codexvs\.baseURL/],
    ['transport selection setting', /codexvs\.transport/],
    ['hard-coded OAuth client identifier', /client[_-]?id["']?\s*[:=]\s*["'][A-Za-z0-9_-]{12,}/i],
    ['WebSocket Responses transport', /responses\/ws|require\(["']ws["']\)/i]
    ,['workspace current-directory exposure', /workspaceFolders?.*cwd|cwd.*workspaceFolders?/i]
  ];
  for (const [label, pattern] of forbidden) {
    reject(pattern.test(source), `Compiled extension contains ${label}.`);
  }
}

async function checkIgnoreFile() {
  const ignorePath = path.join(repositoryRoot, '.vscodeignore');
  if (!await exists(ignorePath)) {
    errors.push('.vscodeignore is missing.');
    return;
  }
  const entries = new Set((await readFile(ignorePath, 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean));
  for (const required of [
    '.github/**',
    '.vscode/**',
    '.vscode-test/**',
    'docs/**',
    'scripts/**',
    'src/**',
    'test/**',
    'node_modules/**',
    'assets/*.svg',
    '**/AGENTS.md',
    'out/**/*.map',
    '*.vsix',
    'logs/**',
    '*.md',
    '!README.md',
    '!CHANGELOG.md',
    '!SECURITY.md',
    '!THIRD_PARTY_NOTICES.md'
  ]) {
    reject(!entries.has(required), `.vscodeignore must exclude ${required}.`);
  }
}

async function checkVsix(vsixPath) {
  if (!await exists(vsixPath) || !(await stat(vsixPath)).isFile()) {
    errors.push(`VSIX is missing: ${path.basename(vsixPath)}.`);
    return;
  }

  const entries = await readZip(vsixPath);
  const names = new Set(entries.map((entry) => entry.fileName));
  for (const required of [
    'extension/package.json',
    'extension/out/extension.js',
    'extension/readme.md',
    'extension/LICENSE.txt',
    'extension/THIRD_PARTY_NOTICES.md',
    'extension/assets/vscodex.png'
  ]) {
    reject(!names.has(required), `VSIX is missing required file ${required}.`);
  }

  const allowedFiles = new Set([
    'extension/package.json',
    'extension/readme.md',
    'extension/changelog.md',
    'extension/SECURITY.md',
    'extension/THIRD_PARTY_NOTICES.md',
    'extension/LICENSE.txt',
    'extension/out/extension.js',
    'extension/assets/vscodex.png'
  ]);
  for (const entry of entries) {
    const name = entry.fileName.replaceAll('\\', '/');
    reject(name.includes('../') || name.startsWith('/'), `VSIX contains an unsafe archive path: ${name}.`);
    reject(name.startsWith('extension/') && !name.endsWith('/') && !allowedFiles.has(name),
      `VSIX contains a file outside the package allowlist: ${name}.`);
  }

  const packagedBundle = await readZipEntry(vsixPath, 'extension/out/extension.js');
  if (packagedBundle) {
    const workspaceBundle = await readFile(bundlePath);
    reject(!packagedBundle.equals(workspaceBundle), 'VSIX bundle differs from the security-checked out/extension.js.');
  }
  const packagedManifest = await readZipEntry(vsixPath, 'extension/package.json');
  if (packagedManifest) {
    checkManifest(JSON.parse(packagedManifest.toString('utf8')));
  }
  const packagedLicense = await readZipEntry(vsixPath, 'extension/LICENSE.txt');
  if (packagedLicense) {
    const workspaceLicense = await readFile(path.join(repositoryRoot, 'LICENSE'));
    reject(!packagedLicense.equals(workspaceLicense), 'VSIX LICENSE differs from the checked repository license.');
  }
}

function readZip(vsixPath) {
  return new Promise((resolve, rejectPromise) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(new Error('Could not inspect the packaged VSIX.'));
        return;
      }
      const entries = [];
      zip.once('error', () => rejectPromise(new Error('Could not inspect the packaged VSIX.')));
      zip.on('entry', (entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.once('end', () => resolve(entries));
      zip.readEntry();
    });
  });
}

function readZipEntry(vsixPath, expectedName) {
  return new Promise((resolve, rejectPromise) => {
    yauzl.open(vsixPath, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        rejectPromise(new Error('Could not inspect the packaged VSIX.'));
        return;
      }
      let settled = false;
      zip.once('error', () => finishReject('Could not inspect the packaged VSIX.'));
      zip.on('entry', (entry) => {
        if (entry.fileName !== expectedName) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finishReject('Could not read the packaged extension bundle.');
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.once('error', () => finishReject('Could not read the packaged extension bundle.'));
          stream.once('end', () => finishResolve(Buffer.concat(chunks)));
        });
      });
      zip.once('end', () => finishResolve(undefined));
      zip.readEntry();

      function finishResolve(value) {
        if (settled) {
          return;
        }
        settled = true;
        zip.close();
        resolve(value);
      }

      function finishReject(message) {
        if (settled) {
          return;
        }
        settled = true;
        zip.close();
        rejectPromise(new Error(message));
      }
    });
  });
}

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const next = process.argv[index + 1];
  return next && !next.startsWith('--') ? next : '';
}

function defaultVsixName(version) {
  return `codexvs-${version}.vsix`;
}

function reject(condition, message) {
  if (condition) {
    errors.push(message);
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryContainsFiles(directory) {
  if (!await exists(directory)) {
    return false;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      return true;
    }
    if (entry.isDirectory() && await directoryContainsFiles(path.join(directory, entry.name))) {
      return true;
    }
  }
  return false;
}
