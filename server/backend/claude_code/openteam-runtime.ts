import { createInterface } from 'readline';
import { spawn } from 'child_process';
import {
  executeLocalDevPrimitiveCall,
  extractLocalDevPrimitiveCall,
  type LocalDevPrimitiveCall,
} from '../../runtime/shared/local-dev-primitives.js';

type InputMessage = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
};

type ChatCompletionResponse = {
  choices?: Array<{
    delta?: {
      content?: unknown;
    };
    message?: {
      content?: unknown;
    };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type ChatCompletionMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g;
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 120_000;

function parseArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitStatus(
  status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed',
  message?: string,
): void {
  emit({
    type: 'status',
    status,
    ...(message ? { message } : {}),
  });
}

function expandEnvRefs(value: string, env: NodeJS.ProcessEnv, resolving = new Set<string>()): string {
  return value.replace(ENV_REF_PATTERN, (_match, name: string, fallback: string | undefined) => {
    if (resolving.has(name)) {
      return env[name] ?? fallback ?? '';
    }
    const raw = env[name];
    if (raw === undefined) {
      return fallback ?? '';
    }
    resolving.add(name);
    const expanded = expandEnvRefs(raw, env, resolving);
    resolving.delete(name);
    return expanded;
  });
}

function resolveEnvValue(...candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return expandEnvRefs(candidate, process.env).trim();
    }
  }
  return undefined;
}

function extractPrompt(message: InputMessage): string {
  const content = message.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return '';
        }
        const block = item as { type?: unknown; text?: unknown };
        return block.type === 'text' && typeof block.text === 'string' ? block.text : '';
      })
      .join('\n');
  }
  return '';
}

function buildSystemPrompt(): string {
  return [
    'You are OpenTeam Claude Code running inside a local software development runtime.',
    'When real work requires tools, respond with exactly one XML tool block and no extra prose.',
    'Available tools:',
    '<read_file><path>ABSOLUTE_OR_RELATIVE_PATH</path></read_file>',
    '<write_file><path>ABSOLUTE_OR_RELATIVE_PATH</path><content>FULL_FILE_CONTENT</content></write_file>',
    '<list_dir><path>DIRECTORY_PATH</path></list_dir>',
    '<grep_search><path>DIRECTORY_OR_FILE_PATH</path><pattern>TEXT_OR_REGEX</pattern></grep_search>',
    '<run_command><command>SHELL_COMMAND</command></run_command>',
    '<apply_patch><patch>UNIFIED_DIFF_PATCH</patch></apply_patch>',
    '<web_fetch><url>HTTP_OR_HTTPS_URL</url></web_fetch>',
    '<browser_open><url>HTTP_OR_HTTPS_URL</url></browser_open>',
    '<browser_activate><app>APPLICATION_NAME</app></browser_activate>',
    'Rules:',
    '1. Use tools instead of pretending.',
    '2. After a tool result arrives, decide the next action or provide the final answer.',
    '3. Only provide a normal prose answer when the task is complete.',
    '4. Prefer read_file, grep_search, list_dir, write_file, apply_patch, and run_command for software development tasks.',
  ].join('\n');
}

