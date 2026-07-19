import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';

const tempDir = await mkdtemp(join(tmpdir(), 'codex-app-server-state-'));
const require = createRequire(import.meta.url);

try {
  const modules = {};
  for (const name of ['conversationThreadStore', 'eventRouter', 'toolBridge', 'turnCoordinator']) {
    const outfile = join(tempDir, `${name}.cjs`);
    await build({
      entryPoints: [`src/appServer/${name}.ts`],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node20',
      outfile
    });
    modules[name] = require(outfile);
  }

  testConversationPlanning(modules.conversationThreadStore);
  testActiveConversationBranchesDoNotExpire(modules.conversationThreadStore);
  testGenerationScopedInvalidation(modules.conversationThreadStore);
  testEventRouting(modules.eventRouter);
  await testToolHandoff(modules.toolBridge);
  await testToolCallIdentityScoping(modules.toolBridge);
  await testCoordinatorToolRoundTrip(modules);
  await testMismatchedDynamicToolTurnFailsClosed(modules);
  await testRequiredModeAndPassivePolicy(modules);
  await testMismatchedPassiveLifecycleFailsClosed(modules);
  await testMalformedTerminalEvents(modules);
  await testMalformedTokenUsageIsIgnored(modules);
  await testPreIdHostCancellation(modules);
  await testInterruptFailurePreservesHostCancellation(modules);
  await testLocalInvalidationDoesNotInterrupt(modules);

  console.log('Unit tests passed: app-server conversation, event, tool, and turn state.');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function testConversationPlanning({ ConversationThreadStore, hashHistory }) {
  let now = 1_000;
  const evictions = [];
  const store = new ConversationThreadStore({
    maxBranches: 2,
    ttlMs: 100,
    now: () => now,
    onEvict: (_branch, reason) => evictions.push(reason)
  });
  const envelope = testEnvelope();
  const history = [{ role: 'user', text: 'one' }, { role: 'user', text: 'two' }];
  const branch = store.register({
    envelope,
    projectedHistory: history,
    threadId: 'thread-1',
    checkpoints: [{
      projectedHistoryLength: 1,
      historyHash: hashHistory(history.slice(0, 1)),
      turnId: 'turn-1'
    }]
  });

  const continuation = store.plan(envelope, [...history, { role: 'user', text: 'three' }]);
  equal(continuation.kind, 'continue', 'append-only history continues');
  equal(continuation.branch.id, branch.id, 'continuation branch');
  equal(continuation.appendedHistory.length, 1, 'continuation delta');

  const fork = store.plan(envelope, [history[0], { role: 'user', text: 'alternate' }]);
  equal(fork.kind, 'fork', 'exact checkpoint can fork');
  equal(fork.checkpoint.turnId, 'turn-1', 'fork checkpoint turn');

  const nonCheckpointDivergence = store.plan(envelope, [history[0], history[1], { role: 'user', text: 'same' }]);
  equal(nonCheckpointDivergence.kind, 'continue', 'full stored history remains a continuation');

  const envelopeChange = store.plan({ ...envelope, serviceTier: 'fast' }, history);
  equal(envelopeChange.kind, 'cold', 'envelope change reconstructs cold');

  store.register({ envelope, projectedHistory: [], threadId: 'thread-2' });
  store.register({ envelope, projectedHistory: [], threadId: 'thread-3' });
  ok(evictions.includes('overflow'), 'branch capacity evicts oldest');
  now += 101;
  equal(store.size, 0, 'idle branches expire');
  ok(evictions.includes('expired'), 'expiry hook runs');
}

function testActiveConversationBranchesDoNotExpire({ ConversationThreadStore }) {
  let now = 1_000;
  const evictions = [];
  const store = new ConversationThreadStore({
    maxBranches: 3,
    ttlMs: 100,
    now: () => now,
    onEvict: (branch, reason) => evictions.push({ threadId: branch.threadId, reason })
  });
  const envelope = testEnvelope();
  const idle = store.register({ envelope, projectedHistory: [], threadId: 'thread-idle' });
  const active = store.register({ envelope, projectedHistory: [], threadId: 'thread-active' });
  const suspended = store.register({ envelope, projectedHistory: [], threadId: 'thread-suspended' });

  store.setActiveTurn(active.id, { turnId: 'turn-active', visibleOutput: false });
  store.setPendingTools(suspended.id, [{ callId: 'call-suspended', turnId: 'turn-suspended' }]);
  now += 101;

  equal(store.size, 2, 'active and suspended branches survive the idle TTL');
  deepEqual(
    evictions,
    [{ threadId: idle.threadId, reason: 'expired' }],
    'only the inactive idle branch expires'
  );

  store.setActiveTurn(active.id, undefined);
  store.setPendingTools(suspended.id, []);
  now += 101;

  equal(store.size, 0, 'branches expire after active and pending state is cleared');
  deepEqual(
    evictions.slice(1),
    [
      { threadId: 'thread-active', reason: 'expired' },
      { threadId: 'thread-suspended', reason: 'expired' }
    ],
    'cleared branches return to normal idle expiry'
  );
}

function testGenerationScopedInvalidation({ ConversationThreadStore }) {
  const evictions = [];
  const store = new ConversationThreadStore({
    onEvict: (branch, reason) => evictions.push({ threadId: branch.threadId, reason })
  });
  const current = store.register({
    envelope: { ...testEnvelope(), processGeneration: 2, accountGeneration: 2 },
    projectedHistory: [],
    threadId: 'thread-current-generation'
  });
  store.register({
    envelope: { ...testEnvelope(), processGeneration: 1, accountGeneration: 2 },
    projectedHistory: [],
    threadId: 'thread-old-process'
  });
  store.register({
    envelope: { ...testEnvelope(), processGeneration: 2, accountGeneration: 1 },
    projectedHistory: [],
    threadId: 'thread-old-account'
  });

  store.invalidateProcessGeneration(2);
  equal(store.get(current.id)?.threadId, current.threadId, 'process invalidation preserves the current generation');
  equal(
    evictions.some((entry) => entry.threadId === 'thread-old-process' && entry.reason === 'processChanged'),
    true,
    'process invalidation removes only stale process generations'
  );

  store.invalidateAccountGeneration(2);
  equal(store.get(current.id)?.threadId, current.threadId, 'account invalidation preserves the current generation');
  equal(
    evictions.some((entry) => entry.threadId === 'thread-old-account' && entry.reason === 'accountChanged'),
    true,
    'account invalidation removes only stale account generations'
  );
}

function testEventRouting({ AppServerEventRouter }) {
  const router = new AppServerEventRouter();
  router.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'item-a', delta: 'early' }
  });
  const seen = [];
  const subscription = router.beginTurn('thread-a', (event) => seen.push(event.method));
  equal(subscription.turnId, 'turn-a', 'early event binds provisional turn');
  deepEqual(seen, ['item/agentMessage/delta'], 'early event drains once');

  router.route({
    method: 'turn/completed',
    params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'completed' } }
  });
  deepEqual(seen, ['item/agentMessage/delta', 'turn/completed'], 'bound turn receives later event');
  subscription.dispose();

  const nextSeen = [];
  const next = router.beginTurn('thread-a', (event) => nextSeen.push(event.turnId));
  equal(router.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-a', turnId: 'turn-a', itemId: 'late', delta: 'late' }
  }), false, 'late closed-turn event is ignored');
  equal(next.turnId, undefined, 'late closed-turn event cannot bind the next turn');
  deepEqual(nextSeen, [], 'late closed-turn event is not delivered to the next turn');

  router.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-a', turnId: 'turn-b', itemId: 'item-b', delta: 'next' }
  });
  equal(next.turnId, 'turn-b', 'a new turn can bind after the prior turn closes');
  deepEqual(nextSeen, ['turn-b'], 'only the new turn event is delivered');
  throws(() => next.bindTurn('turn-a'), 'closed turn cannot be rebound explicitly');
  next.dispose();
}

