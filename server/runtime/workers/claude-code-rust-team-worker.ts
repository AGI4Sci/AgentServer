import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInterface, type Interface } from 'readline';
import { ensureBackendStateDirs } from '../../../core/runtime/backend-paths.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
  resolveRuntimeModelName,
} from '../model-spec.js';
import { resolveHealthyRuntimeBackendConnection } from './runtime-backend-config.js';
import type { SessionOutput } from '../session-types.js';
import { formatRuntimeError } from '../session-types.js';
import { withRuntimeEventProtocol } from '../runtime-event-contract.js';
import type {
  DisposeWorkerSessionOptions,
  EnsureWorkerSessionOptions,
  WorkerEvent,
  WorkerRunRequest,
  WorkerSessionStatus,
} from '../team-worker-types.js';
import { requestDemandsRuntimeToolExecution } from '../shared/runtime-tool-requirements.js';
import { runSharedRuntimeToolFallback } from '../shared/runtime-tool-fallback.js';
import { resolveManagedBackendExecutableForBackend } from './backend-managed-launchers.js';
import {
  containsEmbeddedProviderToolCallText,
  containsUnexecutedToolIntentText,
  runOpenAICompatibleStreamingChat,
  shouldUseDirectOpenAICompatibleRuntime,
} from './openai-compatible-stream.js';
import {
  buildRuntimeCompletedMessage,
  buildRuntimeRunningMessage,
  buildRuntimeStartingMessage,
  buildRuntimeTimeoutMessage,
} from './worker-runtime-labels.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

const CLAUDE_CODE_RUST_DIR = join(process.cwd(), 'server', 'backend', 'claude_code_rust');
const CLAUDE_CODE_RUST_BINARIES = [
  join(CLAUDE_CODE_RUST_DIR, 'target', 'release', process.platform === 'win32' ? 'claude.exe' : 'claude'),
  join(CLAUDE_CODE_RUST_DIR, 'target', 'debug', process.platform === 'win32' ? 'claude.exe' : 'claude'),
];
const CLAUDE_CODE_RUST_MANIFEST = join(CLAUDE_CODE_RUST_DIR, 'Cargo.toml');
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
  textFragments: string[];
  timeoutHandle?: NodeJS.Timeout;
};

