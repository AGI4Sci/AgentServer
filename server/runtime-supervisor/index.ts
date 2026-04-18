import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { listBackendModelContracts } from '../runtime/backend-model-contract.js';
import {
  disposeRuntimeWorkerSession,
  ensureRuntimeWorkerSession,
  listAllRuntimeWorkerSessions,
  listRuntimeWorkerSessions,
  runTeamWorker,
  shutdownRuntimeWorkerSessions,
} from '../runtime/team-worker-manager.js';
import {
  loadRuntimeSessionSnapshot,
  saveRuntimeSessionSnapshot,
} from '../runtime/supervisor-snapshot-store.js';
import type {
  SupervisorDiagnosticsResponse,
  SupervisorDisposeSessionRequest,
  SupervisorEnsureSessionRequest,
  SupervisorJsonResponse,
  SupervisorRunRequest,
  SupervisorRunStreamEnvelope,
  SupervisorShutdownSessionsRequest,
} from '../runtime/supervisor-types.js';
import type { WorkerRuntimeType } from '../runtime/team-worker-types.js';
import { normalizeSessionStreamEvent } from '../runtime/runtime-event-contract.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';
import { handleCodexChatResponsesAdapter } from './codex-chat-responses-adapter.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = CURRENT_DIR.includes('/dist/')
  ? resolve(CURRENT_DIR, '../../..')
  : resolve(CURRENT_DIR, '../..');

const SUPERVISOR_PORT = loadOpenTeamConfig().runtime.supervisor.port;
const SUPERVISOR_STARTED_AT = new Date().toISOString();
const SUPERVISOR_REQUEST_LOG_PATH = join(PROJECT_ROOT, 'tmp', 'runtime-supervisor-requests.log');
const SNAPSHOT_FLUSH_INTERVAL_MS = Math.max(
  5_000,
  loadOpenTeamConfig().runtime.supervisor.snapshotFlushMs,
);
const restoreState = {
  inProgress: false,
  lastStartedAt: null as string | null,
  lastCompletedAt: null as string | null,
  restoredCount: 0,
  errors: [] as string[],
};

function logSupervisorFailure(scope: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(`[runtime-supervisor] ${scope}: ${message}`);
}

