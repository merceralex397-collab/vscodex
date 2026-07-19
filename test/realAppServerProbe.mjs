import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-real-app-server-'));
const bundlePath = path.join(temporaryDirectory, 'codex-backend.cjs');
const command = process.env.CODEX_TEST_CODEX_COMMAND?.trim() || 'codex';
const requestedModel = process.env.CODEX_TEST_MODEL?.trim();
const requestedServiceTier = process.env.CODEX_TEST_SERVICE_TIER?.trim();
const originalLoad = Module._load;
let backend;
const logs = [];
const mcpStartupStatuses = [];

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
            ? { globalValue: command, defaultValue: 'codex' }
            : undefined;
        },
        get(_key, fallback) {
          return fallback;
        }
      };
    },
    onDidChangeConfiguration() {
      return { dispose() {} };
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
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  backend = new CodexAppServerBackend({
    extension: { packageJSON: { version: packageJson.version } },
    globalStorageUri: { fsPath: path.join(temporaryDirectory, 'global-storage') }
  }, {
    debug(message, metadata) {
      recordLog(logs, { level: 'debug', message, metadata });
    },
    warn(message, metadata) {
      recordLog(logs, { level: 'warn', message, metadata });
    }
  });
  backend.process.onNotification((notification) => {
    if (notification.method !== 'mcpServer/startupStatus/updated') {
      return;
    }
    const status = notification.params?.status;
    mcpStartupStatuses.push(typeof status === 'string' ? status : '<invalid>');
  });

  await backend.ensureReady();
  assert.match(backend.runtimeVersion ?? '', /^\d+\.\d+\.\d+$/, 'The real probe requires a stable Codex CLI version.');
  const account = await backend.readAccount(false);
  if (!account) {
    throw new Error('Codex app-server is signed out. Sign in with ChatGPT through Codex CLI, then retry.');
  }

  const neverCancelled = createCancellationToken();
  const models = await backend.listModels(neverCancelled.token);
  assert(models.length > 0, 'The signed-in account did not return any app-server models.');
  const model = requestedModel
    ? models.find((candidate) => candidate.id === requestedModel || candidate.model === requestedModel)
    : models.find((candidate) => candidate.isDefault && !candidate.hidden)
      ?? models.find((candidate) => !candidate.hidden);
  assert(model, requestedModel
    ? `Requested model ${requestedModel} was not returned by app-server.`
    : 'App-server did not return a visible model.');

  if (requestedServiceTier) {
    assert(
      model.serviceTiers.some((tier) => tier.id === requestedServiceTier),
      `Requested service tier ${requestedServiceTier} is not advertised by ${model.model}.`
    );
  }
  const serviceTier = requestedServiceTier
    ?? (model.defaultServiceTier && model.serviceTiers.some((tier) => tier.id === model.defaultServiceTier)
      ? model.defaultServiceTier
      : undefined);

  const limits = await backend.readRateLimits();
  assert(Array.isArray(limits.limits), 'App-server returned an invalid rate-limit snapshot.');

  const firstRequest = requestForText('Reply with a brief confirmation that this app-server probe is connected.', model.model, serviceTier);
  const firstSink = createSink();
  const firstResult = await backend.runChat(firstRequest, firstSink, neverCancelled.token);
  assert.equal(firstResult.kind, 'completed');
  assert(firstSink.textValue.trim(), 'The real app-server text probe returned no final text.');

  const followUpText = 'Reply briefly that continuation is working.';
  const followUpMessage = userMessage(followUpText);
  const followUpRequest = {
    ...firstRequest,
    fullHistory: [
      firstRequest.fullHistory[0],
      assistantMessage(firstSink.textValue),
      followUpMessage
    ],
    historyBeforeCurrent: [
      firstRequest.fullHistory[0],
      assistantMessage(firstSink.textValue)
    ],
    projectedHistory: [firstRequest.fullHistory[0], followUpMessage],
    currentInput: [{ type: 'text', text: followUpText, text_elements: [] }]
  };
  const followUpSink = createSink();
  const followUpResult = await backend.runChat(followUpRequest, followUpSink, neverCancelled.token);
  assert.equal(followUpResult.kind, 'completed');
  assert(followUpSink.textValue.trim(), 'The continuation probe returned no final text.');

  const forkText = 'Reply briefly that checkpoint forking is working.';
  const forkMessage = userMessage(forkText);
  const forkRequest = {
    ...firstRequest,
    fullHistory: [
      firstRequest.fullHistory[0],
      assistantMessage(firstSink.textValue),
      forkMessage
    ],
    historyBeforeCurrent: [
      firstRequest.fullHistory[0],
      assistantMessage(firstSink.textValue)
    ],
    projectedHistory: [firstRequest.fullHistory[0], forkMessage],
    currentInput: [{ type: 'text', text: forkText, text_elements: [] }]
  };
  const forkSink = createSink();
  const forkResult = await backend.runChat(forkRequest, forkSink, neverCancelled.token);
  assert.equal(forkResult.kind, 'completed');
  assert(forkSink.textValue.trim(), 'The checkpoint-fork probe returned no final text.');

  const reconstructedEarlier = userMessage('This is reconstructed earlier conversation context.');
  const reconstructedCurrentText = 'Reply briefly that cold reconstruction is working.';
  const reconstructedCurrent = userMessage(reconstructedCurrentText);
  const reconstructedHistory = [
    reconstructedEarlier,
    assistantMessage('Earlier reconstructed assistant context.'),
    reconstructedCurrent
  ];
  const reconstructionSink = createSink();
  const reconstructionResult = await backend.runChat({
    ...firstRequest,
    fullHistory: reconstructedHistory,
    historyBeforeCurrent: reconstructedHistory.slice(0, -1),
    projectedHistory: [reconstructedEarlier, reconstructedCurrent],
    currentInput: [{ type: 'text', text: reconstructedCurrentText, text_elements: [] }]
  }, reconstructionSink, neverCancelled.token);
  assert.equal(reconstructionResult.kind, 'completed');
  assert(reconstructionSink.textValue.trim(), 'The cold-reconstruction probe returned no final text.');

  const toolRequest = requestForText(
    'Call the supplied probe_echo tool once before answering.',
    model.model,
    serviceTier,
    [{
      name: 'probe_echo',
      description: 'Echo a short probe value.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }
    }],
    'required'
  );
  const toolSink = createSink();
  const toolBoundary = await backend.runChat(toolRequest, toolSink, neverCancelled.token);
  assert.equal(toolBoundary.kind, 'toolBoundary', 'Required mode completed without a dynamic-tool boundary.');
  assert.equal(toolSink.toolCalls.length, 1, 'Required mode must expose exactly one tool call per invocation.');
  assert.equal(toolSink.toolCalls[0].name, 'probe_echo');

  const toolCall = toolSink.toolCalls[0];
  const toolHistory = [
    ...toolRequest.fullHistory,
    {
      type: 'function_call',
      call_id: toolCall.callId,
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input)
    },
    {
      type: 'function_call_output',
      call_id: toolCall.callId,
      output: 'probe tool completed'
    }
  ];
  const resumedSink = createSink();
  const resumedResult = await backend.runChat({
    ...toolRequest,
    fullHistory: toolHistory,
    historyBeforeCurrent: toolHistory.slice(0, -1),
    projectedHistory: [toolRequest.fullHistory[0], toolHistory.at(-1)],
    currentInput: [],
    toolResults: [{
      callId: toolCall.callId,
      content: [{ value: 'probe tool completed' }]
    }]
  }, resumedSink, neverCancelled.token);
  assert.equal(resumedResult.kind, 'completed');
  assert.equal(resumedSink.toolCalls.length, 0, 'The resumed app-server turn repeated a completed tool call.');

  const chainedTools = [
    {
      name: 'probe_first',
      description: 'Record the first step of the probe.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }
    },
    {
      name: 'probe_second',
      description: 'Record the second step of the probe after probe_first completes.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false
      }
    }
  ];
  const chainedRequest = requestForText(
    'Call probe_first once, wait for its result, then call probe_second once before answering.',
    model.model,
    serviceTier,
    chainedTools,
    'required'
  );
  const chainedFirstSink = createSink();
  const chainedFirstBoundary = await backend.runChat(chainedRequest, chainedFirstSink, neverCancelled.token);
  assert.equal(chainedFirstBoundary.kind, 'toolBoundary');
  assert.equal(chainedFirstSink.toolCalls.length, 1);
  assert.equal(chainedFirstSink.toolCalls[0].name, 'probe_first');

  const firstChainedCall = chainedFirstSink.toolCalls[0];
  const firstChainedOutput = {
    type: 'function_call_output',
    call_id: firstChainedCall.callId,
    output: 'first chained probe completed'
  };
  const chainedHistoryAfterFirst = [
    ...chainedRequest.fullHistory,
    {
      type: 'function_call',
      call_id: firstChainedCall.callId,
      name: firstChainedCall.name,
      arguments: JSON.stringify(firstChainedCall.input)
    },
    firstChainedOutput
  ];
  const chainedSecondSink = createSink();
  const chainedSecondBoundary = await backend.runChat({
    ...chainedRequest,
    fullHistory: chainedHistoryAfterFirst,
    historyBeforeCurrent: chainedHistoryAfterFirst.slice(0, -1),
    projectedHistory: [chainedRequest.fullHistory[0], firstChainedOutput],
    currentInput: [],
    toolResults: [{
      callId: firstChainedCall.callId,
      content: [{ value: 'first chained probe completed' }]
    }]
  }, chainedSecondSink, neverCancelled.token);
  assert.equal(chainedSecondBoundary.kind, 'toolBoundary');
  assert.equal(chainedSecondSink.toolCalls.length, 1);
  assert.equal(chainedSecondSink.toolCalls[0].name, 'probe_second');

  const secondChainedCall = chainedSecondSink.toolCalls[0];
  const secondChainedOutput = {
    type: 'function_call_output',
    call_id: secondChainedCall.callId,
    output: 'second chained probe completed'
  };
  const chainedHistoryAfterSecond = [
    ...chainedHistoryAfterFirst,
    {
      type: 'function_call',
      call_id: secondChainedCall.callId,
      name: secondChainedCall.name,
      arguments: JSON.stringify(secondChainedCall.input)
    },
    secondChainedOutput
  ];
  const chainedFinalSink = createSink();
  const chainedFinalResult = await backend.runChat({
    ...chainedRequest,
    fullHistory: chainedHistoryAfterSecond,
    historyBeforeCurrent: chainedHistoryAfterSecond.slice(0, -1),
    projectedHistory: [
      chainedRequest.fullHistory[0],
      firstChainedOutput,
      secondChainedOutput
    ],
    currentInput: [],
    toolResults: [{
      callId: secondChainedCall.callId,
      content: [{ value: 'second chained probe completed' }]
    }]
  }, chainedFinalSink, neverCancelled.token);
  assert.equal(chainedFinalResult.kind, 'completed');
  assert.equal(chainedFinalSink.toolCalls.length, 0);

  const cancellation = createCancellationToken();
  const cancellationProbe = backend.runChat(
    requestForText('Explain app-server cancellation in detail.', model.model, serviceTier),
    createSink(),
    cancellation.token
  );
  cancellation.cancel();
  await assert.rejects(cancellationProbe, (error) => error instanceof MockCancellationError);

  const [parallelOne, parallelTwo] = await Promise.all([
    runTextProbe(backend, requestForText('Reply with the single word one.', model.model, serviceTier), neverCancelled.token),
    runTextProbe(backend, requestForText('Reply with the single word two.', model.model, serviceTier), neverCancelled.token)
  ]);
  assert(parallelOne.trim(), 'The first simultaneous chat returned no text.');
  assert(parallelTwo.trim(), 'The second simultaneous chat returned no text.');

  assert.equal(
    logs.some((entry) => entry.metadata?.method === 'mcpServer/startupStatus/updated'),
    false,
    'The passive app-server started a user-configured MCP server.'
  );
  assert.equal(
    mcpStartupStatuses.length,
    0,
    'The passive app-server emitted a user-configured MCP startup transition.'
  );

  const serializedLogs = JSON.stringify(logs);
  for (const privateValue of [
    'app-server probe is connected',
    'probe tool completed',
    'first chained probe completed',
    'Reply with the single word one'
  ]) {
    assert.equal(serializedLogs.includes(privateValue), false, 'Diagnostic logs included prompt or tool content.');
  }

  console.log(
    `Real app-server probe passed with codex-cli ${backend.runtimeVersion}; `
    + 'account, models, limits, continuation, forking, reconstruction, tools, cancellation, and concurrency succeeded.'
  );
} catch (error) {
  console.error(`Real app-server probe failed: ${sanitizeError(error)}`);
  if (error && typeof error === 'object'
    && ['launch', 'timeout', 'exited', 'malformed', 'oversized', 'capacity', 'configuration-changed', 'not-disabled'].includes(error.reason)) {
    console.error(`MCP isolation failure: ${error.reason}`);
  }
  if (error && typeof error === 'object' && typeof error.methodOrItemType === 'string') {
    console.error(`Passive-policy trigger: ${error.methodOrItemType}`);
    if (typeof error.invariant === 'string' && error.invariant) {
      console.error(`Failed invariant: ${error.invariant}`);
    }
  }
  if (error && typeof error === 'object' && error.detail) {
    console.error(`Sanitized error detail: ${sanitizeDiagnosticError(error.detail)}`);
  }
  const lifecycle = logs.slice(-100).map((entry) => ({
    level: entry.level,
    message: entry.message,
    method: entry.metadata?.method,
    status: entry.metadata?.status,
    generation: entry.metadata?.generation
  }));
  console.error(`Sanitized lifecycle: ${JSON.stringify(lifecycle)}`);
  if (mcpStartupStatuses.length > 0) {
    console.error(`Sanitized MCP statuses: ${JSON.stringify(mcpStartupStatuses)}`);
  }
  process.exitCode = 1;
} finally {
  backend?.dispose();
  await delay(1_500);
  Module._load = originalLoad;
  await rm(temporaryDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200
  });
}