async function testToolHandoff({
  createDynamicToolCatalog,
  createDynamicToolAlias,
  SuspendedDynamicToolBridge,
  DynamicToolBridgeError
}) {
  const schema = { type: 'object', properties: { path: { type: 'string' } } };
  const alias = createDynamicToolAlias('read workspace file with a deliberately very long name', 'Read', schema);
  equal(alias.length <= 64, true, 'tool alias length');
  equal(alias, createDynamicToolAlias('read workspace file with a deliberately very long name', 'Read', schema), 'alias determinism');

  const interrupts = [];
  const bridge = new SuspendedDynamicToolBridge({
    handoffTimeoutMs: 1_000,
    interruptTurn: (threadId, turnId, reason) => interrupts.push({ threadId, turnId, reason })
  });
  const catalog = createDynamicToolCatalog([
    { name: 'read_file', description: 'Read a file', inputSchema: schema },
    { name: 'list_dir', description: 'List a directory', inputSchema: schema }
  ]);
  equal(
    catalog.tools.every((tool) => tool.description.includes('VS Code executes this tool')),
    true,
    'every dynamic tool tells the model that VS Code owns execution and permissions'
  );
  bridge.registerThread('thread-tools', catalog);
  const responses = [];

  for (const [index, tool] of catalog.tools.entries()) {
    await bridge.receive({
      id: index + 1,
      params: {
        threadId: 'thread-tools',
        turnId: 'turn-tools',
        callId: `call-${index + 1}`,
        namespace: null,
        tool: tool.alias,
        arguments: { path: `file-${index + 1}` }
      },
      respond: (response) => responses.push({ callId: `call-${index + 1}`, response })
    });
  }

  const first = bridge.takeNextBoundary('thread-tools', 'turn-tools');
  equal(first.callId, 'call-1', 'FIFO exposes first request');
  equal(bridge.takeNextBoundary('thread-tools', 'turn-tools'), undefined, 'one boundary per invocation');
  await bridge.submitResult({
    threadId: 'thread-tools',
    turnId: 'turn-tools',
    callId: 'call-1',
    content: [{ value: 'first result' }]
  });
  equal(responses[0].response.success, true, 'first tool succeeds');
  equal(bridge.takeNextBoundary('thread-tools', 'turn-tools').callId, 'call-2', 'next invocation exposes queued call');

  let duplicateError;
  try {
    await bridge.submitResult({
      threadId: 'thread-tools',
      turnId: 'turn-tools',
      callId: 'call-1',
      content: []
    });
  } catch (error) {
    duplicateError = error;
  }
  ok(duplicateError instanceof DynamicToolBridgeError, 'duplicate result is rejected');
  equal(interrupts.length > 0, true, 'invalid handoff interrupts turn');
}