type AgentRuntimeSession = {
  cacheKey: string;
  teamId: string;
  agentId: string;
  projectScope: string | null;
  sessionMode: 'ephemeral' | 'persistent';
  persistentKey: string | null;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  modelName: string | null;
  child: ChildProcessWithoutNullStreams | null;
  stdoutReader: Interface | null;
  activeRun: ActiveRun | null;
  status: 'starting' | 'ready' | 'busy' | 'error' | 'offline';
  startedAt: string | null;
  lastUsedAt: string;
  lastEventAt: string | null;
  lastError: string | null;
  lastRequestId: string | null;
  lastSessionKey: string | null;
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
    message: output.success ? buildRuntimeCompletedMessage('Claude Code Rust') : output.error,
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

function resolveClaudeCodeRustCommand(): { command: string; args: string[] } {
  if (process.env.OPENTEAM_CLAUDE_CODE_RUST_EXECUTABLE && existsSync(process.env.OPENTEAM_CLAUDE_CODE_RUST_EXECUTABLE)) {
    return {
      command: process.env.OPENTEAM_CLAUDE_CODE_RUST_EXECUTABLE,
      args: [],
    };
  }

  const managedBinary = resolveManagedBackendExecutableForBackend('claude-code-rust');
  if (managedBinary) {
    return {
      command: managedBinary,
      args: [],
    };
  }

  const localBinary = CLAUDE_CODE_RUST_BINARIES.find((candidate) => existsSync(candidate));
  if (localBinary) {
    return {
      command: localBinary,
      args: [],
    };
  }

  if (!existsSync(CLAUDE_CODE_RUST_MANIFEST)) {
    throw new Error(`Claude Code Rust manifest not found: ${CLAUDE_CODE_RUST_MANIFEST}`);
  }

  const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  if (cargoCheck.error || cargoCheck.status !== 0) {
    throw new Error('cargo is not available in PATH');
  }

  return {
    command: 'cargo',
    args: ['run', '--quiet', '--manifest-path', CLAUDE_CODE_RUST_MANIFEST, '--bin', 'claude', '--'],
  };
}

function buildPrompt(input: WorkerRunRequest['input']): string {
  const task = input.task.trim();
  const context = input.context.trim();
  if (!task) {
    return context;
  }
  if (!context) {
    return task;
  }
  return `${context}\n\n## Primary Task\n${task}`;
}

export class ClaudeCodeRustTeamWorker {
  private readonly sessions = new Map<string, AgentRuntimeSession>();
  private readonly idleTtlMs = DEFAULT_IDLE_TTL_MS;
  private readonly idleSweepHandle: NodeJS.Timeout;

  constructor() {
    this.idleSweepHandle = setInterval(() => {
      this.sweepIdleSessions();
    }, DEFAULT_IDLE_SWEEP_MS);
    this.idleSweepHandle.unref();
  }

  async init(_teamId: string): Promise<void> {}

  async ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus> {
    const session = await this.getOrCreateSession({
      type: 'run',
      runtime: 'claude-code-rust',
      teamId: options.teamId,
      agentId: options.agentId,
      requestId: `warm-${Date.now()}`,
      sessionKey: `warm:${options.teamId}:${options.agentId}:${Date.now()}`,
      input: {
        task: '',
        context: '',
      },
      options: {
        backend: 'claude-code-rust',
        teamId: options.teamId,
        agentId: options.agentId,
        cwd: options.cwd,
        model: resolveConfiguredRuntimeModelName(options) || resolveRuntimeModelName(options.model),
        modelProvider: resolveConfiguredRuntimeModelProvider(options),
        modelName: resolveConfiguredRuntimeModelName(options),
        sessionMode: options.sessionMode,
        persistentKey: options.persistentKey,
      },
    });
    return this.toSessionStatus(session);
  }

  disposeSession(options: DisposeWorkerSessionOptions): WorkerSessionStatus | null {
    const session = this.findSession(options.agentId, options.persistentKey, options.cacheKey);
    if (!session) {
      return null;
    }
    const snapshot = this.toSessionStatus(session);
    this.closeSession(session, options.reason || 'Runtime session stopped by supervisor', true);
    return snapshot;
  }

  shutdown(reason = 'Runtime supervisor shutting down'): WorkerSessionStatus[] {
    const snapshots = this.listSessionStatuses();
    for (const session of this.sessions.values()) {
      this.closeSession(session, reason, false);
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
    const requiresRealTools = requestDemandsRuntimeToolExecution(request);
    const useDirectRuntime = shouldUseDirectOpenAICompatibleRuntime(request)
      && process.env.OPENTEAM_CLAUDE_CODE_RUST_FORCE_NATIVE !== '1';
    const session = await this.getOrCreateSession(request, !useDirectRuntime);
    if (session.activeRun) {
      throw new Error(`Claude Code Rust agent ${request.agentId} already has an active run`);
    }

    return await new Promise<SessionOutput>((resolve) => {
      const activeRun: ActiveRun = {
        request,
        onEvent: handlers.onEvent,
        resolve: (output) => {
          session.activeRun = null;
          session.status = session.child && !session.child.killed ? 'ready' : 'offline';
          session.lastUsedAt = new Date().toISOString();
          session.lastEventAt = session.lastUsedAt;
          if (session.sessionMode === 'ephemeral') {
            this.closeSession(session, 'Ephemeral session completed', true);
          }
          resolve(output);
        },
        settled: false,
        textFragments: [],
      };

      session.activeRun = activeRun;
      session.status = 'busy';
      session.lastUsedAt = new Date().toISOString();
      session.lastEventAt = session.lastUsedAt;
      session.lastRequestId = request.requestId;
      session.lastSessionKey = request.sessionKey;

      emitWorkerEvent(request, activeRun, {
        type: 'status',
        status: 'starting',
        message: buildRuntimeStartingMessage('Claude Code Rust'),
      });

      const timeoutMs = request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : null;
      if (timeoutMs) {
        activeRun.timeoutHandle = setTimeout(() => {
          if (!session.activeRun || session.activeRun !== activeRun) {
            return;
          }
          settleRun(request, activeRun, {
            success: false,
            error: buildRuntimeTimeoutMessage('Claude Code Rust', timeoutMs),
          });
          session.child?.kill('SIGTERM');
        }, timeoutMs).unref();
      }

      if (requiresRealTools) {
        void (async () => {
          try {
            const output = await this.runLocalToolFallback(request, activeRun);
            settleRun(request, activeRun, output);
          } catch (error) {
            settleRun(request, activeRun, {
              success: false,
              error: formatRuntimeError(error),
            });
          }
        })();
        return;
      }

      if (useDirectRuntime) {
        void (async () => {
          try {
            const output = await runOpenAICompatibleStreamingChat({
              backendLabel: 'Claude Code Rust',
              request,
              hooks: {
                onStatus: (status, message) => {
                  emitWorkerEvent(request, activeRun, {
                    type: 'status',
                    status,
                    message,
                  });
                },
                onTextDelta: (text) => {
                  activeRun.textFragments.push(text);
                  emitWorkerEvent(request, activeRun, {
                    type: 'text-delta',
                    text,
                  });
                },
              },
            });
            if (
              output.success
              && requestDemandsRuntimeToolExecution(request)
              && (containsEmbeddedProviderToolCallText(output.result) || containsUnexecutedToolIntentText(output.result))
            ) {
              settleRun(request, activeRun, await this.runLocalToolFallback(request, activeRun));
              return;
            }
            settleRun(request, activeRun, output);
          } catch (error) {
            settleRun(request, activeRun, {
              success: false,
              error: formatRuntimeError(error),
            });
          }
        })();
        return;
      }

      session.child?.stdin.write(`${JSON.stringify({
        type: 'run',
        request_id: request.requestId,
        prompt: buildPrompt(request.input),
        cwd: request.options.cwd,
        model: resolveConfiguredRuntimeModelName(request.options) || resolveRuntimeModelName(request.options.model),
      })}\n`);
    });
  }

  private async runLocalToolFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    return await runSharedRuntimeToolFallback({
      backendLabel: 'Claude Code Rust',
      request,
      prompt: buildPrompt(request.input),
      cwd: request.options.cwd,
      onStatus: (status, message) => {
        emitWorkerEvent(request, run, {
          type: 'status',
          status,
          message,
        });
      },
      onToolCall: (toolName, detail) => {
        emitWorkerEvent(request, run, {
          type: 'tool-call',
          toolName,
          detail,
        });
      },
      onToolResult: (toolName, detail, output) => {
        emitWorkerEvent(request, run, {
          type: 'tool-result',
          toolName,
          detail,
          output,
        });
      },
      onTextDelta: (text) => {
        run.textFragments.push(text);
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text,
        });
      },
    });
  }

  private async getOrCreateSession(request: WorkerRunRequest, requireNativeSession = true): Promise<AgentRuntimeSession> {
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
    const cacheKey = getSessionCacheKey(sessionOptions, request.requestId);
    const existing = this.sessions.get(cacheKey);
    const nextCwd = request.options.cwd || process.cwd();
    const nextModel = normalizeConfiguredRuntimeModelIdentifier(request.options) || null;
    const nextModelProvider = resolveConfiguredRuntimeModelProvider(request.options) || null;
    const nextModelName = resolveConfiguredRuntimeModelName(request.options) || resolveRuntimeModelName(request.options.model) || null;
    const sessionMode = resolveSessionMode(sessionOptions);
    const persistentKey = resolvePersistentKey(sessionOptions);
    const existingMatches =
      existing &&
      existing.cwd === nextCwd &&
      existing.model === nextModel &&
      existing.modelProvider === nextModelProvider &&
      existing.modelName === nextModelName &&
      (requireNativeSession ? Boolean(existing.child && !existing.child.killed) : !existing.child);
    if (existingMatches) {
      return existing;
    }

    if (existing) {
      this.closeSession(existing, 'Recreating Claude Code Rust worker session', true);
    }

    if (!requireNativeSession) {
      const session: AgentRuntimeSession = {
        cacheKey,
        teamId: request.teamId,
        agentId: request.agentId,
        projectScope: request.projectScope?.trim() || null,
        sessionMode,
        persistentKey,
        cwd: nextCwd,
        model: nextModel,
        modelProvider: nextModelProvider,
        modelName: nextModelName,
        child: null,
        stdoutReader: null,
        activeRun: null,
        status: 'ready',
        startedAt: existing?.startedAt || new Date().toISOString(),
        lastUsedAt: existing?.lastUsedAt || new Date().toISOString(),
        lastEventAt: existing?.lastEventAt || new Date().toISOString(),
        lastError: existing?.lastError || null,
        lastRequestId: existing?.lastRequestId || null,
        lastSessionKey: existing?.lastSessionKey || null,
      };
      this.sessions.set(cacheKey, session);
      return session;
    }

    const commandInfo = resolveClaudeCodeRustCommand();
    const { stateDir } = ensureBackendStateDirs('claude_code_rust', ['tmp', 'home', 'cache', 'config', 'data']);
    const runtimeConnection = await resolveHealthyRuntimeBackendConnection(request.options);
    const launchModelName = runtimeConnection.modelName || nextModelName;
    const child = spawn(commandInfo.command, [...commandInfo.args, 'openteam-session'], {
      cwd: nextCwd,
      env: {
        ...process.env,
        API_BASE_URL: runtimeConnection.baseUrl || loadOpenTeamConfig().llm.baseUrl,
        OPENTEAM_MODEL: launchModelName || loadOpenTeamConfig().llm.model,
        ANTHROPIC_API_KEY: runtimeConnection.apiKey || loadOpenTeamConfig().llm.apiKey,
        HOME: join(stateDir, 'home'),
        TMPDIR: join(stateDir, 'tmp'),
        XDG_CACHE_HOME: join(stateDir, 'cache'),
        XDG_CONFIG_HOME: join(stateDir, 'config'),
        XDG_DATA_HOME: join(stateDir, 'data'),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const session: AgentRuntimeSession = {
      cacheKey,
      teamId: request.teamId,
      agentId: request.agentId,
      projectScope: request.projectScope?.trim() || null,
      sessionMode,
      persistentKey,
      cwd: nextCwd,
      model: nextModel,
      modelProvider: nextModelProvider,
      modelName: launchModelName,
      child,
      stdoutReader: createInterface({ input: child.stdout }),
      activeRun: null,
      status: 'starting',
      startedAt: null,
      lastUsedAt: new Date().toISOString(),
      lastEventAt: null,
      lastError: null,
      lastRequestId: existing?.lastRequestId || null,
      lastSessionKey: existing?.lastSessionKey || null,
    };
    this.sessions.set(cacheKey, session);

    const stdoutReader = session.stdoutReader;
    if (!stdoutReader) {
      throw new Error('Claude Code Rust worker stdout reader was not initialized.');
    }

    stdoutReader.on('line', (line) => {
      this.handleStdoutLine(session, request, line);
    });

    child.stderr.on('data', (chunk) => {
      session.lastEventAt = new Date().toISOString();
      const run = session.activeRun;
      if (!run) {
        return;
      }
      emitWorkerEvent(run.request, run, {
        type: 'status',
        status: 'running',
        message: chunk.toString().trim(),
      });
    });

    child.on('spawn', () => {
      session.startedAt = new Date().toISOString();
      session.lastEventAt = session.startedAt;
    });

    child.on('error', (error) => {
      session.status = 'error';
      session.lastError = formatRuntimeError(error);
      session.lastEventAt = new Date().toISOString();
      const run = session.activeRun;
      if (run) {
        settleRun(run.request, run, { success: false, error: session.lastError });
      }
    });

    child.on('close', (code, signal) => {
      const run = session.activeRun;
      session.child = null;
      session.status = code === 0 ? 'offline' : 'error';
      session.lastEventAt = new Date().toISOString();
      session.stdoutReader?.close();
      session.stdoutReader = null;
      if (code !== 0) {
        session.lastError = `Claude Code Rust worker exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
      }
      if (run && !run.settled) {
        const text = run.textFragments.join('').trim();
        if (code === 0 && text) {
          settleRun(run.request, run, { success: true, result: text });
        } else {
          settleRun(run.request, run, {
            success: false,
            error: session.lastError || `Claude Code Rust worker exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
          });
        }
      }
    });

    return session;
  }

  private findSession(agentId: string, persistentKey?: string | null, cacheKey?: string | null): AgentRuntimeSession | null {
    const normalizedCacheKey = cacheKey?.trim();
    if (normalizedCacheKey) {
      return this.sessions.get(normalizedCacheKey) || null;
    }
    const normalizedKey = persistentKey?.trim();
    if (normalizedKey) {
      for (const session of this.sessions.values()) {
        if (session.agentId === agentId && session.persistentKey === normalizedKey) {
          return session;
        }
      }
      return null;
    }
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId) {
        return session;
      }
    }
    return null;
  }

  private handleStdoutLine(session: AgentRuntimeSession, request: WorkerRunRequest, line: string): void {
    const run = session.activeRun;
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      if (run) {
        run.textFragments.push(`${trimmed}\n`);
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text: `${trimmed}\n`,
        });
      }
      return;
    }

    session.lastEventAt = new Date().toISOString();

    if (payload.type === 'system' && payload.subtype === 'ready') {
      session.status = session.activeRun ? 'busy' : 'ready';
      session.lastError = null;
      return;
    }

    if (!run) {
      return;
    }

    session.lastUsedAt = session.lastEventAt;

    if (payload.type === 'status' && typeof payload.status === 'string') {
      emitWorkerEvent(request, run, {
        type: 'status',
        status: payload.status === 'completed' ? 'completed' : payload.status === 'failed' ? 'failed' : 'running',
        message: payload.status === 'running'
          ? buildRuntimeRunningMessage('Claude Code Rust')
          : typeof payload.message === 'string' ? payload.message : undefined,
      });
      return;
    }

    if (payload.type === 'text-delta' && typeof payload.text === 'string') {
      run.textFragments.push(payload.text);
      emitWorkerEvent(request, run, {
        type: 'text-delta',
        text: payload.text,
      });
      return;
    }

    if (payload.type === 'result' && payload.output && typeof payload.output === 'object') {
      const output = payload.output as SessionOutput;
      settleRun(request, run, output);
    }
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const [cacheKey, session] of this.sessions.entries()) {
      if (!session.child || session.child.killed || session.activeRun) {
        continue;
      }
      const lastUsedAt = Date.parse(session.lastUsedAt);
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt < this.idleTtlMs) {
        continue;
      }
      this.closeSession(session, 'Runtime session idle TTL reached', false);
      this.sessions.delete(cacheKey);
    }
  }

  private closeSession(session: AgentRuntimeSession, reason: string, removeFromMap: boolean): void {
    const run = session.activeRun;
    if (run && !run.settled) {
      settleRun(run.request, run, {
        success: false,
        error: reason,
      });
    }
    session.activeRun = null;
    session.lastEventAt = new Date().toISOString();
    session.lastError = reason;
    if (session.child && !session.child.killed) {
      session.child.stdin.write(`${JSON.stringify({
        type: 'shutdown',
        request_id: `shutdown-${Date.now()}`,
      })}\n`);
      session.child.kill('SIGTERM');
    }
    if (session.stdoutReader) {
      session.stdoutReader.close();
      session.stdoutReader = null;
    }
    session.child = null;
    session.status = 'offline';
    if (removeFromMap) {
      this.sessions.delete(session.cacheKey);
    }
  }

  private toSessionStatus(session: AgentRuntimeSession): WorkerSessionStatus {
    const online = Boolean(session.child && !session.child.killed);
    const sessionReady = online && (session.status === 'ready' || session.status === 'busy');
    return {
      runtime: 'claude-code-rust',
      teamId: session.teamId,
      agentId: session.agentId,
      projectScope: session.projectScope,
      cwd: session.cwd,
      model: session.model,
      modelProvider: session.modelProvider,
      modelName: session.modelName,
      sessionMode: session.sessionMode,
      persistentKey: session.persistentKey,
      pid: session.child?.pid ?? null,
      sessionReady,
      online,
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
}
