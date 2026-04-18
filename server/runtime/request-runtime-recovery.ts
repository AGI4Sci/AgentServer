import { getTeamRegistry } from '../../core/team/registry.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import type { TaskFact } from '../../core/runtime/blackboard-types.js';
import { isRecoverableRunningHeartbeatState } from '../../core/runtime/agent-liveness.js';
import { deriveRunningHeartbeatWindow } from '../../core/runtime/running-heartbeat.js';
import { resolveRuntimeBackend } from './session-runner-registry.js';
import { disposeSupervisorSession } from './supervisor-client.js';
import { triggerBlackboardDispatch } from '../ws/blackboard-runtime-loop.js';

const SESSIONLESS_RUNTIME_RECOVERY_COOLDOWN_MS = 15_000;
const COORDINATOR_STALL_RECOVERY_GRACE_MS = 30_000;

const lastRecoveryAt = new Map<string, number>();

function buildRecoveryKey(teamId: string, chatSessionId: string, requestId: string): string {
  return `${teamId}::${chatSessionId}::${requestId}`;
}

function extractRecoverableTaskIdsFromRuntimeBlockedReason(
  runtimeBlockedReason: string | null | undefined,
  tasks: TaskFact[] | null | undefined,
): string[] {
  const reason = String(runtimeBlockedReason || '').trim();
  if (!reason) {
    return [];
  }
  return (tasks || [])
    .filter((task) => task.status === 'running')
    .filter((task) => isRecoverableRunningHeartbeatState(deriveRunningHeartbeatWindow(task).state))
    .map((task) => task.id)
    .filter((taskId) => reason.includes(taskId));
}

function isRecoverableTaskForStaleAgent(task: TaskFact): boolean {
  if (task.status === 'running' || task.status === 'pending') {
    return true;
  }
  if (task.status === 'blocked') {
    return task.blockedBy?.retryable !== false;
  }
  return false;
}

function isCoordinatorControlTask(task: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return task.requiredCapability === 'coordination'
    || task.requiredCapability === 'user-input'
    || task.requiredCapability === 'retrieval'
    || task.id.startsWith('coordinator:');
}

export function shouldTriggerSessionlessRuntimeRecovery(args: {
  requestId: string | null;
  failureCategory: string | null | undefined;
  runtimeBlockedReason: string | null | undefined;
}): boolean {
  const requestId = String(args.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  if (String(args.failureCategory || '').trim() !== 'runtime_deadlock') {
    return false;
  }
  return /without any active runtime session|without a stable runtime session/i.test(String(args.runtimeBlockedReason || ''));
}

export function extractRecoverableCoordinatorOnlyStallTaskIds(args: {
  requestId: string | null;
  failureCategory: string | null | undefined;
  runtimeDiagnostics: Record<string, unknown> | null | undefined;
  tasks?: TaskFact[] | null;
  now?: number;
}): string[] {
  const requestId = String(args.requestId || '').trim();
  if (!requestId || String(args.failureCategory || '').trim() !== 'coordinator_only_stall') {
    return [];
  }
  if (!args.runtimeDiagnostics || typeof args.runtimeDiagnostics !== 'object' || 'error' in args.runtimeDiagnostics) {
    return [];
  }
  const activeRequestId = String((args.runtimeDiagnostics as { activeRequestId?: unknown }).activeRequestId || '').trim();
  if (activeRequestId && activeRequestId !== requestId) {
    return [];
  }
  const activeSessionCount = Number((args.runtimeDiagnostics as { activeSessionCount?: unknown }).activeSessionCount || 0);
  const blockingStaleSessions = Array.isArray((args.runtimeDiagnostics as { blockingStaleSessions?: unknown }).blockingStaleSessions)
    ? ((args.runtimeDiagnostics as { blockingStaleSessions?: unknown }).blockingStaleSessions as Array<unknown>)
    : [];
  if (activeSessionCount > 0 || blockingStaleSessions.length > 0) {
    return [];
  }
  const now = Number(args.now || Date.now());
  return (args.tasks || [])
    .filter((task) =>
      String(task.requestId || '').trim() === requestId
      && task.status === 'running'
      && isCoordinatorControlTask(task),
    )
    .filter((task) => {
      const lastActivityAt = Number(task.lastHeartbeatAt || task.claimedAt || 0);
      if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
        return true;
      }
      return now - lastActivityAt >= COORDINATOR_STALL_RECOVERY_GRACE_MS;
    })
    .map((task) => task.id);
}

