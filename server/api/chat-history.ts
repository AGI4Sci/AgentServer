import type { IncomingMessage, ServerResponse } from 'http';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

export async function handleChatHistoryRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const match = url.pathname.match(/^\/api\/teams\/([^/]+)\/chat-history(?:\/(new-session|select-session|delete-session))?$/);
  if (!match) {
    return false;
  }

  const teamId = decodeURIComponent(match[1]);
  const action = match[2] || null;
  const store = getTeamChatStore();

  if (!action && method === 'GET') {
    const sessionId = url.searchParams.get('sessionId');
    sendJson(res, 200, {
      ok: true,
      teamId,
      activeSessionId: store.getActiveSessionId(teamId),
      sessions: store.listSessions(teamId),
      history: store.getHistory(teamId, sessionId),
    });
    return true;
  }

  if (action === 'new-session' && method === 'POST') {
    const session = store.startNewSession(teamId);
    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (action === 'select-session' && method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string };
    const session = payload.sessionId ? store.selectSession(teamId, payload.sessionId) : null;
    if (!session) {
      sendJson(res, 404, { ok: false, error: 'Session not found' });
      return true;
    }
    sendJson(res, 200, { ok: true, session });
    return true;
  }

  if (action === 'delete-session' && method === 'POST') {
    const payload = JSON.parse((await readBody(req)) || '{}') as { sessionId?: string };
    if (!payload.sessionId) {
      sendJson(res, 400, { ok: false, error: 'Missing sessionId' });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      ...store.deleteSession(teamId, payload.sessionId),
    });
    return true;
  }

  sendJson(res, 405, { ok: false, error: 'Method not allowed' });
  return true;
}
