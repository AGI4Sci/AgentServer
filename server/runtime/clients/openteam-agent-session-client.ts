import type {
  RunSessionOptions,
  SessionInput,
  SessionOutput,
  SessionRunner,
  SessionStreamEvent,
} from '../session-types.js';
import {
  resolveRuntimeBackendConnection,
  resolveRuntimeBackendConnectionCandidates,
} from '../workers/runtime-backend-config.js';
import { resolveLocalDevRunPolicy } from '../shared/local-dev-agent.js';
import { runOpenTeamAgentLocalDevToolAgent } from '../shared/openteam-agent-local-dev-agent.js';

function buildPrompt(input: SessionInput): string {
  const parts: string[] = [];
  const context = input.context.trim();
  if (context) {
    parts.push(context);
  }
  parts.push(input.task);
  return parts.join('\n\n');
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

export class OpenTeamAgentSessionClient implements SessionRunner {
  async run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput> {
    let finalOutput: SessionOutput | null = null;
    await this.runStream(input, options, {
      onEvent: (event) => {
        if (event.type === 'result') {
          finalOutput = event.output;
        }
      },
    });
    return finalOutput || { success: false, error: 'OpenTeam Agent runtime exited without result event.' };
  }

  async runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: {
      onEvent: (event: SessionStreamEvent) => void;
    },
  ): Promise<SessionOutput> {
    const prompt = buildPrompt(input);
    const policy = resolveLocalDevRunPolicy({
      prompt,
      requestedMaxSteps: options.localDevPolicy?.maxSteps,
      requestedForceSummaryOnBudgetExhausted: options.localDevPolicy?.forceSummaryOnBudgetExhausted ?? true,
      requestedIsSourceTask: options.localDevPolicy?.isSourceTask,
    });
    const candidates = resolveRuntimeBackendConnectionCandidates(options);
    if (candidates.length === 0) {
      const connection = resolveRuntimeBackendConnection(options);
      const output: SessionOutput = {
        success: false,
        error: `OpenTeam Agent requires baseUrl and modelName. Resolved baseUrl=${connection.baseUrl ?? 'none'} modelName=${connection.modelName ?? 'none'}.`,
      };
      handlers.onEvent({ type: 'result', output });
      return output;
    }

    handlers.onEvent({
      type: 'status',
      status: 'running',
      message: 'Running OpenTeam Agent through AgentServer tool bridge',
    });

    const failures: string[] = [];
    for (const connection of candidates) {
      const baseUrl = connection.baseUrl;
      const model = connection.modelName;
      if (!baseUrl || !model) {
        continue;
      }

      let output: SessionOutput;
      try {
        output = await runOpenTeamAgentLocalDevToolAgent({
          baseUrl,
          apiKey: connection.apiKey || 'EMPTY',
          model,
          prompt,
          cwd: options.cwd || process.cwd(),
          maxSteps: policy.maxSteps,
          forceSummaryOnBudgetExhausted: policy.forceSummaryOnBudgetExhausted,
          hooks: {
            onToolCall: (toolName, detail) => {
              handlers.onEvent({ type: 'tool-call', toolName, detail });
            },
            onToolResult: (toolName, detail, output) => {
              handlers.onEvent({ type: 'tool-result', toolName, detail, output });
            },
            onTextDelta: (text) => {
              handlers.onEvent({ type: 'text-delta', text });
            },
            onStatus: (status, message) => {
              handlers.onEvent({ type: 'status', status, message });
            },
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        failures.push(`${model} @ ${baseUrl}: ${detail}`);
        if (shouldTryNextRuntimeEndpoint(detail)) {
          continue;
        }
        output = { success: false, error: detail };
        handlers.onEvent({ type: 'result', output });
        return output;
      }

      if (output.success) {
        handlers.onEvent({ type: 'result', output });
        return output;
      }
      failures.push(`${model} @ ${baseUrl}: ${output.error}`);
      if (!shouldTryNextRuntimeEndpoint(output.error)) {
        handlers.onEvent({ type: 'result', output });
        return output;
      }
    }

    const output: SessionOutput = {
      success: false,
      error: failures.length
        ? `OpenTeam Agent exhausted configured endpoints. Failures: ${failures.join(' | ')}`
        : 'OpenTeam Agent exhausted configured endpoints without a usable response.',
    };
    handlers.onEvent({ type: 'result', output });
    return output;
  }
}