export function extractRecoverableStaleRuntimeSessions(runtimeDiagnostics: Record<string, unknown> | null | undefined): Array<{
  agentId: string;
  persistentKey: string;
  status: string;
  busy: boolean;
}> {
  if (!runtimeDiagnostics || typeof runtimeDiagnostics !== 'object') {
    return [];
  }
  const sessions = Array.isArray((runtimeDiagnostics as { blockingStaleSessions?: unknown }).blockingStaleSessions)
    ? ((runtimeDiagnostics as { blockingStaleSessions?: unknown }).blockingStaleSessions as Array<Record<string, unknown>>)
    : [];
  return sessions
    .map((session) => ({
      agentId: String(session.agentId || '').trim(),
      persistentKey: String(session.persistentKey || '').trim(),
      status: String(session.status || '').trim(),
      busy: session.busy === true,
    }))
    .filter((session) => session.agentId && session.persistentKey)
    .filter((session) => session.busy || session.status === 'error');
}

export function extractRecoverableTaskIdsFromStaleSessions(args: {
  requestId: string | null;
  staleSessions: Array<{ agentId: string; persistentKey: string; status: string; busy: boolean }>;
  tasks?: TaskFact[] | null;
}): string[] {
  const requestId = String(args.requestId || '').trim();
  const staleAgentIds = new Set(
    (args.staleSessions || [])
      .map((session) => String(session.agentId || '').trim())
      .filter(Boolean),
  );
  if (!requestId || staleAgentIds.size === 0) {
    return [];
  }
  return (args.tasks || [])
    .filter((task) => String(task.requestId || '').trim() === requestId)
    .filter((task) => staleAgentIds.has(String(task.owner || '').trim()))
    .filter((task) => isRecoverableTaskForStaleAgent(task))
    .filter((task) => {
      if (task.status !== 'running') {
        return true;
      }
      const heartbeat = deriveRunningHeartbeatWindow(task);
      return isRecoverableRunningHeartbeatState(heartbeat.state);
    })
    .map((task) => task.id);
}

