#!/usr/bin/env node
'use strict';

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.144.4\n');
  process.exit(0);
}

if (process.argv.includes('mcp') && process.argv.includes('list')) {
  if (process.argv.includes('--json')) {
    process.stderr.write('JSON MCP listing is forbidden in provider tests.\n');
    process.exit(2);
  }
  const disabled = process.argv.some((argument) =>
    argument.includes('"fixture_mcp"={enabled=false,command="./.codexvs-disabled-mcp"}'));
  process.stdout.write(
    'Name         Command  Args  Env  Cwd  Status    Auth\n'
    + `fixture_mcp  fixture  -     -    -    ${disabled ? 'disabled' : 'enabled '}  Unsupported\n`
  );
  process.exit(0);
}

const processMcpOverrideApplied = process.argv.some((argument) =>
  argument.includes('"fixture_mcp"={enabled=false,command="./.codexvs-disabled-mcp"}'));

const threads = new Map();
const turns = new Map();
const pendingToolRequests = new Map();
let nextThread = 1;
let nextTurn = 1;
let nextServerRequest = 1;
let authMode = process.env.CODEX_FAKE_AUTH_MODE === 'signedOut'
  ? null
  : process.env.CODEX_FAKE_AUTH_MODE || 'chatgpt';
let signedIn = authMode !== null;
let inputBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inputBuffer += chunk;
  while (inputBuffer.includes('\n')) {
    const newline = inputBuffer.indexOf('\n');
    const line = inputBuffer.slice(0, newline).replace(/\r$/, '');
    inputBuffer = inputBuffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});

function handle(message) {
  if (message.method) {
    handleMethod(message);
    return;
  }

  const pending = pendingToolRequests.get(String(message.id));
  if (pending) {
    pendingToolRequests.delete(String(message.id));
    completeToolTurn(pending, message.result);
  }
}

function handleMethod(message) {
  switch (message.method) {
    case 'initialize':
      respond(message, {
        userAgent: 'fake-codex-app-server',
        codexHome: '[redacted]',
        platformFamily: process.platform,
        platformOs: process.platform
      });
      break;
    case 'initialized':
      break;
    case 'account/read':
      respond(message, {
        account: signedIn ? { type: 'chatgpt', planType: 'pro' } : null,
        requiresOpenaiAuth: false
      });
      break;
    case 'getAuthStatus':
      respond(message, {
        authMethod: signedIn ? authMode : null,
        authToken: null,
        requiresOpenaiAuth: false
      });
      break;
    case 'account/login/start':
      startLogin(message);
      break;
    case 'account/login/cancel':
      respond(message, {});
      break;
    case 'account/logout':
      signedIn = false;
      authMode = null;
      respond(message, {});
      notify('account/updated', { authMode: null, planType: null });
      break;
    case 'model/list':
      listModels(message);
      break;
    case 'account/rateLimits/read':
      respond(message, rateLimits());
      break;
    case 'account/usage/read':
      respond(message, {
        summary: {
          lifetimeTokens: 1234,
          peakDailyTokens: 100,
          longestRunningTurnSec: 4,
          currentStreakDays: 2,
          longestStreakDays: 3
        },
        dailyUsageBuckets: [{ startDate: '2026-07-14', tokens: 100 }]
      });
      break;
    case 'thread/start':
      startThread(message);
      break;
    case 'thread/fork':
      forkThread(message);
      break;
    case 'thread/inject_items':
      injectItems(message);
      break;
    case 'thread/unsubscribe':
      respond(message, {});
      break;
    case 'turn/start':
      startTurn(message);
      break;
    case 'turn/interrupt':
      interruptTurn(message);
      break;
    default:
      if (message.id !== undefined) {
        send({ id: message.id, error: { code: -32601, message: 'Method not found.' } });
      }
      break;
  }
}

