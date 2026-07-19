import * as vscode from 'vscode';
import type {
  ContentItem,
  DynamicToolCallOutputContentItem,
  FunctionCallOutputContentItem,
  ResponseItem,
  UserInput
} from './appServer/wireTypes';

export type ResponsesInputMessage = Extract<ResponseItem, {
  type: 'message' | 'function_call' | 'function_call_output';
}>;
type ResponseFunctionCallOutputItem = FunctionCallOutputContentItem;
type ResponseFunctionCallOutputItemList = FunctionCallOutputContentItem[];
type ResponseInputImage = Extract<ContentItem, { type: 'input_image' }>;
type ResponseInputImageContent = Extract<FunctionCallOutputContentItem, { type: 'input_image' }>;
type ResponseInputMessageContentList = ContentItem[];
type ResponseInputTextContent = Extract<FunctionCallOutputContentItem, { type: 'input_text' }>;

interface LanguageModelDataPartLike {
  readonly data: Uint8Array;
  readonly mimeType: string;
}

type VSCodeWithDataPart = typeof vscode & {
  readonly LanguageModelDataPart?: abstract new (...args: never[]) => LanguageModelDataPartLike;
};

const textDecoder = new TextDecoder();
const USAGE_DATA_PART_MIME = 'usage';
const CACHE_CONTROL_DATA_PART_MIME = 'cache_control';
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i;

export function convertMessagesToResponsesInput(messages: readonly vscode.LanguageModelChatRequestMessage[]): ResponsesInputMessage[] {
  return messages.flatMap((message) => convertMessageToResponsesInput(message));
}

export function estimateTokenCount(value: string | vscode.LanguageModelChatRequestMessage): number {
  if (typeof value === 'string') {
    return Math.ceil(value.length / 4);
  }

  const serialized = JSON.stringify(convertMessagesToResponsesInput([value]));
  return serialized === '[]' ? 0 : Math.max(1, Math.ceil(serialized.length / 4));
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortForStableSerialization(value));
}

export function projectResponsesInputForContinuation(
  input: readonly ResponsesInputMessage[]
): ResponsesInputMessage[] {
  return input.filter((item) => {
    if (item.type === 'function_call_output') {
      return true;
    }

    return item.type === 'message' && item.role === 'user';
  });
}

export function getTextFromMessage(message: vscode.LanguageModelChatRequestMessage): string {
  return message.content
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }

      if (isLanguageModelDataPart(part)) {
        return serializeDataPart(part);
      }

      return '';
    })
    .join('');
}

export function convertMessageToUserInput(message: vscode.LanguageModelChatRequestMessage): UserInput[] {
  const input: UserInput[] = [];
  let text = '';

  const flushText = () => {
    if (!text) {
      return;
    }
    input.push({ type: 'text', text, text_elements: [] });
    text = '';
  };

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseMessageImageDataUrl(part.value);
      if (image?.image_url) {
        flushText();
        input.push({ type: 'image', url: image.image_url, detail: image.detail });
      } else {
        text += part.value;
      }
      continue;
    }

    if (isLanguageModelDataPart(part)) {
      const image = dataPartToMessageImage(part);
      if (image?.image_url) {
        flushText();
        input.push({ type: 'image', url: image.image_url, detail: image.detail });
      } else {
        text += serializeDataPart(part);
      }
    }
  }

  flushText();
  return input;
}

export function convertToolResultToDynamicContent(
  result: vscode.LanguageModelToolResultPart
): DynamicToolCallOutputContentItem[] {
  const contentItems: DynamicToolCallOutputContentItem[] = [];

  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseMessageImageDataUrl(part.value);
      if (image?.image_url) {
        contentItems.push({ type: 'inputImage', imageUrl: image.image_url });
      } else {
        contentItems.push({ type: 'inputText', text: part.value });
      }
      continue;
    }

    if (isLanguageModelDataPart(part)) {
      const image = dataPartToMessageImage(part);
      if (image?.image_url) {
        contentItems.push({ type: 'inputImage', imageUrl: image.image_url });
      } else {
        contentItems.push({ type: 'inputText', text: serializeDataPart(part) });
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelPromptTsxPart) {
      contentItems.push({ type: 'inputText', text: stableJsonStringify(part.value) });
      continue;
    }

    contentItems.push({ type: 'inputText', text: stableJsonStringify(part) });
  }

  return contentItems;
}

