import { spawn, type ChildProcess } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { ensureBackendStateDirs, getBackendConfigPath } from '../../../core/runtime/backend-paths.js';
import { getOpenTeamInstance } from '../../../core/runtime/instance.js';
import {
  buildProviderQualifiedModel,
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
import { outputWithMergedModelProviderUsage } from '../model-provider-usage.js';
import { resolveManagedBackendExecutableForBackend } from './backend-managed-launchers.js';
import {
  containsEmbeddedProviderToolCallText,
  containsUnexecutedToolIntentText,
  runOpenAICompatibleStreamingChat,
  shouldUseDirectOpenAICompatibleRuntime,
} from './openai-compatible-stream.js';
import { ensureOpenClawRuntimeConfig } from './runtime-backend-config.js';
import { normalizeStreamingText } from './stream-normalizer.js';
import {
  buildRuntimeCompletedMessage,
  buildRuntimeRunningMessage,
  buildRuntimeStartingMessage,
  buildRuntimeTimeoutMessage,
} from './worker-runtime-labels.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

const OPENCLAW_DIR = join(process.cwd(), 'server', 'backend', 'openclaw');
const OPENCLAW_NODE_MODULES = join(OPENCLAW_DIR, 'node_modules');
const OPENCLAW_DIST_ENTRY = join(OPENCLAW_DIR, 'dist', 'index.js');
const OPENCLAW_SOURCE_GATEWAY_CLIENT = join(OPENCLAW_DIR, 'src', 'gateway', 'client.ts');
const DEFAULT_IDLE_TTL_MS = Math.max(
  60_000,
  loadOpenTeamConfig().runtime.worker.idleTtlMs,
);
const DEFAULT_IDLE_SWEEP_MS = Math.max(
  15_000,
  loadOpenTeamConfig().runtime.worker.idleSweepMs,
);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const OPENCLAW_GATEWAY_BASE_PORT = loadOpenTeamConfig().runtime.openclaw.gatewayBasePort;
const GATEWAY_START_TIMEOUT_MS = Math.max(
  20_000,
  loadOpenTeamConfig().runtime.worker.gatewayStartTimeoutMs,
);

type GatewayEventFrame = {
  event?: string;
  payload?: unknown;
};

type GatewayClientLike = {
  start(): void;
  stop(): void;
  request<T = unknown>(method: string, params?: unknown, opts?: { expectFinal?: boolean; timeoutMs?: number | null }): Promise<T>;
};

type GatewayClientConstructor = new (opts: {
  url?: string;
  role?: string;
  scopes?: string[];
  mode?: string;
  requestTimeoutMs?: number;
  onEvent?: (evt: GatewayEventFrame) => void;
  onHelloOk?: () => void;
  onConnectError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
}) => GatewayClientLike;

type ActiveRun = {
  request: WorkerRunRequest;
  onEvent: (event: WorkerEvent) => void;
  resolve: (output: SessionOutput) => void;
  settled: boolean;
  runtimeRunId: string | null;
  sawToolCall: boolean;
  seenText: string[];
  streamedText: string;
  streamedSnapshot: string;
  latestAssistantText: string | null;
  minAssistantMessageSeq: number | null;
  timeoutHandle?: NodeJS.Timeout;
};

type OpenClawSession = {
  cacheKey: string;
  teamId: string;
  agentId: string;
  projectScope: string | null;
  runtimeAgentId: string;
  sessionKey: string;
  sessionMode: 'ephemeral' | 'persistent';
  persistentKey: string | null;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  modelName: string | null;
  client: OpenClawPersistentClient | null;
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
    message: output.success ? buildRuntimeCompletedMessage('OpenClaw') : output.error,
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

function buildPersistentSessionKey(runtimeAgentId: string, teamId: string, agentId: string): string {
  return `agent:${sanitizeKey(runtimeAgentId)}:openteam:${sanitizeKey(teamId)}:${sanitizeKey(agentId)}`;
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

function buildGatewaySessionKey(
  runtimeAgentId: string,
  options: EnsureWorkerSessionOptions,
  requestId?: string,
): string {
  const sessionMode = resolveSessionMode(options);
  const persistentKey = resolvePersistentKey(options);
  if (sessionMode === 'persistent') {
    if (persistentKey) {
      return `agent:${sanitizeKey(runtimeAgentId)}:persistent:${sanitizeKey(persistentKey)}`;
    }
    return buildPersistentSessionKey(runtimeAgentId, options.teamId, options.agentId);
  }
  return `agent:${sanitizeKey(runtimeAgentId)}:ephemeral:${sanitizeKey(requestId || `${Date.now()}`)}`;
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

function coerceOpenClawOutput(text: string): SessionOutput {
  const normalized = text.trim();
  if (!normalized) {
    return {
      success: false,
      error: 'OpenClaw returned an empty final reply.',
    };
  }
  if (normalized.startsWith('⚠️ Agent failed before reply:')) {
    return {
      success: false,
      error: normalized,
    };
  }
  return {
    success: true,
    result: normalized,
  };
}

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  if (typeof (message as { text?: unknown }).text === 'string') {
    return ((message as { text: string }).text || '').trim();
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return '';
      }
      if ((entry as { type?: unknown }).type === 'text' && typeof (entry as { text?: unknown }).text === 'string') {
        return (entry as { text: string }).text;
      }
      return '';
    })
    .join('')
    .trim();
}

function readMessageRole(message: unknown): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }
  return typeof (message as { role?: unknown }).role === 'string'
    ? (message as { role: string }).role
    : null;
}

