'use strict';

const test = require('node:test');
const { runStandalone } = require('../support/runStandalone.cjs');

const focusedTests = [
  'test/runtimeValidation.test.cjs',
  'test/jsonRpcStdioClient.test.cjs',
  'test/runtimeAppServerProcess.test.cjs',
  'test/accountModelAdapters.unit.mjs',
  'test/modelProviderMetadata.unit.mjs',
  'test/providerDiscovery.unit.mjs',
  'test/vsCodeIntegration.unit.mjs',
  'test/accountUsageStatusBar.unit.mjs',
  'test/messageConversion.unit.mjs',
  'test/appServerConversationToolState.unit.mjs'
];

for (const testPath of focusedTests) {
  test(testPath, { timeout: 120_000 }, async () => {
    await runStandalone(testPath);
  });
}