async function testToolCallIdentityScoping({
  createDynamicToolCatalog,
  SuspendedDynamicToolBridge
}) {
  const bridge = new SuspendedDynamicToolBridge({ handoffTimeoutMs: 1_000 });
  const catalog = createDynamicToolCatalog([{ name: 'read_file', inputSchema: { type: 'object' } }]);
  const alias = catalog.tools[0].alias;
  const responses = [];
  const request = (id, threadId, turnId, callId) => ({
    id,
    params: {
      threadId,
      turnId,
      callId,
      namespace: null,
      tool: alias,
      arguments: { id }
    },
    respond: (response) => responses.push({ threadId, turnId, callId, response })
  });

  bridge.registerThread('thread-scope-a', catalog);
  bridge.registerThread('thread-scope-b', catalog);
  equal(
    await bridge.receive(request(1, 'thread-scope-a', 'turn-scope-1', 'shared-call')),
    'queued',
    'first scoped call queues'
  );
  equal(
    await bridge.receive(request(2, 'thread-scope-b', 'turn-scope-1', 'shared-call')),
    'queued',
    'same call ID can queue in another thread'
  );
  equal(
    await bridge.receive(request(3, 'thread-scope-a', 'turn-scope-2', 'shared-call')),
    'queued',
    'same call ID can queue in another turn'
  );

  for (const [threadId, turnId] of [
    ['thread-scope-a', 'turn-scope-1'],
    ['thread-scope-b', 'turn-scope-1'],
    ['thread-scope-a', 'turn-scope-2']
  ]) {
    equal(bridge.takeNextBoundary(threadId, turnId).callId, 'shared-call', 'scoped boundary is available');
    await bridge.submitResult({ threadId, turnId, callId: 'shared-call', content: [] });
  }

  equal(
    await bridge.receive(request(4, 'thread-scope-a', 'turn-scope-1', 'shared-call')),
    'rejected',
    'settled call remains a duplicate in its exact scope'
  );
  equal(responses.at(-1).response.success, false, 'duplicate call receives a failed response');

  bridge.clearSettledTurn('thread-scope-a', 'turn-scope-1');
  equal(
    await bridge.receive(request(5, 'thread-scope-a', 'turn-scope-1', 'shared-call')),
    'queued',
    'terminal cleanup permits scoped identity reuse'
  );
  bridge.takeNextBoundary('thread-scope-a', 'turn-scope-1');
  await bridge.submitResult({
    threadId: 'thread-scope-a',
    turnId: 'turn-scope-1',
    callId: 'shared-call',
    content: []
  });

  await bridge.clearThread('thread-scope-a');
  bridge.registerThread('thread-scope-a', catalog);
  equal(
    await bridge.receive(request(6, 'thread-scope-a', 'turn-scope-1', 'shared-call')),
    'queued',
    'thread cleanup clears settled identities'
  );
  await bridge.dispose();
}

