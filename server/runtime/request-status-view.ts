import type { TaskFact } from '../../core/runtime/blackboard-types.js';
import type { RequestStateRecord } from '../../core/store/request-state-store.js';
import { deriveRequestClosureMode, type RequestClosureMode } from '../../core/runtime/request-integrity.js';
import { deriveRunningHeartbeatSummary, deriveRunningHeartbeatWindow } from '../../core/runtime/running-heartbeat.js';
import { deriveAgentLivenessSnapshot, type AgentLivenessState } from '../../core/runtime/agent-liveness.js';
import { deriveBlackboardFailureTriage } from '../../core/runtime/request-failure-triage.js';
import type { BlackboardFailureTransport } from '../../core/runtime/request-failure-triage.js';
import { deriveDependencyHandoffHints } from './blackboard-t006-diagnostics.js';

export type RequestRuntimeTaskLiveness = {
  taskId: string;
  owner: string | null;
  status: string;
  heartbeatState: string;
  livenessState: AgentLivenessState;
  livenessReason: string;
  lastHeartbeatAt: number | null;
  leaseUntil: number | null;
  heartbeatRemainingMs: number | null;
  heartbeatOverdueMs: number | null;
  msSinceLastHeartbeat: number | null;
  runtimeSessionState: 'active' | 'stale' | 'none';
};

export type RequestRuntimeBlockers = {
  runtimeActiveSessionCount: number;
  runtimeBlockingStaleSessionCount: number;
  runtimeBlockingStaleAgentIds: string[];
  runtimeBlockedReason: string | null;
  runtimeTaskLiveness: RequestRuntimeTaskLiveness[];
};

const SESSIONLESS_RUNNING_TASK_GRACE_MS = 30_000;
const LONG_RUNNING_SESSIONLESS_TASK_GRACE_MS = 45_000;
const LONG_RUNNING_SESSIONLESS_ATTEMPT_THRESHOLD = 5;

function isCoordinatorControlTask(task: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return task.requiredCapability === 'coordination'
    || task.requiredCapability === 'user-input'
    || task.requiredCapability === 'retrieval'
    || task.id.startsWith('coordinator:');
}

