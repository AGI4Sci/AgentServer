import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { createInterface, type Interface } from 'readline';
import { randomUUID } from 'crypto';
import { ensureBackendStateDirs } from '../../../core/runtime/backend-paths.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
  resolveRuntimeModelName,
} from '../model-spec.js';
import { resolveHealthyRuntimeBackendConnection } from './runtime-backend-config.js';
import { toOpenAICompatibleRuntimeEnv } from '../model-runtime-resolver.js';
import type { SessionOutput, SessionUsage } from '../session-types.js';
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
import {
  containsEmbeddedProviderToolCallText,
  containsUnexecutedToolIntentText,
  runOpenAICompatibleStreamingChat,
  shouldUseDirectOpenAICompatibleRuntime,
} from './openai-compatible-stream.js';
import { requestDemandsRuntimeToolExecution } from '../shared/runtime-tool-requirements.js';
import { runSharedRuntimeToolFallback } from '../shared/runtime-tool-fallback.js';
import { outputWithMergedModelProviderUsage } from '../model-provider-usage.js';
import {
  buildRuntimeCompletedMessage,
  buildRuntimeRunningMessage,
  buildRuntimeStartingMessage,
  buildRuntimeTimeoutMessage,
} from './worker-runtime-labels.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

const CLAUDE_CODE_DIR = join(process.cwd(), 'server', 'backend', 'claude_code');
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
  requestId: string;
  sessionKey: string;
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

function settleRun(
  request: WorkerRunRequest,
  run: ActiveRun,
  output: SessionOutput,
): void {
  if (run.settled) {
    return;
  }
  run.settled = true;
  if (run.timeoutHandle) {
    clearTimeout(run.timeoutHandle);
  }
  let statusMessage = buildRuntimeCompletedMessage('Claude Code');
  if (!output.success) {
    statusMessage = (output as { success: false; error: string }).error;
    emitWorkerEvent(request, run, {
      type: 'error',
      error: statusMessage,
    });
  }
  emitWorkerEvent(request, run, {
    type: 'status',
    status: output.success ? 'completed' : 'failed',
    message: statusMessage,
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

function resolveClaudeCodeCommand(): { command: string; args: string[] } {
  if (process.env.OPENTEAM_CLAUDE_CODE_EXECUTABLE && existsSync(process.env.OPENTEAM_CLAUDE_CODE_EXECUTABLE)) {
    return {
      command: process.env.OPENTEAM_CLAUDE_CODE_EXECUTABLE,
      args: [],
    };
  }

  const managedLauncher = resolveManagedBackendExecutableForBackend('claude-code');
  if (managedLauncher) {
    return {
      command: managedLauncher,
      args: [],
    };
  }

  const entryPath = process.env.OPENTEAM_CLAUDE_CODE_ENTRY || join(CLAUDE_CODE_DIR, 'openteam-runtime.ts');
  if (!existsSync(entryPath)) {
    throw new Error(`Claude Code entry not found: ${entryPath}`);
  }

  if (process.env.OPENTEAM_CLAUDE_CODE_ENTRY) {
    return {
      command: process.execPath,
      args: [entryPath],
    };
  }

  const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });
  if (!bunCheck.error && bunCheck.status === 0) {
    return {
      command: 'bun',
      args: [
        entryPath,
      ],
    };
  }

  const nodeTsxCheck = spawnSync('node', ['--import', 'tsx', '--eval', ''], { stdio: 'ignore' });
  if (!nodeTsxCheck.error && nodeTsxCheck.status === 0) {
    return {
      command: 'node',
      args: [
        '--import',
        'tsx',
        entryPath,
      ],
    };
  }

  const tsxCheck = spawnSync('npx', ['tsx', '--version'], { stdio: 'ignore' });
  if (!tsxCheck.error && tsxCheck.status === 0) {
    return {
      command: 'npx',
      args: [
        'tsx',
        entryPath,
      ],
    };
  }

  throw new Error('Neither bun, npx tsx, nor node --import tsx is available to launch server/backend/claude_code');
}

function hasClaudeCodeNativeRuntimeAvailable(): boolean {
  try {
    resolveClaudeCodeCommand();
    return true;
  } catch {
    return false;
  }
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

function extractTextFromAssistantMessage(message: unknown): string {
  if (!message || typeof message !== 'object') {
    return '';
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') {
        return '';
      }
      if ((block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        return (block as { text: string }).text;
      }
      return '';
    })
    .join('');
}

function maybeEmitToolCall(
  request: WorkerRunRequest,
  run: ActiveRun,
  payload: unknown,
): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = payload as {
    event?: {
      type?: string;
      content_block?: { type?: string; name?: string };
    };
  };

  if (event.event?.type !== 'content_block_start') {
    return;
  }

  const block = event.event.content_block;
  if (!block || typeof block.name !== 'string') {
    return;
  }

  const type = block.type;
  if (type === 'tool_use' || type === 'server_tool_use' || type === 'mcp_tool_use') {
    emitWorkerEvent(request, run, {
      type: 'tool-call',
      toolName: block.name,
    });
  }
}