async function testCoordinatorToolRoundTrip(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { createDynamicToolCatalog, SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator } = modules.turnCoordinator;
  const interrupts = [];
  const router = new AppServerEventRouter();
  const bridge = new SuspendedDynamicToolBridge({
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const catalog = createDynamicToolCatalog([{ name: 'read_file', inputSchema: { type: 'object' } }]);
  bridge.registerThread('thread-roundtrip', catalog);
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: router,
    toolBridge: bridge,
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const firstOutput = createSink();
  const handle = coordinator.beginTurn(
    'thread-roundtrip',
    firstOutput.sink,
    { requiredToolMode: true }
  );
  handle.bindTurn('turn-roundtrip');
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-roundtrip',
      turnId: 'turn-roundtrip',
      item: { type: 'agentMessage', id: 'message-1', text: '', phase: 'final_answer' }
    }
  });
  coordinator.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-roundtrip', turnId: 'turn-roundtrip', itemId: 'message-1', delta: 'Before tool. ' }
  });
  const toolResponses = [];
  await coordinator.handleServerRequest({
    id: 7,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-roundtrip',
      turnId: 'turn-roundtrip',
      callId: 'call-roundtrip',
      namespace: null,
      tool: catalog.tools[0].alias,
      arguments: { path: 'README.md' }
    },
    respond: (response) => toolResponses.push(response)
  });
  const firstResult = await handle.result;
  equal(firstResult.kind, 'toolBoundary', 'provider invocation stops at tool boundary');
  deepEqual(firstOutput.text, ['Before tool. '], 'Required mode releases buffered text at the first tool boundary');
  deepEqual(firstOutput.tools, [{ callId: 'call-roundtrip', name: 'read_file', input: { path: 'README.md' } }], 'tool name maps back');

  const resumedOutput = createSink();
  const resumed = coordinator.resumeWithToolResult({
    threadId: 'thread-roundtrip',
    turnId: 'turn-roundtrip',
    callId: 'call-roundtrip',
    content: [{ value: 'README content' }]
  }, resumedOutput.sink);
  await Promise.resolve();
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-roundtrip',
      turnId: 'turn-roundtrip',
      item: { type: 'agentMessage', id: 'message-2', text: '', phase: 'final_answer' }
    }
  });
  coordinator.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-roundtrip', turnId: 'turn-roundtrip', itemId: 'message-2', delta: 'After tool.' }
  });
  coordinator.route({
    method: 'turn/completed',
    params: { threadId: 'thread-roundtrip', turn: { id: 'turn-roundtrip', status: 'completed', error: null } }
  });
  equal((await resumed).kind, 'completed', 'same turn resumes to completion');
  equal(toolResponses.length, 1, 'tool request answered exactly once');
  deepEqual(resumedOutput.text, ['After tool.'], 'resumed output streams to new sink');
}

