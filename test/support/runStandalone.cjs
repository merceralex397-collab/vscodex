'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN'
]);

function runStandalone(relativePath) {
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !SENSITIVE_ENVIRONMENT_KEYS.has(key.toUpperCase())));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repositoryRoot, relativePath)], {
      cwd: repositoryRoot,
      env: environment,
      stdio: 'inherit',
      windowsHide: true
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal
        ? `${relativePath} exited with signal ${signal}.`
        : `${relativePath} exited with code ${code}.`));
    });
  });
}

module.exports = { runStandalone };