export function deriveActiveRequestRuntimeBlockers(args: {
  activeRequestId: string | null;
  runtimeDiagnostics: Record<string, unknown> | { error?: string } | null;
  tasks?: TaskFact[] | null;
}): RequestRuntimeBlockers {
  if (!args.runtimeDiagnostics || typeof args.runtimeDiagnostics !== 'object' || 'error' in args.runtimeDiagnostics) {
    return {
      runtimeActiveSessionCount: 0,
      runtimeBlockingStaleSessionCount: 0,
      runtimeBlockingStaleAgentIds: [],
      runtimeBlockedReason: null,
      runtimeTaskLiveness: [],
    };
  }
  const diag = args.runtimeDiagnostics as {
    activeRequestId?: unknown;
    activeSessionCount?: unknown;
    blockingStaleSessions?: unknown;
  };
  if (String(diag.activeRequestId || '').trim() !== String(args.activeRequestId || '').trim()) {
    return {
      runtimeActiveSessionCount: 0,
      runtimeBlockingStaleSessionCount: 0,
      runtimeBlockingStaleAgentIds: [],
      runtimeBlockedReason: null,
      runtimeTaskLiveness: [],
    };
  }
  const blockingStaleSessions = Array.isArray(diag.blockingStaleSessions)
    ? diag.blockingStaleSessions as Array<Record<string, unknown>>
    : [];
  const runtimeBlockingStaleAgentIds = Array.from(new Set(
    blockingStaleSessions
      .map((session) => String(session.agentId || '').trim())
      .filter(Boolean),
  )).sort();
  const runtimeActiveSessionCount = Number(diag.activeSessionCount || 0);
  const runtimeBlockingStaleSessionCount = blockingStaleSessions.length;
  const activeSessionAgentIds = new Set(
    Array.isArray((diag as { activeSessions?: unknown }).activeSessions)
      ? ((diag as { activeSessions?: unknown }).activeSessions as Array<Record<string, unknown>>)
          .map((session) => String(session.agentId || '').trim())
          .filter(Boolean)
      : [],
  );
  const runtimeTaskLiveness = (args.tasks || [])
    .filter((task) => task.status === 'running')
    .map((task) => {
      const owner = String(task.owner || '').trim() || null;
      const heartbeat = deriveRunningHeartbeatWindow(task);
      const runtimeSessionState: RequestRuntimeTaskLiveness['runtimeSessionState'] = owner && activeSessionAgentIds.has(owner)
        ? 'active'
        : owner && runtimeBlockingStaleAgentIds.includes(owner)
          ? 'stale'
          : 'none';
      const liveness = deriveAgentLivenessSnapshot({
        heartbeatState: heartbeat.state,
        hostedSessionBusy: runtimeSessionState === 'active',
        hostedSessionStatus: runtimeSessionState === 'active'
          ? 'busy'
          : runtimeSessionState === 'stale'
            ? 'error'
            : null,
      });
      return {
        taskId: task.id,
        owner,
        status: task.status,
        heartbeatState: heartbeat.state,
        livenessState: liveness.state,
        livenessReason: liveness.reason,
        lastHeartbeatAt: Number.isFinite(Number(task.lastHeartbeatAt)) ? Number(task.lastHeartbeatAt) : null,
        leaseUntil: Number.isFinite(Number(task.leaseUntil)) ? Number(task.leaseUntil) : null,
        heartbeatRemainingMs: heartbeat.remainingMs,
        heartbeatOverdueMs: heartbeat.overdueMs,
        msSinceLastHeartbeat: heartbeat.msSinceLastHeartbeat,
        runtimeSessionState,
      };
    });
  const runningHeartbeatSummary = deriveRunningHeartbeatSummary(args.tasks || []);
  const hasFreshOrAwaitingRunningTasks =
    runningHeartbeatSummary.healthyTaskIds.length > 0
    || runningHeartbeatSummary.awaitingHeartbeatTaskIds.length > 0;
  const staleBlockingAgentSet = new Set(runtimeBlockingStaleAgentIds);
  const staleBlockedRunningTaskIds = (args.tasks || [])
    .filter((task) =>
      task.status === 'running'
      && !isCoordinatorControlTask(task)
      && staleBlockingAgentSet.has(String(task.owner || '').trim()),
    )
    .filter((task) => {
      const heartbeat = deriveRunningHeartbeatWindow(task);
      return heartbeat.state === 'stale' || heartbeat.state === 'missing_lease';
    })
    .map((task) => task.id);
  const sessionlessRunningTaskIds = (args.tasks || [])
    .filter((task) => task.status === 'running' && !isCoordinatorControlTask(task))
    .filter((task) => {
      const heartbeat = deriveRunningHeartbeatWindow(task);
      if (heartbeat.state !== 'stale' && heartbeat.state !== 'missing_lease') {
        return false;
      }
      const lastActivityAt = Number(task.lastHeartbeatAt || task.claimedAt || 0);
      if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
        return true;
      }
      return Date.now() - lastActivityAt >= SESSIONLESS_RUNNING_TASK_GRACE_MS;
    })
    .map((task) => task.id);
  const longRunningSessionlessTaskIds = (args.tasks || [])
    .filter((task) => task.status === 'running' && !isCoordinatorControlTask(task))
    .filter((task) => Number(task.attempt || 0) >= LONG_RUNNING_SESSIONLESS_ATTEMPT_THRESHOLD)
    .filter((task) => {
      const claimedAt = Number(task.claimedAt || 0);
      if (!Number.isFinite(claimedAt) || claimedAt <= 0) {
        return false;
      }
      return Date.now() - claimedAt >= LONG_RUNNING_SESSIONLESS_TASK_GRACE_MS;
    })
    .map((task) => task.id);
  const orphanRunningTaskIds = (args.tasks || [])
    .filter((task) => task.status === 'running' && !isCoordinatorControlTask(task))
    .map((task) => task.id)
    .filter((taskId) =>
      runningHeartbeatSummary.staleTaskIds.includes(taskId)
      || runningHeartbeatSummary.missingLeaseTaskIds.includes(taskId),
    );
  return {
    runtimeActiveSessionCount,
    runtimeBlockingStaleSessionCount,
    runtimeBlockingStaleAgentIds,
    runtimeTaskLiveness,
    runtimeBlockedReason:
      runtimeBlockingStaleSessionCount > 0 && staleBlockedRunningTaskIds.length > 0
        ? `request has ${staleBlockedRunningTaskIds.length} running task(s) blocked by stale runtime session(s): ${staleBlockedRunningTaskIds.join(', ')}`
        : runtimeBlockingStaleSessionCount > 0 && !hasFreshOrAwaitingRunningTasks
        ? `request is blocked by ${runtimeBlockingStaleSessionCount} stale runtime session(s): ${runtimeBlockingStaleAgentIds.join(', ') || 'unknown'}`
        : runtimeActiveSessionCount === 0 && runtimeBlockingStaleSessionCount === 0 && sessionlessRunningTaskIds.length > 0
          ? `request has ${sessionlessRunningTaskIds.length} running task(s) without any active runtime session after ${SESSIONLESS_RUNNING_TASK_GRACE_MS}ms grace: ${sessionlessRunningTaskIds.join(', ')}`
        : runtimeActiveSessionCount === 0 && runtimeBlockingStaleSessionCount === 0 && longRunningSessionlessTaskIds.length > 0
          ? `request has ${longRunningSessionlessTaskIds.length} long-running task(s) without a stable runtime session after ${LONG_RUNNING_SESSIONLESS_TASK_GRACE_MS}ms grace: ${longRunningSessionlessTaskIds.join(', ')}`
        : runtimeActiveSessionCount === 0 && orphanRunningTaskIds.length > 0 && !hasFreshOrAwaitingRunningTasks
          ? `request has ${orphanRunningTaskIds.length} running task(s) without any active runtime session: ${orphanRunningTaskIds.join(', ')}`
          : null,
  };
}