function logSupervisorRequest(req: IncomingMessage): void {
  const url = req.url || '/';
  if (!/codex|responses/i.test(url)) {
    return;
  }
  try {
    mkdirSync(join(PROJECT_ROOT, 'tmp'), { recursive: true });
    appendFileSync(
      SUPERVISOR_REQUEST_LOG_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        method: req.method || 'GET',
        url,
      })}\n`,
      'utf8',
    );
  } catch {
    // Ignore logging failures.
  }
}

process.on('unhandledRejection', (reason) => {
  logSupervisorFailure('unhandledRejection', reason);
});

process.on('uncaughtException', (error) => {
  logSupervisorFailure('uncaughtException', error);
});

function writeJson<T>(res: ServerResponse, statusCode: number, body: SupervisorJsonResponse<T>): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function persistSnapshot() {
  return saveRuntimeSessionSnapshot(listAllRuntimeWorkerSessions());
}

function buildDiagnostics(): SupervisorDiagnosticsResponse {
  const sessions = listAllRuntimeWorkerSessions();
  const grouped = new Map<WorkerRuntimeType, {
    runtime: WorkerRuntimeType;
    sessionCount: number;
    readyCount: number;
    busyCount: number;
    errorCount: number;
  }>();

  for (const session of sessions) {
    const current = grouped.get(session.runtime) || {
      runtime: session.runtime,
      sessionCount: 0,
      readyCount: 0,
      busyCount: 0,
      errorCount: 0,
    };
    current.sessionCount += 1;
    if (session.status === 'ready') {
      current.readyCount += 1;
    }
    if (session.status === 'busy') {
      current.busyCount += 1;
    }
    if (session.status === 'error') {
      current.errorCount += 1;
    }
    grouped.set(session.runtime, current);
  }

  return {
    ok: true,
    service: 'runtime-supervisor',
    pid: process.pid,
    startedAt: SUPERVISOR_STARTED_AT,
    contracts: listBackendModelContracts(),
    sessions,
    snapshot: loadRuntimeSessionSnapshot(),
    summary: Array.from(grouped.values()).sort((left, right) => left.runtime.localeCompare(right.runtime)),
    restore: {
      inProgress: restoreState.inProgress,
      lastStartedAt: restoreState.lastStartedAt,
      lastCompletedAt: restoreState.lastCompletedAt,
      restoredCount: restoreState.restoredCount,
      errorCount: restoreState.errors.length,
      errors: [...restoreState.errors],
    },
  };
}

async function restoreSessionsFromSnapshot(): Promise<void> {
  const snapshot = loadRuntimeSessionSnapshot();
  restoreState.inProgress = true;
  restoreState.lastStartedAt = new Date().toISOString();
  restoreState.lastCompletedAt = null;
  restoreState.restoredCount = 0;
  restoreState.errors = [];

  for (const entry of snapshot.sessions) {
    try {
      if (!entry.projectScope?.trim()) {
        restoreState.errors.push(
          `${entry.runtime}/${entry.teamId}/${entry.agentId}: skipped legacy snapshot entry without projectScope`,
        );
        continue;
      }
      await ensureRuntimeWorkerSession(entry.runtime, {
        teamId: entry.teamId,
        agentId: entry.agentId,
        projectScope: entry.projectScope,
        cwd: entry.cwd || undefined,
        model: entry.model,
        modelProvider: entry.modelProvider,
        modelName: entry.modelName,
        sessionMode: entry.sessionMode ?? 'persistent',
        persistentKey: entry.persistentKey ?? undefined,
      });
      restoreState.restoredCount += 1;
    } catch (error) {
      restoreState.errors.push(
        `${entry.runtime}/${entry.teamId}/${entry.agentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  restoreState.inProgress = false;
  restoreState.lastCompletedAt = new Date().toISOString();
  persistSnapshot();
}

