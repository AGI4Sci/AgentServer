import type { IncomingMessage, ServerResponse } from 'http';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, join } from 'path';
import { promisify } from 'util';
import { isBackendType, type BackendType } from '../../core/runtime/backend-catalog.js';
import { getTeamRegistry } from '../../core/team/registry.js';
import { error, sendJson, success } from '../utils/response.js';
import {
  listBackendModelContracts,
  resolveBackendModelSelection,
} from '../runtime/backend-model-contract.js';
import { getRuntimeSupervisorDiagnostics, getRuntimeSupervisorHealth } from '../runtime/supervisor-client.js';
import { getSessionRunner, resolveRuntimeBackend } from '../runtime/session-runner-registry.js';
import type {
  RunSessionOptions,
  RuntimeSessionMode,
  SessionInput,
  SessionOutput,
  SessionStreamEvent,
} from '../runtime/session-types.js';
import { normalizeSessionStreamEvent } from '../runtime/runtime-event-contract.js';
import { PROJECT_ROOT } from '../utils/paths.js';

const execFileAsync = promisify(execFile);

interface RuntimeRunRequest {
  backend?: BackendType;
  teamId: string;
  agentId: string;
  task?: string;
  context?: string;
  cwd?: string;
  model?: string;
  modelProvider?: string;
  modelName?: string;
  timeoutMs?: number;
  sessionMode?: RuntimeSessionMode;
  persistentKey?: string;
}

export async function handleRuntimeRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  if (url === '/api/runtime/runs' && method === 'POST') {
    await handleCreateRuntimeRun(req, res);
    return true;
  }

  if (url.startsWith('/api/runtime/diagnostics') && method === 'GET') {
    await handleGetRuntimeDiagnostics(req, res);
    return true;
  }

  if (url.startsWith('/api/runtime/observability') && method === 'GET') {
    await handleGetRuntimeObservability(req, res);
    return true;
  }

  return false;
}

async function listListeningPorts(): Promise<Array<{
  command: string;
  pid: number | null;
  user: string | null;
  protocol: string;
  address: string;
  port: number | null;
}>> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return String(stdout || '')
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 9)
      .map((parts) => {
        const name = parts[8] || '';
        const portMatch = name.match(/:(\d+)(?:\s|\(|$)/);
        return {
          command: parts[0] || '',
          pid: Number.isFinite(Number(parts[1])) ? Number(parts[1]) : null,
          user: parts[2] || null,
          protocol: parts[7] || 'TCP',
          address: name,
          port: portMatch ? Number(portMatch[1]) : null,
        };
      })
      .filter((row) => row.port != null)
      .slice(0, 80);
  } catch {
    return [];
  }
}

async function listRecentLogFiles(): Promise<Array<{
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  tail: string;
}>> {
  const logDir = join(PROJECT_ROOT, 'tmp');
  if (!existsSync(logDir)) {
    return [];
  }
  const entries = await readdir(logDir, { withFileTypes: true }).catch(() => []);
  const rows = await Promise.all(entries
    .filter((entry) => entry.isFile() && /\.log$/i.test(entry.name))
    .map(async (entry) => {
      const path = join(logDir, entry.name);
      const info = await stat(path);
      const content = await readFile(path, 'utf-8').catch(() => '');
      const tail = content.split(/\r?\n/).slice(-20).join('\n').slice(-4000);
      return {
        name: basename(path),
        path,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
        tail,
      };
    }));
  return rows
    .sort((a, b) => String(b.modifiedAt).localeCompare(String(a.modifiedAt)))
    .slice(0, 16);
}

async function handleGetRuntimeObservability(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const [ports, logs] = await Promise.all([
      listListeningPorts(),
      listRecentLogFiles(),
    ]);
    sendJson(res, 200, success({
      checkedAt: new Date().toISOString(),
      ports,
      logs,
    }));
  } catch (err) {
    sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
  }
}

async function handleCreateRuntimeRun(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const body = await readJsonBody<RuntimeRunRequest>(req);
    if (!body.teamId || !body.agentId) {
      sendJson(res, 400, error('teamId and agentId are required'));
      return;
    }

    const registry = getTeamRegistry(body.teamId);
    if (!registry) {
      sendJson(res, 404, error(`Team not found: ${body.teamId}`));
      return;
    }

    const backend = body.backend
      ? (isBackendType(body.backend) ? body.backend : null)
      : resolveRuntimeBackend(registry.raw.runtime);
    if (!backend) {
      sendJson(res, 400, error('Invalid backend'));
      return;
    }

    const modelSelection = resolveBackendModelSelection(backend, {
      model: body.model,
      modelProvider: body.modelProvider,
      modelName: body.modelName,
    });

    const input: SessionInput = {
      task: body.task?.trim() || body.context?.trim() || '',
      context: body.context?.trim() || '',
    };

    const options: RunSessionOptions = {
      backend,
      teamId: body.teamId,
      agentId: body.agentId,
      projectScope: PROJECT_ROOT,
      cwd: body.cwd,
      model: modelSelection.modelIdentifier ?? undefined,
      modelProvider: modelSelection.modelProvider ?? undefined,
      modelName: modelSelection.modelName ?? undefined,
      timeoutMs: body.timeoutMs,
      sessionMode: body.sessionMode ?? 'ephemeral',
      persistentKey: body.persistentKey?.trim() || undefined,
      requestId: `runtime-run-${Date.now()}`,
      sessionKey: `runtime-run:${body.teamId}:${body.agentId}:${Date.now()}`,
    };

    const events: SessionStreamEvent[] = [];
    let output: SessionOutput;
    try {
      output = await getSessionRunner(backend).runStream(input, options, {
        onEvent: (event) => {
          events.push(normalizeSessionStreamEvent(event));
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      events.push(normalizeSessionStreamEvent({ type: 'error', error: message, raw: error }));
      output = {
        success: false,
        error: message,
      };
      events.push(normalizeSessionStreamEvent({ type: 'result', output }));
    }

    sendJson(res, 200, success({
      backend,
      teamId: body.teamId,
      agentId: body.agentId,
      modelSelection,
      input,
      output,
      events,
    }));
  } catch (err) {
    console.error('[API] Failed to create runtime run:', err);
    sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body) as T);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

async function handleGetRuntimeDiagnostics(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const requestUrl = new URL(req.url || '/api/runtime/diagnostics', 'http://127.0.0.1');
    const ensure = requestUrl.searchParams.get('ensure') === '1';
    const [health, diagnostics] = await Promise.all([
      getRuntimeSupervisorHealth(),
      getRuntimeSupervisorDiagnostics({ ensure }),
    ]);

    sendJson(res, 200, success({
      supervisor: {
        healthy: Boolean(health),
        health,
        diagnostics,
      },
      contracts: listBackendModelContracts(),
    }));
  } catch (err) {
    console.error('[API] Failed to load runtime diagnostics:', err);
    sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
  }
}
