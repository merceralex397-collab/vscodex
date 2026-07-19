import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: [
      "export * from './src/appServer/types.ts';",
      "export * from './src/appServer/authController.ts';",
      "export * from './src/appServer/modelCatalog.ts';",
      "export * from './src/appServer/accountUsageAdapter.ts';"
    ].join('\n'),
    resolveDir: process.cwd(),
    sourcefile: 'account-model-adapters-entry.ts'
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  write: false
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`;
const {
  AccountUsageAdapter,
  AuthController,
  ChatGptAccountRequiredError,
  CodexCompatibilityError,
  LoginCancelledError,
  LoginTimeoutError,
  ModelCatalog
} = await import(moduleUrl);

class FakeRpc {
  listeners = new Set();
  handlers = new Map();
  calls = [];

  onNotification = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  enqueue(method, response) {
    const queue = this.handlers.get(method) ?? [];
    queue.push(response);
    this.handlers.set(method, queue);
  }

  async request(method, params, options) {
    this.calls.push({ method, params, options });
    const queue = this.handlers.get(method) ?? [];
    if (queue.length === 0) {
      throw new Error(`No fake response for ${method}`);
    }
    const response = queue.shift();
    return typeof response === 'function' ? response(params, options) : response;
  }

  emit(method, params) {
    for (const listener of [...this.listeners]) {
      listener({ method, params });
    }
  }
}

await testAuthLifecycle();
await testModelCatalog();
await testAccountUsage();
console.log('Account, model catalog, and usage adapter tests passed.');

async function testAuthLifecycle() {
  const rpc = new FakeRpc();
  rpc.enqueue('getAuthStatus', {
    authMethod: 'chatgpt',
    authToken: null,
    requiresOpenaiAuth: true
  });
  rpc.enqueue('account/read', {
    account: { type: 'chatgpt', email: 'not-exposed@example.com', planType: 'pro' },
    requiresOpenaiAuth: true
  });
  const auth = new AuthController(rpc, { loginTimeoutMs: 200 });
  assert.deepEqual(await auth.readAccount(false), { type: 'chatgpt', planType: 'pro' });
  assert.deepEqual(rpc.calls[0].params, { includeToken: false, refreshToken: false });
  assert.deepEqual(rpc.calls[1].params, { refreshToken: false });

  rpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'browser-1',
    authUrl: 'https://example.invalid/login?secret=value'
  });
  rpc.enqueue('account/read', {
    account: { type: 'chatgpt', email: 'hidden@example.com', planType: 'plus' },
    requiresOpenaiAuth: true
  });
  const browser = await auth.beginLogin('browser');
  assert.equal(browser.kind, 'browser');
  assert.deepEqual(rpc.calls.at(-1).params, {
    type: 'chatgpt',
    useHostedLoginSuccessPage: true,
    appBrand: 'chatgpt'
  });
  rpc.emit('account/login/completed', {
    loginId: 'browser-1',
    success: true,
    error: null
  });
  assert.deepEqual(await browser.completion, { type: 'chatgpt', planType: 'plus' });

  const accountEvents = [];
  const subscription = auth.onDidChangeAccount((event) => accountEvents.push(event));
  rpc.emit('account/updated', {
    authMode: 'chatgpt',
    planType: 'plus',
    email: 'must-not-escape@example.com'
  });
  assert.deepEqual(accountEvents, [{ generation: 1, authMode: 'chatgpt', planType: 'plus' }]);
  assert.equal(JSON.stringify(accountEvents).includes('must-not-escape'), false);

  rpc.emit('account/updated', {
    authMode: 'chatgptAuthTokens',
    planType: 'plus'
  });
  await assert.rejects(
    auth.readAccount(false),
    ChatGptAccountRequiredError,
    'A ChatGPT-shaped account must not bypass an announced token authentication mode.'
  );

  rpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'browser-after-token-mode',
    authUrl: 'https://example.invalid/login'
  });
  rpc.enqueue('account/read', {
    account: { type: 'chatgpt', planType: 'pro' },
    requiresOpenaiAuth: true
  });
  const browserAfterTokenMode = await auth.beginLogin('browser');
  rpc.emit('account/login/completed', {
    loginId: 'browser-after-token-mode',
    success: true,
    error: null
  });
  assert.deepEqual(
    await browserAfterTokenMode.completion,
    { type: 'chatgpt', planType: 'pro' },
    'A successful extension-owned ChatGPT login must supersede a previously announced unsupported mode.'
  );

  rpc.enqueue('account/login/start', {
    type: 'chatgptDeviceCode',
    loginId: 'device-1',
    verificationUrl: 'https://example.invalid/device',
    userCode: 'ABCD-EFGH'
  });
  rpc.enqueue('account/login/cancel', { status: 'canceled' });
  const device = await auth.beginLogin('deviceCode');
  assert.equal(device.kind, 'deviceCode');
  assert.equal(device.userCode, 'ABCD-EFGH');
  await auth.cancelLogin('device-1');
  await assert.rejects(device.completion, LoginCancelledError);

  rpc.enqueue('account/read', {
    account: { type: 'apiKey' },
    requiresOpenaiAuth: true
  });
  await assert.rejects(auth.readAccount(false), ChatGptAccountRequiredError);

  rpc.enqueue('account/logout', {});
  const generationBeforeLogout = auth.generation;
  await auth.logout();
  assert.equal(auth.account, undefined);
  assert.equal(auth.generation, generationBeforeLogout + 1);

  subscription.dispose();
  auth.dispose();

  const timeoutRpc = new FakeRpc();
  timeoutRpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'timeout-1',
    authUrl: 'https://example.invalid/login'
  });
  timeoutRpc.enqueue('account/login/cancel', { status: 'canceled' });
  let fireTimer;
  const timeoutAuth = new AuthController(timeoutRpc, {
    setTimer: (callback) => {
      fireTimer = callback;
      return 1;
    },
    clearTimer: () => undefined
  });
  const timedOut = await timeoutAuth.beginLogin('browser');
  fireTimer();
  await assert.rejects(timedOut.completion, LoginTimeoutError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(timeoutRpc.calls.at(-1).method, 'account/login/cancel');
  timeoutAuth.dispose();

  const failureRpc = new FakeRpc();
  failureRpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'failure-1',
    authUrl: 'https://example.invalid/login'
  });
  const failureAuth = new AuthController(failureRpc);
  const failed = await failureAuth.beginLogin('browser');
  failureRpc.emit('account/login/completed', {
    loginId: 'failure-1',
    success: false,
    error: 'See https://secret.invalid/path for hidden@example.com'
  });
  await assert.rejects(failed.completion, (error) => {
    assert.equal(error.message.includes('secret.invalid'), false);
    assert.equal(error.message.includes('hidden@example.com'), false);
    return true;
  });
  failureAuth.dispose();

  const earlyRpc = new FakeRpc();
  earlyRpc.enqueue('account/login/start', () => {
    earlyRpc.emit('account/login/completed', {
      loginId: 'early-1',
      success: true,
      error: null
    });
    return {
      type: 'chatgpt',
      loginId: 'early-1',
      authUrl: 'https://example.invalid/login'
    };
  });
  earlyRpc.enqueue('account/read', {
    account: { type: 'chatgpt', email: null, planType: 'team' },
    requiresOpenaiAuth: true
  });
  const earlyAuth = new AuthController(earlyRpc);
  const early = await earlyAuth.beginLogin('browser');
  assert.deepEqual(await early.completion, { type: 'chatgpt', planType: 'team' });
  earlyAuth.dispose();

  const racingRpc = new FakeRpc();
  racingRpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'racing-login',
    authUrl: 'https://example.invalid/login'
  });
  racingRpc.enqueue('account/read', () => {
    racingRpc.emit('account/updated', { authMode: 'chatgpt', planType: 'pro' });
    return { account: { type: 'chatgpt', planType: 'pro' } };
  });
  racingRpc.enqueue('account/read', {
    account: { type: 'chatgpt', planType: 'pro' }
  });
  const racingAuth = new AuthController(racingRpc);
  const racingLogin = await racingAuth.beginLogin('browser');
  racingRpc.emit('account/login/completed', {
    loginId: 'racing-login',
    success: true,
    error: null
  });
  assert.deepEqual(await racingLogin.completion, { type: 'chatgpt', planType: 'pro' });
  assert.equal(racingRpc.calls.filter((call) => call.method === 'account/read').length, 2);
  racingAuth.dispose();

  const deviceRaceRpc = new FakeRpc();
  deviceRaceRpc.enqueue('account/login/start', {
    type: 'chatgptDeviceCode',
    loginId: 'racing-device-login',
    verificationUrl: 'https://example.invalid/device',
    userCode: 'RACE-CODE'
  });
  deviceRaceRpc.enqueue('account/read', () => {
    deviceRaceRpc.emit('account/updated', { authMode: 'chatgpt', planType: 'team' });
    return { account: { type: 'chatgpt', planType: 'team' } };
  });
  deviceRaceRpc.enqueue('account/read', {
    account: { type: 'chatgpt', planType: 'team' }
  });
  const deviceRaceAuth = new AuthController(deviceRaceRpc);
  const racingDeviceLogin = await deviceRaceAuth.beginLogin('deviceCode');
  deviceRaceRpc.emit('account/login/completed', {
    loginId: 'racing-device-login',
    success: true,
    error: null
  });
  assert.deepEqual(await racingDeviceLogin.completion, { type: 'chatgpt', planType: 'team' });
  assert.equal(deviceRaceRpc.calls.filter((call) => call.method === 'account/read').length, 2);
  deviceRaceAuth.dispose();

  for (const unsupportedMode of ['chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken']) {
    const statusRpc = new FakeRpc();
    statusRpc.enqueue('getAuthStatus', {
      authMethod: unsupportedMode,
      authToken: null,
      requiresOpenaiAuth: true
    });
    const statusAuth = new AuthController(statusRpc);
    await assert.rejects(
      statusAuth.readAccount(false),
      ChatGptAccountRequiredError,
      `${unsupportedMode} must fail closed during the initial token-free authentication check.`
    );
    assert.equal(statusRpc.calls.some((call) => call.method === 'account/read'), false);
    statusAuth.dispose();
  }

  const leakedTokenRpc = new FakeRpc();
  leakedTokenRpc.enqueue('getAuthStatus', {
    authMethod: 'chatgpt',
    authToken: 'must-not-be-accepted-or-logged',
    requiresOpenaiAuth: true
  });
  const leakedTokenAuth = new AuthController(leakedTokenRpc);
  await assert.rejects(leakedTokenAuth.readAccount(false), (error) => {
    assert.match(error.message, /credential material/);
    assert.equal(error.message.includes('must-not-be-accepted-or-logged'), false);
    return true;
  });
  leakedTokenAuth.dispose();

  for (const unsupportedMode of ['headers', 'agentIdentity', 'personalAccessToken']) {
    const unsupportedRpc = new FakeRpc();
    const unsupportedAuth = new AuthController(unsupportedRpc);
    unsupportedRpc.emit('account/updated', { authMode: unsupportedMode, planType: 'pro' });
    unsupportedRpc.enqueue('account/read', {
      account: { type: 'chatgpt', planType: 'pro' },
      requiresOpenaiAuth: true
    });
    await assert.rejects(
      unsupportedAuth.readAccount(false),
      ChatGptAccountRequiredError,
      `${unsupportedMode} must not be accepted as browser-managed ChatGPT authentication.`
    );
    unsupportedAuth.dispose();
  }

  const logoutBeforeResponseRpc = new FakeRpc();
  const logoutBeforeResponseAuth = new AuthController(logoutBeforeResponseRpc);
  const logoutBeforeEvents = [];
  logoutBeforeResponseAuth.onDidChangeAccount((event) => logoutBeforeEvents.push(event));
  logoutBeforeResponseRpc.enqueue('account/logout', () => {
    logoutBeforeResponseRpc.emit('account/updated', { authMode: null, planType: null });
    return {};
  });
  await logoutBeforeResponseAuth.logout();
  assert.equal(logoutBeforeEvents.length, 1, 'A logout notification before the RPC response must not be double-counted.');
  logoutBeforeResponseAuth.dispose();

  const logoutAfterResponseRpc = new FakeRpc();
  const logoutAfterResponseAuth = new AuthController(logoutAfterResponseRpc);
  const logoutAfterEvents = [];
  logoutAfterResponseAuth.onDidChangeAccount((event) => logoutAfterEvents.push(event));
  logoutAfterResponseRpc.enqueue('account/logout', {});
  await logoutAfterResponseAuth.logout();
  logoutAfterResponseRpc.emit('account/updated', { authMode: null, planType: null });
  assert.equal(logoutAfterEvents.length, 1, 'A late signed-out notification must be deduplicated after local logout invalidation.');
  logoutAfterResponseAuth.dispose();

  const pristineRpc = new FakeRpc();
  const pristineAuth = new AuthController(pristineRpc);
  assert.equal(pristineAuth.invalidateProcess(), false);
  assert.equal(pristineAuth.generation, 0, 'The first process start must not invalidate pristine auth state.');
  pristineAuth.dispose();

  const processRpc = new FakeRpc();
  processRpc.enqueue('getAuthStatus', {
    authMethod: 'chatgpt',
    authToken: null,
    requiresOpenaiAuth: true
  });
  processRpc.enqueue('account/read', {
    account: { type: 'chatgpt', planType: 'pro' }
  });
  const processAuth = new AuthController(processRpc);
  await processAuth.readAccount(false);
  processRpc.enqueue('account/login/start', {
    type: 'chatgpt',
    loginId: 'process-bound-login',
    authUrl: 'https://example.invalid/login'
  });
  const processBoundLogin = await processAuth.beginLogin('browser');
  const generationBeforeProcessChange = processAuth.generation;
  assert.equal(processAuth.invalidateProcess(), true);
  assert.equal(processAuth.generation, generationBeforeProcessChange + 1);
  assert.equal(processAuth.account, undefined);
  await assert.rejects(processBoundLogin.completion, (error) => {
    assert.equal(error instanceof LoginCancelledError, true);
    assert.match(error.message, /process changed/i);
    return true;
  });
  assert.equal(
    processRpc.calls.some((call) => call.method === 'account/login/cancel'),
    false,
    'Process invalidation must not launch a replacement process just to cancel an old login.'
  );

  processRpc.enqueue('getAuthStatus', {
    authMethod: 'headers',
    authToken: null,
    requiresOpenaiAuth: true
  });
  await assert.rejects(processAuth.readAccount(false), ChatGptAccountRequiredError);
  assert.equal(
    processRpc.calls.filter((call) => call.method === 'getAuthStatus').length,
    2,
    'A replacement process must be queried instead of reusing the old announced auth mode.'
  );
  processAuth.dispose();
}

async function testModelCatalog() {
  const rpc = new FakeRpc();
  const model = {
    id: 'catalog-gpt',
    model: 'gpt-5.4',
    displayName: 'GPT-5.4',
    description: 'Main Codex model.',
    hidden: false,
    isDefault: true,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced.' },
      { reasoningEffort: 'high', description: 'Deeper.' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Lower latency.' }],
    defaultServiceTier: 'fast'
  };
  rpc.enqueue('model/list', { data: [{ ...model, futureOptionalField: { enabled: true } }], nextCursor: 'page-2', futurePageField: 1 });
  rpc.enqueue('model/list', {
    data: [{
      ...model,
      id: 'catalog-mini',
      model: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 mini',
      isDefault: false,
      inputModalities: ['text']
    }],
    nextCursor: null
  });

  const catalog = new ModelCatalog(rpc, { runtimeVersion: '0.144.4', pageSize: 1 });
  const models = await catalog.listModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].model, 'gpt-5.4');
  assert.deepEqual(models[0].supportedReasoningEfforts.map((entry) => entry.effort), ['medium', 'high']);
  assert.deepEqual(models[0].inputModalities, ['text', 'image']);
  assert.deepEqual(models[0].serviceTiers.map((entry) => entry.id), ['fast']);
  assert.match(models[0].catalogHash, /^[0-9a-f]{16}$/);
  assert.deepEqual(rpc.calls.filter((call) => call.method === 'model/list').map((call) => call.params.cursor), [null, 'page-2']);

  const updates = [];
  catalog.onDidUpdateContextWindow((event) => updates.push(event));
  assert.equal(catalog.updateContextWindow('gpt-5.4', 400000), true);
  assert.equal(catalog.updateContextWindow('gpt-5.4', 400000), false);
  assert.deepEqual(updates, [{ model: 'gpt-5.4', contextWindow: 400000 }]);

  rpc.enqueue('model/list', { data: [model], nextCursor: null });
  const refreshed = await catalog.listModels();
  assert.equal(refreshed[0].contextWindow, 400000);
  assert.equal(refreshed[0].catalogHash, models[0].catalogHash);
  catalog.dispose();

  const malformedRpc = new FakeRpc();
  malformedRpc.enqueue('model/list', {
    data: [{ ...model, displayName: undefined }],
    nextCursor: null
  });
  const malformedCatalog = new ModelCatalog(malformedRpc, { runtimeVersion: '0.145.0' });
  await assert.rejects(
    malformedCatalog.listModels(),
    (error) => error instanceof CodexCompatibilityError
      && error.cliVersion === '0.145.0'
      && error.methodOrEvent === 'model/list'
      && error.category === 'malformed-required-response'
  );
  malformedCatalog.dispose();
}

async function testAccountUsage() {
  const rpc = new FakeRpc();
  rpc.enqueue('account/rateLimits/read', {
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2_000_000_000 },
      secondary: { usedPercent: 50, windowDurationMins: 10080, resetsAt: 2_000_100_000 },
      credits: { hasCredits: true, unlimited: false, balance: '12.5' },
      individualLimit: null,
      planType: 'pro',
      rateLimitReachedType: null
    },
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null
  });
  rpc.enqueue('account/usage/read', {
    summary: {
      lifetimeTokens: '9007199254740993',
      peakDailyTokens: 12000,
      longestRunningTurnSec: 90,
      currentStreakDays: 4,
      longestStreakDays: 8
    },
    dailyUsageBuckets: [{ startDate: '2026-07-14', tokens: 1234 }]
  });

  const usage = new AccountUsageAdapter(rpc, { now: () => 1_750_000_000_000 });
  const events = [];
  usage.onDidUpdateRateLimits((event) => events.push(event));
  const initial = await usage.readRateLimits();
  assert.equal(initial.planType, 'pro');
  assert.equal(initial.creditsBalance, 12.5);
  assert.equal(initial.limits.length, 2);
  assert.equal(initial.limits[0].remainingPercent, 75);
  assert.equal(initial.limits[0].resetAt, 2_000_000_000_000);

  rpc.emit('account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      limitName: null,
      primary: { usedPercent: 80, windowDurationMins: null, resetsAt: null },
      secondary: null,
      credits: null,
      individualLimit: null,
      planType: null,
      rateLimitReachedType: null
    }
  });
  assert.equal(usage.snapshot.planType, 'pro');
  assert.equal(usage.snapshot.creditsBalance, 12.5);
  assert.equal(usage.snapshot.limits[0].windowMinutes, 300);
  assert.equal(usage.snapshot.limits[0].usedPercent, 80);
  assert.equal(events.at(-1).limits[0].usedPercent, 80);

  const activity = await usage.readTokenActivity();
  assert.equal(activity.lifetimeTokens, 9007199254740993n);
  assert.equal(activity.dailyUsage[0].tokens, 1234);
  usage.dispose();

  const sparseRpc = new FakeRpc();
  sparseRpc.enqueue('account/rateLimits/read', {
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType: 'pro'
    },
    rateLimitsByLimitId: {
      review: {
        limitId: 'review',
        limitName: 'Code review',
        primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: null },
        secondary: null,
        credits: null,
        planType: 'pro'
      }
    }
  });
  const sparseUsage = new AccountUsageAdapter(sparseRpc, { now: () => 1_750_000_000_000 });
  await sparseUsage.readRateLimits();
  sparseRpc.emit('account/rateLimits/updated', {
    rateLimits: {
      limitId: null,
      limitName: null,
      primary: { usedPercent: 75, windowDurationMins: null, resetsAt: null },
      secondary: null,
      credits: null,
      planType: null
    }
  });
  const codexWindow = sparseUsage.snapshot.limits.find((limit) => limit.limitId === 'codex');
  const reviewWindow = sparseUsage.snapshot.limits.find((limit) => limit.limitId === 'review');
  assert.equal(codexWindow.usedPercent, 75, 'An anonymous sparse update must merge into the tracked primary limit.');
  assert.equal(reviewWindow.usedPercent, 20);
  assert.equal(sparseUsage.snapshot.limits.length, 2, 'The sparse update must not create an anonymous duplicate limit.');
  sparseUsage.dispose();
}
