import type { AgentMessage } from '../../core/runtime/types.js';
import type { AgentResponse } from '../runtime/agent-response.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';

export interface DeliveryContext {
  from: string;
  replyTo: string | null;
  msgId: string;
  sessionKey: string;
  timestamp: number;
  teamId: string;
  requestId: string | null;
  sourceClientId: string | null;
  isPrivate: boolean;
}

const CONTEXT_TTL_MS = Math.max(30_000, Math.trunc(loadOpenTeamConfig().runtime.ws.deliveryContextTtlMs));

const deliveryContextMap = new Map<string, DeliveryContext>();
const deliveryContextBySessionKey = new Map<string, DeliveryContext>();
const latestRequestIdByAgent = new Map<string, string>();
const latestRequestIdByTeam = new Map<string, string>();

function contextKey(agentId: string, msgId: string): string {
  return `${agentId}:${msgId}`;
}

function shouldPreserveSessionContext(
  existing: DeliveryContext | undefined,
  incoming: DeliveryContext,
): boolean {
  if (!existing) {
    return false;
  }

  if (existing.requestId && incoming.requestId && existing.requestId !== incoming.requestId) {
    return false;
  }

  return existing.from === 'user';
}

export function recordDeliveryContext(agentId: string, sessionKey: string, msg: AgentMessage): DeliveryContext {
  const deliveryContext: DeliveryContext = {
    from: msg.from,
    replyTo: msg.replyTo || null,
    msgId: msg.id,
    sessionKey,
    timestamp: Date.now(),
    teamId: msg.teamId || 'vibe-coding',
    requestId: msg.requestId || null,
    sourceClientId: msg.sourceClientId || null,
    isPrivate: msg.isPrivate === true,
  };

  deliveryContextMap.set(contextKey(agentId, msg.id), deliveryContext);
  const existingSessionContext = deliveryContextBySessionKey.get(sessionKey);
  if (!shouldPreserveSessionContext(existingSessionContext, deliveryContext)) {
    deliveryContextBySessionKey.set(sessionKey, deliveryContext);
    console.log(
      `[WS][delivery-context] set sessionKey=${sessionKey} team=${deliveryContext.teamId} requestId=${deliveryContext.requestId || 'none'} from=${deliveryContext.from}`,
    );
  } else {
    console.log(
      `[WS][delivery-context] preserve sessionKey=${sessionKey} existingFrom=${existingSessionContext?.from || 'unknown'} incomingFrom=${deliveryContext.from}`,
    );
  }
  if (msg.requestId) {
    latestRequestIdByAgent.set(agentId, msg.requestId);
  }
  return deliveryContext;
}

export function getExactDeliveryContext(response: AgentResponse): DeliveryContext | null {
  if (!response.sessionKey) {
    return null;
  }
  const context = deliveryContextBySessionKey.get(response.sessionKey) || null;
  if (!context) {
    console.warn(`[WS][delivery-context] miss sessionKey=${response.sessionKey}`);
  } else {
    refreshDeliveryContext(response.sessionKey);
  }
  return context;
}

export function refreshDeliveryContext(sessionKey: string, now = Date.now()): void {
  const sessionContext = deliveryContextBySessionKey.get(sessionKey);
  if (sessionContext) {
    sessionContext.timestamp = now;
  }
  for (const ctx of deliveryContextMap.values()) {
    if (ctx.sessionKey === sessionKey) {
      ctx.timestamp = now;
    }
  }
}

export function findRecentContextForAgent(agentId: string, now = Date.now()): DeliveryContext | null {
  let recent: DeliveryContext | null = null;

  for (const [key, ctx] of deliveryContextMap) {
    if (key.startsWith(`${agentId}:`) && now - ctx.timestamp < CONTEXT_TTL_MS) {
      if (!recent || ctx.timestamp > recent.timestamp) {
        recent = ctx;
      }
    }
  }

  return recent;
}

export function pruneExpiredDeliveryContexts(now = Date.now()): void {
  for (const [key, ctx] of deliveryContextMap) {
    if (now - ctx.timestamp > CONTEXT_TTL_MS) {
      deliveryContextMap.delete(key);
    }
  }
  for (const [sessionKey, ctx] of deliveryContextBySessionKey) {
    if (now - ctx.timestamp > CONTEXT_TTL_MS) {
      console.log(`[WS][delivery-context] expire sessionKey=${sessionKey} team=${ctx.teamId} requestId=${ctx.requestId || 'none'}`);
      deliveryContextBySessionKey.delete(sessionKey);
    }
  }
}

export function setLatestRequestForTeam(teamId: string, requestId: string): void {
  latestRequestIdByTeam.set(teamId, requestId);
}

export function deleteLatestRequestForTeam(teamId: string): void {
  latestRequestIdByTeam.delete(teamId);
}

export function deleteLatestRequestForAgent(agentId: string): void {
  latestRequestIdByAgent.delete(agentId);
}

export function clearDeliveryContextForTeam(
  teamId: string,
  options?: {
    preserveRecentMs?: number;
    now?: number;
  },
): void {
  const now = options?.now ?? Date.now();
  const preserveRecentMs = Math.max(0, options?.preserveRecentMs ?? 0);

  for (const [key, ctx] of deliveryContextMap) {
    const shouldPreserve = preserveRecentMs > 0 && now - ctx.timestamp <= preserveRecentMs;
    if (ctx.teamId === teamId && !shouldPreserve) {
      deliveryContextMap.delete(key);
    }
  }

  for (const [sessionKey, ctx] of deliveryContextBySessionKey) {
    const shouldPreserve = preserveRecentMs > 0 && now - ctx.timestamp <= preserveRecentMs;
    if (ctx.teamId === teamId && !shouldPreserve) {
      console.log(`[WS][delivery-context] clear sessionKey=${sessionKey} team=${ctx.teamId} requestId=${ctx.requestId || 'none'}`);
      deliveryContextBySessionKey.delete(sessionKey);
    }
  }
}
