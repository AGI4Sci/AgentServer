import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import WebSocket from 'ws';
import { ensureBackendStateDirs } from '../../../core/runtime/backend-paths.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from '../model-spec.js';
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
import { ensureZeroClawRuntimeConfig } from './runtime-backend-config.js';
import { normalizeStreamingText } from './stream-normalizer.js';
import {
  buildRuntimeCompletedMessage,
  buildRuntimeRunningMessage,
  buildRuntimeStartingMessage,
  buildRuntimeTimeoutMessage,
} from './worker-runtime-labels.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

interface ZeroClawGatewayEvent {
  type?: string;
  content?: string;
  name?: string;
  args?: unknown;
  output?: unknown;
  message?: string;
  full_response?: string;
}

const ZEROCLAW_DIR = join(process.cwd(), 'server', 'backend', 'zeroclaw');
const ZEROCLAW_MANIFEST = join(ZEROCLAW_DIR, 'Cargo.toml');
const ZEROCLAW_BINARIES = [
  join(ZEROCLAW_DIR, 'target', 'release', process.platform === 'win32' ? 'zeroclaw.exe' : 'zeroclaw'),
  join(ZEROCLAW_DIR, 'target', 'debug', process.platform === 'win32' ? 'zeroclaw.exe' : 'zeroclaw'),
];
const DEFAULT_IDLE_TTL_MS = Math.max(
  60_000,
  loadOpenTeamConfig().runtime.worker.idleTtlMs,
);
const DEFAULT_IDLE_SWEEP_MS = Math.max(
  15_000,
  loadOpenTeamConfig().runtime.worker.idleSweepMs,
);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const ZEROCLAW_GATEWAY_BASE_PORT = loadOpenTeamConfig().runtime.zeroclaw.gatewayBasePort;
const GATEWAY_START_TIMEOUT_MS = Math.max(
  20_000,
  loadOpenTeamConfig().runtime.worker.gatewayStartTimeoutMs,
);

type ActiveRun = {
  request: WorkerRunRequest;
  onEvent: (event: WorkerEvent) => void;
  resolve: (output: SessionOutput) => void;
  settled: boolean;
  sawToolCall: boolean;
  sawToolResult: boolean;
  lastToolName: string | null;
  streamedText: string;
  streamedSnapshot: string;
  timeoutHandle?: NodeJS.Timeout;
};

type ZeroClawSession = {
  cacheKey: string;
  teamId: string;
  agentId: string;
  projectScope: string | null;
  sessionMode: 'ephemeral' | 'persistent';
  persistentKey: string | null;
  sessionId: string;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  modelName: string | null;
  ws: WebSocket | null;
  connected: boolean;
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
    message: output.success ? buildRuntimeCompletedMessage('ZeroClaw') : output.error,
  });
  emitWorkerEvent(request, run, {
    type: 'result',
    output,
    usage: output.usage,
  });
  run.resolve(output);
}

