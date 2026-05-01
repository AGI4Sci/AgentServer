import type { SessionUsage } from './session-types.js';
import { normalizeModelProviderUsage } from './model-provider-usage.js';

export type ModelProviderChatMessage = {
  role: string;
  content: unknown;
  [key: string]: unknown;
};

export type OpenAICompatibleTextCompletionResult = {
  text: string;
  usage?: SessionUsage;
  raw?: unknown;
};

export class ModelProviderCallError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'ModelProviderCallError';
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export function resolveChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

export async function callOpenAICompatibleChatCompletions(params: {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<Response> {
  return await fetch(resolveChatCompletionsUrl(params.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey || 'EMPTY'}`,
    },
    body: JSON.stringify({
      ...params.body,
      model: params.model,
    }),
    signal: params.signal,
  });
}

export async function requestOpenAICompatibleTextCompletion(params: {
  baseUrl: string;
  apiKey?: string | null;
  model: string;
  provider?: string | null;
  messages: ModelProviderChatMessage[];
  stream?: boolean;
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
}): Promise<OpenAICompatibleTextCompletionResult> {
  let response: Response;
  try {
    response = await callOpenAICompatibleChatCompletions({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      signal: params.signal,
      body: {
        messages: params.messages,
        stream: params.stream === true,
      },
    });
  } catch (error) {
    throw new ModelProviderCallError(
      `Unable to reach model provider at ${resolveChatCompletionsUrl(params.baseUrl)}: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true },
    );
  }

  if (!response.ok) {
    const responseText = await response.text();
    throw new ModelProviderCallError(
      `HTTP ${response.status} ${response.statusText}: ${responseText}`,
      { retryable: isRetryableHttpStatus(response.status), status: response.status },
    );
  }

  const contentType = response.headers.get('content-type') || '';
  if (!response.body || /application\/json/i.test(contentType)) {
    const responseText = await response.text();
    let payload: any;
    try {
      payload = JSON.parse(responseText);
    } catch (error) {
      throw new ModelProviderCallError(
        `Non-streaming response parse failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: false },
      );
    }
    const providerError = extractProviderApiError(payload);
    if (providerError) {
      throw new ModelProviderCallError(providerError, {
        retryable: isRetryableProviderApiError(providerError),
      });
    }
    const text = extractChatCompletionText(payload?.choices?.[0]);
    if (!text) {
      throw new ModelProviderCallError('Response did not contain assistant text.', { retryable: false });
    }
    const usage = normalizeModelProviderUsage(payload?.usage, {
      provider: params.provider,
      model: params.model,
    });
    params.onTextDelta?.(text);
    return { text, usage, raw: payload };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let collected = '';
  let finalUsage: SessionUsage | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) {
        break;
      }
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) {
        continue;
      }
      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        continue;
      }
      const payload = JSON.parse(data);
      const providerError = extractProviderApiError(payload);
      if (providerError) {
        throw new ModelProviderCallError(providerError, {
          retryable: isRetryableProviderApiError(providerError),
        });
      }
      const usage = normalizeModelProviderUsage(payload?.usage, {
        provider: params.provider,
        model: params.model,
      });
      if (usage) {
        finalUsage = usage;
      }
      const deltaText = extractChatCompletionDelta(payload);
      if (!deltaText) {
        continue;
      }
      collected += deltaText;
      params.onTextDelta?.(deltaText);
    }
  }

  if (!collected.trim()) {
    throw new ModelProviderCallError('Response did not contain assistant text.', { retryable: false });
  }
  return {
    text: collected,
    usage: finalUsage,
  };
}

export function extractProviderApiError(payload: any): string | null {
  const baseResp = payload?.base_resp;
  if (baseResp && typeof baseResp === 'object') {
    const statusCode = Number(baseResp.status_code);
    const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg.trim() : '';
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      return statusMsg ? `API error ${statusCode}: ${statusMsg}` : `API error ${statusCode}`;
    }
  }

  const error = payload?.error;
  if (error && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    const code = typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : '';
    if (message || code) {
      return [code ? `API error ${code}` : 'API error', message].filter(Boolean).join(': ');
    }
  }

  return null;
}

export function isRetryableProviderApiError(message: string | null | undefined): boolean {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('api error 1000')
    || normalized.includes('unknown error, 520')
    || normalized.includes('502')
    || normalized.includes('503')
    || normalized.includes('504')
    || normalized.includes('temporarily unavailable');
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const part = item as { type?: unknown; text?: unknown };
      return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

function extractReasoningText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const part = item as { type?: unknown; reasoning?: unknown; text?: unknown };
      if (part.type === 'reasoning' && typeof part.reasoning === 'string') {
        return part.reasoning;
      }
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

function extractChatCompletionText(choice: any): string {
  const messageContent = extractTextParts(choice?.message?.content);
  if (messageContent) {
    return messageContent;
  }
  if (typeof choice?.message?.reasoning === 'string' && choice.message.reasoning.trim()) {
    return choice.message.reasoning;
  }
  return extractReasoningText(choice?.message?.content);
}

function extractChatCompletionDelta(payload: any): string {
  const choice = payload?.choices?.[0];
  if (!choice) {
    return '';
  }

  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === 'string') {
    return deltaContent;
  }
  const deltaText = extractTextParts(deltaContent);
  if (deltaText) {
    return deltaText;
  }

  if (typeof choice?.delta?.reasoning === 'string' && choice.delta.reasoning) {
    return choice.delta.reasoning;
  }

  return extractChatCompletionText(choice);
}