async function readJsonBody<T extends object>(req: IncomingMessage): Promise<Partial<T>> {
  const body = await new Promise<string>((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as Partial<T>;
  } catch {
    return {};
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || 'GET';
  const url = req.url || '/';
  logSupervisorRequest(req);

  if (await handleCodexChatResponsesAdapter(req, res)) {
    return;
  }

  if (url === '/health' && method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      data: {
        ok: true,
        service: 'runtime-supervisor',
        pid: process.pid,
        startedAt: SUPERVISOR_STARTED_AT,
      },
    });
    return;
  }

  if (url === '/diagnostics' && method === 'GET') {
    writeJson(res, 200, {
      ok: true,
      data: buildDiagnostics(),
    });
    return;
  }

  if (url === '/sessions/ensure' && method === 'POST') {
    const body = await readJsonBody<SupervisorEnsureSessionRequest>(req);
    if (!body.runtime || !body.options) {
      writeJson(res, 400, { ok: false, error: 'Missing runtime or options' });
      return;
    }
    const session = await ensureRuntimeWorkerSession(body.runtime, body.options);
    persistSnapshot();
    writeJson(res, 200, { ok: true, data: session });
    return;
  }

  if (url === '/sessions/dispose' && method === 'POST') {
    const body = await readJsonBody<SupervisorDisposeSessionRequest>(req);
    if (!body.runtime || !body.options) {
      writeJson(res, 400, { ok: false, error: 'Missing runtime or options' });
      return;
    }
    const session = disposeRuntimeWorkerSession(body.runtime, body.options);
    persistSnapshot();
    writeJson(res, 200, { ok: true, data: session ?? null });
    return;
  }

  if (url === '/sessions/shutdown' && method === 'POST') {
    const body = await readJsonBody<SupervisorShutdownSessionsRequest>(req);
    if (!body.runtime || !body.teamId) {
      writeJson(res, 400, { ok: false, error: 'Missing runtime or teamId' });
      return;
    }
    const sessions = shutdownRuntimeWorkerSessions(body.runtime, body.teamId, body.projectScope, body.reason);
    persistSnapshot();
    writeJson(res, 200, { ok: true, data: sessions });
    return;
  }

  if (url.startsWith('/sessions/list') && method === 'GET') {
    const requestUrl = new URL(url, `http://127.0.0.1:${SUPERVISOR_PORT}`);
    const runtime = requestUrl.searchParams.get('runtime');
    const teamId = requestUrl.searchParams.get('teamId');
    const projectScope = requestUrl.searchParams.get('projectScope');
    if (!runtime || !teamId) {
      writeJson(res, 400, { ok: false, error: 'Missing runtime or teamId' });
      return;
    }
    const sessions = listRuntimeWorkerSessions(runtime as WorkerRuntimeType, teamId, projectScope);
    writeJson(res, 200, { ok: true, data: sessions });
    return;
  }

  if (url === '/runs' && method === 'POST') {
    const body = await readJsonBody<SupervisorRunRequest>(req);
    if (!body.request) {
      writeJson(res, 400, { ok: false, error: 'Missing request' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });

    const emit = (event: SupervisorRunStreamEnvelope): void => {
      res.write(`${JSON.stringify({ event: normalizeSessionStreamEvent(event.event) })}\n`);
    };

    try {
      await runTeamWorker(body.request, {
        onEvent: (event) => {
          if (event.type === 'tool-call') {
            emit({
              event: {
                type: 'tool-call',
                toolName: event.toolName,
                detail: event.detail,
                raw: event.raw,
              },
            });
            return;
          }
          if (event.type === 'tool-result') {
            emit({
              event: {
                type: 'tool-result',
                toolName: event.toolName,
                detail: event.detail,
                output: event.output,
                raw: event.raw,
              },
            });
            return;
          }
          if (event.type === 'permission-request') {
            emit({
              event: {
                type: 'permission-request',
                requestId: event.permissionId,
                toolName: event.toolName,
                detail: event.detail,
                raw: event.raw,
              },
            });
            return;
          }
          if (event.type === 'status') {
            emit({
              event: {
                type: 'status',
                status: event.status,
                message: event.message,
              },
            });
            return;
          }
          if (event.type === 'text-delta') {
            emit({
              event: {
                type: 'text-delta',
                text: event.text,
              },
            });
            return;
          }
          if (event.type === 'result') {
            emit({
              event: {
                type: 'result',
                output: event.output,
                usage: event.usage,
              },
            });
            return;
          }
          if (event.type === 'error') {
            emit({
              event: {
                type: 'error',
                error: event.error,
                raw: event.raw,
              },
            });
          }
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit({
        event: {
          type: 'error',
          error: message,
          raw: error,
        },
      });
      emit({
        event: {
          type: 'result',
          output: {
            success: false,
            error: message,
          },
        },
      });
    } finally {
      persistSnapshot();
    }

    res.end();
    return;
  }

  writeJson(res, 404, { ok: false, error: 'Not found' });
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    writeJson(res, 500, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
});

const snapshotFlushHandle = setInterval(() => {
  try {
    persistSnapshot();
  } catch (error) {
    logSupervisorFailure('snapshotFlush', error);
  }
}, SNAPSHOT_FLUSH_INTERVAL_MS);
snapshotFlushHandle.unref();

server.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
  console.log(`[runtime-supervisor] listening on http://127.0.0.1:${SUPERVISOR_PORT}`);
  void restoreSessionsFromSnapshot().catch((error) => {
    restoreState.inProgress = false;
    restoreState.lastCompletedAt = new Date().toISOString();
    restoreState.errors.push(error instanceof Error ? error.message : String(error));
    logSupervisorFailure('restoreSessionsFromSnapshot', error);
  });
});