function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function buildPersistentSessionId(teamId: string, agentId: string): string {
  return `${sanitizeKey(teamId)}__${sanitizeKey(agentId)}`;
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

function describeToolDetail(payload: unknown): string | undefined {
  if (payload == null) {
    return undefined;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function chooseZeroClawGatewayPort(teamId: string): number {
  let hash = 0;
  for (const char of teamId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return ZEROCLAW_GATEWAY_BASE_PORT + hash;
}

function resolveZeroClawCommand(): { command: string; args: string[] } {
  if (process.env.ZEROCLAW_EXECUTABLE && existsSync(process.env.ZEROCLAW_EXECUTABLE)) {
    return {
      command: process.env.ZEROCLAW_EXECUTABLE,
      args: [],
    };
  }

  const managedBinary = resolveManagedBackendExecutableForBackend('zeroclaw');
  if (managedBinary) {
    return {
      command: managedBinary,
      args: [],
    };
  }

  const binaryPath = ZEROCLAW_BINARIES.find((candidate) => existsSync(candidate));
  if (binaryPath) {
    return {
      command: binaryPath,
      args: [],
    };
  }

  if (!existsSync(ZEROCLAW_MANIFEST)) {
    throw new Error(`ZeroClaw manifest not found: ${ZEROCLAW_MANIFEST}`);
  }

  const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  if (cargoCheck.error || cargoCheck.status !== 0) {
    throw new Error('cargo is not available in PATH');
  }

  return {
    command: 'cargo',
    args: ['run', '--quiet', '--manifest-path', ZEROCLAW_MANIFEST, '--bin', 'zeroclaw', '--'],
  };
}

export class ZeroClawTeamWorker {
  private readonly sessions = new Map<string, ZeroClawSession>();
  private readonly idleTtlMs = DEFAULT_IDLE_TTL_MS;
  private readonly idleSweepHandle: NodeJS.Timeout;
  private teamId: string | null = null;
  private gatewayPort: number | null = null;
  private gatewayChild: ChildProcess | null = null;
  private gatewayStartPromise: Promise<void> | null = null;
  private gatewayLastError: string | null = null;

  constructor() {
    this.idleSweepHandle = setInterval(() => {
      this.sweepIdleSessions();
    }, DEFAULT_IDLE_SWEEP_MS);
    this.idleSweepHandle.unref();
  }

  async init(teamId: string): Promise<void> {
    this.teamId = teamId;
    this.gatewayPort = chooseZeroClawGatewayPort(teamId);
  }

  async ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus> {
    const requireGateway = !(
      shouldUseDirectOpenAICompatibleRuntime({
        type: 'run',
        runtime: 'zeroclaw',
        teamId: options.teamId,
        agentId: options.agentId,
        requestId: 'ensure-session',
        sessionKey: 'ensure-session',
        input: { task: '', context: '' },
        options: {
          teamId: options.teamId,
          agentId: options.agentId,
          cwd: options.cwd,
          model: options.model || undefined,
          modelProvider: options.modelProvider || undefined,
          modelName: options.modelName || undefined,
          sessionMode: options.sessionMode,
          persistentKey: options.persistentKey,
        },
      })
      && process.env.OPENTEAM_ZEROCLAW_FORCE_GATEWAY !== '1'
    );
    const session = await this.getOrCreateSession(options, requireGateway);
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
    this.closeGateway(reason);
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
    const requiresRealTools = requestDemandsRuntimeToolExecution(request);
    const useDirectRuntime = shouldUseDirectOpenAICompatibleRuntime(request)
      && process.env.OPENTEAM_ZEROCLAW_FORCE_GATEWAY !== '1';
    const session = await this.getOrCreateSession(sessionOptions, !useDirectRuntime);
    if (session.activeRun) {
      throw new Error(`ZeroClaw agent ${request.agentId} already has an active run`);
    }
    if (!useDirectRuntime && (!session.ws || session.ws.readyState !== WebSocket.OPEN)) {
      throw new Error('ZeroClaw persistent websocket is not connected.');
    }

    return await new Promise<SessionOutput>((resolve) => {
      const run: ActiveRun = {
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
          if (session.sessionMode !== 'persistent') {
            this.closeSession(session, 'ZeroClaw ephemeral session completed', true);
          }
        resolve(output);
        },
        settled: false,
        sawToolCall: false,
        sawToolResult: false,
        lastToolName: null,
        streamedText: '',
        streamedSnapshot: '',
      };

      session.activeRun = run;
      session.status = 'busy';
      session.lastError = null;
      session.lastUsedAt = new Date().toISOString();
      session.lastEventAt = session.lastUsedAt;
      session.lastRequestId = request.requestId;
      session.lastSessionKey = request.sessionKey;

      emitWorkerEvent(request, run, {
        type: 'status',
        status: 'starting',
        message: buildRuntimeStartingMessage('ZeroClaw'),
      });

      const timeoutMs = request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
      run.timeoutHandle = setTimeout(() => {
        settleRun(request, run, {
          success: false,
          error: buildRuntimeTimeoutMessage('ZeroClaw', timeoutMs),
        });
      }, timeoutMs);
      run.timeoutHandle.unref?.();

      if (requiresRealTools) {
        void (async () => {
          try {
            const output = await this.runLocalToolFallback(request, run);
            settleRun(request, run, output);
          } catch (error) {
            const message = formatRuntimeError(error);
            session.lastError = message;
            settleRun(request, run, { success: false, error: message });
          }
        })();
        return;
      }

      if (useDirectRuntime) {
        void (async () => {
          try {
            const output = await runOpenAICompatibleStreamingChat({
              backendLabel: 'ZeroClaw',
              request,
              hooks: {
                onStatus: (status, message) => {
                  emitWorkerEvent(request, run, {
                    type: 'status',
                    status,
                    message,
                  });
                },
                onTextDelta: (text) => {
                  run.streamedText += text;
                  run.streamedSnapshot += text;
                  emitWorkerEvent(request, run, {
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
              settleRun(request, run, await this.runLocalToolFallback(request, run));
              return;
            }
            settleRun(request, run, output);
          } catch (error) {
            const message = formatRuntimeError(error);
            session.lastError = message;
            settleRun(request, run, { success: false, error: message });
          }
        })();
        return;
      }

      try {
        const ws = session.ws;
        if (!ws) {
          throw new Error('ZeroClaw persistent websocket is not connected.');
        }
        ws.send(JSON.stringify({
          type: 'message',
          content: buildPrompt(request.input),
        }));
        emitWorkerEvent(request, run, {
          type: 'status',
          status: 'running',
          message: buildRuntimeRunningMessage('ZeroClaw'),
        });
      } catch (error) {
        const message = formatRuntimeError(error);
        session.lastError = message;
        settleRun(request, run, { success: false, error: message });
      }
    });
  }

  private async runLocalToolFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    return await runSharedRuntimeToolFallback({
      backendLabel: 'ZeroClaw',
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
        run.sawToolCall = true;
        run.lastToolName = toolName;
        emitWorkerEvent(request, run, {
          type: 'tool-call',
          toolName,
          detail,
        });
      },
      onToolResult: (toolName, detail, output) => {
        run.sawToolCall = true;
        run.sawToolResult = true;
        run.lastToolName = toolName;
        emitWorkerEvent(request, run, {
          type: 'tool-result',
          toolName,
          detail,
          output,
        });
      },
      onTextDelta: (text) => {
        run.streamedText += text;
        run.streamedSnapshot += text;
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text,
        });
      },
    });
  }

  private async getOrCreateSession(
    options: EnsureWorkerSessionOptions,
    requireGateway = true,
  ): Promise<ZeroClawSession> {
    if (requireGateway) {
      await this.ensureGateway(options);
    }

    const nextCwd = options.cwd || process.cwd();
    const nextModel = normalizeConfiguredRuntimeModelIdentifier(options) || null;
    const nextModelProvider = resolveConfiguredRuntimeModelProvider(options) || null;
    const nextModelName = resolveConfiguredRuntimeModelName(options) || null;
    const sessionMode = resolveSessionMode(options);
    const persistentKey = resolvePersistentKey(options);
    const cacheKey = getSessionCacheKey(options);
    const existing = this.sessions.get(cacheKey);
    const existingMatches =
      existing
      && existing.cwd === nextCwd
      && existing.model === nextModel
      && existing.modelProvider === nextModelProvider
      && existing.modelName === nextModelName
      && (requireGateway ? existing.ws?.readyState === WebSocket.OPEN : !existing.ws);
    if (existingMatches) {
      return existing;
    }

    if (existing) {
      this.closeSession(
        existing,
        sessionMode === 'persistent'
          ? 'Refreshing ZeroClaw persistent session'
          : 'Refreshing ZeroClaw ephemeral session',
        true,
      );
    }

    const session: ZeroClawSession = {
      cacheKey,
      teamId: options.teamId,
      agentId: options.agentId,
      projectScope: options.projectScope?.trim() || null,
      sessionMode,
      persistentKey,
      sessionId: sessionMode === 'persistent'
        ? buildPersistentSessionId(options.teamId, options.agentId)
        : `${buildPersistentSessionId(options.teamId, options.agentId)}__${Date.now().toString(36)}`,
      cwd: nextCwd,
      model: nextModel,
      modelProvider: nextModelProvider,
      modelName: nextModelName,
      ws: null,
      connected: false,
      activeRun: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      lastEventAt: null,
      lastError: null,
      lastRequestId: existing?.lastRequestId || null,
      lastSessionKey: existing?.lastSessionKey || null,
    };
    this.sessions.set(cacheKey, session);

    if (requireGateway) {
      await this.connectSession(session);
    }
    session.status = 'ready';
    session.lastEventAt = new Date().toISOString();
    return session;
  }

  private async connectSession(session: ZeroClawSession): Promise<void> {
    const gatewayPort = this.gatewayPort;
    if (!gatewayPort) {
      throw new Error('ZeroClaw gateway port has not been initialised.');
    }

    const url = new URL(`ws://127.0.0.1:${gatewayPort}/ws/chat`);
    url.searchParams.set('session_id', session.sessionId);
    url.searchParams.set('name', `${session.teamId}/${session.agentId}`);
    const token = process.env.ZEROCLAW_TOKEN;
    if (token) {
      url.searchParams.set('token', token);
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      let resolved = false;

      const cleanupError = (error: unknown): void => {
        if (resolved) {
          return;
        }
        resolved = true;
        reject(error);
      };

      ws.on('open', () => {
        session.ws = ws;
        session.connected = true;
        session.status = session.activeRun ? 'busy' : 'ready';
        session.lastError = null;
        session.lastEventAt = new Date().toISOString();
        ws.send(JSON.stringify({
          type: 'connect',
          session_id: session.sessionId,
          device_name: `${session.teamId}/${session.agentId}`,
          capabilities: ['openteam-runtime'],
          model_provider: session.modelProvider,
          model_name: session.modelName,
        }));
        resolved = true;
        resolve();
      });

      ws.on('message', (data) => {
        this.handleGatewayMessage(session, data.toString());
      });
      ws.on('error', (error) => {
        if (!resolved) {
          cleanupError(error);
          return;
        }
        session.connected = false;
        session.status = 'error';
        session.lastError = formatRuntimeError(error);
      });
      ws.on('close', (_code, reason) => {
        session.connected = false;
        session.status = 'offline';
        session.lastError = reason.toString().trim() || session.lastError || 'ZeroClaw websocket closed';
        session.ws = null;
        if (session.activeRun && !session.activeRun.settled) {
          settleRun(session.activeRun.request, session.activeRun, {
            success: false,
            error: session.lastError,
          });
        }
      });
    });
  }

  private handleGatewayMessage(session: ZeroClawSession, raw: string): void {
    let event: ZeroClawGatewayEvent;
    try {
      event = JSON.parse(raw) as ZeroClawGatewayEvent;
    } catch {
      return;
    }

    session.lastEventAt = new Date().toISOString();
    session.lastUsedAt = session.lastEventAt;
    const run = session.activeRun;
    if (!run) {
      return;
    }

    const emitStreamingText = (text: string): void => {
      const normalized = normalizeStreamingText(run.streamedSnapshot, text);
      run.streamedSnapshot = normalized.snapshot;
      if (!normalized.delta) {
        return;
      }
      run.streamedText += normalized.delta;
      emitWorkerEvent(run.request, run, {
        type: 'text-delta',
        text: normalized.delta,
      });
    };

    if ((event.type === 'chunk' || event.type === 'thinking') && typeof event.content === 'string') {
      emitStreamingText(event.content);
      return;
    }

    if (event.type === 'tool_call' && typeof event.name === 'string') {
      run.sawToolCall = true;
      run.lastToolName = event.name;
      emitWorkerEvent(run.request, run, {
        type: 'tool-call',
        toolName: event.name,
        detail: describeToolDetail(event.args),
      });
      return;
    }

    if (event.type === 'tool_result' && typeof event.name === 'string') {
      run.sawToolCall = true;
      run.sawToolResult = true;
      emitWorkerEvent(run.request, run, {
        type: 'tool-result',
        toolName: event.name,
        detail: describeToolDetail(event.output),
      });
      return;
    }

    if (event.type === 'error') {
      const message = event.message || 'ZeroClaw persistent session returned an error.';
      session.lastError = message;
      settleRun(run.request, run, {
        success: false,
        error: message,
      });
      return;
    }

    if (event.type === 'done' && typeof event.full_response === 'string') {
      if (requestDemandsRuntimeToolExecution(run.request) && !run.sawToolCall) {
        void this.runLocalToolFallback(run.request, run).then((output) => {
          settleRun(run.request, run, output);
        }).catch((error) => {
          settleRun(run.request, run, {
            success: false,
            error: formatRuntimeError(error),
          });
        });
        return;
      }
      if (run.sawToolCall && !run.sawToolResult) {
        run.sawToolResult = true;
        emitWorkerEvent(run.request, run, {
          type: 'tool-result',
          toolName: run.lastToolName || 'tool',
          detail: event.full_response,
          output: event.full_response,
        });
      }
      emitStreamingText(event.full_response);
      settleRun(run.request, run, {
        success: true,
        result: event.full_response,
      });
    }
  }

  private async ensureGateway(model?: EnsureWorkerSessionOptions): Promise<void> {
    if (await this.isGatewayHealthy()) {
      return;
    }

    if (!this.gatewayStartPromise) {
      this.gatewayStartPromise = this.startGateway(model).finally(() => {
        this.gatewayStartPromise = null;
      });
    }

    await this.gatewayStartPromise;
  }

  private async startGateway(model?: EnsureWorkerSessionOptions): Promise<void> {
    const gatewayPort = this.gatewayPort;
    if (!gatewayPort || !this.teamId) {
      throw new Error('ZeroClaw team worker was used before init(teamId).');
    }

    this.closeGateway('Restarting ZeroClaw gateway');
    const { stateDir } = ensureBackendStateDirs('zeroclaw', ['tmp', 'logs']);
    ensureZeroClawRuntimeConfig({
      stateDir,
      gatewayPort,
      model: model ?? {},
    });
    const { command, args } = resolveZeroClawCommand();
    const child = spawn(command, [...args, 'gateway', 'start', '--host', '127.0.0.1', '--port', String(gatewayPort)], {
      cwd: ZEROCLAW_DIR,
      env: {
        ...process.env,
        HOME: stateDir,
        TMPDIR: join(stateDir, 'tmp'),
        ZEROCLAW_CONFIG_DIR: stateDir,
        ZEROCLAW_HOME: stateDir,
        ZEROCLAW_OPENTEAM_TEAM_ID: this.teamId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.gatewayChild = child;
    this.gatewayLastError = null;

    child.stdout.on('data', () => {});
    child.stderr.on('data', (chunk) => {
      this.gatewayLastError = chunk.toString().trim() || this.gatewayLastError;
    });
    child.on('error', (error) => {
      this.gatewayLastError = formatRuntimeError(error);
    });
    child.on('close', (code, signal) => {
      if (this.gatewayChild === child) {
        this.gatewayChild = null;
      }
      if (code !== 0 && signal !== 'SIGTERM') {
        this.gatewayLastError = `ZeroClaw gateway exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`;
      }
    });

    const deadline = Date.now() + GATEWAY_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isGatewayHealthy()) {
        return;
      }
      if (child.exitCode != null) {
        throw new Error(this.gatewayLastError || `ZeroClaw gateway exited early with code ${child.exitCode}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(this.gatewayLastError || `ZeroClaw gateway failed to become healthy on port ${gatewayPort} within ${GATEWAY_START_TIMEOUT_MS}ms.`);
  }

  private async isGatewayHealthy(): Promise<boolean> {
    if (!this.gatewayPort) {
      return false;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${this.gatewayPort}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const [agentId, session] of this.sessions.entries()) {
      if (session.activeRun) {
        continue;
      }
      if (session.sessionMode === 'persistent') {
        continue;
      }
      const lastUsedAt = Date.parse(session.lastUsedAt);
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt < this.idleTtlMs) {
        continue;
      }
      this.closeSession(session, 'Runtime session idle TTL reached', true);
      this.sessions.delete(agentId);
    }
  }

  private closeSession(
    session: ZeroClawSession,
    reason: string,
    removeFromMap: boolean,
  ): void {
    if (session.activeRun && !session.activeRun.settled) {
      settleRun(session.activeRun.request, session.activeRun, {
        success: false,
        error: reason,
      });
    }
    session.activeRun = null;
    session.lastError = reason;
    session.lastEventAt = new Date().toISOString();
    session.status = 'offline';
    if (session.ws && (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING)) {
      session.ws.close();
    }
    session.ws = null;
    session.connected = false;
    if (removeFromMap) {
      this.sessions.delete(session.cacheKey);
    }
  }

  private findSession(agentId: string, persistentKey?: string | null, cacheKey?: string | null): ZeroClawSession | null {
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

  private closeGateway(reason: string): void {
    this.gatewayLastError = reason;
    if (this.gatewayChild && !this.gatewayChild.killed) {
      this.gatewayChild.kill('SIGTERM');
    }
    this.gatewayChild = null;
  }

  private toSessionStatus(session: ZeroClawSession): WorkerSessionStatus {
    const gatewayOnline = Boolean(this.gatewayChild && !this.gatewayChild.killed);
    const online = gatewayOnline && session.connected;
    const sessionReady = online && (session.status === 'ready' || session.status === 'busy');
    return {
      runtime: 'zeroclaw',
      teamId: session.teamId,
      agentId: session.agentId,
      projectScope: session.projectScope,
      cwd: session.cwd,
      model: session.model,
      modelProvider: session.modelProvider,
      modelName: session.modelName,
      sessionMode: session.sessionMode,
      persistentKey: session.persistentKey,
      pid: this.gatewayChild?.pid ?? null,
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