async function testMismatchedDynamicToolTurnFailsClosed(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { createDynamicToolCatalog, SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator, AppServerTurnError } = modules.turnCoordinator;
  const interrupts = [];
  const rejected = [];
  const catalog = createDynamicToolCatalog([{ name: 'read_file', inputSchema: { type: 'object' } }]);
  const bridge = new SuspendedDynamicToolBridge();
  bridge.registerThread('thread-mismatched-tool', catalog);
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: bridge,
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const handle = coordinator.beginTurn('thread-mismatched-tool', createSink().sink);
  handle.bindTurn('turn-known');

  await coordinator.handleServerRequest({
    id: 81,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-mismatched-tool',
      turnId: 'turn-claimed',
      callId: 'call-mismatched',
      namespace: null,
      tool: catalog.tools[0].alias,
      arguments: {}
    },
    respond: () => {
      throw new Error('mismatched tool request should be rejected');
    },
    reject: (code, message) => rejected.push({ code, message })
  });

  await rejects(handle.result, AppServerTurnError, 'mismatched tool turn settles the provider invocation');
  equal(rejected.length, 1, 'mismatched tool RPC is rejected exactly once');
  deepEqual(
    interrupts,
    ['thread-mismatched-tool/turn-known', 'thread-mismatched-tool/turn-claimed'],
    'both the known and falsely claimed turns are interrupted'
  );
}

async function testRequiredModeAndPassivePolicy(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const {
    AppServerTurnCoordinator,
    RequiredToolModeError,
    PassivePolicyViolationError
  } = modules.turnCoordinator;
  const interrupts = [];
  const router = new AppServerEventRouter();
  const bridge = new SuspendedDynamicToolBridge({
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: router,
    toolBridge: bridge,
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });

  const requiredOutput = createSink();
  const required = coordinator.beginTurn('thread-required', requiredOutput.sink, { requiredToolMode: true });
  required.bindTurn('turn-required');
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-required',
      turnId: 'turn-required',
      item: { type: 'agentMessage', id: 'required-message', text: '', phase: 'final_answer' }
    }
  });
  coordinator.route({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread-required', turnId: 'turn-required', itemId: 'required-message', delta: 'must stay hidden' }
  });
  coordinator.route({
    method: 'turn/completed',
    params: { threadId: 'thread-required', turn: { id: 'turn-required', status: 'completed', error: null } }
  });
  await rejects(required.result, RequiredToolModeError, 'Required mode fails without a tool');
  deepEqual(requiredOutput.text, [], 'Required mode discards buffered final text');

  const blockedOutput = createSink();
  const blocked = coordinator.beginTurn('thread-blocked', blockedOutput.sink);
  blocked.bindTurn('turn-blocked');
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-blocked',
      turnId: 'turn-blocked',
      item: { type: 'commandExecution', id: 'forbidden', command: 'whoami' }
    }
  });
  await rejects(blocked.result, PassivePolicyViolationError, 'built-in command is blocked');
  ok(interrupts.includes('thread-blocked/turn-blocked'), 'passive violation interrupts turn');

  const earlyBlocked = coordinator.beginTurn('thread-early-blocked', createSink().sink);
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-early-blocked',
      turnId: 'turn-early-blocked',
      item: { type: 'commandExecution', id: 'forbidden-before-start-response' }
    }
  });
  await rejects(
    earlyBlocked.result,
    PassivePolicyViolationError,
    'built-in command before turn/start response is blocked'
  );
  earlyBlocked.bindTurn('turn-early-blocked');

  const collabOutput = createSink();
  const collab = coordinator.beginTurn('thread-collab-blocked', collabOutput.sink);
  collab.bindTurn('turn-collab-blocked');
  coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-collab-blocked',
      turnId: 'turn-collab-blocked',
      item: { type: 'collabToolCall', id: 'forbidden-collab', tool: 'spawn_agent' }
    }
  });
  await rejects(collab.result, PassivePolicyViolationError, 'legacy built-in collaboration is blocked');
  ok(
    interrupts.includes('thread-collab-blocked/turn-collab-blocked'),
    'built-in collaboration violation interrupts turn'
  );

  const directOutput = createSink();
  const direct = coordinator.beginTurn('thread-direct-blocked', directOutput.sink);
  direct.bindTurn('turn-direct-blocked');
  coordinator.route({
    method: 'process/exited',
    params: { threadId: 'thread-direct-blocked' }
  });
  await rejects(direct.result, PassivePolicyViolationError, 'direct forbidden notification is blocked');
  ok(
    interrupts.includes('thread-direct-blocked/turn-direct-blocked'),
    'direct forbidden notification interrupts its active turn'
  );

  const unscopedOutput = createSink();
  const unscoped = coordinator.beginTurn('thread-unscoped-blocked', unscopedOutput.sink);
  unscoped.bindTurn('turn-unscoped-blocked');
  coordinator.route({ method: 'process/exited', params: {} });
  await rejects(unscoped.result, PassivePolicyViolationError, 'unscoped forbidden notification is blocked');
  ok(
    interrupts.includes('thread-unscoped-blocked/turn-unscoped-blocked'),
    'unscoped forbidden notification interrupts the sole active turn'
  );
}