function extractUsageFromMessage(message: unknown): { input: number; output: number; total?: number; cacheRead?: number; cacheWrite?: number } | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const raw = usage as Record<string, unknown>;
  const input = Number(raw.input ?? raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens ?? 0) || 0;
  const output = Number(raw.output ?? raw.outputTokens ?? raw.output_tokens ?? raw.completion_tokens ?? 0) || 0;
  const cacheRead = Number(raw.cacheRead ?? raw.cache_read_input_tokens ?? 0) || 0;
  const cacheWrite = Number(raw.cacheWrite ?? raw.cache_creation_input_tokens ?? 0) || 0;
  const total = Number(raw.total ?? raw.totalTokens ?? raw.total_tokens ?? (input + output + cacheRead + cacheWrite)) || 0;
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && total <= 0) {
    return undefined;
  }
  return {
    input,
    output,
    total,
    cacheRead: cacheRead || undefined,
    cacheWrite: cacheWrite || undefined,
  };
}

function readMessageSeq(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const direct = (payload as { messageSeq?: unknown }).messageSeq;
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct;
  }
  const openclawMeta = (payload as { message?: { __openclaw?: { seq?: unknown } } }).message?.__openclaw?.seq;
  return typeof openclawMeta === 'number' && Number.isFinite(openclawMeta) ? openclawMeta : null;
}

