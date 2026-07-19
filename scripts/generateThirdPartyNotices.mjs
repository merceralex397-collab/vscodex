import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const queue = Object.keys(manifest.dependencies ?? {});
const visited = new Set();
const packages = [];

while (queue.length > 0) {
  const name = queue.shift();
  if (!name || visited.has(name)) {
    continue;
  }
  visited.add(name);
  const lockEntry = lock.packages?.[`node_modules/${name}`];
  if (!lockEntry) {
    throw new Error(`Production dependency ${name} is missing from package-lock.json.`);
  }
  packages.push({ name, version: lockEntry.version, license: lockEntry.license });
  queue.push(...Object.keys(lockEntry.dependencies ?? {}));
}

packages.sort((left, right) => left.name.localeCompare(right.name));
const sections = [
  '# Third-party notices',
  '',
  'CodexVS bundles the following third-party packages. These notices apply only to those packages and do not license CodexVS source code.',
  ''
];

for (const entry of packages) {
  const packageDirectory = path.join(root, 'node_modules', entry.name);
  const names = await readdir(packageDirectory);
  const licenseFile = names.find((name) => /^(?:licen[cs]e|copying)(?:\..*)?$/i.test(name));
  const licenseText = licenseFile
    ? (await readFile(path.join(packageDirectory, licenseFile), 'utf8')).trim()
    : `Declared license: ${entry.license ?? 'not specified'}`;
  sections.push(
    `## ${entry.name} ${entry.version}`,
    '',
    `Declared license: ${entry.license ?? 'not specified'}`,
    '',
    '```text',
    licenseText.replaceAll('```', "'''"),
    '```',
    ''
  );
}

const generated = `${sections.join('\n').trimEnd()}\n`;
if (process.argv.includes('--check')) {
  const existing = await readFile(outputPath, 'utf8').catch(() => '');
  if (existing.replaceAll('\r\n', '\n') !== generated) {
    throw new Error('THIRD_PARTY_NOTICES.md is stale. Run npm run generate:notices.');
  }
} else {
  await writeFile(outputPath, generated, 'utf8');
  process.stdout.write(`Generated notices for ${packages.length} production packages.\n`);
}
