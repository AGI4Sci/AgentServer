import type {
  RunSessionOptions,
  SessionInput,
  SessionOutput,
  SessionRunner,
  SessionStreamEvent,
} from '../session-types.js';
import { runSessionViaSupervisor } from '../supervisor-session-runner.js';

export class CodexSessionClient implements SessionRunner {
  async run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput> {
    let finalOutput: SessionOutput | null = null;
    await this.runStream(input, options, {
      onEvent: (event) => {
        if (event.type === 'result') {
          finalOutput = event.output;
        }
      },
    });
    return finalOutput || { success: false, error: 'Codex runtime exited without result event.' };
  }

  async runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: {
      onEvent: (event: SessionStreamEvent) => void;
    },
  ): Promise<SessionOutput> {
    return await runSessionViaSupervisor('codex', input, options, handlers);
  }
}
