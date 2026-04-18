import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  type DisposeWorkerSessionOptions,
  type EnsureWorkerSessionOptions,
  type WorkerRuntimeType,
  type WorkerRunRequest,
  type WorkerSessionStatus,
} from './team-worker-types.js';
import type { SessionOutput, SessionStreamEvent } from './session-types.js';
import type {
  SupervisorDiagnosticsResponse,
  SupervisorHealthResponse,
  SupervisorJsonResponse,
  SupervisorRunStreamEnvelope,
} from './supervisor-types.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';
import { PROJECT_ROOT } from '../utils/paths.js';

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR_PORT = loadOpenTeamConfig().runtime.supervisor.port;
const SUPERVISOR_BASE_URL = `http://127.0.0.1:${SUPERVISOR_PORT}`;
const RUNTIME_PROJECT_SCOPE = PROJECT_ROOT;

let ensurePromise: Promise<void> | null = null;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SUPERVISOR_BASE_URL}${path}`, init);
  const payload = await response.json() as SupervisorJsonResponse<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error || `Runtime supervisor request failed: ${response.status}`);
  }
  return payload.data;
}

async function fetchNullableJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await fetch(`${SUPERVISOR_BASE_URL}${path}`, init);
  const payload = await response.json() as SupervisorJsonResponse<T | null>;
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Runtime supervisor request failed: ${response.status}`);
  }
  return payload.data ?? null;
}

async function isSupervisorHealthy(): Promise<boolean> {
  try {
    const health = await fetchJson<SupervisorHealthResponse>('/health');
    return health.ok === true && (!health.projectRoot || resolve(health.projectRoot) === resolve(PROJECT_ROOT));
  } catch {
    return false;
  }
}

async function tryFetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    return await fetchJson<T>(path, init);
  } catch {
    return null;
  }
}

function spawnSupervisorProcess(): void {
  const compiledEntry = join(PROJECT_ROOT, 'dist', 'server', 'runtime-supervisor', 'index.js');
  const sourceEntry = join(PROJECT_ROOT, 'server', 'runtime-supervisor', 'index.ts');
  const isCompiled = CURRENT_DIR.includes('/dist/');
  const command = process.execPath;
  const args = isCompiled && existsSync(compiledEntry)
    ? [compiledEntry]
    : ['--import', 'tsx', sourceEntry];

  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

async function waitForSupervisorShutdown(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await isSupervisorHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Runtime supervisor failed to stop within ${timeoutMs}ms`);
}

export async function ensureRuntimeSupervisor(): Promise<void> {
  if (await isSupervisorHealthy()) {
    return;
  }

  if (!ensurePromise) {
    ensurePromise = (async () => {
      spawnSupervisorProcess();
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await isSupervisorHealthy()) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error('Runtime supervisor failed to start within 15s');
    })().finally(() => {
      ensurePromise = null;
    });
  }

  await ensurePromise;
}

export async function restartRuntimeSupervisor(): Promise<SupervisorHealthResponse> {
  const health = await getRuntimeSupervisorHealth();
  if (health?.pid) {
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ESRCH') {
        throw error;
      }
    }
    await waitForSupervisorShutdown();
  }

  await ensureRuntimeSupervisor();
  const restarted = await getRuntimeSupervisorHealth();
  if (!restarted?.ok) {
    throw new Error('Runtime supervisor did not report healthy after restart');
  }
  return restarted;
}

export async function getRuntimeSupervisorHealth(): Promise<SupervisorHealthResponse | null> {
  return await tryFetchJson<SupervisorHealthResponse>('/health');
}

export async function getRuntimeSupervisorDiagnostics(
  options?: { ensure?: boolean },
): Promise<SupervisorDiagnosticsResponse | null> {
  if (options?.ensure) {
    await ensureRuntimeSupervisor();
  }
  return await tryFetchJson<SupervisorDiagnosticsResponse>('/diagnostics');
}

export async function ensureSupervisorSession(
  runtime: WorkerRuntimeType,
  options: EnsureWorkerSessionOptions,
): Promise<WorkerSessionStatus> {
  await ensureRuntimeSupervisor();
  return await fetchJson<WorkerSessionStatus>('/sessions/ensure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runtime,
      options: {
        ...options,
        projectScope: options.projectScope || RUNTIME_PROJECT_SCOPE,
      },
    }),
  });
}

export async function disposeSupervisorSession(
  runtime: WorkerRuntimeType,
  options: DisposeWorkerSessionOptions,
): Promise<WorkerSessionStatus | null> {
  await ensureRuntimeSupervisor();
  return await fetchNullableJson<WorkerSessionStatus>('/sessions/dispose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      runtime,
      options: {
        ...options,
        projectScope: options.projectScope || RUNTIME_PROJECT_SCOPE,
      },
    }),
  });
}

export async function shutdownSupervisorSessions(
  runtime: WorkerRuntimeType,
  teamId: string,
  reason?: string,
): Promise<WorkerSessionStatus[]> {
  await ensureRuntimeSupervisor();
  return await fetchJson<WorkerSessionStatus[]>('/sessions/shutdown', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runtime, teamId, projectScope: RUNTIME_PROJECT_SCOPE, reason }),
  });
}

export async function listSupervisorSessions(
  runtime: WorkerRuntimeType,
  teamId: string,
  projectScope?: string | null,
): Promise<WorkerSessionStatus[]> {
  await ensureRuntimeSupervisor();
  const search = new URLSearchParams({ runtime, teamId });
  search.set('projectScope', projectScope?.trim() || RUNTIME_PROJECT_SCOPE);
  return await fetchJson<WorkerSessionStatus[]>(`/sessions/list?${search.toString()}`);
}

export async function runSupervisorWorker(
  request: WorkerRunRequest,
  handlers: {
    onEvent: (event: SessionStreamEvent) => void;
  },
): Promise<SessionOutput> {
  await ensureRuntimeSupervisor();
  const response = await fetch(`${SUPERVISOR_BASE_URL}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      request: {
        ...request,
        projectScope: request.projectScope || request.options.projectScope || RUNTIME_PROJECT_SCOPE,
      },
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Runtime supervisor run failed: ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalOutput: SessionOutput | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const payload = JSON.parse(line) as SupervisorRunStreamEnvelope;
      handlers.onEvent(payload.event);
      if (payload.event.type === 'result') {
        finalOutput = payload.event.output;
      }
    }
  }

  if (!finalOutput) {
    throw new Error('Runtime supervisor stream ended without a result event');
  }

  return finalOutput;
}
