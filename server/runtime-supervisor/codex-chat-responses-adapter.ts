import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';

type JsonRecord = Record<string, any>;

type StoredConversation = {
  id: string;
  messages: JsonRecord[];
  createdAt: number;
};

type PreparedChatRequest = {
  chatRequest: JsonRecord;
  messages: JsonRecord[];
};

type SyntheticResponse = {
  responseId: string;
  events: Array<{ event: string; data: JsonRecord }>;
  storedConversation: StoredConversation;
};

const DEFAULT_SUPERVISOR_PORT = loadOpenTeamConfig().runtime.supervisor.port;
const conversationStore = new Map<string, StoredConversation>();
const MAX_STORED_CONVERSATIONS = Math.max(
  32,
  loadOpenTeamConfig().runtime.codex.responseStoreLimit,
);
const ADAPTER_LOG_PATH = join(process.cwd(), 'tmp', 'codex-chat-responses-adapter.log');

function resolveUpstreamBaseUrl(): string | null {
  return loadOpenTeamConfig().llm.baseUrl;
}

function resolveUpstreamApiKey(): string {
  return loadOpenTeamConfig().llm.apiKey;
}

function resolveDefaultModel(): string {
  return loadOpenTeamConfig().llm.model;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function pruneConversationStore(): void {
  if (conversationStore.size <= MAX_STORED_CONVERSATIONS) {
    return;
  }
  const entries = Array.from(conversationStore.values())
    .sort((left, right) => left.createdAt - right.createdAt);
  const overflow = conversationStore.size - MAX_STORED_CONVERSATIONS;
  for (const entry of entries.slice(0, overflow)) {
    conversationStore.delete(entry.id);
  }
}

function logAdapterEvent(label: string, payload: JsonRecord): void {
  try {
    mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
    appendFileSync(
      ADAPTER_LOG_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        label,
        payload,
      })}\n`,
      'utf8',
    );
  } catch {
    // Ignore logging failures to avoid breaking runtime traffic.
  }
}

function cloneMessages(messages: JsonRecord[]): JsonRecord[] {
  return messages.map((message) => JSON.parse(JSON.stringify(message)) as JsonRecord);
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (Array.isArray(output)) {
    const text = output
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        const candidate = item as { type?: unknown; text?: unknown };
        return typeof candidate.text === 'string' ? candidate.text : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) {
      return text;
    }
  }
  if (output == null) {
    return '';
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function normalizeChatContent(content: unknown): string | JsonRecord[] {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  const parts = content
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null as JsonRecord | null;
      }
      const part = item as { type?: unknown; text?: unknown; image_url?: unknown };
      if (part.type === 'input_text' || part.type === 'output_text') {
        return typeof part.text === 'string'
          ? { type: 'text', text: part.text }
          : null as JsonRecord | null;
      }
      if (part.type === 'input_image' && typeof part.image_url === 'string') {
        return {
          type: 'image_url',
          image_url: { url: part.image_url },
        } as JsonRecord;
      }
      return null as JsonRecord | null;
    })
    .filter((item) => item !== null) as JsonRecord[];

  if (parts.length === 0) {
    return '';
  }
  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => String(part.text || '')).join('');
  }
  return parts;
}

function normalizeChatRole(role: unknown): string {
  if (role === 'system' || role === 'assistant' || role === 'user' || role === 'tool' || role === 'function') {
    return role;
  }
  if (role === 'developer') {
    return 'system';
  }
  return 'user';
}

function translateResponsesTools(tools: unknown): JsonRecord[] | undefined {
  if (!Array.isArray(tools)) {
    return undefined;
  }
  const translated = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') {
        return null;
      }
      const record = tool as JsonRecord;
      if (record.type !== 'function' || typeof record.name !== 'string') {
        return null;
      }
      return {
        type: 'function',
        function: {
          name: record.name,
          description: typeof record.description === 'string' ? record.description : undefined,
          parameters: record.parameters && typeof record.parameters === 'object' ? record.parameters : undefined,
          strict: typeof record.strict === 'boolean' ? record.strict : undefined,
        },
      } as JsonRecord;
    })
    .filter((tool) => tool !== null) as JsonRecord[];

  return translated.length > 0 ? translated : undefined;
}

function appendInputItems(messages: JsonRecord[], input: unknown): void {
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return;
  }
  if (!Array.isArray(input)) {
    return;
  }

  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as JsonRecord;
    if (record.type === 'message') {
      messages.push({
        role: normalizeChatRole(record.role),
        content: normalizeChatContent(record.content),
      });
      continue;
    }
    if (
      record.type === 'function_call_output'
      || record.type === 'custom_tool_call_output'
      || record.type === 'mcp_tool_call_output'
      || record.type === 'tool_search_output'
    ) {
      messages.push({
        role: 'tool',
        tool_call_id: typeof record.call_id === 'string' ? record.call_id : randomUUID(),
        content: stringifyToolOutput(record.output ?? record.tools ?? ''),
      });
    }
  }
}

export function buildChatCompletionsRequest(
  requestBody: JsonRecord,
  previousConversation?: StoredConversation | null,
): PreparedChatRequest {
  const messages = previousConversation ? cloneMessages(previousConversation.messages) : [];
  const instructions = typeof requestBody.instructions === 'string' ? requestBody.instructions.trim() : '';
  if (instructions) {
    if (messages[0]?.role === 'system') {
      messages[0] = { role: 'system', content: instructions };
    } else {
      messages.unshift({ role: 'system', content: instructions });
    }
  }

  appendInputItems(messages, requestBody.input);

  const chatRequest: JsonRecord = {
    model: typeof requestBody.model === 'string' && requestBody.model.trim()
      ? requestBody.model.trim()
      : resolveDefaultModel(),
    messages,
    stream: false,
  };

  const tools = translateResponsesTools(requestBody.tools);
  if (tools) {
    chatRequest.tools = tools;
  }
  if (typeof requestBody.parallel_tool_calls === 'boolean') {
    chatRequest.parallel_tool_calls = requestBody.parallel_tool_calls;
  }
  if (typeof requestBody.tool_choice === 'string' || (requestBody.tool_choice && typeof requestBody.tool_choice === 'object')) {
    chatRequest.tool_choice = requestBody.tool_choice;
  }
  if (typeof requestBody.temperature === 'number') {
    chatRequest.temperature = requestBody.temperature;
  }
  if (typeof requestBody.max_output_tokens === 'number') {
    chatRequest.max_tokens = requestBody.max_output_tokens;
  }

  return {
    chatRequest,
    messages,
  };
}

function extractAssistantText(content: unknown): string {
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
      const record = item as { type?: unknown; text?: unknown };
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('');
}

function normalizeChatToolCalls(toolCalls: unknown): JsonRecord[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== 'object') {
        return null;
      }
      const record = toolCall as JsonRecord;
      const fn = record.function && typeof record.function === 'object' ? record.function as JsonRecord : null;
      if (!fn || typeof fn.name !== 'string') {
        return null;
      }
      return {
        id: typeof record.id === 'string' ? record.id : `call_${randomUUID()}`,
        type: 'function',
        function: {
          name: fn.name,
          arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
        },
      } as JsonRecord;
    })
    .filter((toolCall) => toolCall !== null) as JsonRecord[];
}

function buildResponseUsage(chatUsage: JsonRecord | undefined): JsonRecord | undefined {
  if (!chatUsage || typeof chatUsage !== 'object') {
    return undefined;
  }
  const promptTokens = Number(chatUsage.prompt_tokens) || 0;
  const completionTokens = Number(chatUsage.completion_tokens) || 0;
  const totalTokens = Number(chatUsage.total_tokens) || (promptTokens + completionTokens);
  return {
    input_tokens: promptTokens,
    input_tokens_details: {
      cached_tokens: 0,
    },
    output_tokens: completionTokens,
    output_tokens_details: {
      reasoning_tokens: 0,
    },
    total_tokens: totalTokens,
  };
}

export function buildSyntheticResponsesFromChatCompletion(
  requestBody: JsonRecord,
  prepared: PreparedChatRequest,
  chatPayload: JsonRecord,
): SyntheticResponse {
  const choice = Array.isArray(chatPayload.choices) ? chatPayload.choices[0] as JsonRecord | undefined : undefined;
  const message = choice?.message && typeof choice.message === 'object' ? choice.message as JsonRecord : {};
  const assistantText = extractAssistantText(message.content);
  const toolCalls = normalizeChatToolCalls(message.tool_calls);
  const responseId = `resp_${randomUUID()}`;
  const messageItemId = `msg_${randomUUID()}`;
  const events: SyntheticResponse['events'] = [];

  events.push({
    event: 'response.created',
    data: {
      type: 'response.created',
      response: {
        id: responseId,
        model: typeof chatPayload.model === 'string' ? chatPayload.model : prepared.chatRequest.model,
        status: 'in_progress',
      },
    },
  });

  if (assistantText) {
    events.push({
      event: 'response.output_item.added',
      data: {
        type: 'response.output_item.added',
        item: {
          id: messageItemId,
          type: 'message',
          role: 'assistant',
          content: [],
        },
      },
    });
    events.push({
      event: 'response.output_text.delta',
      data: {
        type: 'response.output_text.delta',
        delta: assistantText,
      },
    });
    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item: {
          id: messageItemId,
          type: 'message',
          role: 'assistant',
          // Codex app-server surfaces both output_text.delta and the completed
          // message item as text-bearing notifications. Keep the full text in
          // the delta path only so downstream finalText aggregation does not
          // duplicate assistant output.
          content: [],
        },
      },
    });
  }

  for (const toolCall of toolCalls) {
    events.push({
      event: 'response.output_item.done',
      data: {
        type: 'response.output_item.done',
        item: {
          id: `fc_${randomUUID()}`,
          type: 'function_call',
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
          call_id: toolCall.id,
        },
      },
    });
  }

  events.push({
    event: 'response.completed',
    data: {
      type: 'response.completed',
      response: {
        id: responseId,
        model: typeof chatPayload.model === 'string' ? chatPayload.model : prepared.chatRequest.model,
        status: 'completed',
        usage: buildResponseUsage(chatPayload.usage),
      },
    },
  });

  const assistantHistoryMessage: JsonRecord = {
    role: 'assistant',
    content: assistantText,
  };
  if (toolCalls.length > 0) {
    assistantHistoryMessage.tool_calls = toolCalls;
  }

  const storedConversation: StoredConversation = {
    id: responseId,
    createdAt: Date.now(),
    messages: [
      ...cloneMessages(prepared.messages),
      assistantHistoryMessage,
    ],
  };

  return {
    responseId,
    events,
    storedConversation,
  };
}

function writeSse(res: ServerResponse, event: string, data: JsonRecord): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleCodexChatResponsesAdapter(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const rawUrl = req.url || '/';
  const method = req.method || 'GET';
  const parsedUrl = new URL(rawUrl, `http://127.0.0.1:${DEFAULT_SUPERVISOR_PORT}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

  if (pathname !== '/codex/v1/responses') {
    return false;
  }
  if (method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Method not allowed: ${method}` } }));
    return true;
  }

  const upstreamBaseUrl = resolveUpstreamBaseUrl();
  if (!upstreamBaseUrl) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'LLM base URL is not configured.' } }));
    return true;
  }

  let requestBody: JsonRecord;
  try {
    requestBody = JSON.parse(await readBody(req) || '{}') as JsonRecord;
  } catch (error) {
    logAdapterEvent('invalid_json', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }));
    return true;
  }

  const previousId = typeof requestBody.previous_response_id === 'string'
    ? requestBody.previous_response_id
    : null;
  const previousConversation = previousId ? conversationStore.get(previousId) || null : null;
  const prepared = buildChatCompletionsRequest(requestBody, previousConversation);
  logAdapterEvent('request_received', {
    model: prepared.chatRequest.model,
    previousResponseId: previousId,
    toolCount: Array.isArray(prepared.chatRequest.tools) ? prepared.chatRequest.tools.length : 0,
    toolNames: Array.isArray(prepared.chatRequest.tools)
      ? prepared.chatRequest.tools
        .map((tool) => {
          if (!tool || typeof tool !== 'object') {
            return null;
          }
          const record = tool as JsonRecord;
          const fn = record.function && typeof record.function === 'object' ? record.function as JsonRecord : null;
          return typeof fn?.name === 'string' ? fn.name : null;
        })
        .filter((name): name is string => typeof name === 'string')
        .slice(0, 20)
      : [],
    messageCount: Array.isArray(prepared.chatRequest.messages) ? prepared.chatRequest.messages.length : 0,
  });

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(resolveChatCompletionsUrl(upstreamBaseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${resolveUpstreamApiKey()}`,
      },
      body: JSON.stringify(prepared.chatRequest),
    });
  } catch (error) {
    logAdapterEvent('upstream_fetch_failed', {
      error: error instanceof Error ? error.message : String(error),
      model: prepared.chatRequest.model,
      toolCount: Array.isArray(prepared.chatRequest.tools) ? prepared.chatRequest.tools.length : 0,
      messageCount: Array.isArray(prepared.chatRequest.messages) ? prepared.chatRequest.messages.length : 0,
    });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream chat.completions request failed: ${error instanceof Error ? error.message : String(error)}` } }));
    return true;
  }

  const rawText = await upstreamResponse.text();
  if (!upstreamResponse.ok) {
    logAdapterEvent('upstream_not_ok', {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      bodyPreview: rawText.slice(0, 2000),
      model: prepared.chatRequest.model,
      toolCount: Array.isArray(prepared.chatRequest.tools) ? prepared.chatRequest.tools.length : 0,
      messageCount: Array.isArray(prepared.chatRequest.messages) ? prepared.chatRequest.messages.length : 0,
    });
    res.writeHead(upstreamResponse.status, { 'Content-Type': upstreamResponse.headers.get('content-type') || 'application/json' });
    res.end(rawText);
    return true;
  }

  let chatPayload: JsonRecord;
  try {
    chatPayload = JSON.parse(rawText) as JsonRecord;
  } catch (error) {
    logAdapterEvent('upstream_invalid_json', {
      error: error instanceof Error ? error.message : String(error),
      bodyPreview: rawText.slice(0, 2000),
      model: prepared.chatRequest.model,
      toolCount: Array.isArray(prepared.chatRequest.tools) ? prepared.chatRequest.tools.length : 0,
      messageCount: Array.isArray(prepared.chatRequest.messages) ? prepared.chatRequest.messages.length : 0,
    });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Upstream chat.completions returned invalid JSON: ${error instanceof Error ? error.message : String(error)}` } }));
    return true;
  }

  const synthetic = buildSyntheticResponsesFromChatCompletion(requestBody, prepared, chatPayload);
  conversationStore.set(synthetic.responseId, synthetic.storedConversation);
  pruneConversationStore();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'openai-model': typeof chatPayload.model === 'string' ? chatPayload.model : prepared.chatRequest.model,
  });
  for (const frame of synthetic.events) {
    writeSse(res, frame.event, frame.data);
  }
  res.end();
  return true;
}

export function getCodexAdapterBaseUrl(): string {
  return loadOpenTeamConfig().runtime.codex.responsesBaseUrl?.trim()
    || `http://localhost:${DEFAULT_SUPERVISOR_PORT}/codex/v1`;
}

export function resetCodexConversationStore(): void {
  conversationStore.clear();
}
