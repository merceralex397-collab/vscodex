import spawn from 'cross-spawn';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
const packageLock = JSON.parse(await readFile(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
const { requestedOutput, preRelease } = parseArguments(process.argv.slice(2));

if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error(
    'VS Code Marketplace versions must use major.minor.patch without a SemVer pre-release suffix.'
  );
}
if (packageLock.version !== manifest.version || packageLock.packages?.['']?.version !== manifest.version) {
  throw new Error('package.json and package-lock.json must contain the same release version.');
}

const outputPath = path.resolve(
  repositoryRoot,
  requestedOutput || defaultOutputName(manifest.version, preRelease)
);

const packageArguments = [
  '--no-install',
  'vsce',
  'package',
  '--out',
  outputPath
];
if (preRelease) {
  packageArguments.push('--pre-release');
}

await run('npx', packageArguments);
await run(process.execPath, [
  path.join(repositoryRoot, 'scripts', 'checkPackageSecurity.mjs'),
  '--vsix',
  outputPath
]);
process.stdout.write(
  `Validated ${preRelease ? 'pre-release' : 'stable'} VSIX: ${path.basename(outputPath)}\n`
);

function parseArguments(args) {
  let requestedOutput;
  let preRelease = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--pre-release') {
      if (preRelease) {
        throw new Error('--pre-release may only be supplied once.');
      }
      preRelease = true;
      continue;
    }
    if (argument === '--out') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--out requires a file path.');
      }
      if (requestedOutput !== undefined) {
        throw new Error('--out may only be supplied once.');
      }
      requestedOutput = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown packaging argument: ${argument}`);
  }

  return { requestedOutput, preRelease };
}

function defaultOutputName(version, preRelease) {
  const channelSuffix = preRelease ? '-pre-release' : '';
  return `codexvs-${version}${channelSuffix}.vsix`;
}

async function run(command, args) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    shell: false,
    stdio: 'inherit'
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Packaging command exited from signal ${signal}.`));
      } else {
        resolve(code ?? 1);
      }
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Packaging command failed with exit code ${exitCode}.`);
  }
}