async function testMismatchedPassiveLifecycleFailsClosed(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const {
    AppServerTurnCoordinator,
    PassivePolicyViolationError
  } = modules.turnCoordinator;
  const interrupts = [];
  const router = new AppServerEventRouter();
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: router,
    toolBridge: new SuspendedDynamicToolBridge(),
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const affected = coordinator.beginTurn('thread-passive-a', createSink().sink);
  affected.bindTurn('turn-passive-a');
  const unrelated = coordinator.beginTurn('thread-passive-b', createSink().sink);
  unrelated.bindTurn('turn-passive-b');

  equal(coordinator.route({
    method: 'item/started',
    params: {
      threadId: 'thread-passive-a',
      turnId: 'turn-false-claim',
      item: { type: 'commandExecution', id: 'dangerous-mismatch' }
    }
  }), true, 'mismatched dangerous lifecycle is claimed before routing');
  await rejects(
    affected.result,
    PassivePolicyViolationError,
    'mismatched dangerous lifecycle settles the matching thread'
  );
  equal(router.bufferedEventCount, 0, 'dangerous mismatched lifecycle is never buffered');
  deepEqual(
    interrupts.slice(0, 2),
    ['thread-passive-a/turn-passive-a', 'thread-passive-a/turn-false-claim'],
    'known and claimed turns on the affected thread are interrupted'
  );

  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-passive-b',
      turn: { id: 'turn-passive-b', status: 'completed', error: null }
    }
  });
  equal((await unrelated.result).kind, 'completed', 'mismatched scope does not fail an unrelated chat');

  const unscoped = coordinator.beginTurn('thread-passive-unscoped', createSink().sink);
  unscoped.bindTurn('turn-passive-unscoped');
  equal(coordinator.route({
    method: 'item/completed',
    params: { item: { type: 'fileChange', id: 'dangerous-unscoped' } }
  }), true, 'unscoped dangerous lifecycle is claimed while a turn is active');
  await rejects(
    unscoped.result,
    PassivePolicyViolationError,
    'unscoped dangerous lifecycle fails closed'
  );
  equal(router.bufferedEventCount, 0, 'dangerous unscoped lifecycle is never buffered');
}

async function testMalformedTerminalEvents(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator, AppServerTurnError } = modules.turnCoordinator;
  const interrupts = [];
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: new SuspendedDynamicToolBridge(),
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });

  const malformed = coordinator.beginTurn('thread-malformed', createSink().sink);
  malformed.bindTurn('turn-malformed');
  coordinator.route({
    method: 'turn/completed',
    params: { threadId: 'thread-malformed', turn: { status: 'completed' } }
  });
  await rejects(malformed.result, AppServerTurnError, 'malformed terminal notification fails the turn');
  ok(
    interrupts.includes('thread-malformed/turn-malformed'),
    'malformed terminal notification interrupts the affected turn'
  );

  const nonterminal = coordinator.beginTurn('thread-nonterminal', createSink().sink);
  nonterminal.bindTurn('turn-nonterminal');
  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-nonterminal',
      turn: { id: 'turn-nonterminal', status: 'inProgress' }
    }
  });
  await rejects(nonterminal.result, AppServerTurnError, 'nonterminal turn/completed fails the turn');
  ok(
    interrupts.includes('thread-nonterminal/turn-nonterminal'),
    'nonterminal turn/completed interrupts the affected turn'
  );
}