function requestForText(text, model, serviceTier, tools = [], toolMode = 'auto') {
  const message = userMessage(text);
  return {
    model,
    requestedMode: undefined,
    backendEffort: undefined,
    orchestrationMode: 'standard',
    serviceTier,
    developerInstructions: 'Keep probe responses brief.',
    toolMode,
    tools,
    fullHistory: [message],
    historyBeforeCurrent: [],
    projectedHistory: [message],
    currentInput: [{ type: 'text', text, text_elements: [] }],
    toolResults: []
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

async function runTextProbe(targetBackend, request, token) {
  const sink = createSink();
  const result = await targetBackend.runChat(request, sink, token);
  assert.equal(result.kind, 'completed');
  return sink.textValue;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function recordLog(target, entry) {
  target.push(entry);
  if (target.length > 512) {
    target.splice(0, target.length - 512);
  }
}

function sanitizeError(value) {
  const message = value instanceof Error ? value.message : 'Unknown failure.';
  return message
    .replace(/https?:\/\/\S+/gi, '[redacted URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted account]')
    .replace(/[A-Za-z]:\\[^\r\n]+/g, '[redacted path]')
    .slice(0, 500);
}

function sanitizeDiagnosticError(value) {
  if (!value || typeof value !== 'object') {
    return sanitizeError(value);
  }
  const record = {
    name: typeof value.name === 'string' ? value.name : undefined,
    code: typeof value.code === 'number' || typeof value.code === 'string' ? value.code : undefined,
    message: sanitizeError(value),
    cause: value.cause ? sanitizeError(value.cause) : undefined
  };
  return JSON.stringify(record);
}
