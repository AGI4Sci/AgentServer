import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { ensureBackendStateDirs } from '../../../core/runtime/backend-paths.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from '../model-spec.js';
import { resolveCodexRuntimeModelSelection } from '../codex-model-runtime.js';
import { ensureRuntimeSupervisor } from '../supervisor-client.js';
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
import { resolveManagedBackendExecutableForBackend } from './backend-managed-launchers.js';
import { requestDemandsRuntimeToolExecution } from '../shared/runtime-tool-requirements.js';
import { runOpenAICompatibleStreamingChat, shouldUseDirectOpenAICompatibleRuntime } from './openai-compatible-stream.js';
import { containsEmbeddedProviderToolCallText } from './openai-compatible-stream.js';
import { containsUnexecutedToolIntentText } from './openai-compatible-stream.js';
import { runSharedRuntimeToolFallback } from '../shared/runtime-tool-fallback.js';
import { normalizeStreamingText } from './stream-normalizer.js';
import {
  buildRuntimeCompletedMessage,
  buildRuntimeRunningMessage,
  buildRuntimeStallMessage,
  buildRuntimeStartingMessage,
  buildRuntimeTimeoutMessage,
} from './worker-runtime-labels.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

interface CodexWireEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    server?: string;
    tool?: string;
    error?: { message?: string };
  };
  error?: { message?: string };
  message?: string;
}

