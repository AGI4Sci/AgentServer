import type { SessionRunner, SessionStreamEvent, SessionOutput } from '../session-types.js';
import { formatRuntimeError } from '../session-types.js';
import { withRuntimeEventProtocol } from '../runtime-event-contract.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from '../model-spec.js';
import type {
  DisposeWorkerSessionOptions,
  EnsureWorkerSessionOptions,
  WorkerEvent,
  WorkerRunRequest,
  WorkerRuntimeType,
  WorkerSessionStatus,
} from '../team-worker-types.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

const DEFAULT_IDLE_TTL_MS = Math.max(
  60_000,
  loadOpenTeamConfig().runtime.worker.idleTtlMs,
);
const DEFAULT_IDLE_SWEEP_MS = Math.max(
  15_000,
  loadOpenTeamConfig().runtime.worker.idleSweepMs,
);

type ActiveRun = {
  request: WorkerRunRequest;
  onEvent: (event: WorkerEvent) => void;
  resolve: (output: SessionOutput) => void;
  settled: boolean;
  timeoutHandle?: NodeJS.Timeout;
};

type GenericRuntimeSession = {
  cacheKey: string;
  runtime: WorkerRuntimeType;
  teamId: string;
  agentId: string;
  projectScope: string | null;
  sessionMode: 'ephemeral' | 'persistent';
  persistentKey: string | null;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  modelName: string | null;
  status: 'starting' | 'ready' | 'busy' | 'error' | 'offline';
  startedAt: string | null;
  lastUsedAt: string;
  lastEventAt: string | null;
  lastError: string | null;
  lastRequestId: string | null;
  lastSessionKey: string | null;
  activeRun: ActiveRun | null;
};

type WorkerEventPayload = WorkerEvent extends infer T
  ? T extends {
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
    }
    ? Omit<T, 'teamId' | 'agentId' | 'requestId' | 'sessionKey'>
    : never
  : never;

function emitWorkerEvent(
  request: WorkerRunRequest,
  run: ActiveRun,
  event: WorkerEventPayload,
): void {
  run.onEvent(withRuntimeEventProtocol({
    ...event,
    teamId: request.teamId,
    agentId: request.agentId,
    requestId: request.requestId,
    sessionKey: request.sessionKey,
  } as WorkerEvent));
}

function settleRun(request: WorkerRunRequest, run: ActiveRun, output: SessionOutput): void {
  if (run.settled) {
    return;
  }
  run.settled = true;
  if (run.timeoutHandle) {
    clearTimeout(run.timeoutHandle);
  }
  if (!output.success) {
    emitWorkerEvent(request, run, {
      type: 'error',
      error: output.error,
    });
  }
  emitWorkerEvent(request, run, {
    type: 'status',
    status: output.success ? 'completed' : 'failed',
    message: output.success ? 'Runtime run completed' : output.error,
  });
  emitWorkerEvent(request, run, {
    type: 'result',
    output,
    usage: output.usage,
  });
  run.resolve(output);
}

function resolveSessionMode(options: EnsureWorkerSessionOptions): 'ephemeral' | 'persistent' {
  return options.sessionMode === 'persistent' ? 'persistent' : 'ephemeral';
}

function resolvePersistentKey(options: EnsureWorkerSessionOptions): string | null {
  const value = options.persistentKey?.trim();
  return value ? value : null;
}

function getSessionCacheKey(options: EnsureWorkerSessionOptions, requestId?: string): string {
  const sessionMode = resolveSessionMode(options);
  const persistentKey = resolvePersistentKey(options);
  const projectScope = options.projectScope?.trim() || '__default__';
  if (sessionMode === 'persistent') {
    return `persistent:${projectScope}:${persistentKey || options.teamId}:${options.agentId}`;
  }
  return `ephemeral:${projectScope}:${options.teamId}:${options.agentId}:${requestId || `warm-${Date.now()}`}`;
}

export class SessionRunnerTeamWorker {
  private readonly sessions = new Map<string, GenericRuntimeSession>();
  private readonly idleTtlMs = DEFAULT_IDLE_TTL_MS;
  private readonly idleSweepHandle: NodeJS.Timeout;

  constructor(
    private readonly runtime: WorkerRuntimeType,
    private readonly runner: SessionRunner,
  ) {
    this.idleSweepHandle = setInterval(() => {
      this.sweepIdleSessions();
    }, DEFAULT_IDLE_SWEEP_MS);
    this.idleSweepHandle.unref();
  }