function startLogin(message) {
  const loginId = `login-${Date.now()}`;
  const device = message.params?.type === 'chatgptDeviceCode';
  respond(message, device
    ? {
        type: 'chatgptDeviceCode',
        loginId,
        verificationUrl: 'https://example.invalid/device',
        userCode: 'ABCD-EFGH'
      }
    : {
        type: 'chatgpt',
        loginId,
        authUrl: 'https://example.invalid/login'
      });
  if (process.env.CODEX_FAKE_LOGIN_BEHAVIOR === 'wait') {
    return;
  }
  setTimeout(() => {
    signedIn = true;
    authMode = 'chatgpt';
    notify('account/login/completed', { loginId, success: true, error: null });
    notify('account/updated', { authMode: 'chatgpt', planType: 'pro' });
  }, 5);
}

function listModels(message) {
  if (message.params?.cursor === null || message.params?.cursor === undefined) {
    respond(message, {
      data: [{
        id: 'catalog-gpt-5.5',
        model: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Fake Codex model',
        hidden: false,
        isDefault: true,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Low reasoning' },
          { reasoningEffort: 'high', description: 'High reasoning' },
          { reasoningEffort: 'max', description: 'Maximum reasoning' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with delegation' }
        ],
        defaultReasoningEffort: 'high',
        inputModalities: ['text', 'image'],
        serviceTiers: [
          { id: 'default', name: 'Default', description: 'Default tier' },
          { id: 'fast', name: 'Fast', description: 'Fast tier' }
        ],
        defaultServiceTier: 'default'
      }],
      nextCursor: 'page-2'
    });
  } else {
    respond(message, {
      data: [{
        id: 'hidden-model',
        model: 'hidden-model',
        displayName: 'Hidden',
        description: 'Hidden fake model',
        hidden: true,
        isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text'],
        serviceTiers: [],
        defaultServiceTier: null
      }],
      nextCursor: null
    });
  }
}

function rateLimits() {
  return {
    rateLimits: {
      limitId: 'codex',
      limitName: 'Codex',
      planType: 'pro',
      credits: { balance: 7 },
      primary: {
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: Math.floor(Date.now() / 1000) + 3600
      },
      secondary: {
        usedPercent: 40,
        windowDurationMins: 10080,
        resetsAt: Math.floor(Date.now() / 1000) + 7200
      }
    },
    rateLimitsByLimitId: {}
  };
}

function startThread(message) {
  const threadMcp = message.params?.config?.mcp_servers?.fixture_mcp;
  if (!processMcpOverrideApplied
    || threadMcp?.enabled !== false
    || threadMcp?.command !== './.codexvs-disabled-mcp') {
    send({ id: message.id, error: { code: -32602, message: 'Passive MCP isolation was not propagated.' } });
    return;
  }
  if (!hasPassiveMultiAgentConfig(message.params?.config)) {
    send({ id: message.id, error: { code: -32602, message: 'Passive multi-agent containment was not propagated.' } });
    return;
  }
  const id = `thread-${nextThread++}`;
  threads.set(id, {
    id,
    dynamicTools: message.params?.dynamicTools ?? [],
    developerInstructions: message.params?.developerInstructions ?? '',
    history: []
  });
  respond(message, threadResponse(id, message.params));
}

function forkThread(message) {
  if (!hasPassiveMultiAgentConfig(message.params?.config)) {
    send({ id: message.id, error: { code: -32602, message: 'Passive multi-agent containment was not propagated to the fork.' } });
    return;
  }
  const source = threads.get(message.params?.threadId);
  const id = `thread-${nextThread++}`;
  threads.set(id, {
    id,
    dynamicTools: source?.dynamicTools ?? [],
    developerInstructions: message.params?.developerInstructions ?? '',
    history: [...(source?.history ?? [])]
  });
  respond(message, threadResponse(id, message.params));
}

function threadResponse(id, params) {
  return {
    thread: {
      id,
      turns: [],
      ephemeral: true,
      modelProvider: 'openai',
      cwd: params?.cwd ?? ''
    },
    model: params?.model ?? 'gpt-5.5',
    modelProvider: 'openai',
    // The real 0.144.4 runtime resolves an omitted/null tier to the catalog
    // default in the thread response.
    serviceTier: params?.serviceTier ?? 'default',
    cwd: params?.cwd ?? '',
    runtimeWorkspaceRoots: [],
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly', networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: null,
    multiAgentMode: 'explicitRequestOnly'
  };
}