function chooseOpenClawGatewayPort(teamId: string): number {
  let hash = 0;
  for (const char of teamId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return OPENCLAW_GATEWAY_BASE_PORT + hash;
}

function resolveOpenClawGatewayCommand(port: number): { command: string; args: string[] } {
  if (!existsSync(OPENCLAW_DIR)) {
    throw new Error(`OpenClaw workspace not found: ${OPENCLAW_DIR}`);
  }
  const managedLauncher = resolveManagedBackendExecutableForBackend('openclaw');
  if (managedLauncher) {
    return {
      command: managedLauncher,
      args: [
        'gateway',
        'run',
        '--allow-unconfigured',
        '--bind',
        'loopback',
        '--auth',
        'none',
        '--port',
        String(port),
      ],
    };
  }
  if (!existsSync(OPENCLAW_NODE_MODULES)) {
    throw new Error(`OpenClaw local runtime dependencies are missing. Run "cd ${OPENCLAW_DIR} && pnpm install" first.`);
  }
  if (existsSync(OPENCLAW_DIST_ENTRY)) {
    return {
      command: process.execPath,
      args: [
        OPENCLAW_DIST_ENTRY,
        'gateway',
        'run',
        '--allow-unconfigured',
        '--bind',
        'loopback',
        '--auth',
        'none',
        '--port',
        String(port),
      ],
    };
  }
  return {
    command: process.execPath,
    args: [
      'scripts/run-node.mjs',
      'gateway',
      'run',
      '--allow-unconfigured',
      '--bind',
      'loopback',
      '--auth',
      'none',
      '--port',
      String(port),
    ],
  };
}

function hasOpenClawNativeRuntimeAvailable(): boolean {
  if (!existsSync(OPENCLAW_DIR) || !existsSync(OPENCLAW_NODE_MODULES)) {
    return false;
  }
  return existsSync(OPENCLAW_DIST_ENTRY) || existsSync(OPENCLAW_SOURCE_GATEWAY_CLIENT);
}

async function importGatewayClient(): Promise<{ GatewayClient: GatewayClientConstructor }> {
  const moduleUrl = pathToFileURL(OPENCLAW_SOURCE_GATEWAY_CLIENT).href;
  return await import(moduleUrl) as { GatewayClient: GatewayClientConstructor };
}

class OpenClawPersistentClient {
  private client: GatewayClientLike | null = null;
  private connected = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;

  constructor(
    private readonly options: {
      url: string;
      sessionKey: string;
      runtimeAgentId: string;
      timeoutMs: number;
      onEvent: (evt: GatewayEventFrame) => void;
      onConnected: () => void;
      onDisconnected: (reason: string) => void;
    },
  ) {}

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    const { GatewayClient } = await importGatewayClient();
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const client = new GatewayClient({
      url: this.options.url,
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      mode: 'backend',
      requestTimeoutMs: this.options.timeoutMs,
      onEvent: (evt) => {
        this.options.onEvent(evt);
      },
      onHelloOk: () => {
        this.connected = true;
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        this.options.onConnected();
      },
      onConnectError: (error) => {
        this.connected = false;
        if (this.readyReject) {
          this.readyReject(error);
          this.readyResolve = null;
          this.readyReject = null;
          return;
        }
        this.options.onDisconnected(formatRuntimeError(error));
      },
      onClose: (_code, reason) => {
        this.connected = false;
        const message = reason || 'OpenClaw gateway connection closed';
        if (this.readyReject) {
          this.readyReject(new Error(message));
          this.readyResolve = null;
          this.readyReject = null;
          return;
        }
        this.options.onDisconnected(message);
      },
    });
    this.client = client;
    client.start();
    await this.waitForReady();
  }

  async waitForReady(): Promise<void> {
    await this.readyPromise;
  }

  stop(): void {
    this.connected = false;
    this.client?.stop();
    this.client = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }

  async deleteSession(): Promise<void> {
    const client = this.requireClient();
    try {
      await client.request('sessions.messages.unsubscribe', {
        key: this.options.sessionKey,
      });
    } catch {
      // Best-effort cleanup; continue to session deletion.
    }
    await client.request('sessions.delete', {
      key: this.options.sessionKey,
    });
  }

  async ensureSession(model: string | null = null): Promise<void> {
    const client = this.requireClient();
    let exists = false;
    try {
      await client.request('sessions.resolve', {
        key: this.options.sessionKey,
      });
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      await client.request('sessions.create', {
        key: this.options.sessionKey,
        agentId: this.options.runtimeAgentId,
        ...(model ? { model } : {}),
      });
    } else if (model) {
      await client.request('sessions.patch', {
        key: this.options.sessionKey,
        model,
      });
    }

    await client.request('sessions.messages.subscribe', {
      key: this.options.sessionKey,
    });
  }

  async sendSessionMessage(params: {
    message: string;
    runId: string;
    timeoutMs: number;
  }): Promise<{ runId: string; messageSeq?: number }> {
    const client = this.requireClient();
    const result = await client.request<{ runId?: string; messageSeq?: number }>('sessions.send', {
      key: this.options.sessionKey,
      message: params.message,
      timeoutMs: params.timeoutMs,
      idempotencyKey: params.runId,
    });
    return {
      runId: typeof result?.runId === 'string' && result.runId.trim() ? result.runId : params.runId,
      messageSeq: typeof result?.messageSeq === 'number' ? result.messageSeq : undefined,
    };
  }

  async waitForAgentRun(runId: string, timeoutMs: number): Promise<{ status?: string; error?: string }> {
    const client = this.requireClient();
    return await client.request<{ status?: string; error?: string }>('agent.wait', {
      runId,
      timeoutMs,
    }, {
      timeoutMs: timeoutMs + 5_000,
    });
  }

  async loadHistory(limit = 8): Promise<{ messages?: unknown[] }> {
    const client = this.requireClient();
    return await client.request<{ messages?: unknown[] }>('chat.history', {
      sessionKey: this.options.sessionKey,
      limit,
    });
  }

  private requireClient(): GatewayClientLike {
    if (!this.client || !this.connected) {
      throw new Error('OpenClaw gateway client is not connected.');
    }
    return this.client;
  }
}

