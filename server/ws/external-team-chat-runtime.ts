import { WebSocket } from 'ws';
import type { InboundMessage, OutboundMessage } from '../../core/types/index.js';

export interface ExternalTeamChatRuntimeOptions {
  teamId: string;
  prompt: string;
  requestId: string;
  targetAgentId: string;
  timeoutMs: number;
  wsUrl: string;
}

export interface ExternalTeamChatRuntimeResult {
  events: OutboundMessage[];
  finalMessage: OutboundMessage | null;
  timedOut: boolean;
  sessionId: string | null;
}

function isCoordinatorTerminalMessage(message: OutboundMessage, targetAgentId: string): boolean {
  const from = String(message.from || '').trim();
  const to = String(message.to || '').trim();
  if (message.type === 'agent-blocked') {
    return from === targetAgentId;
  }
  return (
    (message.type === 'agent-reply' || message.type === 'agent-chat-final')
    && from === targetAgentId
    && to === 'user'
  );
}

function isMessageRelevant(message: OutboundMessage, requestId: string, sessionId: string | null): boolean {
  if (message.type === 'session-init') {
    return true;
  }
  if (String(message.requestId || '').trim() === requestId) {
    return true;
  }
  if (sessionId && String(message.sessionId || '').trim() === sessionId) {
    return true;
  }
  return false;
}

export function normalizeHttpBaseUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function deriveWebSocketUrl(input: string): string {
  const normalized = normalizeHttpBaseUrl(input);
  if (!normalized) {
    throw new Error('Missing server base URL');
  }
  if (normalized.startsWith('ws://') || normalized.startsWith('wss://')) {
    return normalized;
  }
  if (normalized.startsWith('http://')) {
    return `ws://${normalized.slice('http://'.length)}`;
  }
  if (normalized.startsWith('https://')) {
    return `wss://${normalized.slice('https://'.length)}`;
  }
  return `ws://${normalized.replace(/^\/+/, '')}`;
}

export async function runExternalTeamChatRuntime(
  options: ExternalTeamChatRuntimeOptions,
): Promise<ExternalTeamChatRuntimeResult> {
  const ws = new WebSocket(options.wsUrl);
  const events: OutboundMessage[] = [];
  let finalMessage: OutboundMessage | null = null;
  let timedOut = false;
  let sessionId: string | null = null;

  await new Promise<void>((resolve, reject) => {
    let initialized = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        ws.close();
      } catch {}
      resolve();
    }, options.timeoutMs);

    ws.on('open', () => {
      // Wait for session-init before sending the first user message.
    });

    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as OutboundMessage;

      if (!initialized && message.type === 'session-init') {
        initialized = true;
        sessionId = String(message.sessionId || '').trim() || null;
        events.push(message);
        const payload: InboundMessage = {
          type: 'user-message',
          to: options.targetAgentId,
          body: options.prompt,
          requestId: options.requestId,
          sessionId: sessionId || undefined,
          context: {
            teamId: options.teamId,
            projectId: 'external-smoke',
          },
          timestamp: new Date().toISOString(),
        };
        ws.send(JSON.stringify(payload));
        return;
      }

      if (!isMessageRelevant(message, options.requestId, sessionId)) {
        return;
      }

      events.push(message);

      if (isCoordinatorTerminalMessage(message, options.targetAgentId)) {
        finalMessage = message;
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        resolve();
      }
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    ws.on('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });

  return {
    events,
    finalMessage,
    timedOut,
    sessionId,
  };
}
