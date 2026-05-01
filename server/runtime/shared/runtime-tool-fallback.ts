import type { RuntimeModelInput } from '../model-spec.js';
import type { LocalDevPolicyHint, SessionOutput } from '../session-types.js';
import {
  resolveRuntimeBackendConnection,
  resolveRuntimeBackendConnectionCandidates,
} from '../workers/runtime-backend-config.js';
import { resolveLocalDevRunPolicy, runLocalDevToolAgent } from './local-dev-agent.js';

export function resolveTaskAwareLocalToolMaxSteps(
  prompt: string,
  requestedMaxSteps?: number,
  hint?: LocalDevPolicyHint,
): number | undefined {
  return resolveLocalDevRunPolicy({
    prompt,
    requestedMaxSteps: hint?.maxSteps ?? requestedMaxSteps,
    requestedIsSourceTask: hint?.isSourceTask,
  }).maxSteps;
}

function shouldTryNextRuntimeEndpoint(error: string): boolean {
  const normalized = error.toLowerCase();
  return normalized.includes('unable to reach local model')
    || normalized.includes('chat.completions failed')
    || normalized.includes('fetch failed')
    || normalized.includes('connection refused')
    || normalized.includes('econnrefused')
    || normalized.includes('timeout')
    || normalized.includes('503')
    || normalized.includes('502')
    || normalized.includes('504');
}

export async function runSharedRuntimeToolFallback(params: {
  backendLabel: string;
  request: {
    options: RuntimeModelInput & { cwd?: string | null };
  };
  prompt: string;
  cwd?: string | null;
  onToolCall?: (toolName: string, detail?: string) => void;
  onToolResult?: (toolName: string, detail?: string, output?: string) => void;
  onTextDelta?: (text: string) => void;
  onStatus?: (status: 'running' | 'completed' | 'failed', message?: string) => void;
  maxSteps?: number;
  forceSummaryOnBudgetExhausted?: boolean;
}): Promise<SessionOutput> {
  const policy = resolveLocalDevRunPolicy({
    prompt: params.prompt,
    requestedMaxSteps: params.request.options.localDevPolicy?.maxSteps ?? params.maxSteps,
    requestedForceSummaryOnBudgetExhausted:
      typeof params.request.options.localDevPolicy?.forceSummaryOnBudgetExhausted === 'boolean'
        ? params.request.options.localDevPolicy.forceSummaryOnBudgetExhausted
        : params.forceSummaryOnBudgetExhausted,
    requestedIsSourceTask: params.request.options.localDevPolicy?.isSourceTask,
  });
  const candidates = resolveRuntimeBackendConnectionCandidates(params.request.options);
  if (candidates.length === 0) {
    const connection = resolveRuntimeBackendConnection(params.request.options);
    return {
      success: false,
      error: `${params.backendLabel} local tool fallback requires baseUrl and modelName. Resolved baseUrl=${connection.baseUrl ?? 'none'} modelName=${connection.modelName ?? 'none'}.`,
    };
  }

  const failures: string[] = [];
  for (const connection of candidates) {
    const baseUrl = connection.baseUrl;
    const model = connection.modelName;
    if (!baseUrl || !model) {
      continue;
    }
    let output: Awaited<ReturnType<typeof runLocalDevToolAgent>>;
    try {
      output = await runLocalDevToolAgent({
        baseUrl,
        apiKey: connection.apiKey || 'EMPTY',
        model,
        prompt: params.prompt,
        cwd: params.cwd || params.request.options.cwd || process.cwd(),
        maxSteps: policy.maxSteps,
        forceSummaryOnBudgetExhausted: policy.forceSummaryOnBudgetExhausted,
        hooks: {
          onToolCall: params.onToolCall,
          onToolResult: params.onToolResult,
          onTextDelta: params.onTextDelta,
          onStatus: params.onStatus,
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`${model} @ ${baseUrl}: ${detail}`);
      if (shouldTryNextRuntimeEndpoint(detail)) {
        continue;
      }
      return {
        success: false,
        error: detail,
      };
    }

    if (output.success) {
      return { success: true, result: output.result, usage: output.usage };
    }
    failures.push(`${model} @ ${baseUrl}: ${output.error}`);
    if (!shouldTryNextRuntimeEndpoint(output.error)) {
      return { success: false, error: output.error, usage: output.usage };
    }
  }

  if (failures.length === 0) {
    return {
      success: false,
      error: `${params.backendLabel} local tool fallback exhausted configured endpoints without a usable response.`,
    };
  }
  return {
    success: false,
    error: `${params.backendLabel} local tool fallback exhausted configured endpoints without a usable response. Failures: ${failures.join(' | ')}`,
  };
}
