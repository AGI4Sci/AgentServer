import type { RequestStateRecord } from '../../core/store/request-state-store.js';
import type { WorkerSessionStatus } from './team-worker-types.js';

export interface RequestScopedSessionView {
  cacheKey: string | null;
  runtime: string;
  agentId: string;
  status: WorkerSessionStatus['status'];
  busy: boolean;
  sessionMode: WorkerSessionStatus['sessionMode'] | null;
  persistentKey: string | null;
  currentRequestId: string | null;
  currentSessionKey: string | null;
  lastRequestId: string | null;
  lastSessionKey: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  startedAt: string | null;
}

export interface RequestScopedRuntimeDiagnostics {
  activeRequestId: string | null;
  activeSessionCount: number;
  currentRequestSessions: RequestScopedSessionView[];
  staleSessions: RequestScopedSessionView[];
  blockingStaleSessions: RequestScopedSessionView[];
  disposableStaleSessions: RequestScopedSessionView[];
  busyAgentIdsForActiveRequest: string[];
  staleBusyAgentIds: string[];
  staleErrorAgentIds: string[];
}

function normalizeRequestId(value: string | null | undefined): string | null {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function toSessionView(session: WorkerSessionStatus): RequestScopedSessionView {
  return {
    cacheKey: session.cacheKey || null,
    runtime: session.runtime,
    agentId: session.agentId,
    status: session.status,
    busy: session.busy === true,
    sessionMode: session.sessionMode || null,
    persistentKey: session.persistentKey || null,
    currentRequestId: normalizeRequestId(session.currentRequestId),
    currentSessionKey: session.currentSessionKey || null,
    lastRequestId: normalizeRequestId(session.lastRequestId),
    lastSessionKey: session.lastSessionKey || null,
    lastError: session.lastError || null,
    lastUsedAt: session.lastUsedAt || null,
    startedAt: session.startedAt || null,
  };
}

function sortSessions<T extends { busy: boolean; status: string; lastUsedAt: string | null; agentId: string }>(sessions: T[]): T[] {
  return [...sessions].sort((left, right) => {
    if (left.busy !== right.busy) {
      return left.busy ? -1 : 1;
    }
    if (left.status !== right.status) {
      return left.status.localeCompare(right.status);
    }
    const timeCompare = String(right.lastUsedAt || '').localeCompare(String(left.lastUsedAt || ''));
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return left.agentId.localeCompare(right.agentId);
  });
}

function isStaleSession(session: RequestScopedSessionView, activeRequestId: string | null): boolean {
  if (!activeRequestId) {
    return false;
  }
  return Boolean(
    (session.currentRequestId && session.currentRequestId !== activeRequestId)
      || (!session.currentRequestId && session.lastRequestId && session.lastRequestId !== activeRequestId),
  );
}

function isDisposableStaleSession(session: RequestScopedSessionView): boolean {
  if (session.sessionMode !== 'ephemeral') {
    return false;
  }
  if (!session.cacheKey) {
    return false;
  }
  return session.status === 'error' || session.status === 'offline' || session.status === 'ready';
}

export function deriveRequestScopedRuntimeDiagnostics(args: {
  requests: RequestStateRecord[];
  sessions: WorkerSessionStatus[];
  activeRequestId?: string | null;
}): RequestScopedRuntimeDiagnostics {
  const activeRequestId = normalizeRequestId(args.activeRequestId)
    || args.requests
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .at(0)?.requestId
    || null;
  const sessionViews = args.sessions.map(toSessionView);
  const currentRequestSessions = activeRequestId
    ? sessionViews.filter((session) => session.currentRequestId === activeRequestId || (!session.currentRequestId && session.lastRequestId === activeRequestId))
    : [];
  const staleSessions = activeRequestId
    ? sessionViews.filter((session) => isStaleSession(session, activeRequestId))
    : [];
  const blockingStaleSessions = staleSessions.filter((session) => session.busy || session.status === 'error');
  const disposableStaleSessions = staleSessions.filter(isDisposableStaleSession);
  const busyAgentIdsForActiveRequest = Array.from(
    new Set(
      currentRequestSessions
        .filter((session) => session.busy)
        .map((session) => session.agentId),
    ),
  ).sort();
  const staleBusyAgentIds = Array.from(new Set(staleSessions.filter((session) => session.busy).map((session) => session.agentId))).sort();
  const staleErrorAgentIds = Array.from(new Set(staleSessions.filter((session) => session.status === 'error').map((session) => session.agentId))).sort();

  return {
    activeRequestId,
    activeSessionCount: currentRequestSessions.length,
    currentRequestSessions: sortSessions(currentRequestSessions),
    staleSessions: sortSessions(staleSessions),
    blockingStaleSessions: sortSessions(blockingStaleSessions),
    disposableStaleSessions: sortSessions(disposableStaleSessions),
    busyAgentIdsForActiveRequest,
    staleBusyAgentIds,
    staleErrorAgentIds,
  };
}
