/**
 * Minimal app-server wire shapes used by vsCodex.
 *
 * These types intentionally describe only fields that the extension sends or
 * consumes. Runtime validators remain authoritative at every protocol
 * boundary so newer app-server versions may add optional fields safely.
 */
export type JsonValue =
  | number
  | string
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | null;

export type RequestId = string | number;
export type ImageDetail = 'auto' | 'low' | 'high' | 'original';

export type ContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: ImageDetail }
  | { type: 'output_text'; text: string };

export type FunctionCallOutputContentItem =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: ImageDetail }
  | { type: 'encrypted_content'; encrypted_content: string };

export type ResponseItem =
  | {
    type: 'message';
    id?: string;
    role: string;
    content: ContentItem[];
    phase?: string;
  }
  | {
    type: 'function_call';
    id?: string;
    name: string;
    namespace?: string;
    arguments: string;
    call_id: string;
  }
  | {
    type: 'function_call_output';
    id?: string;
    call_id: string;
    output: string | FunctionCallOutputContentItem[];
  };

export type UserInput =
  | { type: 'text'; text: string; text_elements: unknown[] }
  | { type: 'image'; detail?: ImageDetail; url: string }
  | { type: 'localImage'; detail?: ImageDetail; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: JsonValue;
}

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

export type DynamicToolSpec = {
  type: 'function';
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
};