function convertMessageToResponsesInput(message: vscode.LanguageModelChatRequestMessage): ResponsesInputMessage[] {
  const items: ResponsesInputMessage[] = [];
  const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant';
  let bufferedText = '';
  let bufferedContent: ResponseInputMessageContentList = [];

  const flushText = () => {
    if (!bufferedText.trim()) {
      bufferedText = '';
      return;
    }

    bufferedContent.push(role === 'user'
      ? { type: 'input_text', text: bufferedText }
      : { type: 'output_text', text: bufferedText });

    bufferedText = '';
  };

  const flushMessage = () => {
    flushText();

    if (bufferedContent.length === 0) {
      return;
    }

    items.push({
      role,
      content: bufferedContent,
      type: 'message'
    });

    bufferedContent = [];
  };

  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseMessageImageDataUrl(part.value);
      if (image) {
        flushText();
        bufferedContent.push(image);
        continue;
      }

      bufferedText += part.value;
      continue;
    }

    if (isLanguageModelDataPart(part)) {
      const image = dataPartToMessageImage(part);
      if (image) {
        flushText();
        bufferedContent.push(image);
        continue;
      }

      const serialized = serializeDataPart(part);
      if (serialized.length > 0) {
        bufferedText += serialized;
      }
      continue;
    }

    if (part instanceof vscode.LanguageModelToolCallPart) {
      flushMessage();
      items.push({
        type: 'function_call',
        call_id: part.callId,
        name: part.name,
        arguments: stableJsonStringify(part.input ?? {})
      });
      continue;
    }

    if (part instanceof vscode.LanguageModelToolResultPart) {
      flushMessage();
      items.push({
        type: 'function_call_output',
        call_id: part.callId,
        output: serializeToolResultContent(part.content)
      });
    }
  }

  flushMessage();
  return items;
}

function serializeToolResultContent(content: readonly unknown[]): string | ResponseFunctionCallOutputItemList {
  const outputItems: ResponseFunctionCallOutputItemList = [];
  const textSegments: string[] = [];

  const flushTextSegments = () => {
    if (textSegments.length === 0) {
      return;
    }

    outputItems.push({
      type: 'input_text',
      text: textSegments.join('\n\n')
    });
    textSegments.length = 0;
  };

  for (const part of content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      const image = tryParseToolOutputImageDataUrl(part.value);
      if (image) {
        flushTextSegments();
        outputItems.push(image);
        continue;
      }

      if (part.value.length > 0) {
        textSegments.push(part.value);
      }
      continue;
    }

    if (isLanguageModelDataPart(part)) {
      const image = dataPartToToolOutputImage(part);
      if (image) {
        flushTextSegments();
        outputItems.push(image);
        continue;
      }

      const serialized = serializeDataPart(part);
      if (serialized.length > 0) {
        textSegments.push(serialized);
      }
      continue;
    }

    const serialized = stableJsonStringify(part);
    if (serialized.length > 0) {
      textSegments.push(serialized);
    }
  }

  flushTextSegments();

  if (outputItems.length === 0) {
    return '';
  }

  if (outputItems.every((item) => item.type === 'input_text')) {
    return outputItems
      .map((item) => (item as ResponseInputTextContent).text)
      .join('\n\n');
  }

  return outputItems;
}

function serializeDataPart(part: LanguageModelDataPartLike): string {
  const mimeType = part.mimeType.toLowerCase();

  if (mimeType === USAGE_DATA_PART_MIME || mimeType === CACHE_CONTROL_DATA_PART_MIME) {
    return '';
  }

  if (mimeType.startsWith('text/') || mimeType.includes('json') || mimeType.includes('xml') || mimeType.includes('javascript')) {
    return textDecoder.decode(part.data);
  }

  return `[binary data: ${part.mimeType}, ${part.data.byteLength} bytes]`;
}

function dataPartToMessageImage(part: LanguageModelDataPartLike): ResponseInputImage | undefined {
  if (!part.mimeType.toLowerCase().startsWith('image/') || part.data.byteLength === 0) {
    return undefined;
  }

  return {
    detail: 'auto',
    type: 'input_image',
    image_url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`
  };
}

function dataPartToToolOutputImage(part: LanguageModelDataPartLike): ResponseInputImageContent | undefined {
  const image = dataPartToMessageImage(part);
  if (!image) {
    return undefined;
  }

  return {
    type: image.type,
    detail: image.detail,
    image_url: image.image_url
  };
}

function tryParseMessageImageDataUrl(value: string): ResponseInputImage | undefined {
  const trimmed = value.trim();
  if (!IMAGE_DATA_URL_PATTERN.test(trimmed)) {
    return undefined;
  }

  return {
    detail: 'auto',
    type: 'input_image',
    image_url: trimmed
  };
}

function isLanguageModelDataPart(value: unknown): value is LanguageModelDataPartLike {
  const DataPart = (vscode as VSCodeWithDataPart).LanguageModelDataPart;
  if (typeof DataPart === 'function' && value instanceof DataPart) {
    return true;
  }
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.mimeType === 'string' && record.data instanceof Uint8Array;
}

function tryParseToolOutputImageDataUrl(value: string): ResponseInputImageContent | undefined {
  const image = tryParseMessageImageDataUrl(value);
  if (!image) {
    return undefined;
  }

  return {
    type: image.type,
    detail: image.detail,
    image_url: image.image_url
  };
}

function stableJsonStringify(value: unknown): string {
  try {
    return stableSerialize(value);
  } catch {
    return String(value);
  }
}

function sortForStableSerialization(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableSerialization(item));
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortForStableSerialization(entryValue)]);

    return Object.fromEntries(entries);
  }

  return value;
}
