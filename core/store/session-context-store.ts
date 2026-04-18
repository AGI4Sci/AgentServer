import type { SessionContext } from '../runtime/types.js';

function key(teamId: string, sessionId: string): string {
  return `${teamId}:${sessionId}`;
}

export class SessionContextStore {
  private readonly contexts = new Map<string, SessionContext>();

  getCurrent(teamId: string, sessionId?: string | null): SessionContext | null {
    if (!sessionId) {
      return null;
    }
    return this.contexts.get(key(teamId, sessionId)) || null;
  }

  getCurrentForSession(teamId: string, sessionId: string): SessionContext | null {
    return this.getCurrent(teamId, sessionId);
  }

  merge(teamId: string, input: {
    requestId: string;
    sessionId?: string;
    envPatch?: Record<string, string | null | undefined>;
    incrementRevision?: boolean;
  }, sessionId?: string | null): SessionContext {
    const resolvedSessionId = String(sessionId || input.sessionId || '').trim();
    if (!resolvedSessionId) {
      throw new Error('SessionContextStore requires sessionId');
    }
    const existing = this.getCurrent(teamId, resolvedSessionId);
    const nextEnv: Record<string, string> = {
      ...(existing?.env || {}),
    };
    for (const [envKey, envValue] of Object.entries(input.envPatch || {})) {
      if (envValue == null) {
        delete nextEnv[envKey];
      } else {
        nextEnv[envKey] = envValue;
      }
    }
    const now = new Date().toISOString();
    const next: SessionContext = {
      sessionId: resolvedSessionId,
      requestId: input.requestId,
      revision: input.incrementRevision ? (existing?.revision || 0) + 1 : (existing?.revision || 1),
      env: nextEnv,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.contexts.set(key(teamId, resolvedSessionId), next);
    return next;
  }

  mergeForSession(teamId: string, sessionId: string, input: Omit<Parameters<SessionContextStore['merge']>[1], 'sessionId'>): SessionContext {
    return this.merge(teamId, { ...input, sessionId }, sessionId);
  }

  clear(teamId: string, sessionId?: string | null): void {
    if (sessionId) {
      this.contexts.delete(key(teamId, sessionId));
      return;
    }
    for (const contextKey of Array.from(this.contexts.keys())) {
      if (contextKey.startsWith(`${teamId}:`)) {
        this.contexts.delete(contextKey);
      }
    }
  }
}

let store: SessionContextStore | null = null;

export function getSessionContextStore(): SessionContextStore {
  if (!store) {
    store = new SessionContextStore();
  }
  return store;
}