function injectItems(message) {
  const thread = threads.get(message.params?.threadId);
  if (!thread) {
    send({ id: message.id, error: { code: -32000, message: 'Unknown thread.' } });
    return;
  }
  const items = message.params?.items ?? [];
  const registeredTools = new Set((thread.dynamicTools ?? []).map((tool) => tool.name));
  const invalidFunctionCall = items.find((item) =>
    item.type === 'function_call'
    && registeredTools.size > 0
    && !registeredTools.has(item.name));
  if (invalidFunctionCall) {
    send({ id: message.id, error: { code: -32602, message: 'Injected function call was not aliased.' } });
    return;
  }
  thread.history.push(...items);
  respond(message, {});
}

function startTurn(message) {
  const threadId = message.params?.threadId;
  const thread = threads.get(threadId);
  const turnId = `turn-${nextTurn++}`;
  const turn = { threadId, turnId, status: 'inProgress' };
  turns.set(turnId, turn);
  const text = (message.params?.input ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join(' ');

  if (/expect proactive ultra/i.test(text)) {
    const subagentTool = thread?.dynamicTools?.find((tool) =>
      /VS Code caller tool '(?:runSubagent|agent\/runSubagent)'/.test(tool.description ?? ''));
    const instructions = thread?.developerInstructions ?? '';
    if (message.params?.effort !== 'max'
      || !subagentTool
      || !instructions.includes(`'${subagentTool.name}'`)
      || !/bounded, independent work/i.test(instructions)
      || !/Never call Codex collaboration tools/i.test(instructions)) {
      send({ id: message.id, error: { code: -32602, message: 'VS Code Ultra orchestration was not configured correctly.' } });
      return;
    }
    respond(message, { turn: turnPayload(turnId, 'inProgress') });
    setImmediate(() => issueToolRequest(threadId, turnId, 1, 1, false, subagentTool.name));
    return;
  }

  if (/expect nested ultra fallback/i.test(text)) {
    if (message.params?.effort !== 'max'
      || (thread?.developerInstructions ?? '').includes('Ultra (VS Code) orchestration is active')) {
      send({ id: message.id, error: { code: -32602, message: 'Nested Ultra fallback was not single-agent Max.' } });
      return;
    }
  }

  if (/(?:use|chain|crash after|invalid) tool/i.test(text) && thread?.dynamicTools?.length) {
    respond(message, { turn: turnPayload(turnId, 'inProgress') });
    const total = /chain tool/i.test(text) ? 2 : 1;
    setImmediate(() => issueToolRequest(
      threadId,
      turnId,
      1,
      total,
      /invalid tool/i.test(text)
    ));
    if (/crash after tool/i.test(text)) {
      setTimeout(() => process.exit(42), 150);
    }
    return;
  }

  respond(message, { turn: turnPayload(turnId, 'inProgress') });
  if (/forbidden shell/i.test(text)) {
    setImmediate(() => notify('item/started', {
      threadId,
      turnId,
      startedAtMs: Date.now(),
      item: {
        type: 'commandExecution',
        id: `forbidden-${turnId}`,
        command: 'whoami',
        cwd: '.',
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      }
    }));
    return;
  }
  if (/malformed output/i.test(text)) {
    setImmediate(() => process.stdout.write('{malformed jsonl\n'));
    return;
  }
  if (/wait forever/i.test(text)) {
    return;
  }
  setTimeout(() => completeTextTurn(threadId, turnId, `Echo: ${text}`), /parallel/i.test(text) ? 20 : 0);
}

function completeToolTurn(pending, result) {
  notify('item/completed', {
    threadId: pending.threadId,
    turnId: pending.turnId,
    completedAtMs: Date.now(),
    item: {
      type: 'dynamicToolCall',
      id: pending.itemId,
      namespace: null,
      tool: 'fake',
      arguments: {},
      status: result?.success ? 'completed' : 'failed',
      contentItems: result?.contentItems ?? [],
      success: result?.success === true
    }
  });
  if (pending.index < pending.total) {
    setImmediate(() => issueToolRequest(
      pending.threadId,
      pending.turnId,
      pending.index + 1,
      pending.total
    ));
    return;
  }
  const completion = () => completeTextTurn(
    pending.threadId,
    pending.turnId,
    pending.total > 1 ? 'Tool chain accepted.' : 'Tool result accepted.'
  );
  if (JSON.stringify(result?.contentItems ?? []).includes('slow resume')) {
    setTimeout(completion, 50);
  } else {
    completion();
  }
}

function issueToolRequest(
  threadId,
  turnId,
  index,
  total,
  invalidArguments = false,
  requestedToolName
) {
  const thread = threads.get(threadId);
  const tool = requestedToolName
    ? thread?.dynamicTools?.find((candidate) => candidate.name === requestedToolName)
    : thread?.dynamicTools?.[0];
  if (!tool) {
    completeTextTurn(threadId, turnId, 'No dynamic tool was registered.');
    return;
  }
  const itemId = `tool-item-${turnId}-${index}`;
  const toolArguments = invalidArguments
    ? ['arguments must be an object']
    : { path: index === 1 ? 'README.md' : 'package.json' };
  notify('item/started', {
    threadId,
    turnId,
    startedAtMs: Date.now(),
    item: {
      type: 'dynamicToolCall',
      id: itemId,
      namespace: null,
      tool: tool.name,
      arguments: toolArguments,
      status: 'inProgress',
      contentItems: null,
      success: null
    }
  });
  const requestId = `server-${nextServerRequest++}`;
  pendingToolRequests.set(requestId, { threadId, turnId, itemId, index, total });
  send({
    id: requestId,
    method: 'item/tool/call',
    params: {
      threadId,
      turnId,
      callId: `call-${turnId}-${index}`,
      namespace: null,
      tool: tool.name,
      arguments: toolArguments
    }
  });
}

function hasPassiveMultiAgentConfig(config) {
  const multiAgentV2 = config?.features?.multi_agent_v2;
  return config?.features?.multi_agent === false
    && multiAgentV2?.enabled === false
    && multiAgentV2?.max_concurrent_threads_per_session === 1
    && multiAgentV2?.usage_hint_text === ''
    && multiAgentV2?.root_agent_usage_hint_text === ''
    && multiAgentV2?.subagent_usage_hint_text === ''
    && /built-in collaboration is prohibited/i.test(
      multiAgentV2?.multi_agent_mode_hint_text ?? ''
    );
}

function completeTextTurn(threadId, turnId, text) {
  const itemId = `agent-${turnId}`;
  notify('item/started', {
    threadId,
    turnId,
    startedAtMs: Date.now(),
    item: { type: 'agentMessage', id: itemId, text: '', phase: 'final_answer', memoryCitation: null }
  });
  notify('item/agentMessage/delta', { threadId, turnId, itemId, delta: text });
  notify('item/completed', {
    threadId,
    turnId,
    completedAtMs: Date.now(),
    item: { type: 'agentMessage', id: itemId, text, phase: 'final_answer', memoryCitation: null }
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: usage(),
      last: usage(),
      modelContextWindow: 272000
    }
  });
  notify('turn/completed', { threadId, turn: turnPayload(turnId, 'completed') });
}

function interruptTurn(message) {
  const turnId = message.params?.turnId;
  const turn = turns.get(turnId);
  respond(message, {});
  if (turn) {
    notify('turn/completed', {
      threadId: turn.threadId,
      turn: turnPayload(turnId, 'interrupted')
    });
  }
}

function usage() {
  return {
    totalTokens: 18,
    inputTokens: 11,
    cachedInputTokens: 3,
    outputTokens: 7,
    reasoningOutputTokens: 2
  };
}

function turnPayload(id, status) {
  return {
    id,
    items: [],
    itemsView: 'full',
    status,
    error: null,
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: status === 'inProgress' ? null : Math.floor(Date.now() / 1000),
    durationMs: status === 'inProgress' ? null : 1
  };
}

function respond(message, result) {
  send({ id: message.id, result });
}

function notify(method, params) {
  send({ method, params });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