export class OpenClawTeamWorker {
  private readonly sessions = new Map<string, OpenClawSession>();
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
    this.gatewayPort = chooseOpenClawGatewayPort(teamId);
  }

  async ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus> {
    const directCompatible = shouldUseDirectOpenAICompatibleRuntime({
      type: 'run',
      runtime: 'openclaw',
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
    });
    const forceDirectRuntime = process.env.OPENTEAM_OPENCLAW_FORCE_DIRECT_CHAT_COMPLETIONS === '1';
    const nativeRuntimeAvailable = hasOpenClawNativeRuntimeAvailable();
    const requireGateway = !(
      forceDirectRuntime
      || (
        directCompatible
        && process.env.OPENTEAM_OPENCLAW_FORCE_GATEWAY !== '1'
        && !nativeRuntimeAvailable
      )
    );
    const session = await this.getOrCreateSession(options, undefined, requireGateway);
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
    const forceDirectRuntime = process.env.OPENTEAM_OPENCLAW_FORCE_DIRECT_CHAT_COMPLETIONS === '1';
    const requiresRealTools = requestDemandsRuntimeToolExecution(request);
    const useDirectRuntime = forceDirectRuntime
      || (
        shouldUseDirectOpenAICompatibleRuntime(request)
        && process.env.OPENTEAM_OPENCLAW_FORCE_GATEWAY !== '1'
      );
    const session = await this.getOrCreateSession(sessionOptions, request.requestId, !useDirectRuntime);
    if (session.activeRun) {
      throw new Error(`OpenClaw agent ${request.agentId} already has an active run`);
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
          if (session.sessionMode === 'ephemeral') {
            this.closeSession(session, 'Ephemeral session completed', true);
          }
          resolve(output);
        },
        settled: false,
        runtimeRunId: null,
        sawToolCall: false,
        seenText: [],
        streamedText: '',
        streamedSnapshot: '',
        latestAssistantText: null,
        minAssistantMessageSeq: null,
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
        message: buildRuntimeStartingMessage('OpenClaw'),
      });

      const timeoutMs = request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : DEFAULT_TIMEOUT_MS;
      run.timeoutHandle = setTimeout(() => {
        settleRun(request, run, {
          success: false,
          error: buildRuntimeTimeoutMessage('OpenClaw', timeoutMs),
        });
      }, timeoutMs);
      run.timeoutHandle.unref?.();

      if (useDirectRuntime) {
        void (async () => {
          try {
            if (requiresRealTools) {
              const output = await this.runLocalToolFallback(request, run);
              settleRun(request, run, output);
              return;
            }
            const output = await runOpenAICompatibleStreamingChat({
              backendLabel: 'OpenClaw',
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
                  run.latestAssistantText = `${run.latestAssistantText || ''}${text}`;
                  run.seenText.push(text);
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
              settleRun(request, run, outputWithMergedModelProviderUsage(await this.runLocalToolFallback(request, run), [output.usage]));
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

      void this.executeRun(session, run, timeoutMs).catch((error) => {
        const message = formatRuntimeError(error);
        session.lastError = message;
        settleRun(request, run, { success: false, error: message });
      });
    });
  }

  private async executeRun(session: OpenClawSession, run: ActiveRun, timeoutMs: number): Promise<void> {
    const client = session.client;
    if (!client || !client.isConnected()) {
      throw new Error('OpenClaw gateway client is not available.');
    }

    const prompt = buildPrompt(run.request.input);
    const sendResult = await client.sendSessionMessage({
      message: prompt,
      runId: run.request.requestId,
      timeoutMs,
    });
    run.runtimeRunId = typeof sendResult.runId === 'string' && sendResult.runId.trim()
      ? sendResult.runId
      : run.request.requestId;
    run.minAssistantMessageSeq = typeof sendResult.messageSeq === 'number' && Number.isFinite(sendResult.messageSeq)
      ? sendResult.messageSeq + 1
      : null;

    emitWorkerEvent(run.request, run, {
      type: 'status',
      status: 'running',
      message: buildRuntimeRunningMessage('OpenClaw'),
    });

    const waitResult = await client.waitForAgentRun(run.runtimeRunId || run.request.requestId, timeoutMs);
    if (run.settled) {
      return;
    }
    if (!waitResult || waitResult.status === 'timeout') {
      throw new Error(`OpenClaw agent.wait timed out for run ${run.request.requestId}`);
    }
    if (waitResult.status === 'error') {
      throw new Error(waitResult.error || 'OpenClaw agent.wait returned an error');
    }

    if (requestDemandsRuntimeToolExecution(run.request) && !run.sawToolCall) {
      const fallbackOutput = await this.runLocalToolFallback(run.request, run);
      settleRun(run.request, run, fallbackOutput);
      return;
    }

    const directText = run.latestAssistantText?.trim() || run.seenText.join('').trim();
    if (directText) {
      settleRun(run.request, run, coerceOpenClawOutput(directText));
      return;
    }

    const history = await client.loadHistory(8);
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (readMessageRole(messages[index]) !== 'assistant') {
        continue;
      }
      const text = extractTextFromMessage(messages[index]);
      if (text) {
        const output = coerceOpenClawOutput(text);
        const usage = extractUsageFromMessage(messages[index]);
        settleRun(run.request, run, usage ? { ...output, usage } : output);
        return;
      }
    }

    throw new Error('OpenClaw returned an empty final reply.');
  }

  private async runLocalToolFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    return await runSharedRuntimeToolFallback({
      backendLabel: 'OpenClaw',
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
        emitWorkerEvent(request, run, {
          type: 'tool-call',
          toolName,
          detail,
        });
      },
      onToolResult: (toolName, detail, output) => {
        run.sawToolCall = true;
        emitWorkerEvent(request, run, {
          type: 'tool-result',
          toolName,
          detail,
          output,
        });
      },
      onTextDelta: (text) => {
        run.latestAssistantText = text;
        run.seenText.push(text);
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text,
        });
      },
    });
  }

  private async getOrCreateSession(
    options: EnsureWorkerSessionOptions,
    requestId?: string,
    requireGateway = true,
  ): Promise<OpenClawSession> {
    if (requireGateway) {
      await this.ensureGateway(options);
    }

    const nextCwd = options.cwd || process.cwd();
    const nextModel = buildProviderQualifiedModel(options.model)
      || normalizeConfiguredRuntimeModelIdentifier(options)
      || null;
    const nextModelProvider = resolveConfiguredRuntimeModelProvider(options) || null;
    const nextModelName = resolveConfiguredRuntimeModelName(options) || null;
    const runtimeAgentId = getOpenTeamInstance().getRuntimeAgentId(options.agentId);
    const cacheKey = getSessionCacheKey(options, requestId);
    const sessionMode = resolveSessionMode(options);
    const persistentKey = resolvePersistentKey(options);
    const existing = this.sessions.get(cacheKey);
    const existingMatches =
      existing
      && existing.cwd === nextCwd
      && existing.model === nextModel
      && existing.modelProvider === nextModelProvider
      && existing.modelName === nextModelName
      && (requireGateway ? existing.client?.isConnected() : !existing.client);
    if (existingMatches) {
      return existing;
    }

    if (existing) {
      this.closeSession(existing, 'Refreshing OpenClaw persistent session', false);
    }

    const gatewayPort = this.gatewayPort;
    if (!gatewayPort) {
      throw new Error('OpenClaw gateway port has not been initialised.');
    }
    const sessionKey = buildGatewaySessionKey(runtimeAgentId, options, requestId);
    const client = new OpenClawPersistentClient({
      url: `ws://127.0.0.1:${gatewayPort}`,
      sessionKey,
      runtimeAgentId,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      onEvent: (evt) => {
        this.handleGatewayEvent(session, evt);
      },
      onConnected: () => {
        session.status = session.activeRun ? 'busy' : 'ready';
        session.lastEventAt = new Date().toISOString();
        session.lastUsedAt = session.lastEventAt;
        session.lastError = null;
      },
      onDisconnected: (reason) => {
        session.status = 'error';
        session.lastError = reason || 'OpenClaw gateway connection closed';
        session.lastEventAt = new Date().toISOString();
        if (session.activeRun && !session.activeRun.settled) {
          settleRun(session.activeRun.request, session.activeRun, {
            success: false,
            error: session.lastError,
          });
        }
      },
    });

    const session: OpenClawSession = {
      cacheKey,
      teamId: options.teamId,
      agentId: options.agentId,
      projectScope: options.projectScope?.trim() || null,
      runtimeAgentId,
      sessionKey,
      sessionMode,
      persistentKey,
      cwd: nextCwd,
      model: nextModel,
      modelProvider: nextModelProvider,
      modelName: nextModelName,
      client,
      activeRun: null,
      status: 'starting',
      startedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      lastEventAt: null,
      lastError: null,
      lastRequestId: existing?.lastRequestId || null,
      lastSessionKey: existing?.lastSessionKey || null,
    };

    if (requireGateway) {
      await client.start();
      await client.ensureSession(nextModel);
    }

    this.sessions.set(cacheKey, session);
    session.status = 'ready';
    session.lastEventAt = new Date().toISOString();
    return session;
  }

  private findSession(agentId: string, persistentKey?: string | null, cacheKey?: string | null): OpenClawSession | null {
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

  private handleGatewayEvent(session: OpenClawSession, evt: GatewayEventFrame): void {
    const run = session.activeRun;
    if (!run || !evt.event) {
      return;
    }

    session.lastEventAt = new Date().toISOString();
    session.lastUsedAt = session.lastEventAt;

    const emitStreamingText = (text: string): void => {
      const normalized = normalizeStreamingText(run.streamedSnapshot, text);
      run.streamedSnapshot = normalized.snapshot;
      if (!normalized.delta) {
        return;
      }
      run.streamedText += normalized.delta;
      run.seenText.push(normalized.delta);
      emitWorkerEvent(run.request, run, {
        type: 'text-delta',
        text: normalized.delta,
      });
    };

    if (evt.event === 'chat' && evt.payload && typeof evt.payload === 'object') {
      const payload = evt.payload as {
        runId?: string;
        state?: string;
        message?: unknown;
        errorMessage?: string;
      };
      const expectedRunId = run.runtimeRunId || run.request.requestId;
      if (payload.runId !== expectedRunId) {
        return;
      }
      if (payload.state === 'delta') {
        const text = extractTextFromMessage(payload.message);
        if (text) {
          emitStreamingText(text);
        }
        return;
      }
      if (payload.state === 'error') {
        const message = payload.errorMessage || 'OpenClaw gateway run failed';
        session.lastError = message;
        settleRun(run.request, run, {
          success: false,
          error: message,
        });
        return;
      }
      if (payload.state === 'final') {
        const text = extractTextFromMessage(payload.message);
        if (text) {
          run.latestAssistantText = text;
          emitStreamingText(text);
        }
        return;
      }
      return;
    }

    if (evt.event === 'session.message' && evt.payload && typeof evt.payload === 'object') {
      const payload = evt.payload as {
        sessionKey?: string;
        message?: unknown;
      };
      if (payload.sessionKey !== session.sessionKey || readMessageRole(payload.message) !== 'assistant') {
        return;
      }
      const messageSeq = readMessageSeq(evt.payload);
      if (
        typeof run.minAssistantMessageSeq === 'number' &&
        typeof messageSeq === 'number' &&
        messageSeq < run.minAssistantMessageSeq
      ) {
        return;
      }
      const text = extractTextFromMessage(payload.message);
      if (text) {
        run.latestAssistantText = text;
        emitStreamingText(text);
      }
      return;
    }

    if (evt.event === 'session.tool' && evt.payload && typeof evt.payload === 'object') {
      const payload = evt.payload as {
        sessionKey?: string;
        runId?: string;
        stream?: string;
        data?: {
          phase?: string;
          name?: string;
          args?: unknown;
          result?: unknown;
        };
      };
      const expectedRunId = run.runtimeRunId || run.request.requestId;
      if (payload.sessionKey !== session.sessionKey || payload.runId !== expectedRunId) {
        return;
      }
      if (payload.stream === 'tool' && payload.data?.phase === 'start' && typeof payload.data.name === 'string') {
        run.sawToolCall = true;
        emitWorkerEvent(run.request, run, {
          type: 'tool-call',
          toolName: payload.data.name,
          detail: payload.data.args == null ? undefined : JSON.stringify(payload.data.args),
        });
      } else if (payload.stream === 'tool' && payload.data?.phase === 'result' && typeof payload.data.name === 'string') {
        run.sawToolCall = true;
        const normalizedResult = payload.data.result == null ? undefined : JSON.stringify(payload.data.result);
        emitWorkerEvent(run.request, run, {
          type: 'tool-result',
          toolName: payload.data.name,
          detail: normalizedResult,
          output: normalizedResult,
        });
      }
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
      throw new Error('OpenClaw team worker was used before init(teamId).');
    }

    this.closeGateway('Restarting OpenClaw gateway');
    const { stateDir } = ensureBackendStateDirs('openclaw', ['tmp', 'logs']);
    const runtimeConfigPath = model
      ? ensureOpenClawRuntimeConfig({
          gatewayPort,
          model,
        })
      : getBackendConfigPath('openclaw');
    if (!existsSync(runtimeConfigPath)) {
      writeFileSync(runtimeConfigPath, '{}\n', 'utf-8');
    }
    const { command, args } = resolveOpenClawGatewayCommand(gatewayPort);
    const child = spawn(command, args, {
      cwd: OPENCLAW_DIR,
      env: {
        ...process.env,
        HOME: stateDir,
        TMPDIR: join(stateDir, 'tmp'),
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: runtimeConfigPath,
        OPENCLAW_OPENTEAM_TEAM_ID: this.teamId,
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
        this.gatewayLastError = `OpenClaw gateway exited with code ${code ?? 'null'}${signal ? ` (${signal})` : ''}.`;
      }
    });

    const deadline = Date.now() + GATEWAY_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.isGatewayHealthy()) {
        return;
      }
      if (child.exitCode != null) {
        throw new Error(this.gatewayLastError || `OpenClaw gateway exited early with code ${child.exitCode}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(this.gatewayLastError || `OpenClaw gateway failed to become healthy on port ${gatewayPort} within ${GATEWAY_START_TIMEOUT_MS}ms.`);
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
    for (const [cacheKey, session] of this.sessions.entries()) {
      if (session.activeRun) {
        continue;
      }
      const lastUsedAt = Date.parse(session.lastUsedAt);
      if (!Number.isFinite(lastUsedAt) || now - lastUsedAt < this.idleTtlMs) {
        continue;
      }
      this.closeSession(session, 'Runtime session idle TTL reached', true);
      this.sessions.delete(cacheKey);
    }
  }

  private closeSession(
    session: OpenClawSession,
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
    const client = session.client;
    if (session.sessionMode === 'ephemeral' && client?.isConnected()) {
      void client.deleteSession()
        .catch((error) => {
          this.gatewayLastError = formatRuntimeError(error);
        })
        .finally(() => {
          client.stop();
        });
    } else {
      client?.stop();
    }
    session.client = null;
    if (removeFromMap) {
      this.sessions.delete(session.cacheKey);
    }
  }

  private closeGateway(reason: string): void {
    this.gatewayLastError = reason;
    if (this.gatewayChild && !this.gatewayChild.killed) {
      this.gatewayChild.kill('SIGTERM');
    }
    this.gatewayChild = null;
  }

  private toSessionStatus(session: OpenClawSession): WorkerSessionStatus {
    const gatewayOnline = Boolean(this.gatewayChild && !this.gatewayChild.killed);
    const online = gatewayOnline && Boolean(session.client?.isConnected());
    const sessionReady = online && (session.status === 'ready' || session.status === 'busy');
    return {
      runtime: 'openclaw',
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
