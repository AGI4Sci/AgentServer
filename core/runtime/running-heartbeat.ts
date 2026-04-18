export const DEFAULT_RUNNING_HEARTBEAT_WINDOW_MS = 5 * 60 * 1000;

export type RunningHeartbeatTaskLike = {
  id?: string | null;
  status?: string | null;
  leaseUntil?: number | null;
  lastHeartbeatAt?: number | null;
  claimedAt?: number | null;
};

export type RunningHeartbeatState =
  | 'healthy'
  | 'awaiting_heartbeat'
  | 'stale'
  | 'missing_lease'
  | 'not_running';

export type RunningHeartbeatWindow = {
  taskId: string | null;
  state: RunningHeartbeatState;
  heartbeatWindowMs: number | null;
  dueAt: number | null;
  remainingMs: number | null;
  overdueMs: number | null;
  msSinceLastHeartbeat: number | null;
};

function positiveNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function deriveRunningHeartbeatWindow(
  task: RunningHeartbeatTaskLike,
  nowMs: number = Date.now(),
  defaultWindowMs: number = DEFAULT_RUNNING_HEARTBEAT_WINDOW_MS,
): RunningHeartbeatWindow {
  const taskId = String(task.id || '').trim() || null;
  if (String(task.status || '').trim() !== 'running') {
    return {
      taskId,
      state: 'not_running',
      heartbeatWindowMs: null,
      dueAt: null,
      remainingMs: null,
      overdueMs: null,
      msSinceLastHeartbeat: null,
    };
  }
  const leaseUntil = positiveNumber(task.leaseUntil);
  const lastHeartbeatAt = positiveNumber(task.lastHeartbeatAt);
  const claimedAt = positiveNumber(task.claimedAt);
  const heartbeatWindowMs =
    positiveNumber(leaseUntil != null && lastHeartbeatAt != null ? leaseUntil - lastHeartbeatAt : null)
    || positiveNumber(leaseUntil != null && claimedAt != null ? leaseUntil - claimedAt : null)
    || defaultWindowMs;
  const dueAt = leaseUntil ?? (lastHeartbeatAt != null ? lastHeartbeatAt + heartbeatWindowMs : null);
  const msSinceLastHeartbeat = lastHeartbeatAt != null ? Math.max(0, nowMs - lastHeartbeatAt) : null;
  if (dueAt == null) {
    return {
      taskId,
      state: 'missing_lease',
      heartbeatWindowMs,
      dueAt: null,
      remainingMs: null,
      overdueMs: null,
      msSinceLastHeartbeat,
    };
  }
  if (dueAt > nowMs) {
    return {
      taskId,
      state: 'healthy',
      heartbeatWindowMs,
      dueAt,
      remainingMs: dueAt - nowMs,
      overdueMs: null,
      msSinceLastHeartbeat,
    };
  }
  const overdueMs = nowMs - dueAt;
  const state: RunningHeartbeatState =
    msSinceLastHeartbeat != null && msSinceLastHeartbeat <= heartbeatWindowMs
      ? 'awaiting_heartbeat'
      : 'stale';
  return {
    taskId,
    state,
    heartbeatWindowMs,
    dueAt,
    remainingMs: 0,
    overdueMs,
    msSinceLastHeartbeat,
  };
}

export function deriveRunningHeartbeatSummary(
  tasks: RunningHeartbeatTaskLike[],
  nowMs: number = Date.now(),
  defaultWindowMs: number = DEFAULT_RUNNING_HEARTBEAT_WINDOW_MS,
): {
  healthyTaskIds: string[];
  awaitingHeartbeatTaskIds: string[];
  staleTaskIds: string[];
  missingLeaseTaskIds: string[];
} {
  const summary = {
    healthyTaskIds: [] as string[],
    awaitingHeartbeatTaskIds: [] as string[],
    staleTaskIds: [] as string[],
    missingLeaseTaskIds: [] as string[],
  };
  for (const task of tasks) {
    const heartbeat = deriveRunningHeartbeatWindow(task, nowMs, defaultWindowMs);
    if (!heartbeat.taskId) continue;
    if (heartbeat.state === 'healthy') summary.healthyTaskIds.push(heartbeat.taskId);
    if (heartbeat.state === 'awaiting_heartbeat') summary.awaitingHeartbeatTaskIds.push(heartbeat.taskId);
    if (heartbeat.state === 'stale') summary.staleTaskIds.push(heartbeat.taskId);
    if (heartbeat.state === 'missing_lease') summary.missingLeaseTaskIds.push(heartbeat.taskId);
  }
  return summary;
}
