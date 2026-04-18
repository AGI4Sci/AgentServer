import type { RunningHeartbeatState } from './running-heartbeat.js';

export type AgentLivenessState = 'active' | 'awaiting' | 'stale' | 'dead' | 'unknown';
export type AgentLivenessReason =
  | 'fresh_running_heartbeat'
  | 'hosted_session_busy'
  | 'hosted_session_error'
  | 'recent_session_event'
  | 'idle_threshold_exceeded'
  | 'recoverable_running_heartbeat'
  | 'no_liveness_signal';

export type AgentLivenessSnapshot = {
  state: AgentLivenessState;
  reason: AgentLivenessReason;
  heartbeatState?: RunningHeartbeatState | null;
  idleMs?: number | null;
  staleAfterMs?: number;
};

export function extendLeaseWithoutShortening(args: {
  existingLeaseUntil?: number | null;
  now?: number;
  leaseWindowMs?: number | null;
  minimumWindowMs?: number;
}): number {
  const now = Number.isFinite(args.now) ? Number(args.now) : Date.now();
  const minimumWindowMs = Math.max(1, Math.trunc(args.minimumWindowMs ?? 30_000));
  const leaseWindowMs = Math.max(minimumWindowMs, Math.trunc(Number(args.leaseWindowMs || 0)));
  const nextLeaseUntil = now + leaseWindowMs;
  const existingLeaseUntil = Number(args.existingLeaseUntil || 0);
  return Math.max(
    Number.isFinite(existingLeaseUntil) ? existingLeaseUntil : 0,
    nextLeaseUntil,
  );
}

export function isFreshRunningHeartbeatState(state?: RunningHeartbeatState | null): boolean {
  return state === 'healthy' || state === 'awaiting_heartbeat';
}

export function isRecoverableRunningHeartbeatState(state?: RunningHeartbeatState | null): boolean {
  return state === 'stale' || state === 'missing_lease';
}

export function deriveAgentLivenessFromSignals(args: {
  heartbeatState?: RunningHeartbeatState | null;
  hostedSessionBusy?: boolean | null;
  hostedSessionStatus?: string | null;
  idleMs?: number | null;
  staleAfterMs?: number;
}): AgentLivenessState {
  return deriveAgentLivenessSnapshot(args).state;
}

export function deriveAgentLivenessSnapshot(args: {
  heartbeatState?: RunningHeartbeatState | null;
  hostedSessionBusy?: boolean | null;
  hostedSessionStatus?: string | null;
  idleMs?: number | null;
  staleAfterMs?: number;
}): AgentLivenessSnapshot {
  const heartbeatState = args.heartbeatState || null;
  if (isFreshRunningHeartbeatState(heartbeatState)) {
    return {
      state: 'active',
      reason: 'fresh_running_heartbeat',
      heartbeatState,
      idleMs: args.idleMs ?? null,
      staleAfterMs: args.staleAfterMs,
    };
  }
  if (args.hostedSessionBusy) {
    return {
      state: 'active',
      reason: 'hosted_session_busy',
      heartbeatState,
      idleMs: args.idleMs ?? null,
      staleAfterMs: args.staleAfterMs,
    };
  }
  const status = String(args.hostedSessionStatus || '').trim();
  if (status === 'busy') {
    return {
      state: 'active',
      reason: 'hosted_session_busy',
      heartbeatState,
      idleMs: args.idleMs ?? null,
      staleAfterMs: args.staleAfterMs,
    };
  }
  if (status === 'error') {
    return {
      state: 'dead',
      reason: 'hosted_session_error',
      heartbeatState,
      idleMs: args.idleMs ?? null,
      staleAfterMs: args.staleAfterMs,
    };
  }
  const idleMs = Number(args.idleMs ?? Number.NaN);
  const staleAfterMs = Math.max(1, Math.trunc(args.staleAfterMs ?? 90_000));
  if (Number.isFinite(idleMs)) {
    return {
      state: idleMs >= staleAfterMs ? 'stale' : 'awaiting',
      reason: idleMs >= staleAfterMs ? 'idle_threshold_exceeded' : 'recent_session_event',
      heartbeatState,
      idleMs,
      staleAfterMs,
    };
  }
  if (isRecoverableRunningHeartbeatState(heartbeatState)) {
    return {
      state: 'stale',
      reason: 'recoverable_running_heartbeat',
      heartbeatState,
      idleMs: null,
      staleAfterMs,
    };
  }
  return {
    state: 'unknown',
    reason: 'no_liveness_signal',
    heartbeatState,
    idleMs: null,
    staleAfterMs,
  };
}