export function deriveRequestStatusFailureView(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string | null;
  requestState: string | null;
  requestFinalPublished?: boolean | null;
  tasks: TaskFact[];
  runtimeDiagnostics?: Record<string, unknown> | { error?: string } | null;
  failureTransport?: BlackboardFailureTransport | null;
  transportError?: string | null;
}): {
  dependencyHandoffHints: Array<{ taskId: string; requestId: string; dependencyTaskId: string; dependencyStatus: string | null; blocking: boolean; issue: string }>;
  runtimeBlockers: RequestRuntimeBlockers;
  failureCategory: string | null;
  failureSummary: string | null;
  failureTaskIds: string[];
  closureMode: RequestClosureMode;
  failureTransport: {
    source?: string | null;
    layer?: string | null;
    health?: string | null;
    status?: string | null;
    ws?: string | null;
  } | null;
} {
  const runtimeBlockers = deriveActiveRequestRuntimeBlockers({
    activeRequestId: args.requestId,
    runtimeDiagnostics: args.runtimeDiagnostics || null,
    tasks: args.tasks,
  });
  const dependencyHandoffHints = args.requestId
    ? deriveDependencyHandoffHints({
        teamId: args.teamId,
        chatSessionId: args.chatSessionId,
        tasks: args.tasks,
      })
    : [];
  const failureTriage = deriveBlackboardFailureTriage({
    requestId: args.requestId,
    requestState: args.requestState,
    runtimeBlockedReason: runtimeBlockers.runtimeBlockedReason,
    failureTransport: args.failureTransport || null,
    transportError: String(args.transportError || '').trim() || null,
    dependencyHandoffHints,
    tasks: args.tasks,
  });
  return {
    dependencyHandoffHints,
    runtimeBlockers,
    failureCategory: failureTriage.failureCategory,
    failureSummary: failureTriage.failureSummary,
    failureTaskIds: failureTriage.failureTaskIds,
    closureMode: deriveRequestClosureMode({
      requestState: args.requestId
        ? {
            requestId: args.requestId,
            state: args.requestState || null,
            finalPublished: args.requestFinalPublished === true,
          } as Pick<RequestStateRecord, 'requestId' | 'state' | 'finalPublished'>
        : null,
      tasks: args.tasks,
    }),
    failureTransport: failureTriage.failureTransport,
  };
}
