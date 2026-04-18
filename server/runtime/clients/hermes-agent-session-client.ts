import type {
  RunSessionOptions,
  SessionInput,
  SessionOutput,
  SessionRunner,
  SessionStreamEvent,
} from '../session-types.js';
import { runSharedRuntimeToolFallback } from '../shared/runtime-tool-fallback.js';
import { runSessionViaSupervisor } from '../supervisor-session-runner.js';

function buildPrompt(input: SessionInput): string {
  const parts: string[] = [];
  const context = input.context.trim();
  if (context) {
    parts.push(context);
  }
  parts.push(input.task);
  return parts.join('\n\n');
}

export class HermesAgentSessionClient implements SessionRunner {
  async run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput> {
    let finalOutput: SessionOutput | null = null;
    await this.runStream(input, options, {
      onEvent: (event) => {
        if (event.type === 'result') {
          finalOutput = event.output;
        }
      },
    });
    return finalOutput || { success: false, error: 'Hermes Agent runtime exited without result event.' };
  }

  async runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: {
      onEvent: (event: SessionStreamEvent) => void;
    },
  ): Promise<SessionOutput> {
    return await runSessionViaSupervisor('hermes-agent', input, options, handlers);
  }
}

export class HermesAgentDirectSessionClient implements SessionRunner {
  async run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput> {
    let finalOutput: SessionOutput | null = null;
    await this.runStream(input, options, {
      onEvent: (event) => {
        if (event.type === 'result') {
          finalOutput = event.output;
        }
      },
    });
    return finalOutput || { success: false, error: 'Hermes Agent direct runtime exited without result event.' };
  }

  async runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: {
      onEvent: (event: SessionStreamEvent) => void;
    },
  ): Promise<SessionOutput> {
    handlers.onEvent({
      type: 'status',
      status: 'running',
      message: 'Running Hermes Agent through AgentServer tool bridge',
    });

    return await runSharedRuntimeToolFallback({
      backendLabel: 'Hermes Agent',
      request: { options },
      prompt: buildPrompt(input),
      cwd: options.cwd,
      onStatus: (status, message) => {
        handlers.onEvent({ type: 'status', status, message });
      },
      onToolCall: (toolName, detail) => {
        handlers.onEvent({ type: 'tool-call', toolName, detail });
      },
      onToolResult: (toolName, detail, output) => {
        handlers.onEvent({ type: 'tool-result', toolName, detail, output });
      },
      onTextDelta: (text) => {
        handlers.onEvent({ type: 'text-delta', text });
      },
      forceSummaryOnBudgetExhausted: true,
    });
  }
}