interface CodexLaunchSpec {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const CODEX_RUST_DIR = join(process.cwd(), 'server', 'backend', 'codex', 'codex-rs');
const CODEX_BINARIES = [
  join(CODEX_RUST_DIR, 'target', 'release', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  join(CODEX_RUST_DIR, 'target', 'debug', process.platform === 'win32' ? 'codex.exe' : 'codex'),
];
const DEFAULT_IDLE_TTL_MS = Math.max(
  60_000,
  loadOpenTeamConfig().runtime.worker.idleTtlMs,
);
const DEFAULT_IDLE_SWEEP_MS = Math.max(
  15_000,
  loadOpenTeamConfig().runtime.worker.idleSweepMs,
);
const CODEX_WORKER_LOG_PATH = join(process.cwd(), 'tmp', 'codex-worker-launch.log');

type ActiveRun = {
  request: WorkerRunRequest;
  onEvent: (event: WorkerEvent) => void;
  resolve: (output: SessionOutput) => void;
  settled: boolean;
  fallbackRequested: boolean;
  timeoutHandle?: NodeJS.Timeout;
  stallHandle?: NodeJS.Timeout;
  child: ChildProcessWithoutNullStreams | null;
  finalText: string;
  stdoutFallback: string;
  stderrBuffer: string;
  streamedText: string;
  itemSnapshots: Map<string, string>;
  sawToolCall: boolean;
  phase: string;
  lastUsage?: {
    input: number;
    output: number;
    total?: number;
  };
};

type CodexRuntimeSession = {
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
  threadId: string | null;
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

function emitWorkerEvent(request: WorkerRunRequest, run: ActiveRun, event: WorkerEventPayload): void {
  run.onEvent(withRuntimeEventProtocol({
    ...event,
    teamId: request.teamId,
    agentId: request.agentId,
    requestId: request.requestId,
    sessionKey: request.sessionKey,
  } as WorkerEvent));
}

function setRunPhase(run: ActiveRun, phase: string): void {
  run.phase = phase;
}

function buildCodexTimeoutDetails(run: ActiveRun, timeoutMs: number): string {
  const parts = [buildRuntimeTimeoutMessage('Codex', timeoutMs)];
  const phase = run.phase.trim();
  if (phase) {
    parts.push(`Last known phase: ${phase}.`);
  }
  const stderr = run.stderrBuffer.trim();
  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }
  return parts.join(' ');
}

function settleRun(request: WorkerRunRequest, run: ActiveRun, output: SessionOutput): void {
  if (run.settled) {
    return;
  }
  run.settled = true;
  if (run.timeoutHandle) {
    clearTimeout(run.timeoutHandle);
  }
  if (run.stallHandle) {
    clearTimeout(run.stallHandle);
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
    message: output.success ? buildRuntimeCompletedMessage('Codex') : output.error,
  });
  emitWorkerEvent(request, run, {
    type: 'result',
    output,
    usage: output.usage,
  });
  run.resolve(output);
}

export function buildCodexEnsureSessionOptionsFromRunRequest(
  request: WorkerRunRequest,
): EnsureWorkerSessionOptions {
  return {
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

function requestClearlyDemandsRealTools(request: WorkerRunRequest): boolean {
  if (requestDemandsRuntimeToolExecution(request)) {
    return true;
  }
  const text = `${request.input.task}\n${request.input.context}`.toLowerCase();
  return text.includes('use the available tools')
    || text.includes('use available tools')
    || text.includes('use the provided tools')
    || text.includes('current working directory')
    || text.includes('do not guess')
    || text.includes('请使用可用工具')
    || text.includes('当前工作目录')
    || text.includes('不要猜测');
}

function hasCodexCommandAvailable(): boolean {
  try {
    resolveCodexLaunchSpec();
    return true;
  } catch {
    return false;
  }
}

function logCodexWorkerEvent(label: string, payload: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
    appendFileSync(
      CODEX_WORKER_LOG_PATH,
      `${JSON.stringify({
        at: new Date().toISOString(),
        label,
        payload,
      })}\n`,
      'utf8',
    );
  } catch {
    // Ignore logging failures.
  }
}

function hasCargoAvailable(): boolean {
  const cargoCheck = spawnSync('cargo', ['--version'], { stdio: 'ignore' });
  return !cargoCheck.error && cargoCheck.status === 0;
}

function readBundledRustToolchainChannel(): string | null {
  const toolchainFile = join(CODEX_RUST_DIR, 'rust-toolchain.toml');
  if (existsSync(toolchainFile)) {
    try {
      const content = readFileSync(toolchainFile, 'utf8');
      const match = content.match(/channel\s*=\s*"([^"]+)"/);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    } catch {
      return null;
    }
  }

  const legacyToolchainFile = join(CODEX_RUST_DIR, 'rust-toolchain');
  if (!existsSync(legacyToolchainFile)) {
    return null;
  }
  try {
    const content = readFileSync(legacyToolchainFile, 'utf8').trim();
    return content || null;
  } catch {
    return null;
  }
}

function listInstalledRustupToolchains(): string[] {
  const result = spawnSync('rustup', ['toolchain', 'list'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    return [];
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/\s+\(default\)\s*$/, '').trim());
}

function resolveCargoToolchainOverride(): string | null {
  const explicit = process.env.OPENTEAM_CODEX_CARGO_TOOLCHAIN?.trim();
  if (explicit) {
    return explicit;
  }

  const requested = readBundledRustToolchainChannel();
  const installed = listInstalledRustupToolchains();
  if (requested && installed.includes(requested)) {
    return requested;
  }
  if (installed.includes('stable')) {
    return 'stable';
  }

  const active = spawnSync('rustup', ['show', 'active-toolchain'], { encoding: 'utf8' });
  if (!active.error && active.status === 0) {
    const candidate = active.stdout.trim().split(/\s+/)[0]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return requested || null;
}

function resolveCodexLaunchSpec(): CodexLaunchSpec {
  if (process.env.CODEX_EXECUTABLE && existsSync(process.env.CODEX_EXECUTABLE)) {
    return {
      command: process.env.CODEX_EXECUTABLE,
      args: ['app-server', '--listen', 'stdio://'],
    };
  }

  const managedBinary = resolveManagedBackendExecutableForBackend('codex');
  if (managedBinary) {
    return {
      command: managedBinary,
      args: ['app-server', '--listen', 'stdio://'],
    };
  }

  const localBinary = CODEX_BINARIES.find((candidate) => existsSync(candidate));
  if (localBinary) {
    return {
      command: localBinary,
      args: ['app-server', '--listen', 'stdio://'],
    };
  }

  if (existsSync(join(CODEX_RUST_DIR, 'Cargo.toml')) && hasCargoAvailable()) {
    const toolchain = resolveCargoToolchainOverride();
    return {
      command: 'cargo',
      args: [
        ...(toolchain ? [`+${toolchain}`] : []),
        'run',
        '-p',
        'codex-cli',
        '--bin',
        'codex',
        '--',
        'app-server',
        '--listen',
        'stdio://',
      ],
      cwd: CODEX_RUST_DIR,
      env: toolchain ? { RUSTUP_TOOLCHAIN: toolchain } : undefined,
    };
  }

  throw new Error(
    `Codex executable not found. Set CODEX_EXECUTABLE, build codex under ${CODEX_RUST_DIR}, or ensure cargo is available to launch the bundled codex workspace.`,
  );
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

function buildToolRuntimeUnavailableError(): string {
  return 'Codex tool runtime is unavailable for this request. The current backend fell back to plain chat.completions, which is not allowed for tool-required tasks.';
}

function isResponsesApiIncompatible(details: string): boolean {
  return (
    details.includes('/v1/responses')
    || details.includes('responses_websocket')
    || details.includes('Unknown error, url: ws://127.0.0.1')
    || details.includes('stream disconnected')
  );
}

function isRecoverableDirectChatFailure(details: string): boolean {
  const normalized = details.toLowerCase();
  return normalized.includes('fetch failed')
    || normalized.includes('ecconnrefused')
    || normalized.includes('connection refused')
    || normalized.includes('connect etimedout')
    || normalized.includes('econnreset')
    || normalized.includes('socket hang up')
    || normalized.includes('enotfound')
    || normalized.includes('eai_again')
    || normalized.includes('network error');
}

function describePayload(payload: unknown): string {
  if (payload == null) {
    return '';
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

function summarizeRecentRuntimeOutput(run: ActiveRun): string | null {
  const raw = run.finalText.trim() || run.streamedText.trim() || run.stdoutFallback.trim();
  if (!raw) {
    return null;
  }
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }
  return compact.length > 240 ? `${compact.slice(-240)}` : compact;
}

function resolveCodexRunStallTimeoutMs(totalTimeoutMs?: number | null): number | null {
  const envValue = Number.parseInt(process.env.OPENTEAM_CODEX_RUN_STALL_TIMEOUT_MS?.trim() || '', 10);
  const configured = Number.isFinite(envValue) && envValue > 0
    ? envValue
    : Math.max(0, loadOpenTeamConfig().runtime.worker.runStallTimeoutMs || 0);
  if (configured <= 0) {
    return null;
  }
  if (totalTimeoutMs && configured >= totalTimeoutMs) {
    return null;
  }
  return configured;
}

export class CodexTeamWorker {
  private readonly sessions = new Map<string, CodexRuntimeSession>();
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
    const session = this.getOrCreateSession(options);
    if (options.healthcheck === 'launch') {
      await this.probeSessionLaunch(session, options);
    }
    return this.toSessionStatus(session);
  }

  disposeSession(options: DisposeWorkerSessionOptions): WorkerSessionStatus | null {
    const session = this.findSession(options.agentId, options.persistentKey, options.cacheKey);
    if (!session) {
      return null;
    }
    const snapshot = this.toSessionStatus(session);
    const run = session.activeRun;
    if (run && !run.settled) {
      settleRun(run.request, run, {
        success: false,
        error: options.reason || 'Runtime session stopped by supervisor',
      });
    }
    this.sessions.delete(session.cacheKey);
    return snapshot;
  }

  shutdown(reason = 'Runtime supervisor shutting down'): WorkerSessionStatus[] {
    const snapshots = this.listSessionStatuses();
    for (const session of this.sessions.values()) {
      const run = session.activeRun;
      if (run && !run.settled) {
        settleRun(run.request, run, {
          success: false,
          error: reason,
        });
        run.child?.kill('SIGTERM');
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
    const session = this.getOrCreateSession(
      buildCodexEnsureSessionOptionsFromRunRequest(request),
      request.requestId,
    );
    if (session.activeRun) {
      throw new Error(`Codex agent ${request.agentId} already has an active run`);
    }

    const workingDirectory = request.options.cwd || process.cwd();
    const { stateDir } = ensureBackendStateDirs('codex', ['home', 'tmp', 'sqlite', 'config', 'cache']);
    const runtimeConnection = await resolveHealthyRuntimeBackendConnection(request.options);
    const baseUrl = runtimeConnection.baseUrl;
    const apiKey = runtimeConnection.apiKey;
    const modelSelection = resolveCodexRuntimeModelSelection({
      connection: runtimeConnection,
      input: request.options,
      explicitCodexModel: process.env.AGENT_SERVER_CODEX_MODEL,
    });
    const model = modelSelection.model;
    const runtimeModelProvider = modelSelection.modelProvider || runtimeConnection.provider || request.options.modelProvider || null;
    if (modelSelection.route === 'custom-provider') {
      await ensureRuntimeSupervisor();
    }
    const useDirectChatCompletions = this.shouldUseDirectChatCompletions(request, baseUrl);
    const requiresRealTools = requestClearlyDemandsRealTools(request);

    return await new Promise<SessionOutput>((resolve) => {
      const run: ActiveRun = {
        request,
        onEvent: handlers.onEvent,
        resolve: (output) => {
          session.activeRun = null;
          if (output.success) {
            session.lastError = null;
            session.status = 'ready';
          } else {
            session.status = 'error';
          }
          session.lastUsedAt = new Date().toISOString();
          session.lastEventAt = session.lastUsedAt;
          if (session.sessionMode === 'ephemeral') {
            this.sessions.delete(session.cacheKey);
          }
          resolve(output);
        },
        settled: false,
        fallbackRequested: false,
        child: null,
        finalText: '',
        stdoutFallback: '',
        stderrBuffer: '',
        streamedText: '',
        itemSnapshots: new Map(),
        sawToolCall: false,
        phase: 'spawned',
      };
      session.activeRun = run;
      session.status = 'busy';
      session.lastUsedAt = new Date().toISOString();
      session.lastEventAt = session.lastUsedAt;
      session.lastError = null;
      session.lastRequestId = request.requestId;
      session.lastSessionKey = request.sessionKey;

      emitWorkerEvent(request, run, {
        type: 'status',
        status: 'starting',
        message: buildRuntimeStartingMessage('Codex'),
      });

      if (useDirectChatCompletions) {
        void (async () => {
          try {
            if (requiresRealTools) {
              const output = await this.runLocalToolFallback(request, run);
              if (!output.success) {
                session.lastError = output.error;
              }
              settleRun(request, run, output);
              return;
            }
            const output = await this.runDirectChatWithFallback(request, run);
            settleRun(request, run, output);
          } catch (error) {
            const formatted = formatRuntimeError(error);
            if (isRecoverableDirectChatFailure(formatted)) {
              const fallbackOutput = await this.runLocalToolFallback(request, run);
              if (!fallbackOutput.success) {
                session.lastError = fallbackOutput.error;
              }
              settleRun(request, run, fallbackOutput);
              return;
            }
            session.lastError = formatted;
            settleRun(request, run, {
              success: false,
              error: formatted,
            });
          }
        })();
        return;
      }

      const { command, args, cwd: launchCwd, env: launchEnv } = resolveCodexLaunchSpec();
      const commandArgs = [...args];
      if (baseUrl) {
        commandArgs.push('--config', `openai_base_url="${baseUrl}"`);
      }
      commandArgs.push(...modelSelection.configArgs);
      commandArgs.push('--config', 'approval_policy="never"');
      commandArgs.push('--config', 'web_search="disabled"');
      commandArgs.push('--config', 'features.plugins=false');
      commandArgs.push('--config', 'sandbox_workspace_write.network_access=true');
      commandArgs.push('--config', 'otel.exporter="none"');
      commandArgs.push('--config', 'otel.trace_exporter="none"');
      commandArgs.push('--config', 'otel.metrics_exporter="none"');
      logCodexWorkerEvent('spawn_run', {
        command,
        commandArgs,
        baseUrl,
        requestModel: request.options.model ?? null,
        requestModelProvider: request.options.modelProvider ?? null,
        requestModelName: request.options.modelName ?? null,
        resolvedDirectRuntimeModel: normalizeConfiguredRuntimeModelIdentifier(request.options) || null,
        runtimeModelProvider,
        runtimeModelRoute: modelSelection.route,
        resolvedModelName: model,
        useDirectChatCompletions,
        requiresRealTools,
        taskPreview: request.input.task.slice(0, 240),
        contextPreview: request.input.context.slice(0, 240),
        teamId: request.teamId,
        agentId: request.agentId,
      });

      const child = spawn(command, commandArgs, {
        cwd: launchCwd || workingDirectory,
        env: {
          ...process.env,
          ...launchEnv,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'openteam_runtime',
          HOME: join(stateDir, 'home'),
          TMPDIR: join(stateDir, 'tmp'),
          CODEX_HOME: join(stateDir, 'home'),
          CODEX_SQLITE_HOME: join(stateDir, 'sqlite'),
          XDG_CONFIG_HOME: join(stateDir, 'config'),
          XDG_CACHE_HOME: join(stateDir, 'cache'),
          ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      run.child = child;

      const stdoutReader = createInterface({ input: child.stdout });
      child.stderr.on('data', (chunk) => {
        run.stderrBuffer += chunk.toString();
      });

      const pendingRequests = new Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
      }>();
      let nextRequestId = 1;
      let activeTurnId: string | null = null;
      let latestAgentMessage = '';
      const timeoutMs = request.options.timeoutMs && request.options.timeoutMs > 0
        ? request.options.timeoutMs
        : null;
      const effectiveStallTimeoutMs = resolveCodexRunStallTimeoutMs(timeoutMs);

      const refreshStallWatchdog = (): void => {
        if (!effectiveStallTimeoutMs || run.settled) {
          return;
        }
        if (run.stallHandle) {
          clearTimeout(run.stallHandle);
        }
        run.stallHandle = setTimeout(() => {
          if (run.settled) {
            return;
          }
          const message = buildRuntimeStallMessage(
            'Codex',
            effectiveStallTimeoutMs,
            summarizeRecentRuntimeOutput(run),
          );
          session.lastError = message;
          run.child?.kill('SIGTERM');
          settleRun(request, run, { success: false, error: message });
        }, effectiveStallTimeoutMs).unref();
      };

      const sendMessage = (message: Record<string, unknown>): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const requestJsonRpc = <T = any>(method: string, params: Record<string, unknown>): Promise<T> => {
        const id = `openteam-${nextRequestId++}`;
        return new Promise<T>((resolveRequest, rejectRequest) => {
          pendingRequests.set(id, {
            resolve: resolveRequest,
            reject: rejectRequest,
          });
          sendMessage({
            id,
            method,
            params,
          });
        });
      };

      const rejectPendingRequests = (error: Error): void => {
        for (const pending of pendingRequests.values()) {
          pending.reject(error);
        }
        pendingRequests.clear();
      };

      const handleNotification = (method: string, params: any): void => {
        session.lastEventAt = new Date().toISOString();
        session.lastUsedAt = session.lastEventAt;
        refreshStallWatchdog();

        if (method === 'thread/started') {
          setRunPhase(run, 'thread_started');
          const threadId = typeof params?.thread?.id === 'string' ? params.thread.id : null;
          if (threadId) {
            session.threadId = threadId;
          }
          return;
        }

        if (method === 'turn/started') {
          setRunPhase(run, 'turn_started');
          const turnId = typeof params?.turn?.id === 'string' ? params.turn.id : null;
          if (turnId) {
            activeTurnId = turnId;
          }
          emitWorkerEvent(run.request, run, {
            type: 'status',
            status: 'running',
            message: buildRuntimeRunningMessage('Codex'),
          });
          return;
        }

        if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
          latestAgentMessage += params.delta;
          run.streamedText += params.delta;
          emitWorkerEvent(run.request, run, {
            type: 'text-delta',
            text: params.delta,
          });
          return;
        }

        if (
          (
            method === 'item/reasoning/textDelta'
            || method === 'item/reasoning/summaryTextDelta'
            || method === 'item/commandExecution/outputDelta'
            || method === 'command/exec/outputDelta'
          )
          && typeof params?.delta === 'string'
        ) {
          emitWorkerEvent(run.request, run, {
            type: 'text-delta',
            text: params.delta,
          });
          return;
        }

        if (method === 'item/started') {
          const item = params?.item;
          if (item?.type === 'commandExecution') {
            run.sawToolCall = true;
            emitWorkerEvent(run.request, run, {
              type: 'tool-call',
              toolName: 'shell',
              detail: typeof item.command === 'string' ? item.command : undefined,
            });
            return;
          }
          if (item?.type === 'mcpToolCall') {
            run.sawToolCall = true;
            emitWorkerEvent(run.request, run, {
              type: 'tool-call',
              toolName: [item.server, item.tool].filter((value) => typeof value === 'string' && value).join(':') || 'mcp_tool_call',
            });
            return;
          }
          return;
        }

        if (method === 'item/completed') {
          const item = params?.item;
          if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
            latestAgentMessage = item.text;
            run.finalText = item.text;
          }
          return;
        }

        if (method === 'thread/tokenUsage/updated') {
          setRunPhase(run, 'streaming_usage_updates');
          const tokenUsage = params?.tokenUsage;
          const last = tokenUsage?.last;
          const input = Number(last?.inputTokens) || 0;
          const output = Number(last?.outputTokens) || 0;
          const total = Number(last?.totalTokens) || (input + output);
          if (input > 0 || output > 0 || total > 0) {
            run.lastUsage = {
              input,
              output,
              total,
            };
          }
          return;
        }

        if (method === 'turn/completed') {
          setRunPhase(run, 'turn_completed');
          const turn = params?.turn;
          const completedTurnId = typeof turn?.id === 'string' ? turn.id : null;
          if (activeTurnId && completedTurnId && activeTurnId !== completedTurnId) {
            return;
          }
          if (turn?.status === 'failed') {
            const message = turn?.error?.message || 'Codex turn failed.';
            session.lastError = message;
            if (isResponsesApiIncompatible(message)) {
              run.fallbackRequested = true;
              child.kill('SIGTERM');
              return;
            }
            settleRun(run.request, run, { success: false, error: message });
            child.kill('SIGTERM');
            return;
          }
          if (requiresRealTools && !run.sawToolCall) {
            void this.runLocalToolFallback(request, run).then((output) => {
              settleRun(request, run, output);
            }).catch((error) => {
              settleRun(request, run, {
                success: false,
                error: formatRuntimeError(error),
              });
            });
            child.kill('SIGTERM');
            return;
          }
          run.finalText = run.finalText.trim() || latestAgentMessage.trim();
          settleRun(run.request, run, {
            success: true,
            result: run.finalText.trim() || latestAgentMessage.trim() || run.stdoutFallback.trim(),
            ...(run.lastUsage ? { usage: run.lastUsage } : {}),
          });
          child.kill('SIGTERM');
          return;
        }

        if (method === 'error') {
          setRunPhase(run, 'runtime_error');
          const message = typeof params?.message === 'string' && params.message.trim()
            ? params.message
            : `Codex runtime error: ${describePayload(params) || 'unknown error payload'}`;
          session.lastError = message;
          if (isResponsesApiIncompatible(message)) {
            run.fallbackRequested = true;
            child.kill('SIGTERM');
            return;
          }
          emitWorkerEvent(run.request, run, {
            type: 'status',
            status: 'failed',
            message,
          });
          settleRun(run.request, run, {
            success: false,
            error: message,
          });
          child.kill('SIGTERM');
        }
      };

      stdoutReader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        session.lastEventAt = new Date().toISOString();
        session.lastUsedAt = session.lastEventAt;
        refreshStallWatchdog();
        try {
          const payload = JSON.parse(trimmed) as Record<string, any>;
          if (payload.method && payload.id != null) {
            sendMessage({
              id: payload.id,
              result: {},
            });
            return;
          }
          if (payload.method) {
            handleNotification(String(payload.method), payload.params ?? {});
            return;
          }
          if (payload.id != null) {
            const pending = pendingRequests.get(String(payload.id));
            if (!pending) {
              return;
            }
            pendingRequests.delete(String(payload.id));
            if (payload.error) {
              pending.reject(new Error(payload.error.message || 'Codex app-server request failed.'));
              return;
            }
            pending.resolve(payload.result);
            return;
          }
        } catch {
          run.stdoutFallback += `${trimmed}\n`;
        }
      });

      child.on('error', (error) => {
        const formatted = formatRuntimeError(error);
        rejectPendingRequests(new Error(formatted));
        session.lastError = formatted;
        settleRun(request, run, { success: false, error: formatted });
      });

      child.on('spawn', () => {
        void (async () => {
          try {
            setRunPhase(run, 'initialize_request');
            await requestJsonRpc('initialize', {
              clientInfo: {
                name: 'openteam_runtime',
                title: 'OpenTeam Runtime',
                version: '1.0.0',
              },
              capabilities: {
                experimentalApi: true,
              },
            });
            sendMessage({
              method: 'initialized',
              params: {},
            });

            setRunPhase(run, 'thread_start_request');
            const threadResult = await requestJsonRpc('thread/start', {
              cwd: workingDirectory,
              model: model,
              modelProvider: runtimeModelProvider,
              sandbox: 'danger-full-access',
              approvalPolicy: 'never',
              experimentalRawEvents: false,
              persistExtendedHistory: true,
            });

            const threadId = typeof threadResult?.thread?.id === 'string' ? threadResult.thread.id : null;
            if (!threadId) {
              throw new Error('Codex app-server did not return a thread id.');
            }
            session.threadId = threadId;

            setRunPhase(run, 'turn_start_request');
            await requestJsonRpc('turn/start', {
              threadId,
              cwd: workingDirectory,
              model: model,
              modelProvider: runtimeModelProvider,
              approvalPolicy: 'never',
              sandboxPolicy: {
                type: 'dangerFullAccess',
              },
              input: [
                {
                  type: 'text',
                  text: buildPrompt(request.input),
                  text_elements: [],
                },
              ],
            });
            setRunPhase(run, 'awaiting_turn_events');
          } catch (error) {
            const formatted = formatRuntimeError(error);
            rejectPendingRequests(new Error(formatted));
            session.lastError = formatted;
            if (isResponsesApiIncompatible(formatted)) {
              run.fallbackRequested = true;
              child.kill('SIGTERM');
              return;
            }
            settleRun(request, run, { success: false, error: formatted });
            child.kill('SIGTERM');
          }
        })();
      });

      child.on('close', async (code, signal) => {
        stdoutReader.close();
        rejectPendingRequests(new Error(`Codex app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
        if (run.settled) {
          return;
        }

        const details = [
          `Codex runtime exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
          run.stderrBuffer.trim() || null,
        ].filter(Boolean).join('\n\n');

        if (run.fallbackRequested || isResponsesApiIncompatible(details)) {
          try {
            if (requiresRealTools) {
              const output = await this.runLocalToolFallback(request, run);
              if (!output.success) {
                session.lastError = output.error;
              }
              settleRun(request, run, output);
              return;
            }
            const output = await this.runDirectChatCompletions(request);
            settleRun(request, run, output);
          } catch (error) {
            const formatted = formatRuntimeError(error);
            session.lastError = formatted;
            settleRun(request, run, { success: false, error: formatted });
          }
          return;
        }

        session.lastError = details;
        settleRun(request, run, { success: false, error: details });
      });

      if (timeoutMs) {
        run.timeoutHandle = setTimeout(() => {
          if (run.settled) {
            return;
          }
          child.kill('SIGTERM');
          const message = buildCodexTimeoutDetails(run, timeoutMs);
          session.lastError = message;
          settleRun(request, run, { success: false, error: message });
        }, timeoutMs).unref();
      }

    });
  }

  private getOrCreateSession(options: EnsureWorkerSessionOptions, requestId?: string): CodexRuntimeSession {
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

    resolveCodexLaunchSpec();
    const session: CodexRuntimeSession = {
      cacheKey,
      teamId: options.teamId,
      agentId: options.agentId,
      projectScope: options.projectScope?.trim() || null,
      sessionMode,
      persistentKey,
      cwd: nextCwd,
      model: nextModel,
      modelProvider: nextModelProvider,
      modelName: nextModelName,
      threadId: null,
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

  private findSession(agentId: string, persistentKey?: string | null, cacheKey?: string | null): CodexRuntimeSession | null {
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

  private handleStdoutLine(
    session: CodexRuntimeSession,
    run: ActiveRun,
    line: string,
  ): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const emitNormalizedTextDelta = (snapshotKey: string, text: string): void => {
      const previousSnapshot = run.itemSnapshots.get(snapshotKey) || '';
      const normalizedItem = normalizeStreamingText(previousSnapshot, text);
      run.itemSnapshots.set(snapshotKey, normalizedItem.snapshot);
      if (!normalizedItem.delta) {
        return;
      }
      const normalizedStream = normalizeStreamingText(run.streamedText, normalizedItem.delta);
      run.streamedText = normalizedStream.snapshot;
      if (!normalizedStream.delta) {
        return;
      }
      emitWorkerEvent(run.request, run, {
        type: 'text-delta',
        text: normalizedStream.delta,
      });
    };

    try {
      const event = JSON.parse(trimmed) as CodexWireEvent;
      session.lastEventAt = new Date().toISOString();
      session.lastUsedAt = session.lastEventAt;
      const itemId = event.item?.id?.trim();

      if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
        session.threadId = event.thread_id;
        return;
      }

      if (event.type === 'turn.started') {
        emitWorkerEvent(run.request, run, {
          type: 'status',
          status: 'running',
          message: buildRuntimeRunningMessage('Codex'),
        });
        return;
      }

      if (
        (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed')
        && event.item?.type === 'agent_message'
        && typeof event.item.text === 'string'
      ) {
        if (event.type === 'item.completed') {
          run.finalText = event.item.text;
        }
        emitNormalizedTextDelta(itemId ? `agent:${itemId}` : 'agent:default', event.item.text);
        return;
      }

      if (
        (event.type === 'item.updated' || event.type === 'item.completed')
        && event.item?.type === 'reasoning'
        && typeof event.item.text === 'string'
      ) {
        emitNormalizedTextDelta(itemId ? `reasoning:${itemId}` : 'reasoning:default', event.item.text);
        return;
      }

      if (
        (event.type === 'item.updated' || event.type === 'item.completed')
        && event.item?.type === 'command_execution'
        && typeof event.item.aggregated_output === 'string'
      ) {
        emitWorkerEvent(run.request, run, {
          type: 'tool-result',
          toolName: 'shell',
          detail: event.item.aggregated_output,
          output: event.item.aggregated_output,
        });
        emitNormalizedTextDelta(itemId ? `command:${itemId}` : 'command:default', event.item.aggregated_output);
      }

      if ((event.type === 'item.started' || event.type === 'item.updated') && event.item?.type === 'command_execution') {
        run.sawToolCall = true;
        emitWorkerEvent(run.request, run, {
          type: 'tool-call',
          toolName: 'shell',
          detail: event.item.command,
        });
        return;
      }

      if ((event.type === 'item.started' || event.type === 'item.updated') && event.item?.type === 'mcp_tool_call') {
        run.sawToolCall = true;
        emitWorkerEvent(run.request, run, {
          type: 'tool-call',
          toolName: [event.item.server, event.item.tool].filter(Boolean).join(':') || 'mcp_tool_call',
        });
        return;
      }

      if (event.type === 'item.completed' && event.item?.type === 'error') {
        const message = event.item.error?.message || event.message || 'Codex reported an item error.';
        session.lastError = message;
        if (isResponsesApiIncompatible(message)) {
          run.fallbackRequested = true;
          run.child?.kill('SIGTERM');
          return;
        }
        emitWorkerEvent(run.request, run, {
          type: 'status',
          status: 'failed',
          message,
        });
        return;
      }

      if (event.type === 'turn.failed') {
        const message = event.error?.message || 'Codex turn failed.';
        session.lastError = message;
        settleRun(run.request, run, { success: false, error: message });
        return;
      }

      if (event.type === 'error') {
        const message = event.message || 'Codex runtime error.';
        session.lastError = message;
        if (isResponsesApiIncompatible(message)) {
          run.fallbackRequested = true;
          run.child?.kill('SIGTERM');
          return;
        }
        emitWorkerEvent(run.request, run, {
          type: 'status',
          status: 'failed',
          message,
        });
        return;
      }
    } catch {
      run.stdoutFallback += `${trimmed}\n`;
      const normalized = normalizeStreamingText(run.streamedText, `${trimmed}\n`);
      run.streamedText = normalized.snapshot;
      if (!normalized.delta) {
        return;
      }
      emitWorkerEvent(run.request, run, {
        type: 'text-delta',
        text: normalized.delta,
      });
    }
  }

  private shouldUseDirectChatCompletions(request: WorkerRunRequest, baseUrl: string | null): boolean {
    if (request.options.toolMode === 'none') {
      return true;
    }
    if (process.env.OPENTEAM_CODEX_FORCE_APP_SERVER === '1') {
      return false;
    }
    if (process.env.OPENTEAM_CODEX_FORCE_DIRECT_CHAT_COMPLETIONS === '1') {
      return true;
    }
    if (!hasCodexCommandAvailable()) {
      return true;
    }
    if (shouldUseDirectOpenAICompatibleRuntime(request)) {
      return true;
    }
    return false;
  }

  private async runLocalToolFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    return await runSharedRuntimeToolFallback({
      backendLabel: 'Codex',
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
        run.streamedText += text;
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text,
        });
      },
    });
  }

  private async runDirectChatCompletions(request: WorkerRunRequest, run?: ActiveRun): Promise<SessionOutput> {
    return await runOpenAICompatibleStreamingChat({
      backendLabel: 'Codex',
      request,
      hooks: run ? {
        onStatus: (status, message) => {
          emitWorkerEvent(request, run, {
            type: 'status',
            status,
            message,
          });
        },
        onTextDelta: (text) => {
          emitWorkerEvent(request, run, {
            type: 'text-delta',
            text,
          });
        },
      } : undefined,
    });
  }

  private async runDirectChatWithFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    const output = await this.runDirectChatCompletions(request, run);
    if (
      output.success
      && requestClearlyDemandsRealTools(request)
      && (containsEmbeddedProviderToolCallText(output.result) || containsUnexecutedToolIntentText(output.result))
    ) {
      return await this.runLocalToolFallback(request, run);
    }
    if (!output.success && isRecoverableDirectChatFailure(output.error)) {
      return await this.runLocalToolFallback(request, run);
    }
    return output;
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
      this.sessions.delete(cacheKey);
    }
  }

