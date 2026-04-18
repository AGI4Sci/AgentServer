import type {
  RunSessionOptions,
  SessionInput,
  SessionOutput,
  SessionStreamEvent,
} from './session-types.js';
import { runSupervisorWorker } from './supervisor-client.js';
import type { WorkerRuntimeType } from './team-worker-types.js';

export async function runSessionViaSupervisor(
  runtime: WorkerRuntimeType,
  input: SessionInput,
  options: RunSessionOptions,
  handlers: {
    onEvent: (event: SessionStreamEvent) => void;
  },
): Promise<SessionOutput> {
  const requestId = options.requestId || options.messageId || `${options.agentId}-${Date.now()}`;
  const sessionKey = options.sessionKey || `${options.agentId}:${requestId}`;

  return await runSupervisorWorker(
    {
      type: 'run',
      runtime,
      teamId: options.teamId,
      agentId: options.agentId,
      requestId,
      sessionKey,
      input,
      options,
    },
    handlers,
  );
}