export function shouldTriggerStaleRuntimeSessionRecovery(args: {
  requestId: string | null;
  failureCategory: string | null | undefined;
  runtimeDiagnostics: Record<string, unknown> | null | undefined;
}): boolean {
  const requestId = String(args.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  if (String(args.failureCategory || '').trim() !== 'runtime_deadlock') {
    return false;
  }
  return extractRecoverableStaleRuntimeSessions(args.runtimeDiagnostics).length > 0;
}

function filterStaleRuntimeSessionsSafeToDispose(args: {
  requestId: string | null;
  staleSessions: Array<{ agentId: string; persistentKey: string; status: string; busy: boolean }>;
  tasks?: TaskFact[] | null;
}): Array<{ agentId: string; persistentKey: string; status: string; busy: boolean }> {
  const tasks = Array.isArray(args.tasks) ? args.tasks : null;
  if (!tasks) {
    return args.staleSessions;
  }
  const requestId = String(args.requestId || '').trim();
  return args.staleSessions.filter((session) => {
    const agentId = String(session.agentId || '').trim();
    const matchingFreshRunningTask = tasks
      .filter((task) => String(task.requestId || '').trim() === requestId)
      .filter((task) => String(task.owner || '').trim() === agentId)
      .filter((task) => task.status === 'running')
      .some((task) => !isRecoverableRunningHeartbeatState(deriveRunningHeartbeatWindow(task).state));
    return !matchingFreshRunningTask;
  });
}

export async function maybeTriggerSessionlessRuntimeRecovery(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string | null;
  failureCategory: string | null | undefined;
  runtimeBlockedReason: string | null | undefined;
  runtimeDiagnostics?: Record<string, unknown> | null;
  tasks?: TaskFact[] | null;
  disposeSession?: (session: { agentId: string; persistentKey: string; status: string; busy: boolean }) => Promise<void>;
  resetTask?: (taskId: string) => TaskFact | null;
  triggerDispatch?: () => Promise<void>;
}): Promise<boolean> {
  const requestId = String(args.requestId || '').trim();
  const shouldRecoverSessionless = shouldTriggerSessionlessRuntimeRecovery({
    requestId,
    failureCategory: args.failureCategory,
    runtimeBlockedReason: args.runtimeBlockedReason,
  });
  const staleSessions = shouldTriggerStaleRuntimeSessionRecovery({
    requestId,
    failureCategory: args.failureCategory,
    runtimeDiagnostics: args.runtimeDiagnostics || null,
  })
    ? extractRecoverableStaleRuntimeSessions(args.runtimeDiagnostics || null)
    : [];
  const coordinatorOnlyStallTaskIds = extractRecoverableCoordinatorOnlyStallTaskIds({
    requestId,
    failureCategory: args.failureCategory,
    runtimeDiagnostics: args.runtimeDiagnostics || null,
    tasks: args.tasks || null,
  });
  if (!shouldRecoverSessionless && staleSessions.length === 0 && coordinatorOnlyStallTaskIds.length === 0) {
    return false;
  }
  const key = buildRecoveryKey(args.teamId, args.chatSessionId, requestId);
  const now = Date.now();
  const lastAt = Number(lastRecoveryAt.get(key) || 0);
  if (lastAt > 0 && now - lastAt < SESSIONLESS_RUNTIME_RECOVERY_COOLDOWN_MS) {
    return false;
  }
  lastRecoveryAt.set(key, now);
  const board = getBlackboardStore();
  const resetTask = args.resetTask || ((taskId: string) =>
    board.reset(args.teamId, args.chatSessionId, taskId, 'hosted_run_recovery_reset'));
  const recoverableTaskIds = shouldRecoverSessionless || staleSessions.length > 0
    ? extractRecoverableTaskIdsFromRuntimeBlockedReason(args.runtimeBlockedReason, args.tasks || null)
    : [];
  const staleSessionTaskIds = staleSessions.length > 0
    ? extractRecoverableTaskIdsFromStaleSessions({
        requestId,
        staleSessions,
        tasks: args.tasks || null,
      })
    : [];
  const staleSessionsToDispose = staleSessions.length > 0
    ? filterStaleRuntimeSessionsSafeToDispose({
        requestId,
        staleSessions,
        tasks: args.tasks || null,
      })
    : [];
  const taskIdsToReset = [...new Set([...recoverableTaskIds, ...staleSessionTaskIds, ...coordinatorOnlyStallTaskIds])];
  const hasTaskSnapshot = Array.isArray(args.tasks);
  if (
    hasTaskSnapshot
    && shouldRecoverSessionless
    && staleSessions.length === 0
    && coordinatorOnlyStallTaskIds.length === 0
    && taskIdsToReset.length === 0
  ) {
    return false;
  }
  if (
    hasTaskSnapshot
    && !shouldRecoverSessionless
    && staleSessions.length > 0
    && staleSessionsToDispose.length === 0
    && coordinatorOnlyStallTaskIds.length === 0
    && taskIdsToReset.length === 0
  ) {
    return false;
  }
  if (staleSessionsToDispose.length > 0) {
    const disposeSession = args.disposeSession || (async (session: { agentId: string; persistentKey: string; status: string; busy: boolean }) => {
      const registry = getTeamRegistry(args.teamId);
      if (!registry) {
        return;
      }
      const runtime = resolveRuntimeBackend(registry.raw.runtime);
      await disposeSupervisorSession(runtime, {
        teamId: args.teamId,
        agentId: session.agentId,
        persistentKey: session.persistentKey,
        reason: `dispose stale hosted session before auto-recovering request ${requestId}`,
      });
    });
    for (const session of staleSessionsToDispose) {
      await disposeSession(session);
    }
  }
  for (const taskId of taskIdsToReset) {
    resetTask(taskId);
  }
  const triggerDispatch = args.triggerDispatch || (async () => {
    await triggerBlackboardDispatch({
      teamId: args.teamId,
      requestId,
      chatSessionId: args.chatSessionId,
    });
  });
  await triggerDispatch();
  return true;
}
