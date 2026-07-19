import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-fake-app-server-'));
const bundlePath = path.join(temporaryDirectory, 'codex-backend.cjs');
const launcherPath = await createLauncher(temporaryDirectory);
const originalLoad = Module._load;
const originalFakeAuthMode = process.env.CODEX_FAKE_AUTH_MODE;
const originalFakeLoginBehavior = process.env.CODEX_FAKE_LOGIN_BEHAVIOR;
process.env.CODEX_FAKE_AUTH_MODE = 'chatgpt';
process.env.CODEX_FAKE_LOGIN_BEHAVIOR = 'wait';
const configurationListeners = new Set();
let backend;

class MockEventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose() {
    this.listeners.clear();
  }
}

class MockCancellationError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancellationError';
  }
}

class MockLanguageModelError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
  static NoPermissions(message) {
    return new MockLanguageModelError(message ?? 'No permissions.', 'NoPermissions');
  }
  static Blocked(message) {
    return new MockLanguageModelError(message ?? 'Blocked.', 'Blocked');
  }
  static NotFound(message) {
    return new MockLanguageModelError(message ?? 'Not found.', 'NotFound');
  }
}

const vscodeStub = {
  EventEmitter: MockEventEmitter,
  CancellationError: MockCancellationError,
  LanguageModelError: MockLanguageModelError,
  workspace: {
    getConfiguration() {
      return {
        inspect(key) {
          return key === 'appServer.command'
            ? { globalValue: launcherPath, defaultValue: 'codex' }
            : undefined;
        },
        get(_key, fallback) {
          return fallback;
        }
      };
    },
    onDidChangeConfiguration(listener) {
      configurationListeners.add(listener);
      return { dispose: () => configurationListeners.delete(listener) };
    }
  }
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  await build({
    entryPoints: ['src/appServer/codexBackend.ts'],
    absWorkingDir: repositoryRoot,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode']
  });

  const { CodexAppServerBackend } = require(bundlePath);
  const logs = [];
  backend = new CodexAppServerBackend({
    extension: { packageJSON: { version: '0.2.1' } },
    globalStorageUri: { fsPath: path.join(temporaryDirectory, 'global-storage') }
  }, {
    debug(message, metadata) {
      logs.push({ level: 'debug', message, metadata });
    },
    warn(message, metadata) {
      logs.push({ level: 'warn', message, metadata });
    }
  });

  await testOverlappingAccountGenerationHandlers(backend);

  const neverCancelled = createCancellationToken();
  const models = await backend.listModels(neverCancelled.token);
  assert.equal(models.length, 2, 'Model pagination should include both catalog entries before UI filtering.');
  assert.equal(models[0].model, 'gpt-5.5');
  assert.equal(models[0].inputModalities.includes('image'), true);

  const limits = await backend.readRateLimits();
  assert.equal(limits.planType, 'pro');
  assert.equal(limits.limits.length, 2);
  const activity = await backend.readTokenActivity();
  assert.equal(activity.lifetimeTokens, 1234);

  const plainSink = createSink();
  const plainRequest = requestForText('hello app-server');
  const plainResult = await backend.runChat(plainRequest, plainSink, neverCancelled.token);
  assert.equal(plainResult.kind, 'completed');
  assert.equal(plainSink.textValue, 'Echo: hello app-server');
  assert.equal(plainSink.usageValues.length, 1);

  await assert.rejects(
    backend.runChat({
      ...requestForText('raw ultra must fail'),
      requestedMode: 'ultra',
      backendEffort: 'ultra'
    }, createSink(), neverCancelled.token),
    /Raw Ultra reasoning/,
    'No backend request may send raw Ultra to app-server.'
  );

  const nestedFallback = {
    ...requestForText('expect nested ultra fallback'),
    requestedMode: 'ultra',
    backendEffort: 'max',
    orchestrationMode: 'standard'
  };
  const nestedFallbackSink = createSink();
  await backend.runChat(nestedFallback, nestedFallbackSink, neverCancelled.token);
  assert.equal(
    nestedFallbackSink.textValue,
    'Echo: expect nested ultra fallback',
    'Ultra without the native subagent tool remains single-agent Max.'
  );

  const proactiveToolDefinitions = [{
    name: 'workspace/read_file',
    description: 'Read a workspace file.',
    inputSchema: { type: 'object' }
  }, {
    name: 'runSubagent',
    description: 'Run a governed VS Code subagent.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt']
    }
  }];
  const proactiveRequest = {
    ...requestForText('expect proactive ultra', proactiveToolDefinitions),
    requestedMode: 'ultra',
    backendEffort: 'max',
    orchestrationMode: 'vscodeProactive',
    vsCodeSubagentToolName: 'runSubagent'
  };
  const proactiveSink = createSink();
  const proactiveBoundary = await backend.runChat(
    proactiveRequest,
    proactiveSink,
    neverCancelled.token
  );
  assert.equal(proactiveBoundary.kind, 'toolBoundary');
  assert.equal(
    proactiveSink.toolCalls[0].name,
    'runSubagent',
    'The exact aliased native subagent tool is handed back to VS Code.'
  );
  const proactiveCall = proactiveSink.toolCalls[0];
  const proactiveHistory = appendToolResult(
    proactiveRequest.fullHistory,
    proactiveCall,
    'Bounded worker result'
  );
  const proactiveResumeSink = createSink();
  const proactiveResume = await backend.runChat({
    ...proactiveRequest,
    fullHistory: proactiveHistory,
    historyBeforeCurrent: proactiveHistory.slice(0, -1),
    projectedHistory: [proactiveHistory[0], proactiveHistory.at(-1)],
    currentInput: [],
    toolResults: [{
      callId: proactiveCall.callId,
      content: [{ value: 'Bounded worker result' }]
    }]
  }, proactiveResumeSink, neverCancelled.token);
  assert.equal(proactiveResume.kind, 'completed');
  assert.equal(proactiveResumeSink.textValue, 'Tool result accepted.');

  const maxEnvelopeSeed = {
    ...requestForText('mode envelope seed'),
    requestedMode: 'max',
    backendEffort: 'max',
    orchestrationMode: 'standard'
  };
  await backend.runChat(maxEnvelopeSeed, createSink(), neverCancelled.token);
  const startsBeforeModeSwitch = countRpcMethod(logs, 'thread/start');
  const modeSwitchMessage = userMessage('mode envelope followup');
  const ultraEnvelopeContinuation = {
    ...requestForHistory([
      maxEnvelopeSeed.fullHistory[0],
      assistantMessage('Echo: mode envelope seed'),
      modeSwitchMessage
    ], 'mode envelope followup'),
    requestedMode: 'ultra',
    backendEffort: 'max',
    orchestrationMode: 'standard'
  };
  await backend.runChat(ultraEnvelopeContinuation, createSink(), neverCancelled.token);
  assert.equal(
    countRpcMethod(logs, 'thread/start'),
    startsBeforeModeSwitch + 1,
    'Max and Ultra cannot reuse a conversation even when both send backend Max.'
  );

  const initializesBeforeIgnoredWorkspaceCommand = countRpcMethod(logs, 'initialize');
  fireConfigurationChange('codexvs.appServer.command');
  await delay(50);
  const ignoredWorkspaceCommandSink = createSink();
  await backend.runChat(
    requestForText('workspace command setting is ignored'),
    ignoredWorkspaceCommandSink,
    neverCancelled.token
  );
  assert.equal(ignoredWorkspaceCommandSink.textValue, 'Echo: workspace command setting is ignored');
  assert.equal(
    countRpcMethod(logs, 'initialize'),
    initializesBeforeIgnoredWorkspaceCommand,
    'An ignored workspace executable setting must not restart app-server.'
  );

  const continuationSeed = requestForText('continuation seed');
  await backend.runChat(continuationSeed, createSink(), neverCancelled.token);
  const startsBeforeContinuation = countRpcMethod(logs, 'thread/start');
  const injectsBeforeContinuation = countRpcMethod(logs, 'thread/inject_items');
  const seedMessage = continuationSeed.fullHistory[0];
  const followupMessage = userMessage('continuation followup');
  const continuationRequest = requestForHistory(
    [seedMessage, assistantMessage('Echo: continuation seed'), followupMessage],
    'continuation followup'
  );
  const continuationSink = createSink();
  await backend.runChat(continuationRequest, continuationSink, neverCancelled.token);
  assert.equal(continuationSink.textValue, 'Echo: continuation followup');
  assert.equal(countRpcMethod(logs, 'thread/start'), startsBeforeContinuation);
  assert.equal(countRpcMethod(logs, 'thread/inject_items'), injectsBeforeContinuation);

  const unseenIntermediateMessage = userMessage('intermediate history unseen by app-server');
  const newestContinuationMessage = userMessage('newest continuation input');
  const multiAppendRequest = requestForHistory([
    seedMessage,
    assistantMessage('Echo: continuation seed'),
    followupMessage,
    assistantMessage('Echo: continuation followup'),
    unseenIntermediateMessage,
    assistantMessage('Intermediate answer supplied by the caller.'),
    newestContinuationMessage
  ], 'newest continuation input');
  const startsBeforeMultiAppend = countRpcMethod(logs, 'thread/start');
  const injectsBeforeMultiAppend = countRpcMethod(logs, 'thread/inject_items');
  const multiAppendSink = createSink();
  await backend.runChat(multiAppendRequest, multiAppendSink, neverCancelled.token);
  assert.equal(multiAppendSink.textValue, 'Echo: newest continuation input');
  assert.equal(
    countRpcMethod(logs, 'thread/start'),
    startsBeforeMultiAppend + 1,
    'Multiple appended projected items must cold-reconstruct instead of skipping intermediate history.'
  );
  assert.equal(
    countRpcMethod(logs, 'thread/inject_items'),
    injectsBeforeMultiAppend + 1,
    'Cold reconstruction injects the complete preceding history for a multi-item append.'
  );

  const forksBefore = countRpcMethod(logs, 'thread/fork');
  const injectsBeforeFork = countRpcMethod(logs, 'thread/inject_items');
  const editedMessage = userMessage('edited continuation');
  const forkRequest = requestForHistory([seedMessage, editedMessage], 'edited continuation');
  const forkSink = createSink();
  await backend.runChat(forkRequest, forkSink, neverCancelled.token);
  assert.equal(forkSink.textValue, 'Echo: edited continuation');
  assert.equal(countRpcMethod(logs, 'thread/fork'), forksBefore + 1);
  assert.equal(
    countRpcMethod(logs, 'thread/inject_items'),
    injectsBeforeFork,
    'Forking at a completed checkpoint must not inject the checkpoint assistant output again.'
  );

  const startsBeforeCold = countRpcMethod(logs, 'thread/start');
  const injectsBeforeCold = countRpcMethod(logs, 'thread/inject_items');
  const coldMessage = userMessage('cold envelope');
  const coldRequest = {
    ...requestForHistory([seedMessage, coldMessage], 'cold envelope'),
    developerInstructions: 'A changed instruction envelope.'
  };
  const coldSink = createSink();
  await backend.runChat(coldRequest, coldSink, neverCancelled.token);
  assert.equal(coldSink.textValue, 'Echo: cold envelope');
  assert.equal(countRpcMethod(logs, 'thread/start'), startsBeforeCold + 1);
  assert.equal(countRpcMethod(logs, 'thread/inject_items'), injectsBeforeCold + 1);

  const toolSink = createSink();
  const toolRequest = requestForText('please use tool', [{
    name: 'workspace/read_file',
    description: 'Read a workspace file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  }]);
  const boundary = await backend.runChat(toolRequest, toolSink, neverCancelled.token);
  assert.equal(boundary.kind, 'toolBoundary');
  assert.equal(toolSink.toolCalls.length, 1);
  assert.equal(toolSink.toolCalls[0].name, 'workspace/read_file');

  const callId = toolSink.toolCalls[0].callId;
  const toolHistory = [
    ...toolRequest.fullHistory,
    {
      type: 'function_call',
      call_id: callId,
      name: 'workspace/read_file',
      arguments: '{"path":"README.md"}'
    },
    {
      type: 'function_call_output',
      call_id: callId,
      output: 'README contents'
    }
  ];
  const resumedSink = createSink();
  const resumed = await backend.runChat({
    ...toolRequest,
    fullHistory: toolHistory,
    historyBeforeCurrent: toolHistory.slice(0, -1),
    projectedHistory: [toolHistory[0], toolHistory.at(-1)],
    currentInput: [],
    toolResults: [{
      callId,
      content: [{ value: 'README contents' }]
    }]
  }, resumedSink, neverCancelled.token);
  assert.equal(resumed.kind, 'completed');
  assert.equal(resumedSink.textValue, 'Tool result accepted.');
  assert.equal(resumedSink.toolCalls.length, 0, 'The same tool call must not be emitted twice.');

  const startsBeforeDuplicateResult = countRpcMethod(logs, 'thread/start');
  const injectsBeforeDuplicateResult = countRpcMethod(logs, 'thread/inject_items');
  const duplicateResultSink = createSink();
  const duplicateResult = await backend.runChat({
    ...toolRequest,
    fullHistory: toolHistory,
    historyBeforeCurrent: toolHistory.slice(0, -1),
    projectedHistory: [toolHistory[0], toolHistory.at(-1)],
    currentInput: [],
    toolResults: [{ callId, content: [{ value: 'README contents' }] }]
  }, duplicateResultSink, neverCancelled.token);
  assert.equal(duplicateResult.kind, 'completed');
  assert.equal(
    duplicateResultSink.textValue,
    'Echo: Continue from the preceding tool result and complete the response.'
  );
  assert.equal(countRpcMethod(logs, 'thread/start'), startsBeforeDuplicateResult + 1);
  assert.equal(
    countRpcMethod(logs, 'thread/inject_items'),
    injectsBeforeDuplicateResult + 1,
    'An unresumable tool result must inject its complete supplied history into a cold thread.'
  );

  const exactHistoryRequest = requestForText('please use tool for exact history', toolRequest.tools);
  const exactHistoryBoundarySink = createSink();
  const exactHistoryBoundary = await backend.runChat(
    exactHistoryRequest,
    exactHistoryBoundarySink,
    neverCancelled.token
  );
  assert.equal(exactHistoryBoundary.kind, 'toolBoundary');
  const exactHistoryCall = exactHistoryBoundarySink.toolCalls[0];
  const unrelatedUser = userMessage('unseen user history before the tool result');
  const inexactToolHistory = [
    ...exactHistoryRequest.fullHistory,
    {
      type: 'function_call',
      call_id: exactHistoryCall.callId,
      name: exactHistoryCall.name,
      arguments: JSON.stringify(exactHistoryCall.input)
    },
    unrelatedUser,
    {
      type: 'function_call_output',
      call_id: exactHistoryCall.callId,
      output: 'inexact result'
    }
  ];
  const startsBeforeInexactResult = countRpcMethod(logs, 'thread/start');
  const inexactResultSink = createSink();
  await backend.runChat({
    ...exactHistoryRequest,
    fullHistory: inexactToolHistory,
    historyBeforeCurrent: inexactToolHistory.slice(0, -1),
    projectedHistory: [exactHistoryRequest.fullHistory[0], unrelatedUser, inexactToolHistory.at(-1)],
    currentInput: [],
    toolResults: [{ callId: exactHistoryCall.callId, content: [{ value: 'inexact result' }] }]
  }, inexactResultSink, neverCancelled.token);
  assert.equal(
    inexactResultSink.textValue,
    'Echo: Continue from the preceding tool result and complete the response.'
  );
  assert.equal(
    countRpcMethod(logs, 'thread/start'),
    startsBeforeInexactResult + 1,
    'A tool result with extra unseen history must not resume the suspended turn.'
  );

  const concurrentResultRequest = requestForText('please use tool for concurrent result', toolRequest.tools);
  const concurrentBoundarySink = createSink();
  const concurrentBoundary = await backend.runChat(
    concurrentResultRequest,
    concurrentBoundarySink,
    neverCancelled.token
  );
  assert.equal(concurrentBoundary.kind, 'toolBoundary');
  const concurrentCall = concurrentBoundarySink.toolCalls[0];
  const concurrentHistory = appendToolResult(
    concurrentResultRequest.fullHistory,
    concurrentCall,
    'slow resume result'
  );
  const concurrentToolResultRequest = {
    ...concurrentResultRequest,
    fullHistory: concurrentHistory,
    historyBeforeCurrent: concurrentHistory.slice(0, -1),
    projectedHistory: [concurrentResultRequest.fullHistory[0], concurrentHistory.at(-1)],
    currentInput: [],
    toolResults: [{ callId: concurrentCall.callId, content: [{ value: 'slow resume result' }] }]
  };
  const startsBeforeConcurrentResult = countRpcMethod(logs, 'thread/start');
  const concurrentSinkA = createSink();
  const concurrentSinkB = createSink();
  const concurrentResults = await Promise.all([
    backend.runChat(concurrentToolResultRequest, concurrentSinkA, neverCancelled.token),
    backend.runChat(concurrentToolResultRequest, concurrentSinkB, neverCancelled.token)
  ]);
  assert.deepEqual(concurrentResults.map((result) => result.kind), ['completed', 'completed']);
  assert.deepEqual(
    [concurrentSinkA.textValue, concurrentSinkB.textValue].sort(),
    [
      'Echo: Continue from the preceding tool result and complete the response.',
      'Tool result accepted.'
    ].sort(),
    'One concurrent caller atomically resumes while the other reconstructs without cancelling it.'
  );
  assert.equal(countRpcMethod(logs, 'thread/start'), startsBeforeConcurrentResult + 1);

  const timeoutRequest = requestForText('please use tool then time out', toolRequest.tools);
  const timeoutBoundarySink = createSink();
  const timeoutBoundary = await backend.runChat(
    timeoutRequest,
    timeoutBoundarySink,
    neverCancelled.token
  );
  assert.equal(timeoutBoundary.kind, 'toolBoundary');
  const timeoutCall = timeoutBoundarySink.toolCalls[0];
  const timeoutBinding = [...backend.pendingCallsByBranch.values()]
    .find((binding) => binding.callId === timeoutCall.callId);
  assert.ok(timeoutBinding, 'The timeout fixture should have a branch-scoped pending binding.');
  backend.toolBridge.discardTurn(timeoutBinding.threadId, timeoutBinding.turnId);
  backend.toolBridge.onBridgeError({
    code: 'handoffTimeout',
    threadId: timeoutBinding.threadId,
    turnId: timeoutBinding.turnId,
    message: 'The host did not return the dynamic tool result before the handoff timeout.'
  });
  await waitFor(() => !backend.pendingCallsByBranch.has(timeoutBinding.branchId));
  assert.equal(
    backend.branches.findByActiveTurn(timeoutBinding.threadId, timeoutBinding.turnId),
    undefined,
    'A tool handoff timeout must evict the TTL-exempt active branch.'
  );

  const missingResultRequest = requestForText('please use tool then omit result', toolRequest.tools);
  const missingResultBoundarySink = createSink();
  const missingResultBoundary = await backend.runChat(
    missingResultRequest,
    missingResultBoundarySink,
    neverCancelled.token
  );
  assert.equal(missingResultBoundary.kind, 'toolBoundary');
  const omittedCall = missingResultBoundarySink.toolCalls[0];
  const replacementText = 'continue without the omitted tool result';
  const replacementMessage = userMessage(replacementText);
  const missingResultHistory = [
    ...missingResultRequest.fullHistory,
    {
      type: 'function_call',
      call_id: omittedCall.callId,
      name: omittedCall.name,
      arguments: JSON.stringify(omittedCall.input)
    },
    replacementMessage
  ];
  const startsBeforeMissingResult = countRpcMethod(logs, 'thread/start');
  const missingResultRecoverySink = createSink();
  const missingResultRecovery = await backend.runChat({
    ...missingResultRequest,
    fullHistory: missingResultHistory,
    historyBeforeCurrent: missingResultHistory.slice(0, -1),
    projectedHistory: [missingResultRequest.fullHistory[0], replacementMessage],
    currentInput: [{ type: 'text', text: replacementText, text_elements: [] }],
    toolResults: []
  }, missingResultRecoverySink, neverCancelled.token);
  assert.equal(missingResultRecovery.kind, 'completed');
  assert.equal(missingResultRecoverySink.textValue, `Echo: ${replacementText}`);
  assert.equal(
    countRpcMethod(logs, 'thread/start'),
    startsBeforeMissingResult + 1,
    'Omitting a pending result must interrupt the old turn and reconstruct a cold thread.'
  );

  const chainedRequest = requestForText('chain tools', toolRequest.tools);
  const chainedBoundarySink = createSink();
  const chainedBoundary = await backend.runChat(
    chainedRequest,
    chainedBoundarySink,
    neverCancelled.token
  );
  assert.equal(chainedBoundary.kind, 'toolBoundary');
  const firstChainedCall = chainedBoundarySink.toolCalls[0];
  const firstChainedHistory = appendToolResult(
    chainedRequest.fullHistory,
    firstChainedCall,
    'first result'
  );
  const chainedSecondSink = createSink();
  const chainedSecondBoundary = await backend.runChat({
    ...chainedRequest,
    fullHistory: firstChainedHistory,
    historyBeforeCurrent: firstChainedHistory.slice(0, -1),
    projectedHistory: [chainedRequest.fullHistory[0], firstChainedHistory.at(-1)],
    currentInput: [],
    toolResults: [{ callId: firstChainedCall.callId, content: [{ value: 'first result' }] }]
  }, chainedSecondSink, neverCancelled.token);
  assert.equal(chainedSecondBoundary.kind, 'toolBoundary');
  assert.equal(chainedSecondSink.toolCalls.length, 1);
  const secondChainedCall = chainedSecondSink.toolCalls[0];
  assert.notEqual(secondChainedCall.callId, firstChainedCall.callId);
  const secondChainedHistory = appendToolResult(
    firstChainedHistory,
    secondChainedCall,
    'second result'
  );
  const chainedFinalSink = createSink();
  const chainedCompleted = await backend.runChat({
    ...chainedRequest,
    fullHistory: secondChainedHistory,
    historyBeforeCurrent: secondChainedHistory.slice(0, -1),
    projectedHistory: [
      chainedRequest.fullHistory[0],
      firstChainedHistory.at(-1),
      secondChainedHistory.at(-1)
    ],
    currentInput: [],
    toolResults: [{ callId: secondChainedCall.callId, content: [{ value: 'second result' }] }]
  }, chainedFinalSink, neverCancelled.token);
  assert.equal(chainedCompleted.kind, 'completed');
  assert.equal(chainedFinalSink.textValue, 'Tool chain accepted.');

  const synchronousCancellation = createCancellationToken();
  const synchronousCancellationRequest = requestForText('use tool with synchronous cancellation', toolRequest.tools);
  const synchronousCancellationSink = createSink();
  synchronousCancellationSink.toolCall = function toolCall(callId, name, input) {
    this.toolCalls.push({ callId, name, input });
    synchronousCancellation.cancel();
  };
  const synchronousBoundary = await backend.runChat(
    synchronousCancellationRequest,
    synchronousCancellationSink,
    synchronousCancellation.token
  );
  assert.equal(
    synchronousBoundary.kind,
    'toolBoundary',
    'Cancellation fired by the progress callback must not interrupt an already-visible tool call.'
  );
  const synchronousCall = synchronousCancellationSink.toolCalls[0];
  const synchronousHistory = appendToolResult(
    synchronousCancellationRequest.fullHistory,
    synchronousCall,
    'completed after handoff'
  );
  const synchronousCompletionSink = createSink();
  const synchronousCompletion = await backend.runChat({
    ...synchronousCancellationRequest,
    fullHistory: synchronousHistory,
    historyBeforeCurrent: synchronousHistory.slice(0, -1),
    projectedHistory: [
      synchronousCancellationRequest.fullHistory[0],
      synchronousHistory.at(-1)
    ],
    currentInput: [],
    toolResults: [{
      callId: synchronousCall.callId,
      content: [{ value: 'completed after handoff' }]
    }]
  }, synchronousCompletionSink, neverCancelled.token);
  assert.equal(synchronousCompletion.kind, 'completed');

  await assert.rejects(
    backend.runChat(
      requestForText('invalid tool arguments', toolRequest.tools),
      createSink(),
      neverCancelled.token
    ),
    (error) => error?.name === 'DynamicToolBridgeError'
  );

  await assert.rejects(
    backend.runChat({
      ...requestForText('required without tools'),
      toolMode: 'required'
    }, createSink(), neverCancelled.token),
    /without tools/
  );

  await assert.rejects(
    backend.runChat({
      ...requestForText('required but model does not call', toolRequest.tools),
      toolMode: 'required'
    }, createSink(), neverCancelled.token),
    /completed without calling a tool/
  );

  await assert.rejects(
    backend.runChat(
      requestForText('forbidden shell'),
      createSink(),
      neverCancelled.token
    ),
    (error) => error?.name === 'PassivePolicyViolationError'
  );

  const cancellation = createCancellationToken();
  const waiting = backend.runChat(
    requestForText('wait forever'),
    createSink(),
    cancellation.token
  );
  setTimeout(() => cancellation.cancel(), 20);
  await assert.rejects(waiting, (error) => error instanceof MockCancellationError);

  const toolCancellation = createCancellationToken();
  const cancelledToolTurn = backend.runChat(
    requestForText('please use tool during cancellation', toolRequest.tools),
    createSink(),
    toolCancellation.token
  );
  toolCancellation.cancel();
  await assert.rejects(
    cancelledToolTurn,
    (error) => error instanceof MockCancellationError,
    'Bridge-controlled cancellation must remain a host cancellation instead of a generic tool failure.'
  );

  const parallelRequest = requestForText('parallel identical history');
  const parallelSinkA = createSink();
  const parallelSinkB = createSink();
  const [parallelA, parallelB] = await Promise.all([
    backend.runChat(parallelRequest, parallelSinkA, neverCancelled.token),
    backend.runChat(parallelRequest, parallelSinkB, neverCancelled.token)
  ]);
  assert.equal(parallelA.kind, 'completed');
  assert.equal(parallelB.kind, 'completed');
  assert.equal(parallelSinkA.textValue, 'Echo: parallel identical history');
  assert.equal(parallelSinkB.textValue, 'Echo: parallel identical history');

  const continuationRaceSeed = requestForText('continuation race seed');
  await backend.runChat(continuationRaceSeed, createSink(), neverCancelled.token);
  const continuationRaceFollowup = userMessage('continuation race followup');
  const continuationRaceRequest = requestForHistory([
    continuationRaceSeed.fullHistory[0],
    assistantMessage('Echo: continuation race seed'),
    continuationRaceFollowup
  ], 'continuation race followup');
  const raceStartsBefore = countRpcMethod(logs, 'thread/start');
  const raceSinkA = createSink();
  const raceSinkB = createSink();
  const [raceResultA, raceResultB] = await Promise.all([
    backend.runChat(continuationRaceRequest, raceSinkA, neverCancelled.token),
    backend.runChat(continuationRaceRequest, raceSinkB, neverCancelled.token)
  ]);
  assert.equal(raceResultA.kind, 'completed');
  assert.equal(raceResultB.kind, 'completed');
  assert.equal(raceSinkA.textValue, 'Echo: continuation race followup');
  assert.equal(raceSinkB.textValue, 'Echo: continuation race followup');
  assert.equal(
    countRpcMethod(logs, 'thread/start'),
    raceStartsBefore + 1,
    'One racing continuation should use a separate cold thread instead of sharing an active turn.'
  );

  const crashRequest = requestForText('crash after tool', toolRequest.tools);
  const crashBoundarySink = createSink();
  const crashBoundary = await backend.runChat(crashRequest, crashBoundarySink, neverCancelled.token);
  assert.equal(crashBoundary.kind, 'toolBoundary');
  const crashedCall = crashBoundarySink.toolCalls[0];
  const initializesBeforeCrashExit = countRpcMethod(logs, 'initialize');
  await delay(250);
  assert.equal(
    countRpcMethod(logs, 'initialize'),
    initializesBeforeCrashExit,
    'Crash cleanup must not eagerly launch a replacement app-server process.'
  );
  const crashHistory = appendToolResult(crashRequest.fullHistory, crashedCall, 'recovered result');
  const recoverySink = createSink();
  const recovered = await backend.runChat({
    ...crashRequest,
    fullHistory: crashHistory,
    historyBeforeCurrent: crashHistory.slice(0, -1),
    projectedHistory: [crashRequest.fullHistory[0], crashHistory.at(-1)],
    currentInput: [],
    toolResults: [{ callId: crashedCall.callId, content: [{ value: 'recovered result' }] }]
  }, recoverySink, neverCancelled.token);
  assert.equal(recovered.kind, 'completed');
  assert.equal(
    recoverySink.textValue,
    'Echo: Continue from the preceding tool result and complete the response.'
  );
  assert.equal(
    countRpcMethod(logs, 'initialize'),
    initializesBeforeCrashExit + 1,
    'The next user request lazily starts the replacement app-server process.'
  );

  const pendingLogin = await backend.beginLogin('browser');
  const authGenerationBeforeMalformedOutput = backend.accountGeneration;
  const authStatusReadsBeforeMalformedOutput = countRpcMethod(logs, 'getAuthStatus');
  const initializesBeforeMalformedOutput = countRpcMethod(logs, 'initialize');
  await assert.rejects(
    backend.runChat(requestForText('malformed output'), createSink(), neverCancelled.token),
    /malformed JSONL|process changed|exited/i
  );
  await assert.rejects(pendingLogin.completion, (error) => {
    assert.equal(error?.name, 'LoginCancelledError');
    assert.match(error.message, /process changed/i);
    return true;
  });
  assert.equal(backend.accountGeneration, authGenerationBeforeMalformedOutput + 1);
  assert.equal(
    countRpcMethod(logs, 'initialize'),
    initializesBeforeMalformedOutput,
    'Rejecting a process-bound login must not eagerly start a replacement app-server.'
  );

  const replacementAccount = await backend.readAccount(false);
  assert.deepEqual(replacementAccount, { type: 'chatgpt', planType: 'pro' });
  assert.equal(
    countRpcMethod(logs, 'getAuthStatus'),
    authStatusReadsBeforeMalformedOutput + 1,
    'A replacement process must revalidate auth mode instead of reusing stale announced state.'
  );

  const rateLimitReadsBeforeLogout = countRpcMethod(logs, 'account/rateLimits/read');
  const tokenActivityReadsBeforeLogout = countRpcMethod(logs, 'account/usage/read');
  await backend.logout();
  await delay(50);
  assert.equal(
    countRpcMethod(logs, 'account/rateLimits/read'),
    rateLimitReadsBeforeLogout,
    'The post-account-change refresh must not issue a usage RPC after sign-out.'
  );
  await assert.rejects(
    backend.readRateLimits(),
    (error) => error instanceof MockLanguageModelError && error.code === 'NoPermissions'
  );
  await assert.rejects(
    backend.readTokenActivity(),
    (error) => error instanceof MockLanguageModelError && error.code === 'NoPermissions'
  );
  assert.equal(countRpcMethod(logs, 'account/rateLimits/read'), rateLimitReadsBeforeLogout);
  assert.equal(countRpcMethod(logs, 'account/usage/read'), tokenActivityReadsBeforeLogout);

  for (const authMode of ['headers', 'apikey']) {
    process.env.CODEX_FAKE_AUTH_MODE = authMode;
    const modeLogs = [];
    const modeBackend = new CodexAppServerBackend({
      extension: { packageJSON: { version: '0.2.1' } },
      globalStorageUri: { fsPath: path.join(temporaryDirectory, `global-storage-${authMode}`) }
    }, {
      debug(message, metadata) {
        modeLogs.push({ level: 'debug', message, metadata });
      },
      warn(message, metadata) {
        modeLogs.push({ level: 'warn', message, metadata });
      }
    });
    try {
      await assert.rejects(
        modeBackend.readRateLimits(),
        (error) => error instanceof MockLanguageModelError && error.code === 'NoPermissions'
      );
      await assert.rejects(
        modeBackend.readTokenActivity(),
        (error) => error instanceof MockLanguageModelError && error.code === 'NoPermissions'
      );
      assert.equal(
        countRpcMethod(modeLogs, 'account/rateLimits/read'),
        0,
        `${authMode} authentication must not issue a rate-limit RPC.`
      );
      assert.equal(
        countRpcMethod(modeLogs, 'account/usage/read'),
        0,
        `${authMode} authentication must not issue a token-activity RPC.`
      );
    } finally {
      modeBackend.dispose();
    }
  }
  process.env.CODEX_FAKE_AUTH_MODE = 'chatgpt';

  const serializedLogs = JSON.stringify(logs);
  assert.equal(serializedLogs.includes('hello app-server'), false);
  assert.equal(serializedLogs.includes('README contents'), false);
  assert.equal(serializedLogs.includes('example.invalid'), false);

  backend.dispose();
  console.log('Fake app-server integration tests passed.');
} finally {
  backend?.dispose();
  Module._load = originalLoad;
  restoreEnvironment('CODEX_FAKE_AUTH_MODE', originalFakeAuthMode);
  restoreEnvironment('CODEX_FAKE_LOGIN_BEHAVIOR', originalFakeLoginBehavior);
  await removeWithRetry(temporaryDirectory);
}

async function testOverlappingAccountGenerationHandlers(target) {
  const coordinator = target.turnCoordinator;
  const branches = target.branches;
  const auth = target.auth;
  const usage = target.accountUsage;
  const originalCoordinatorInvalidation = coordinator.invalidateAll;
  const originalBranchInvalidation = branches.invalidateAccountGeneration;
  const originalUsageInvalidation = usage.invalidate;
  const originalUsageRefresh = target.readRateLimits;
  const originalGeneration = auth.accountGeneration;
  const gates = [];
  const invalidatedGenerations = [];

  coordinator.invalidateAll = () => new Promise((resolve) => gates.push(resolve));
  branches.invalidateAccountGeneration = (generation) => invalidatedGenerations.push(generation);
  usage.invalidate = () => undefined;
  target.readRateLimits = async () => undefined;
  try {
    auth.accountGeneration = 10;
    const stale = target.handleAccountChanged(10);
    assert.equal(gates.length, 1);

    auth.accountGeneration = 11;
    const current = target.handleAccountChanged(11);
    assert.equal(gates.length, 2);

    gates[1]();
    await current;
    gates[0]();
    await stale;
    assert.deepEqual(
      invalidatedGenerations,
      [11],
      'A stale account handler must not invalidate branches created for a newer generation.'
    );
  } finally {
    coordinator.invalidateAll = originalCoordinatorInvalidation;
    branches.invalidateAccountGeneration = originalBranchInvalidation;
    usage.invalidate = originalUsageInvalidation;
    target.readRateLimits = originalUsageRefresh;
    auth.accountGeneration = originalGeneration;
  }
}

function requestForText(text, tools = []) {
  const message = userMessage(text);
  return {
    model: 'gpt-5.5',
    requestedMode: 'high',
    backendEffort: 'high',
    orchestrationMode: 'standard',
    serviceTier: 'default',
    developerInstructions: 'Be concise.',
    toolMode: 'auto',
    tools,
    fullHistory: [message],
    historyBeforeCurrent: [],
    projectedHistory: [message],
    currentInput: [{ type: 'text', text, text_elements: [] }],
    toolResults: []
  };
}

function requestForHistory(fullHistory, currentText, tools = []) {
  return {
    ...requestForText(currentText, tools),
    fullHistory,
    historyBeforeCurrent: fullHistory.slice(0, -1),
    projectedHistory: fullHistory.filter((item) =>
      item.type === 'function_call_output' || item.type === 'message' && item.role === 'user')
  };
}

function userMessage(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }]
  };
}

