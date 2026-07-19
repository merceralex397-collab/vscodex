'use strict';

const test = require('node:test');
const { runStandalone } = require('../support/runStandalone.cjs');

test('complete provider flow through the fake app-server', { timeout: 120_000 }, async () => {
  await runStandalone('test/fakeAppServer.integration.mjs');
});
