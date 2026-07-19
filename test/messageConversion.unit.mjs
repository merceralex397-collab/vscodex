import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-message-conversion-'));
const bundlePath = path.join(temporaryDirectory, 'message-conversion.cjs');
const require = createRequire(import.meta.url);
const originalLoad = Module._load;

class TextPart {
  constructor(value) {
    this.value = value;
  }
}

class DataPart {
  constructor(data, mimeType) {
    this.data = data;
    this.mimeType = mimeType;
  }
}

class ToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

class ToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

class PromptTsxPart {
  constructor(value) {
    this.value = value;
  }
}

const vscodeStub = {
  LanguageModelTextPart: TextPart,
  LanguageModelDataPart: DataPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelPromptTsxPart: PromptTsxPart,
  LanguageModelChatMessageRole: {
    User: 1,
    Assistant: 2
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
    stdin: {
      contents: [
        "export * from './src/convertMessages.ts';",
        "export { convertToolResultContent } from './src/appServer/toolBridge.ts';"
      ].join('\n'),
      resolveDir: repositoryRoot,
      sourcefile: 'message-conversion-entry.ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    outfile: bundlePath,
    external: ['vscode']
  });

  const conversion = require(bundlePath);
  const imageBytes = Uint8Array.from([1, 2, 3]);
  const userMessage = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [
      new TextPart('hello'),
      new DataPart(imageBytes, 'image/png'),
      new DataPart(new TextEncoder().encode('{"answer":42}'), 'application/json')
    ]
  };
  const assistantMessage = {
    role: vscodeStub.LanguageModelChatMessageRole.Assistant,
    content: [
      new TextPart('calling now'),
      new ToolCallPart('call-1', 'workspace/read_file', { path: 'README.md', line: 1 })
    ]
  };
  const toolResult = new ToolResultPart('call-1', [
    new TextPart('file contents'),
    new DataPart(imageBytes, 'image/png')
  ]);
  const resultMessage = {
    role: vscodeStub.LanguageModelChatMessageRole.User,
    content: [toolResult]
  };

  const fullHistory = conversion.convertMessagesToResponsesInput([
    userMessage,
    assistantMessage,
    resultMessage
  ]);
  assert.equal(fullHistory.length, 4);
  assert.deepEqual(fullHistory[0], {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'hello' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQID' },
      { type: 'input_text', text: '{"answer":42}' }
    ]
  });
  assert.deepEqual(fullHistory[1], {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'calling now' }]
  });
  assert.deepEqual(fullHistory[2], {
    type: 'function_call',
    call_id: 'call-1',
    name: 'workspace/read_file',
    arguments: '{"line":1,"path":"README.md"}'
  });
  assert.deepEqual(fullHistory[3], {
    type: 'function_call_output',
    call_id: 'call-1',
    output: [
      { type: 'input_text', text: 'file contents' },
      { type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,AQID' }
    ]
  });

  assert.deepEqual(conversion.projectResponsesInputForContinuation(fullHistory), [
    fullHistory[0],
    fullHistory[3]
  ]);
  assert.deepEqual(conversion.convertMessageToUserInput(userMessage), [
    { type: 'text', text: 'hello', text_elements: [] },
    { type: 'image', url: 'data:image/png;base64,AQID', detail: 'auto' },
    { type: 'text', text: '{"answer":42}', text_elements: [] }
  ]);
  assert(conversion.estimateTokenCount(userMessage) > 0);

  const dynamicContent = conversion.convertToolResultContent([
    new TextPart('plain text'),
    new DataPart(new TextEncoder().encode('{"b":2}'), 'application/json'),
    new PromptTsxPart({ b: 2, a: 1 }),
    { custom: true },
    new DataPart(imageBytes, 'image/png')
  ]);
  assert.deepEqual(dynamicContent, [
    { type: 'inputText', text: 'plain text' },
    { type: 'inputText', text: '{"b":2}' },
    { type: 'inputText', text: '{"a":1,"b":2}' },
    { type: 'inputText', text: '{"custom":true}' },
    { type: 'inputImage', imageUrl: 'data:image/png;base64,AQID' }
  ]);

  console.log('Message and tool-result conversion tests passed.');
} finally {
  Module._load = originalLoad;
  await rm(temporaryDirectory, { recursive: true, force: true });
}