function maybeEmitTextDelta(
  request: WorkerRunRequest,
  run: ActiveRun,
  payload: unknown,
): void {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  const event = payload as {
    event?: {
      type?: string;
      delta?: { type?: string; text?: string };
    };
  };

  if (event.event?.type !== 'content_block_delta') {
    return;
  }
  if (event.event.delta?.type !== 'text_delta' || typeof event.event.delta.text !== 'string') {
    return;
  }

  run.textFragments.push(event.event.delta.text);
  emitWorkerEvent(request, run, {
    type: 'text-delta',
    text: event.event.delta.text,
  });
}

function buildPermissionAllowResponse(permissionId: string, toolUseId?: string): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      request_id: permissionId,
      subtype: 'success',
      response: {
        behavior: 'allow',
        message: 'AgentServer auto-approved this tool request for the current session.',
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
      },
    },
  });
}

function claudeUsageFromPayload(payload: Record<string, unknown>): SessionUsage | null {
  const compactMetadata = readRecord(payload.compact_metadata) || readRecord(payload.compactMetadata);
  const compactPreTokens = readNumber(compactMetadata, 'pre_tokens') || readNumber(compactMetadata, 'preTokens');
  if (payload.type === 'system' && payload.subtype === 'compact_boundary' && compactPreTokens) {
    return {
      input: compactPreTokens,
      output: 0,
      total: compactPreTokens,
      provider: 'claude-code',
      source: 'estimated',
    };
  }

  const usage = readRecord(payload.usage) || readRecord(readRecord(payload.message), 'usage');
  const totalTokens = readNumber(usage, 'total_tokens') || readNumber(usage, 'totalTokens');
  const inputTokens = readNumber(usage, 'input_tokens') || readNumber(usage, 'inputTokens') || 0;
  const outputTokens = readNumber(usage, 'output_tokens') || readNumber(usage, 'outputTokens') || 0;
  if (totalTokens || inputTokens || outputTokens) {
    return {
      input: inputTokens || totalTokens || 0,
      output: outputTokens,
      total: totalTokens || inputTokens + outputTokens,
      provider: 'claude-code',
      source: totalTokens && !inputTokens && !outputTokens ? 'estimated' : 'model-provider',
    };
  }
  return null;
}