  async init(_teamId: string): Promise<void> {}

  async ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus> {
    const session = this.getOrCreateSession(options);
    return this.toSessionStatus(session);
  }

  disposeSession(options: DisposeWorkerSessionOptions): WorkerSessionStatus | null {
    const session = this.findSession(options.agentId, options.persistentKey, options.cacheKey);
    if (!session) {
      return null;
    }
    const snapshot = this.toSessionStatus(session);
    if (session.activeRun && !session.activeRun.settled) {
      session.lastError = options.reason || 'Runtime session stopped by supervisor';
      settleRun(session.activeRun.request, session.activeRun, {
        success: false,
        error: session.lastError,
      });
    }
    this.sessions.delete(session.cacheKey);
    return snapshot;
  }

  shutdown(reason = 'Runtime supervisor shutting down'): WorkerSessionStatus[] {
    const snapshots = this.listSessionStatuses();
    for (const session of this.sessions.values()) {
      if (session.activeRun && !session.activeRun.settled) {
        session.lastError = reason;
        settleRun(session.activeRun.request, session.activeRun, {
          success: false,
          error: reason,
        });
      }
    }
    this.sessions.clear();
    clearInterval(this.idleSweepHandle);
    return snapshots;
  }

  getSessionStatus(agentId: string, persistentKey?: string | null): WorkerSessionStatus | null {
    const session = this.findSession(agentId, persistentKey);
    return session ? this.toSessionStatus(session) : null;
  }

  listSessionStatuses(): WorkerSessionStatus[] {
    return Array.from(this.sessions.values()).map((session) => this.toSessionStatus(session));
  }

  async run(
    request: WorkerRunRequest,
    handlers: {
      onEvent: (event: WorkerEvent) => void;
    },
  ): Promise<SessionOutput> {
    const sessionOptions: EnsureWorkerSessionOptions = {
      teamId: request.teamId,
      agentId: request.agentId,
      projectScope: request.projectScope?.trim() || undefined,
      cwd: request.options.cwd,
      model: request.options.model,
      modelProvider: request.options.modelProvider,
      modelName: request.options.modelName,
      sessionMode: request.options.sessionMode,
      persistentKey: request.options.persistentKey,
    };
    const session = this.getOrCreateSession(sessionOptions, request.requestId);
    if (session.activeRun) {
      throw new Error(`${this.runtime} agent ${request.agentId} already has an active run`);
    }

    return await new Promise<SessionOutput>((resolve) => {
      const activeRun: ActiveRun = {
        request,
        onEvent: handlers.onEvent,
        resolve: (output) => {
          session.activeRun = null;
          session.status = output.success ? 'ready' : 'error';
          session.lastUsedAt = new Date().toISOString();
          session.lastEventAt = session.lastUsedAt;
          if (!output.success) {
            session.lastError = output.error;
          }
          if (session.sessionMode === 'ephemeral') {
            this.sessions.delete(session.cacheKey);
          }
          resolve(output);
        },
        settled: false,
      };

      session.activeRun = activeRun;
      session.status = 'busy';
      session.lastUsedAt = new Date().toISOString();
      session.lastEventAt = session.lastUsedAt;
      session.lastError = null;
      session.lastRequestId = request.requestId;
      session.lastSessionKey = request.sessionKey;

      emitWorkerEvent(request, activeRun, {
        type: 'status',
        status: 'starting',
        message: `Launching ${this.runtime} runtime`,
      });

      void this.runner.runStream(request.input, request.options, {
        onEvent: (event) => {
          this.handleRunnerEvent(session, activeRun, event);
        },
      }).then((output) => {
        settleRun(request, activeRun, output);
      }).catch((error) => {
        const formatted = formatRuntimeError(error);
        session.lastError = formatted;
        settleRun(request, activeRun, { success: false, error: formatted });
      });
    });
  }