async function testMalformedTokenUsageIsIgnored(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator } = modules.turnCoordinator;
  const contextWindows = [];
  const output = createSink();
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: new SuspendedDynamicToolBridge(),
    onContextWindow: (_threadId, value) => contextWindows.push(value)
  });
  const handle = coordinator.beginTurn('thread-malformed-usage', output.sink);
  handle.bindTurn('turn-malformed-usage');
  const validBreakdown = {
    totalTokens: 5,
    inputTokens: 3,
    cachedInputTokens: 1,
    outputTokens: 2,
    reasoningOutputTokens: 1
  };

  coordinator.route({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-malformed-usage',
      turnId: 'turn-malformed-usage',
      tokenUsage: {
        total: { ...validBreakdown, totalTokens: -1 },
        last: validBreakdown,
        modelContextWindow: 100
      }
    }
  });
  coordinator.route({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-malformed-usage',
      turnId: 'turn-malformed-usage',
      tokenUsage: {
        total: validBreakdown,
        last: { ...validBreakdown, outputTokens: Number.NaN },
        modelContextWindow: 100
      }
    }
  });
  coordinator.route({
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: 'thread-malformed-usage',
      turnId: 'turn-malformed-usage',
      tokenUsage: {
        total: validBreakdown,
        last: validBreakdown,
        modelContextWindow: 0
      }
    }
  });
  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-malformed-usage',
      turn: { id: 'turn-malformed-usage', status: 'completed', error: null }
    }
  });

  const result = await handle.result;
  equal(result.usage, undefined, 'malformed usage is not retained on completion');
  deepEqual(output.usage, [], 'malformed usage is not emitted to the provider');
  deepEqual(contextWindows, [], 'malformed usage cannot update model context metadata');
}

async function testPreIdHostCancellation(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator, HostTurnCancellationError } = modules.turnCoordinator;
  const interrupts = [];
  const responses = [];
  const output = createSink();
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: new SuspendedDynamicToolBridge(),
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });

  const handle = coordinator.beginTurn('thread-cancel-before-id', output.sink);
  await handle.cancel();
  equal(interrupts.length, 0, 'pre-ID cancellation waits until the turn is bound');

  handle.bindTurn('turn-cancel-before-id');
  await coordinator.handleServerRequest({
    id: 91,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-cancel-before-id',
      turnId: 'turn-cancel-before-id',
      callId: 'call-must-not-escape',
      namespace: null,
      tool: 'vscode_forbidden_after_cancel',
      arguments: {}
    },
    respond: (response) => responses.push(response)
  });

  deepEqual(output.tools, [], 'a tool cannot be exposed after pre-ID host cancellation');
  equal(responses.length, 1, 'cancelled dynamic request is answered exactly once');
  equal(responses[0].success, false, 'cancelled dynamic request receives a failed response');
  deepEqual(
    interrupts,
    ['thread-cancel-before-id/turn-cancel-before-id'],
    'binding a pre-cancelled turn sends one interrupt'
  );

  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-cancel-before-id',
      turn: { id: 'turn-cancel-before-id', status: 'interrupted' }
    }
  });
  await rejects(handle.result, HostTurnCancellationError, 'cancelled terminal event surfaces host cancellation');
}