function resolveChatCompletionsUrl(): string {
  const rawBase =
    resolveEnvValue(
      process.env.API_BASE_URL,
      process.env.LLM_BASE_URL,
      process.env.OPENAI_BASE_URL,
      process.env.CLAUDE_CODE_API_BASE_URL,
      process.env.ANTHROPIC_BASE_URL,
    ) ||
    'http://127.0.0.1:18000/v1';

  const base = rawBase.replace(/\/$/, '');
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  if (base.endsWith('/v1')) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function resolveModel(): string {
  return (
    parseArgValue('--model') ||
    resolveEnvValue(
      process.env.LLM_MODEL_NAME,
      process.env.OPENAI_MODEL,
      process.env.OPENTEAM_MODEL,
    ) ||
    'glm-5-fp8'
  );
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n\n${error.stack}` : error.message;
  }
  return String(error);
}

function resolveLlmRequestTimeoutMs(): number {
  const parsed = Number(process.env.OPENTEAM_CLAUDE_CODE_LLM_TIMEOUT_MS || process.env.LLM_REQUEST_TIMEOUT_MS || '');
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_LLM_REQUEST_TIMEOUT_MS;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`LLM request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

function extractStreamDeltaText(payload: ChatCompletionResponse): string {
  const choice = payload.choices?.[0];
  if (!choice) {
    return '';
  }

  const deltaContent = choice.delta?.content;
  if (typeof deltaContent === 'string') {
    return deltaContent;
  }
  const deltaText = extractTextParts(deltaContent);
  if (deltaText) {
    return deltaText;
  }

  return extractTextParts(choice.message?.content);
}

function toSessionUsage(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): { input: number; output: number; total?: number } | undefined {
  if (!usage) {
    return undefined;
  }
  const input = Number(usage.prompt_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens) || (input + output);
  if (input <= 0 && output <= 0 && total <= 0) {
    return undefined;
  }
  return { input, output, total };
}

function mergeSessionUsage(
  current: { input: number; output: number; total?: number } | undefined,
  next: { input: number; output: number; total?: number } | undefined,
): { input: number; output: number; total?: number } | undefined {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    total: (current.total ?? (current.input + current.output)) + (next.total ?? (next.input + next.output)),
  };
}

async function runPrompt(prompt: string): Promise<void> {
  const url = resolveChatCompletionsUrl();
  const apiKey = resolveEnvValue(
    process.env.LLM_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ) || 'EMPTY';
  const model = resolveModel();

  emitStatus('running', `Calling local model ${model}`);
  const { text, usage } = await requestChatCompletionStream(url, apiKey, model, [
    {
      role: 'user',
      content: prompt,
    },
  ]);

  if (!text.trim()) {
    throw new Error('LLM response missing text content.');
  }

  emitStatus('completed', 'Local model completed');
  emit({
    type: 'result',
    output: {
      success: true,
      result: text,
      ...(usage ? { usage } : {}),
    },
    ...(usage ? { usage } : {}),
  });
}

async function requestChatCompletion(
  url: string,
  apiKey: string,
  model: string,
  messages: ChatCompletionMessage[],
): Promise<ChatCompletionResponse> {
  const timeoutMs = resolveLlmRequestTimeoutMs();
  const requestBody = JSON.stringify({
    model,
    messages,
    stream: false,
  });

  try {
    return await requestChatCompletionWithCurl(url, apiKey, requestBody, timeoutMs);
  } catch (error) {
    emitStatus('running', `curl request failed, falling back to fetch: ${formatError(error)}`);
  }

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: requestBody,
  }, timeoutMs);

  const payload = (await response.json()) as ChatCompletionResponse;
  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function requestChatCompletionStream(
  url: string,
  apiKey: string,
  model: string,
  messages: ChatCompletionMessage[],
): Promise<{ text: string; usage?: { input: number; output: number; total?: number } }> {
  const timeoutMs = resolveLlmRequestTimeoutMs();
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: {
        include_usage: true,
      },
    }),
  }, timeoutMs);

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = await response.text();
    }
    throw new Error(`LLM request failed: ${response.status} ${JSON.stringify(payload)}`);
  }

  if (!response.body) {
    const payload = (await response.json()) as ChatCompletionResponse;
    const text = extractTextParts(payload.choices?.[0]?.message?.content);
    if (text) {
      emit({ type: 'text-delta', text });
      return { text, usage: toSessionUsage(payload.usage) };
    }
    throw new Error(`LLM response missing text content: ${JSON.stringify(payload)}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  let collected = '';
  let usage: { input: number; output: number; total?: number } | undefined;

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

      const payload = JSON.parse(data) as ChatCompletionResponse;
      const nextUsage = toSessionUsage(payload.usage);
      if (nextUsage) {
        usage = nextUsage;
      }
      const deltaText = extractStreamDeltaText(payload);
      if (deltaText) {
        collected += deltaText;
        emit({
          type: 'text-delta',
          text: deltaText,
        });
      }
    }
  }

  if (!collected.trim()) {
    const payload = await requestChatCompletion(url, apiKey, model, messages);
    const text = extractTextParts(payload.choices?.[0]?.message?.content);
    if (text) {
      emit({ type: 'text-delta', text });
      return { text, usage: toSessionUsage(payload.usage) };
    }
    throw new Error(`LLM response missing text content: ${JSON.stringify(payload)}`);
  }

  return { text: collected, usage };
}

async function runToolLoop(prompt: string): Promise<void> {
  const url = resolveChatCompletionsUrl();
  const apiKey = resolveEnvValue(
    process.env.LLM_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
  ) || 'EMPTY';
  const model = resolveModel();
  const cwd = process.cwd();
  const messages: ChatCompletionMessage[] = [
    {
      role: 'system',
      content: buildSystemPrompt(),
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  emitStatus('running', `Calling local model ${model}`);
  let aggregatedUsage: { input: number; output: number; total?: number } | undefined;

  for (let step = 0; step < 12; step += 1) {
    const payload = await requestChatCompletion(url, apiKey, model, messages);
    aggregatedUsage = mergeSessionUsage(aggregatedUsage, toSessionUsage(payload.usage));
    const assistantText = extractTextParts(payload.choices?.[0]?.message?.content);
    if (!assistantText.trim()) {
      throw new Error(`LLM response missing text content: ${JSON.stringify(payload)}`);
    }
    const toolCall = extractLocalDevPrimitiveCall(assistantText);
    messages.push({
      role: 'assistant',
      content: assistantText,
    });

    if (!toolCall) {
      const finalText = assistantText.trim();
      emit({ type: 'text-delta', text: finalText });
      emitStatus('completed', 'Local model completed');
      emit({
        type: 'result',
        output: {
          success: true,
          result: finalText,
          ...(aggregatedUsage ? { usage: aggregatedUsage } : {}),
        },
        ...(aggregatedUsage ? { usage: aggregatedUsage } : {}),
      });
      return;
    }

    emit({
      type: 'tool-call',
      toolName: toolCall.toolName,
      detail: JSON.stringify(toolCall.args),
    });
    const toolResult = await executeLocalDevPrimitive(toolCall, cwd);
    emit({
      type: 'tool-result',
      toolName: toolCall.toolName,
      detail: toolResult.ok ? 'success' : 'failure',
      output: toolResult.output,
    });
    messages.push({
      role: 'user',
      content: [
        `Tool result for ${toolCall.toolName}:`,
        toolResult.ok ? 'STATUS: success' : 'STATUS: failure',
        toolResult.output,
        'Continue using tools if needed, otherwise provide the final answer.',
      ].join('\n\n'),
    });
  }

  throw new Error('Tool loop exceeded 12 steps without reaching a final answer.');
}

async function executeLocalDevPrimitive(
  toolCall: LocalDevPrimitiveCall,
  cwd: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    return await executeLocalDevPrimitiveCall(toolCall, { cwd });
  } catch (error) {
    return {
      ok: false,
      output: formatError(error),
    };
  }
}

async function requestChatCompletionWithCurl(
  url: string,
  apiKey: string,
  requestBody: string,
  timeoutMs: number,
): Promise<ChatCompletionResponse> {
  return await new Promise<ChatCompletionResponse>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`curl LLM request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const child = spawn(
      'curl',
      [
        '-sS',
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        url,
        '-H',
        'Content-Type: application/json',
        '-H',
        `Authorization: Bearer ${apiKey}`,
        '-d',
        requestBody,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      if (settled) {
        return;
      }
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      if (settled) {
        return;
      }
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`curl exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout) as ChatCompletionResponse);
      } catch (error) {
        reject(
          new Error(
            `Failed to parse curl response: ${formatError(error)}\n\n${stdout}`,
          ),
        );
      }
    });
  });
}

async function main(): Promise<void> {
  emitStatus('starting', 'OpenTeam Claude Code runtime ready');

  const reader = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let message: InputMessage;
    try {
      message = JSON.parse(trimmed) as InputMessage;
    } catch (error) {
      emitStatus('failed', `Invalid input JSON: ${formatError(error)}`);
      emit({
        type: 'result',
        output: {
          success: false,
          error: `Invalid input JSON: ${formatError(error)}`,
        },
      });
      continue;
    }

    if (message.type !== 'user') {
      continue;
    }

    const prompt = extractPrompt(message);
    if (!prompt.trim()) {
      emit({
        type: 'result',
        output: {
          success: false,
          error: 'User message content is empty.',
        },
      });
      continue;
    }

    try {
      await runToolLoop(prompt);
    } catch (error) {
      const formatted = formatError(error);
      emitStatus('failed', formatted);
      emit({
        type: 'result',
        output: {
          success: false,
          error: formatted,
        },
      });
    }
  }
}

void main().catch((error) => {
  const formatted = formatError(error);
  emitStatus('failed', formatted);
  emit({
    type: 'result',
    output: {
      success: false,
      error: formatted,
    },
  });
  process.exitCode = 1;
});