function assistantMessage(text) {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  };
}

function appendToolResult(history, call, output) {
  return [
    ...history,
    {
      type: 'function_call',
      call_id: call.callId,
      name: call.name,
      arguments: JSON.stringify(call.input)
    },
    {
      type: 'function_call_output',
      call_id: call.callId,
      output
    }
  ];
}

function countRpcMethod(logs, method) {
  return logs.filter((entry) => entry.metadata?.method === method).length;
}

function fireConfigurationChange(section) {
  const event = {
    affectsConfiguration(candidate) {
      return candidate === section;
    }
  };
  for (const listener of [...configurationListeners]) {
    listener(event);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for fake app-server state.');
    }
    await delay(5);
  }
}

function createSink() {
  return {
    textValue: '',
    thinkingValue: '',
    toolCalls: [],
    usageValues: [],
    text(value) {
      this.textValue += value;
    },
    thinking(value) {
      this.thinkingValue += value;
    },
    toolCall(callId, name, input) {
      this.toolCalls.push({ callId, name, input });
    },
    usage(value) {
      this.usageValues.push(value);
    }
  };
}

function createCancellationToken() {
  const listeners = new Set();
  let cancelled = false;
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      }
    },
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      for (const listener of [...listeners]) {
        listener();
      }
    }
  };
}

async function createLauncher(directory) {
  const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'fakeCodexAppServer.cjs');
  if (process.platform === 'win32') {
    const launcher = path.join(directory, 'fake-codex.cmd');
    await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`, 'utf8');
    return launcher;
  }

  const launcher = path.join(directory, 'fake-codex');
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, 'utf8');
  await chmod(launcher, 0o755);
  return launcher;
}

async function removeWithRetry(directory) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code) || attempt === 99) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
