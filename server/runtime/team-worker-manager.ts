import type { SessionOutput } from './session-types.js';
import type {
  DisposeWorkerSessionOptions,
  EnsureWorkerSessionOptions,
  WorkerEvent,
  WorkerRunRequest,
  WorkerRuntimeType,
  WorkerSessionStatus,
} from './team-worker-types.js';
import { ClaudeCodeTeamWorker } from './workers/claude-code-team-worker.js';
import { ClaudeCodeRustTeamWorker } from './workers/claude-code-rust-team-worker.js';
import { CodexTeamWorker } from './workers/codex-team-worker.js';
import { OpenClawTeamWorker } from './workers/openclaw-team-worker.js';
import { ZeroClawTeamWorker } from './workers/zeroclaw-team-worker.js';

interface TeamWorker {
  init(teamId: string): Promise<void>;
  ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus>;
  disposeSession(options: DisposeWorkerSessionOptions): WorkerSessionStatus | null;
  shutdown(reason?: string): WorkerSessionStatus[];
  getSessionStatus(agentId: string, persistentKey?: string | null): WorkerSessionStatus | null;
  listSessionStatuses(): WorkerSessionStatus[];
  run(
    request: WorkerRunRequest,
    handlers: {
      onEvent: (event: WorkerEvent) => void;
    },
  ): Promise<SessionOutput>;
}

const workers = new Map<string, TeamWorker>();

function normalizeProjectScope(projectScope?: string | null): string {
  const normalized = projectScope?.trim();
  return normalized && normalized.length > 0 ? normalized : '__default__';
}

function getWorkerKey(runtime: WorkerRuntimeType, teamId: string, projectScope?: string | null): string {
  return `${runtime}:${normalizeProjectScope(projectScope)}:${teamId}`;
}

function getWorkersForRuntime(
  runtime: WorkerRuntimeType,
  teamId: string,
  projectScope?: string | null,
): TeamWorker[] {
  if (projectScope?.trim()) {
    const exact = workers.get(getWorkerKey(runtime, teamId, projectScope));
    return exact ? [exact] : [];
  }

  const prefix = `${runtime}:`;
  const suffix = `:${teamId}`;
  const matches: TeamWorker[] = [];
  for (const [key, worker] of workers.entries()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      matches.push(worker);
    }
  }
  return matches;
}

function createWorker(runtime: WorkerRuntimeType): TeamWorker {
  if (runtime === 'claude-code') {
    return new ClaudeCodeTeamWorker();
  }
  if (runtime === 'claude-code-rust') {
    return new ClaudeCodeRustTeamWorker();
  }
  if (runtime === 'codex') {
    return new CodexTeamWorker();
  }
  if (runtime === 'openclaw') {
    return new OpenClawTeamWorker();
  }
  if (runtime === 'zeroclaw') {
    return new ZeroClawTeamWorker();
  }
  throw new Error(`Team worker not implemented for runtime: ${runtime}`);
}

export async function runTeamWorker(
  request: WorkerRunRequest,
  handlers: {
    onEvent: (event: WorkerEvent) => void;
  },
): Promise<SessionOutput> {
  const worker = await getOrCreateWorker(request.runtime, request.teamId, request.projectScope);
  return await worker.run(request, handlers);
}

async function getOrCreateWorker(
  runtime: WorkerRuntimeType,
  teamId: string,
  projectScope?: string | null,
): Promise<TeamWorker> {
  const key = getWorkerKey(runtime, teamId, projectScope);
  let worker = workers.get(key);
  if (!worker) {
    worker = createWorker(runtime);
    workers.set(key, worker);
    await worker.init(teamId);
  }
  return worker;
}

export function supportsRuntimeSupervisor(runtime: string): runtime is WorkerRuntimeType {
  return runtime === 'claude-code'
    || runtime === 'claude-code-rust'
    || runtime === 'codex'
    || runtime === 'openclaw'
    || runtime === 'zeroclaw';
}

export async function ensureRuntimeWorkerSession(
  runtime: WorkerRuntimeType,
  options: EnsureWorkerSessionOptions,
): Promise<WorkerSessionStatus> {
  const worker = await getOrCreateWorker(runtime, options.teamId, options.projectScope);
  return await worker.ensureSession(options);
}

export function getRuntimeWorkerSessionStatus(
  runtime: WorkerRuntimeType,
  teamId: string,
  agentId: string,
  projectScope?: string | null,
  persistentKey?: string | null,
): WorkerSessionStatus | null {
  for (const worker of getWorkersForRuntime(runtime, teamId, projectScope)) {
    const session = worker.getSessionStatus(agentId, persistentKey);
    if (session) {
      return session;
    }
  }
  return null;
}

export function listRuntimeWorkerSessions(
  runtime: WorkerRuntimeType,
  teamId: string,
  projectScope?: string | null,
): WorkerSessionStatus[] {
  return getWorkersForRuntime(runtime, teamId, projectScope)
    .flatMap((worker) => worker.listSessionStatuses());
}

export function listAllRuntimeWorkerSessions(): WorkerSessionStatus[] {
  const sessions: WorkerSessionStatus[] = [];
  for (const worker of workers.values()) {
    sessions.push(...worker.listSessionStatuses());
  }
  sessions.sort((left, right) => {
    if (left.runtime !== right.runtime) {
      return left.runtime.localeCompare(right.runtime);
    }
    if (left.teamId !== right.teamId) {
      return left.teamId.localeCompare(right.teamId);
    }
    return left.agentId.localeCompare(right.agentId);
  });
  return sessions;
}

export function disposeRuntimeWorkerSession(
  runtime: WorkerRuntimeType,
  options: DisposeWorkerSessionOptions,
): WorkerSessionStatus | null {
  const worker = workers.get(getWorkerKey(runtime, options.teamId, options.projectScope));
  return worker?.disposeSession(options) || null;
}

export function shutdownRuntimeWorkerSessions(
  runtime: WorkerRuntimeType,
  teamId: string,
  projectScope?: string | null,
  reason?: string,
): WorkerSessionStatus[] {
  const key = getWorkerKey(runtime, teamId, projectScope);
  const worker = workers.get(key);
  if (!worker) {
    return [];
  }
  const closed = worker.shutdown(reason);
  workers.delete(key);
  return closed;
}