function readRecord(value: unknown, key?: string): Record<string, unknown> | null {
  const next = key && value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : value;
  return next && typeof next === 'object' && !Array.isArray(next) ? next as Record<string, unknown> : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

export class ClaudeCodeTeamWorker {
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
      runtime: 'claude-code',
      teamId: options.teamId,
      agentId: options.agentId,
      requestId: `warm-${Date.now()}`,
      sessionKey: `warm:${options.teamId}:${options.agentId}:${Date.now()}`,
      input: {
        task: '',
        context: '',
      },
      options: {
        backend: 'claude-code',
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
    const forceNativeRuntime = request.options.forceNativeRuntime === true
      || process.env.OPENTEAM_CLAUDE_CODE_FORCE_NATIVE === '1';
    const forceDirectRuntime = !forceNativeRuntime && process.env.OPENTEAM_CLAUDE_CODE_FORCE_DIRECT_CHAT_COMPLETIONS === '1';
    const useDirectRuntime = forceDirectRuntime
      || (
        shouldUseDirectOpenAICompatibleRuntime(request)
        && !forceNativeRuntime
      );
    const session = await this.getOrCreateSession(request, !useDirectRuntime);
    if (session.activeRun) {
      throw new Error(`Claude Code agent ${request.agentId} already has an active run`);
    }

    return await new Promise<SessionOutput>((resolve) => {
      const activeRun: ActiveRun = {
        request,
        requestId: request.requestId,
        sessionKey: request.sessionKey,
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
        message: buildRuntimeStartingMessage('Claude Code'),
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
            error: buildRuntimeTimeoutMessage('Claude Code', timeoutMs),
          });
          session.child?.kill('SIGTERM');
        }, timeoutMs).unref();
      }

      if (useDirectRuntime) {
        void (async () => {
          try {
            const output = await this.runDirectChatWithFallback(request, activeRun);
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

      session.child!.stdin.write(
        JSON.stringify({
          type: 'user',
          session_id: '',
          message: {
            role: 'user',
            content: buildPrompt(request.input),
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        }) + '\n',
      );
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

    if (existing?.child && !existing.child.killed) {
      existing.child.kill('SIGTERM');
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

    const commandInfo = resolveClaudeCodeCommand();
    const args = [...commandInfo.args];
    const runtimeConnection = await resolveHealthyRuntimeBackendConnection(request.options);
    const launchModelName = runtimeConnection.modelName || nextModelName;
    if (launchModelName) {
      args.push('--model', launchModelName);
    }

    const child = spawn(commandInfo.command, args, {
      cwd: nextCwd,
      env: {
        ...process.env,
        ...toOpenAICompatibleRuntimeEnv({
          ...runtimeConnection,
          baseUrl: runtimeConnection.baseUrl || loadOpenTeamConfig().llm.baseUrl,
          apiKey: runtimeConnection.apiKey || loadOpenTeamConfig().llm.apiKey,
          modelName: launchModelName || loadOpenTeamConfig().llm.model,
        }),
        CLAUDE_CODE_SIMPLE: '1',
        ...(() => {
          const { stateDir } = ensureBackendStateDirs('claude_code', ['tmp', 'home', 'cache', 'config', 'data']);
          return {
            HOME: join(stateDir, 'home'),
            TMPDIR: join(stateDir, 'tmp'),
            XDG_CACHE_HOME: join(stateDir, 'cache'),
            XDG_CONFIG_HOME: join(stateDir, 'config'),
            XDG_DATA_HOME: join(stateDir, 'data'),
          };
        })(),
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
      throw new Error('Claude Code worker stdout reader was not initialized.');
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
      session.status = session.activeRun ? 'busy' : 'ready';
      session.startedAt = new Date().toISOString();
      session.lastEventAt = session.startedAt;
      session.lastError = null;
      const run = session.activeRun;
      if (!run) {
        return;
      }
      emitWorkerEvent(run.request, run, {
        type: 'status',
        status: 'running',
        message: buildRuntimeRunningMessage('Claude Code'),
      });
    });

    child.on('error', (error) => {
      session.status = 'error';
      session.lastError = formatRuntimeError(error);
      session.lastEventAt = new Date().toISOString();
      const run = session.activeRun;
      if (!run) {
        return;
      }
      settleRun(run.request, run, {
        success: false,
        error: formatRuntimeError(error),
      });
    });

    child.on('close', (code, signal) => {
      const run = session.activeRun;
      session.child = null;
      session.status = code === 0 ? 'offline' : 'error';
      session.lastEventAt = new Date().toISOString();
      if (code !== 0) {
        session.lastError = `Claude Code worker exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`;
      }
      session.stdoutReader?.close();
      session.stdoutReader = null;
      if (!run) {
        return;
      }

      const text = run.textFragments.join('').trim();
      if (!run.settled && code === 0 && text) {
        settleRun(run.request, run, {
          success: true,
          result: text,
        });
        return;
      }

      if (!run.settled) {
        settleRun(run.request, run, {
          success: false,
          error: `Claude Code worker exited abnormally (code=${code ?? 'null'}, signal=${signal ?? 'null'}).`,
        });
      }
    });

    return session;
  }

  private async runLocalToolFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    return await runSharedRuntimeToolFallback({
      backendLabel: 'Claude Code',
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

  private async runDirectChatWithFallback(request: WorkerRunRequest, run: ActiveRun): Promise<SessionOutput> {
    const requiresRealTools = requestDemandsRuntimeToolExecution(request);
    if (requiresRealTools) {
      return await this.runLocalToolFallback(request, run);
    }
    const output = await runOpenAICompatibleStreamingChat({
      backendLabel: 'Claude Code',
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
          run.textFragments.push(text);
          emitWorkerEvent(request, run, {
            type: 'text-delta',
            text,
          });
        },
      },
    });
    if (output.success && (containsEmbeddedProviderToolCallText(output.result) || containsUnexecutedToolIntentText(output.result))) {
      return outputWithMergedModelProviderUsage(await this.runLocalToolFallback(request, run), [output.usage]);
    }
    return output;
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

  private handleStdoutLine(
    session: AgentRuntimeSession,
    request: WorkerRunRequest,
    line: string,
  ): void {
    const run = session.activeRun;
    if (!run) {
      return;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      emitWorkerEvent(request, run, {
        type: 'text-delta',
        text: `${trimmed}\n`,
      });
      return;
    }

    session.lastEventAt = new Date().toISOString();
    session.lastUsedAt = session.lastEventAt;
    maybeEmitTextDelta(request, run, payload);
    maybeEmitToolCall(request, run, payload);
    const usage = claudeUsageFromPayload(payload);
    if (usage) {
      emitWorkerEvent(request, run, {
        type: 'usage-update',
        usage,
        raw: payload,
      });
    }

    if (payload.type === 'system' && payload.subtype === 'compact_boundary') {
      const compactMetadata = readRecord(payload.compact_metadata) || readRecord(payload.compactMetadata);
      emitWorkerEvent(request, run, {
        type: 'status',
        status: 'completed',
        message: 'Claude Code native context compaction completed.',
        raw: payload,
      });
      emitWorkerEvent(request, run, {
        type: 'tool-result',
        toolName: 'claude_code.compact',
        detail: typeof compactMetadata?.trigger === 'string' ? `trigger=${compactMetadata.trigger}` : undefined,
        output: JSON.stringify(compactMetadata || payload),
        raw: payload,
      });
      return;
    }

    if (payload.type === 'status' && typeof payload.status === 'string') {
      const normalizedMessage = payload.status === 'running'
        ? buildRuntimeRunningMessage('Claude Code')
        : typeof payload.message === 'string' ? payload.message : undefined;
      emitWorkerEvent(request, run, {
        type: 'status',
        status:
          payload.status === 'completed'
            ? 'completed'
            : payload.status === 'failed'
              ? 'failed'
            : payload.status === 'waiting_permission'
                ? 'waiting_permission'
                : 'running',
        message: normalizedMessage,
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

    if (payload.type === 'tool-call' && typeof payload.toolName === 'string') {
      emitWorkerEvent(request, run, {
        type: 'tool-call',
        toolName: payload.toolName,
        detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      });
      return;
    }

    if (payload.type === 'tool-result' && typeof payload.toolName === 'string') {
      emitWorkerEvent(request, run, {
        type: 'tool-result',
        toolName: payload.toolName,
        detail: typeof payload.detail === 'string' ? payload.detail : undefined,
        output: typeof payload.output === 'string' ? payload.output : undefined,
      });
      return;
    }

    if (payload.type === 'system' && payload.subtype === 'status' && typeof payload.status === 'string') {
      if (payload.status === 'compacting') {
        emitWorkerEvent(request, run, {
          type: 'status',
          status: 'running',
          message: 'Claude Code native context compaction is running.',
          raw: payload,
        });
        return;
      }
      emitWorkerEvent(request, run, {
        type: 'status',
        status: payload.status === 'waiting' ? 'waiting_permission' : 'running',
        message: typeof payload.permissionMode === 'string' ? `permissionMode=${payload.permissionMode}` : undefined,
      });
      return;
    }

    if (payload.type === 'control_request') {
      const inner = payload.request as Record<string, unknown> | undefined;
      const permissionId = typeof payload.request_id === 'string' ? payload.request_id : randomUUID();
      if (inner?.subtype === 'can_use_tool' && typeof inner.tool_name === 'string') {
        emitWorkerEvent(request, run, {
          type: 'status',
          status: 'waiting_permission',
          message: `Claude Code is waiting for permission: ${inner.tool_name}`,
        });
        emitWorkerEvent(request, run, {
          type: 'permission-request',
          permissionId,
          toolName: inner.tool_name,
          detail: typeof inner.decision_reason === 'string' ? inner.decision_reason : undefined,
          raw: payload,
        });
        session.child?.stdin.write(buildPermissionAllowResponse(permissionId, typeof inner.tool_use_id === 'string' ? inner.tool_use_id : undefined) + '\n');
      }
      return;
    }

    if (payload.type === 'assistant') {
      const text = extractTextFromAssistantMessage(payload.message);
      if (text && run.textFragments.length === 0) {
        run.textFragments.push(text);
        emitWorkerEvent(request, run, {
          type: 'text-delta',
          text,
        });
      }
      return;
    }

    if (payload.type === 'result') {
      if (
        payload.output &&
        typeof payload.output === 'object' &&
        typeof (payload.output as { success?: unknown }).success === 'boolean'
      ) {
        const output = payload.output as SessionOutput;
        settleRun(request, run, output);
        return;
      }

      if (payload.subtype === 'success' && typeof payload.result === 'string') {
        settleRun(request, run, {
          success: true,
          result: payload.result,
          usage: usage || undefined,
        });
        return;
      }

      const errors = Array.isArray(payload.errors)
        ? payload.errors.filter((value): value is string => typeof value === 'string')
        : [];
      settleRun(request, run, {
        success: false,
        error: errors.join('\n') || `Claude Code result failed with subtype=${String(payload.subtype ?? 'unknown')}`,
      });
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

  private closeSession(
    session: AgentRuntimeSession,
    reason: string,
    removeFromMap: boolean,
  ): void {
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
    if (session.stdoutReader) {
      session.stdoutReader.close();
      session.stdoutReader = null;
    }
    if (session.child && !session.child.killed) {
      session.child.kill('SIGTERM');
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
      runtime: 'claude-code',
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