  private toSessionStatus(session: CodexRuntimeSession): WorkerSessionStatus {
    const online = session.status === 'ready' || session.status === 'busy';
    return {
      runtime: 'codex',
      teamId: session.teamId,
      agentId: session.agentId,
      projectScope: session.projectScope,
      cwd: session.cwd,
      model: session.model,
      modelProvider: session.modelProvider,
      modelName: session.modelName,
      sessionMode: session.sessionMode,
      persistentKey: session.persistentKey,
      pid: session.activeRun?.child?.pid ?? null,
      sessionReady: online,
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

  private async probeSessionLaunch(
    session: CodexRuntimeSession,
    options: EnsureWorkerSessionOptions,
  ): Promise<void> {
    const runtimeConnection = await resolveHealthyRuntimeBackendConnection(options);
    const baseUrl = runtimeConnection.baseUrl;
    const apiKey = runtimeConnection.apiKey;
    const modelSelection = resolveCodexRuntimeModelSelection({
      connection: runtimeConnection,
      input: options,
      explicitCodexModel: process.env.AGENT_SERVER_CODEX_MODEL,
    });
    const model = modelSelection.model;
    const runtimeModelProvider = modelSelection.modelProvider || runtimeConnection.provider || options.modelProvider || null;
    if (modelSelection.route === 'custom-provider') {
      await ensureRuntimeSupervisor();
    }
    const workingDirectory = options.cwd || process.cwd();
    const { stateDir } = ensureBackendStateDirs('codex', ['home', 'tmp', 'sqlite', 'config', 'cache']);
    const { command, args, cwd: launchCwd, env: launchEnv } = resolveCodexLaunchSpec();
    const commandArgs = [...args];
    if (baseUrl) {
      commandArgs.push('--config', `openai_base_url="${baseUrl}"`);
    }
    commandArgs.push(...modelSelection.configArgs);
    commandArgs.push('--config', 'approval_policy="never"');
    commandArgs.push('--config', 'web_search="disabled"');
    commandArgs.push('--config', 'sandbox_workspace_write.network_access=true');
    commandArgs.push('--config', 'otel.exporter="none"');
    commandArgs.push('--config', 'otel.trace_exporter="none"');
    commandArgs.push('--config', 'otel.metrics_exporter="none"');
    logCodexWorkerEvent('probe_launch', {
      command,
      commandArgs,
      baseUrl,
      runtimeModelProvider,
      runtimeModelRoute: modelSelection.route,
      teamId: options.teamId,
      agentId: options.agentId,
    });

    session.status = 'starting';
    session.lastError = null;
    session.lastUsedAt = new Date().toISOString();

    const timeoutMs = Math.max(
      5_000,
      loadOpenTeamConfig().runtime.codex.launchHealthcheckTimeoutMs,
    );

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        cwd: launchCwd || workingDirectory,
        env: {
          ...process.env,
          ...launchEnv,
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'openteam_runtime_probe',
          HOME: join(stateDir, 'home'),
          TMPDIR: join(stateDir, 'tmp'),
          CODEX_HOME: join(stateDir, 'home'),
          CODEX_SQLITE_HOME: join(stateDir, 'sqlite'),
          XDG_CONFIG_HOME: join(stateDir, 'config'),
          XDG_CACHE_HOME: join(stateDir, 'cache'),
          ...(apiKey ? { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey } : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const stdoutReader = createInterface({ input: child.stdout });
      const pendingRequests = new Map<string, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
      }>();
      let stderrBuffer = '';
      let settled = false;
      let nextRequestId = 1;

      const finish = (callback: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        stdoutReader.close();
        callback();
      };

      const rejectPending = (error: Error): void => {
        for (const pending of pendingRequests.values()) {
          pending.reject(error);
        }
        pendingRequests.clear();
      };

      const sendMessage = (message: Record<string, unknown>): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };

      const requestJsonRpc = <T = any>(method: string, params: Record<string, unknown>): Promise<T> => {
        const id = `probe-${nextRequestId++}`;
        return new Promise<T>((resolveRequest, rejectRequest) => {
          pendingRequests.set(id, {
            resolve: resolveRequest,
            reject: rejectRequest,
          });
          sendMessage({ id, method, params });
        });
      };

      const timeoutHandle = setTimeout(() => {
        finish(() => {
          rejectPending(new Error(`Codex launch probe timed out after ${timeoutMs}ms.`));
          child.kill('SIGTERM');
          reject(new Error(`Codex launch probe timed out after ${timeoutMs}ms.`));
        });
      }, timeoutMs);

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      stdoutReader.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        try {
          const payload = JSON.parse(trimmed) as Record<string, any>;
          if (payload.method && payload.id != null) {
            sendMessage({ id: payload.id, result: {} });
            return;
          }
          if (payload.method === 'thread/started') {
            const threadId = typeof payload.params?.thread?.id === 'string' ? payload.params.thread.id : null;
            if (threadId) {
              session.threadId = threadId;
            }
            return;
          }
          if (payload.id != null) {
            const pending = pendingRequests.get(String(payload.id));
            if (!pending) {
              return;
            }
            pendingRequests.delete(String(payload.id));
            if (payload.error) {
              pending.reject(new Error(payload.error.message || 'Codex launch probe request failed.'));
              return;
            }
            pending.resolve(payload.result);
          }
        } catch {
          // Ignore non-JSON stdout during probe; close handler below will surface stderr context.
        }
      });

      child.on('error', (error) => {
        finish(() => {
          rejectPending(new Error(formatRuntimeError(error)));
          reject(error);
        });
      });

      child.on('spawn', () => {
        void (async () => {
          try {
            await requestJsonRpc('initialize', {
              clientInfo: {
                name: 'openteam_runtime_probe',
                title: 'OpenTeam Runtime Probe',
                version: '1.0.0',
              },
              capabilities: {
                experimentalApi: true,
              },
            });
            sendMessage({
              method: 'initialized',
              params: {},
            });

            const threadResult = await requestJsonRpc<any>('thread/start', {
              cwd: workingDirectory,
              model,
              modelProvider: runtimeModelProvider,
              sandbox: 'danger-full-access',
              approvalPolicy: 'never',
              experimentalRawEvents: false,
              persistExtendedHistory: true,
            });

            const threadId = typeof threadResult?.thread?.id === 'string' ? threadResult.thread.id : null;
            if (!threadId) {
              throw new Error('Codex launch probe did not return a thread id.');
            }

            session.threadId = null;

            finish(() => {
              child.kill('SIGTERM');
              resolve();
            });
          } catch (error) {
            finish(() => {
              rejectPending(new Error(formatRuntimeError(error)));
              child.kill('SIGTERM');
              reject(error);
            });
          }
        })();
      });

      child.on('close', (code, signal) => {
        if (settled) {
          return;
        }
        finish(() => {
          rejectPending(new Error(`Codex launch probe exited (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`));
          const details = [
            `Codex launch probe exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
            stderrBuffer.trim() || null,
          ].filter(Boolean).join('\n\n');
          reject(new Error(details));
        });
      });
    }).then(() => {
      session.status = 'ready';
      session.lastEventAt = new Date().toISOString();
      session.lastUsedAt = session.lastEventAt;
      session.lastError = null;
    }).catch((error) => {
      const formatted = formatRuntimeError(error);
      session.status = 'error';
      session.lastEventAt = new Date().toISOString();
      session.lastUsedAt = session.lastEventAt;
      session.lastError = formatted;
      throw error;
    });
  }
}
