import type { SessionOutput } from '../session-types.js';
import type { WorkerRunRequest } from '../team-worker-types.js';
import {
  ModelProviderCallError,
  requestOpenAICompatibleTextCompletion,
} from '../model-provider-client.js';
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
    || /<\s*[|｜]?DSML[|｜]?\s*tool_calls?\s*>/i.test(normalized)
    || /<\s*\/\s*[|｜]?DSML[|｜]?\s*tool_calls?\s*>/i.test(normalized)
    || /<\s*[|｜]?DSML[|｜]?\s*invoke\b/i.test(normalized)
    || /<\s*\/\s*[|｜]?DSML[|｜]?\s*invoke\s*>/i.test(normalized)
    || /<\s*[|｜]?DSML[|｜]?\s*parameter\b/i.test(normalized)
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
      try {
        const completion = await requestOpenAICompatibleTextCompletion({
          baseUrl,
          apiKey,
          model,
          provider: candidate.provider,
          stream: true,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          onTextDelta: params.hooks?.onTextDelta,
        });
        return {
          success: true,
          result: completion.text,
          usage: completion.usage,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failureMessages.push(`${model} @ ${baseUrl}: ${detail}`);
        const retryable = error instanceof ModelProviderCallError ? error.retryable : true;
        if (attempt < 2 && retryable) {
          await new Promise((resolve) => setTimeout(resolve, RETRYABLE_PROVIDER_ERROR_DELAY_MS * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }

  return {
    success: false,
    error: `${params.backendLabel} chat.completions exhausted configured endpoints without a usable response.${failureMessages.length > 0 ? ` Failures: ${failureMessages.join(' | ')}` : ''}`,
  };
}