async function testInterruptFailurePreservesHostCancellation(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator, HostTurnCancellationError } = modules.turnCoordinator;
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: new SuspendedDynamicToolBridge(),
    interruptTurn: async () => {
      throw new Error('interrupt rejected');
    }
  });
  const handle = coordinator.beginTurn('thread-cancel-failure', createSink().sink);
  handle.bindTurn('turn-cancel-failure');

  await handle.cancel();
  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-cancel-failure',
      turn: { id: 'turn-cancel-failure', status: 'interrupted', error: null }
    }
  });
  await rejects(
    handle.result,
    HostTurnCancellationError,
    'an interrupt RPC rejection does not override an interrupted host cancellation'
  );

  const completedAfterCancel = coordinator.beginTurn(
    'thread-cancel-completed',
    createSink().sink
  );
  completedAfterCancel.bindTurn('turn-cancel-completed');
  await completedAfterCancel.cancel();
  coordinator.route({
    method: 'turn/completed',
    params: {
      threadId: 'thread-cancel-completed',
      turn: { id: 'turn-cancel-completed', status: 'completed', error: null }
    }
  });
  await rejects(
    completedAfterCancel.result,
    HostTurnCancellationError,
    'a completed terminal event still resolves as host cancellation after interrupt rejection'
  );
}

async function testLocalInvalidationDoesNotInterrupt(modules) {
  const { AppServerEventRouter } = modules.eventRouter;
  const { createDynamicToolCatalog, SuspendedDynamicToolBridge } = modules.toolBridge;
  const { AppServerTurnCoordinator, AppServerTurnError } = modules.turnCoordinator;
  const interrupts = [];
  const bridge = new SuspendedDynamicToolBridge();
  const catalog = createDynamicToolCatalog([{ name: 'read_file', inputSchema: { type: 'object' } }]);
  bridge.registerThread('thread-local-discard', catalog);
  const coordinator = new AppServerTurnCoordinator({
    eventRouter: new AppServerEventRouter(),
    toolBridge: bridge,
    interruptTurn: (threadId, turnId) => interrupts.push(`${threadId}/${turnId}`)
  });
  const active = coordinator.beginTurn('thread-local-active', createSink().sink);
  active.bindTurn('turn-local-active');
  const pending = coordinator.beginTurn('thread-local-discard', createSink().sink);
  pending.bindTurn('turn-local-discard');
  await coordinator.handleServerRequest({
    id: 92,
    method: 'item/tool/call',
    params: {
      threadId: 'thread-local-discard',
      turnId: 'turn-local-discard',
      callId: 'call-local-discard',
      namespace: null,
      tool: catalog.tools[0].alias,
      arguments: {}
    },
    respond() {
      throw new Error('a dead transport must not be answered');
    }
  });
  equal((await pending.result).kind, 'toolBoundary', 'pending tool boundary is exposed before invalidation');

  await coordinator.invalidateAll('process exited', { interruptRemote: false });
  await rejects(active.result, AppServerTurnError, 'local invalidation settles active invocation');
  equal(bridge.hasPending('thread-local-discard', 'turn-local-discard'), false, 'local invalidation discards pending tool state');
  deepEqual(interrupts, [], 'local invalidation does not contact a replacement process');
}

function testEnvelope() {
  return {
    processGeneration: 1,
    accountGeneration: 1,
    appServerVersion: '0.144.4',
    passivePolicyVersion: '1',
    model: 'gpt-test',
    reasoningEffort: 'high',
    serviceTier: 'default',
    baseInstructions: 'passive',
    developerInstructions: 'test',
    toolMode: 'auto',
    tools: []
  };
}

function createSink() {
  const text = [];
  const thinking = [];
  const tools = [];
  const usage = [];
  return {
    text,
    thinking,
    tools,
    usage,
    sink: {
      onText: (value) => text.push(value),
      onThinking: (value) => thinking.push(value),
      onToolCall: (value) => tools.push({ callId: value.callId, name: value.name, input: value.input }),
      onUsage: (value) => usage.push(value)
    }
  };
}

async function rejects(promise, ErrorType, label) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  ok(error instanceof ErrorType, label);
}

function ok(value, label) {
  if (!value) {
    throw new Error(`Assertion failed (${label})`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`Assertion failed (${label}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deepEqual(actual, expected, label) {
  equal(JSON.stringify(actual), JSON.stringify(expected), label);
}

function throws(callback, label) {
  let error;
  try {
    callback();
  } catch (caught) {
    error = caught;
  }
  ok(error instanceof Error, label);
}
