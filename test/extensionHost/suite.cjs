'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const expectedExtensionId = requiredEnvironment('CODEX_TEST_EXTENSION_ID');
  const fakeCommand = requiredEnvironment('CODEX_TEST_FAKE_COMMAND');
  const expectedWorkspace = requiredEnvironment('CODEX_TEST_WORKSPACE');
  assert.deepEqual(
    Object.keys(process.env).filter((key) => [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'CODEX_ACCESS_TOKEN'
    ].includes(key.toUpperCase())),
    [],
    'Extension-host tests must not inherit API-key or access-token credentials.'
  );
  assert.equal(
    normalizePath(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath),
    normalizePath(expectedWorkspace)
  );

  const extension = vscode.extensions.all.find((candidate) =>
    candidate.id.toLowerCase() === expectedExtensionId.toLowerCase());
  assert(extension, `Extension ${expectedExtensionId} is not registered in VS Code.`);
  assert.equal(extension.id.toLowerCase(), expectedExtensionId.toLowerCase());

  await extension.activate();
  assert.equal(extension.isActive, true, 'Extension did not activate.');

  const config = vscode.workspace.getConfiguration('codexvs');
  const commandSetting = config.inspect('appServer.command');
  assert.equal(commandSetting?.globalValue, fakeCommand, 'Fake app-server must come from the isolated machine setting.');
  assert.equal(commandSetting?.workspaceValue, undefined, 'Workspace settings must not select the executable.');
  assert.equal(commandSetting?.workspaceFolderValue, undefined, 'Workspace-folder settings must not select the executable.');
  const removedBaseUrl = config.inspect('baseURL');
  assert.equal(removedBaseUrl?.defaultValue, undefined, 'The removed direct-backend setting must not have a default.');
  assert.equal(removedBaseUrl?.globalValue, undefined, 'The removed direct-backend setting must not have an isolated user value.');
  assert.equal(removedBaseUrl?.workspaceValue, undefined, 'The removed direct-backend setting must not have a workspace value.');

  const models = await vscode.lm.selectChatModels({ vendor: 'codexvs' });
  assert.equal(models.length, 1, 'Exactly one non-hidden fake model should be selectable.');
  const model = models[0];
  assert.equal(model.id, 'codex::catalog-gpt-5.5');
  assert.equal(model.name, 'GPT-5.5');
  assert.equal(model.family, 'gpt-5.5');
  assert.equal(model.maxInputTokens, 263_808);
  assert.match(model.version, /^0\.144\.4-[0-9a-f]{12}$/);
  assert((await model.countTokens('Count these words.')) > 0, 'Local token estimation should return a positive value.');

  const plainResponse = await model.sendRequest([
    vscode.LanguageModelChatMessage.User('extension host hello')
  ], {
    justification: 'Validate the CodexVS extension-host adapter.'
  });
  const plainParts = await collectParts(plainResponse.stream);
  assert.equal(collectText(plainParts), 'Echo: extension host hello');

  const nativeSubagentTool = {
    name: 'runSubagent',
    description: 'Run one governed VS Code subagent.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt']
    }
  };
  const ultraMessage = vscode.LanguageModelChatMessage.User('expect proactive ultra');
  const ultraResponse = await model.sendRequest([ultraMessage], {
    justification: 'Validate Ultra through the real VS Code language-model host.',
    modelOptions: { reasoningEffort: 'ultra' },
    tools: [nativeSubagentTool]
  });
  const ultraParts = await collectParts(ultraResponse.stream);
  const ultraCalls = ultraParts.filter((part) =>
    part instanceof vscode.LanguageModelToolCallPart);
  assert.equal(ultraCalls.length, 1, 'Ultra must expose one serialized VS Code subagent call.');
  assert.equal(ultraCalls[0].name, 'runSubagent');
  const ultraToolResult = new vscode.LanguageModelToolResultPart(ultraCalls[0].callId, [
    new vscode.LanguageModelTextPart('Bounded VS Code worker result')
  ]);
  const ultraResumedResponse = await model.sendRequest([
    ultraMessage,
    vscode.LanguageModelChatMessage.Assistant([ultraCalls[0]]),
    vscode.LanguageModelChatMessage.User([ultraToolResult])
  ], {
    justification: 'Resume Ultra after the VS Code-owned subagent result.',
    modelOptions: { reasoningEffort: 'ultra' },
    tools: [nativeSubagentTool]
  });
  const ultraResumedParts = await collectParts(ultraResumedResponse.stream);
  assert.equal(collectText(ultraResumedParts), 'Tool result accepted.');
  assert.equal(
    ultraResumedParts.filter((part) => part instanceof vscode.LanguageModelToolCallPart).length,
    0,
    'The resumed Ultra subagent call must not be emitted twice.'
  );

  const tool = {
    name: 'workspace/read_file',
    description: 'Read one workspace file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    }
  };
  const initialToolMessage = vscode.LanguageModelChatMessage.User('please use tool');
  const toolResponse = await model.sendRequest([initialToolMessage], {
    justification: 'Validate the suspended app-server dynamic-tool bridge.',
    tools: [tool]
  });
  const firstToolParts = await collectParts(toolResponse.stream);
  const toolCalls = firstToolParts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
  assert.equal(toolCalls.length, 1, 'The first invocation must expose exactly one dynamic tool call.');
  assert.equal(toolCalls[0].name, tool.name);

  let toolExecutions = 0;
  toolExecutions += 1;
  const toolResult = new vscode.LanguageModelToolResultPart(toolCalls[0].callId, [
    new vscode.LanguageModelTextPart('README contents')
  ]);
  const resumedResponse = await model.sendRequest([
    initialToolMessage,
    vscode.LanguageModelChatMessage.Assistant([toolCalls[0]]),
    vscode.LanguageModelChatMessage.User([toolResult])
  ], {
    justification: 'Resume the same app-server turn after the caller executes the tool.',
    tools: [tool]
  });
  const resumedParts = await collectParts(resumedResponse.stream);
  assert.equal(collectText(resumedParts), 'Tool result accepted.');
  assert.equal(
    resumedParts.filter((part) => part instanceof vscode.LanguageModelToolCallPart).length,
    0,
    'The suspended tool call must not be emitted twice.'
  );
  assert.equal(toolExecutions, 1, 'The caller must execute the tool exactly once.');

  console.log(`Extension-host app-server test passed for ${extension.id} on VS Code ${vscode.version}.`);
}

async function collectParts(stream) {
  const parts = [];
  for await (const part of stream) {
    parts.push(part);
  }
  return parts;
}

function collectText(parts) {
  return parts
    .filter((part) => part instanceof vscode.LanguageModelTextPart)
    .map((part) => part.value)
    .join('');
}

function requiredEnvironment(name) {
  const value = process.env[name];
  assert(value, `Missing required extension-host test environment variable ${name}.`);
  return value;
}

function normalizePath(value) {
  const resolved = value ? path.resolve(value) : '';
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

module.exports = { run };