  private getOrCreateSession(options: EnsureWorkerSessionOptions, requestId?: string): GenericRuntimeSession {
    const cacheKey = getSessionCacheKey(options, requestId);
    const existing = this.sessions.get(cacheKey);
    const nextCwd = options.cwd || process.cwd();
    const nextModel = normalizeConfiguredRuntimeModelIdentifier(options) || null;
    const nextModelProvider = resolveConfiguredRuntimeModelProvider(options) || null;
    const nextModelName = resolveConfiguredRuntimeModelName(options) || null;
    const sessionMode = resolveSessionMode(options);
    const persistentKey = resolvePersistentKey(options);
    if (
      existing
      && existing.cwd === nextCwd
      && existing.model === nextModel
      && existing.modelProvider === nextModelProvider
      && existing.modelName === nextModelName
    ) {
      return existing;
    }

    const session: GenericRuntimeSession = {
      cacheKey,
      runtime: this.runtime,
      teamId: options.teamId,
      agentId: options.agentId,
      projectScope: options.projectScope?.trim() || null,
      sessionMode,
      persistentKey,
      cwd: nextCwd,
      model: nextModel,
      modelProvider: nextModelProvider,
      modelName: nextModelName,
      status: 'ready',
      startedAt: existing?.startedAt || new Date().toISOString(),
      lastUsedAt: existing?.lastUsedAt || new Date().toISOString(),
      lastEventAt: existing?.lastEventAt || new Date().toISOString(),
      lastError: existing?.lastError || null,
      lastRequestId: existing?.lastRequestId || null,
      lastSessionKey: existing?.lastSessionKey || null,
      activeRun: null,
    };
    this.sessions.set(cacheKey, session);
    return session;
  }

  private handleRunnerEvent(
    session: GenericRuntimeSession,
    run: ActiveRun,
    event: SessionStreamEvent,
  ): void {
    session.lastEventAt = new Date().toISOString();
    session.lastUsedAt = session.lastEventAt;

    if (event.type === 'status') {
      if (event.status === 'running') {
        session.status = 'busy';
      } else if (event.status === 'completed') {
        session.status = 'ready';
      } else if (event.status === 'failed') {
        session.status = 'error';
        session.lastError = event.message || session.lastError;
      }
      emitWorkerEvent(run.request, run, event);
      return;
    }

    if (event.type === 'text-delta' || event.type === 'tool-call' || event.type === 'tool-result') {
      emitWorkerEvent(run.request, run, event);
      return;
    }

    if (event.type === 'permission-request') {
      emitWorkerEvent(run.request, run, {
        type: 'permission-request',
        permissionId: event.requestId,
        toolName: event.toolName,
        detail: event.detail,
        raw: event.raw,
      });
      return;
    }

    if (event.type === 'error') {
      session.status = 'error';
      session.lastError = event.error;
      emitWorkerEvent(run.request, run, {
        type: 'status',
        status: 'failed',
        message: event.error,
      });
      return;
    }

    if (event.type === 'result') {
      if (!event.output.success) {
        session.status = 'error';
        session.lastError = event.output.error;
      }
    }
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const [cacheKey, session] of this.sessions.entries()) {
      if (session.activeRun) {
        continue;
      }
      const lastUsed = Date.parse(session.lastUsedAt);
      if (Number.isNaN(lastUsed)) {
        continue;
      }
      if (now - lastUsed >= this.idleTtlMs) {
        this.sessions.delete(cacheKey);
      }
    }
  }

  private toSessionStatus(session: GenericRuntimeSession): WorkerSessionStatus {
    return {
      runtime: session.runtime,
      teamId: session.teamId,
      agentId: session.agentId,
      projectScope: session.projectScope,
      cwd: session.cwd,
      model: session.model,
      modelProvider: session.modelProvider,
      modelName: session.modelName,
      sessionMode: session.sessionMode,
      persistentKey: session.persistentKey,
      pid: null,
      sessionReady: session.status === 'ready',
      online: session.status === 'ready' || session.status === 'busy',
      busy: session.status === 'busy',
      status: session.status,
      startedAt: session.startedAt || undefined,
      lastUsedAt: session.lastUsedAt,
      lastEventAt: session.lastEventAt || undefined,
      lastError: session.lastError,
      cacheKey: session.cacheKey,
      currentRequestId: session.activeRun?.request.requestId || null,
      currentSessionKey: session.activeRun?.request.sessionKey || null,
      lastRequestId: session.lastRequestId,
      lastSessionKey: session.lastSessionKey,
    };
  }

  private findSession(agentId: string, persistentKey?: string | null, cacheKey?: string | null): GenericRuntimeSession | null {
    const normalizedCacheKey = cacheKey?.trim();
    if (normalizedCacheKey) {
      return this.sessions.get(normalizedCacheKey) || null;
    }
    const normalizedKey = persistentKey?.trim();
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId && session.persistentKey === (normalizedKey || null)) {
        return session;
      }
    }
    return null;
  }
}
