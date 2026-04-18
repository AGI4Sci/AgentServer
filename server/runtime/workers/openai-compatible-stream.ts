import type { SessionOutput, SessionUsage } from '../session-types.js';
import type { WorkerRunRequest } from '../team-worker-types.js';
import {
  resolveRuntimeBackendConnection,
  resolveRuntimeBackendConnectionCandidates,
} from './runtime-backend-config.js';

type DirectStreamHooks = {
  onStatus?: (status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed', message?: string) => void;
  onTextDelta?: (text: string) => void;
};
const RETRYABLE_PROVIDER_ERROR_DELAY_MS = 600;

export function containsEmbeddedProviderToolCallText(text: string | null | undefined): boolean {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    return false;
  }
  return /<minimax:tool_call>/i.test(normalized)
    || /<tool_call>/i.test(normalized)
    || /<invoke\s+name=/i.test(normalized)
    || /<\/invoke>/i.test(normalized);
}

export function containsUnexecutedToolIntentText(text: string | null | undefined): boolean {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    return false;
  }
  if (containsEmbeddedProviderToolCallText(normalized)) {
    return true;
  }
  const hasCanonicalToolXml = /<(?:append_file|read_file|write_file|list_dir|grep_search|run_command|apply_patch|web_search|web_fetch|browser_open|browser_activate)\b/i.test(normalized);
  const hasPseudoInvocation = hasCanonicalToolXml
    || /工具调用[:：]|tool[_\s-]?calls?[:：]|list_dir\s*\(|list_directories\s*\(|list_directory\s*\(|catalog_file_or_directory\s*\(|python_code_execution|python_repl|shell_execute|os\.listdir\(|directory_path|dir_path|terminal\.run|<python_execution>|<tool\b|<invoke\s+name=/i.test(normalized);
  const hasToolPlanning = /我将使用.*工具|让我们执行工具调用|使用可用工具|请使用.*工具|不要猜测|执行中\.\.\.|i(?:'| wi)ll use .*tool|let me use .*tool|let me call .*tool|do not guess|use the available tool|use the provided tool|i will use the .* command/i.test(normalized);
  const hasCodePreview = /```(?:json|python|bash|sh|shell)\b/i.test(normalized);
  const hasObservedToolOutput = /(?:^|\n)Tool result for |STATUS:\s*(?:success|failure)|exit_code=|stdout:|stderr:|path=\/|status=\d+|根据工具(?:查询|执行|返回)结果|当前工作目录[:：]\s*\/|当前工作目录（`?\//i.test(normalized);
  return !hasObservedToolOutput && (hasPseudoInvocation || (hasToolPlanning && hasCodePreview));
}

function normalizeChatUsage(raw: any): SessionUsage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const input =
    Number(raw.input_tokens ?? raw.prompt_tokens ?? raw.input ?? 0) || 0;
  const output =
    Number(raw.output_tokens ?? raw.completion_tokens ?? raw.output ?? 0) || 0;
  const cacheRead =
    Number(raw.cache_read_input_tokens ?? raw.cacheRead ?? 0) || 0;
  const cacheWrite =
    Number(raw.cache_creation_input_tokens ?? raw.cacheWrite ?? 0) || 0;
  const total =
    Number(raw.total_tokens ?? raw.total ?? (input + output + cacheRead + cacheWrite)) || 0;
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && total <= 0) {
    return undefined;
  }
  return {
    input,
    output,
    total,
    cacheRead: cacheRead || undefined,
    cacheWrite: cacheWrite || undefined,
  };
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

function extractProviderApiError(payload: any): string | null {
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

function isRetryableProviderApiError(message: string | null | undefined): boolean {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('api error 1000')
    || normalized.includes('unknown error, 520')
    || normalized.includes('502')
    || normalized.includes('503')
    || normalized.includes('504')
    || normalized.includes('temporarily unavailable');
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

function buildPrompt(input: WorkerRunRequest['input']): string {
  const task = input.task.trim();
  const context = input.context.trim();
  if (!task) {
    return context;
  }
  if (!context) {
    return task;
  }
  return `${context}\n\n## Primary Task\n${task}`;
}

export function shouldUseDirectOpenAICompatibleRuntime(request: WorkerRunRequest): boolean {
  const connection = resolveRuntimeBackendConnection(request.options);
  if (!connection.baseUrl) {
    return false;
  }
  return true;
}

export async function runOpenAICompatibleStreamingChat(params: {
  backendLabel: string;
  request: WorkerRunRequest;
  hooks?: DirectStreamHooks;
  connectionOverride?: {
    baseUrl?: string | null;
    modelName?: string | null;
    apiKey?: string | null;
  };
}): Promise<SessionOutput> {
  const candidates = resolveRuntimeBackendConnectionCandidates(
    params.request.options,
    params.connectionOverride ?? null,
  );
  if (candidates.length === 0) {
    const connection = resolveRuntimeBackendConnection(params.request.options);
    return {
      success: false,
      error: `${params.backendLabel} direct chat.completions mode requires baseUrl and modelName. Resolved baseUrl=${connection.baseUrl ?? 'none'} modelName=${connection.modelName ?? 'none'}.`,
    };
  }

  const failureMessages: string[] = [];
  const prompt = buildPrompt(params.request.input);
  for (const candidate of candidates) {
    const baseUrl = candidate.baseUrl;
    const model = candidate.modelName;
    const apiKey = candidate.apiKey || 'EMPTY';
    if (!baseUrl || !model) {
      continue;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      params.hooks?.onStatus?.('running', `Calling local model ${model} @ ${baseUrl}`);
      let response: Response;
      try {
        response = await fetch(resolveChatCompletionsUrl(baseUrl), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: 'user',
                content: prompt,
              },
            ],
            stream: true,
          }),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failureMessages.push(`${model} @ ${baseUrl}: ${detail}`);
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_PROVIDER_ERROR_DELAY_MS * (attempt + 1)));
          continue;
        }
        break;
      }

      if (!response.ok) {
        const responseText = await response.text();
        failureMessages.push(`${model} @ ${baseUrl}: HTTP ${response.status} ${response.statusText}: ${responseText}`);
        break;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!response.body || /application\/json/i.test(contentType)) {
        const responseText = await response.text();
        try {
          const payload = JSON.parse(responseText);
          const providerError = extractProviderApiError(payload);
          if (providerError) {
            failureMessages.push(`${model} @ ${baseUrl}: ${providerError}`);
            if (attempt < 2 && isRetryableProviderApiError(providerError)) {
              await new Promise((resolve) => setTimeout(resolve, RETRYABLE_PROVIDER_ERROR_DELAY_MS * (attempt + 1)));
              continue;
            }
            break;
          }
          const result = extractChatCompletionText(payload?.choices?.[0]);
          const usage = normalizeChatUsage(payload?.usage);
          if (!result) {
            failureMessages.push(`${model} @ ${baseUrl}: response did not contain assistant text.`);
            break;
          }
          params.hooks?.onTextDelta?.(result);
          return {
            success: true,
            result,
            usage,
          };
        } catch (error) {
          failureMessages.push(`${model} @ ${baseUrl}: non-streaming response parse failed: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let collected = '';
      let finalUsage: SessionUsage | undefined;
      let retryProviderError: string | null = null;

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
            retryProviderError = providerError;
            break;
          }
          const usage = normalizeChatUsage(payload?.usage);
          if (usage) {
            finalUsage = usage;
          }
          const deltaText = extractChatCompletionDelta(payload);
          if (!deltaText) {
            continue;
          }
          collected += deltaText;
          params.hooks?.onTextDelta?.(deltaText);
        }
        if (retryProviderError) {
          break;
        }
      }

      if (retryProviderError) {
        failureMessages.push(`${model} @ ${baseUrl}: ${retryProviderError}`);
        if (attempt < 2 && isRetryableProviderApiError(retryProviderError)) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_PROVIDER_ERROR_DELAY_MS * (attempt + 1)));
          continue;
        }
        break;
      }

      if (!collected.trim()) {
        failureMessages.push(`${model} @ ${baseUrl}: response did not contain assistant text.`);
        break;
      }

      return {
        success: true,
        result: collected,
        usage: finalUsage,
      };
    }
  }

  return {
    success: false,
    error: `${params.backendLabel} chat.completions exhausted configured endpoints without a usable response.${failureMessages.length > 0 ? ` Failures: ${failureMessages.join(' | ')}` : ''}`,
  };
}
