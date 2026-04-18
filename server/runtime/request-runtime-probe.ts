import { getTeamRegistry } from '../../core/team/registry.js';
import type { BlackboardFailureTransport } from '../../core/runtime/request-failure-triage.js';
import type { RequestStateRecord } from '../../core/store/request-state-store.js';
import { deriveRequestScopedRuntimeDiagnostics } from './request-scoped-diagnostics.js';
import { listSupervisorSessions } from './supervisor-client.js';
import { resolveRuntimeBackend } from './session-runner-registry.js';

export async function probeRequestRuntimeDiagnostics(args: {
  teamId: string;
  requests: RequestStateRecord[];
  activeRequestId?: string | null;
}): Promise<{
  runtimeDiagnostics: Record<string, unknown> | { error?: string } | null;
  transportError: string | null;
  failureTransport: BlackboardFailureTransport | null;
}> {
  let runtimeDiagnostics: Record<string, unknown> | { error?: string } | null = null;
  let transportError: string | null = null;
  let failureTransport: BlackboardFailureTransport | null = null;
  try {
    const registry = getTeamRegistry(args.teamId);
    if (registry) {
      const runtime = resolveRuntimeBackend(registry.raw.runtime);
      const sessions = await listSupervisorSessions(runtime, args.teamId);
      runtimeDiagnostics = deriveRequestScopedRuntimeDiagnostics({
        requests: args.requests,
        sessions,
        activeRequestId: args.activeRequestId || undefined,
      }) as unknown as Record<string, unknown>;
    }
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
    runtimeDiagnostics = {
      error: transportError,
    };
    failureTransport = {
      source: 'server-runtime',
      layer: 'runtime-diagnostics',
      health: transportError,
      status: null,
      ws: null,
    };
  }
  return {
    runtimeDiagnostics,
    transportError,
    failureTransport,
  };
}
