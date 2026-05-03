import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { BackendTier } from '../../../core/runtime/backend-catalog.js';
import type {
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
  BackendReadableState,
  BackendContextCompactionResult,
  BackendContextWindowState,
  AbortBackendRunInput,
  CompactBackendContextInput,
  DisposeBackendSessionInput,
  ReadBackendContextWindowInput,
  ReadBackendStateInput,
  RunBackendTurnInput,
  StartBackendSessionInput,
} from '../agent-backend-adapter-contract.js';
import type {
  BackendSessionRef,
  BackendStageResult,
} from '../../agent_server/types.js';
import type { RuntimeModelInput } from '../model-spec.js';
import type { SessionStreamEvent, SessionUsage } from '../session-types.js';
import { resolveCodexRuntimeModelSelection } from '../codex-model-runtime.js';
import { normalizeModelProviderUsage } from '../model-provider-usage.js';
import { resolveModelRuntimeConnection } from '../model-runtime-resolver.js';
import { registerRuntimeSupervisorCodexUpstream } from '../supervisor-client.js';

type JsonRpcId = number | string;

type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number; data?: unknown };
};

type CodexSessionState = BackendReadableState & {
  client: CodexJsonRpcClient;
  workspace: string;
  threadId: string;
  runtimeModel?: RuntimeModelInput;
  executionPolicy?: StartBackendSessionInput['executionPolicy'];
  activeTurnId?: string;
  lastUsage?: SessionUsage;
  lastContextWindowState?: BackendContextWindowState;
  lastCompactedAt?: string;
  disposed?: boolean;
};

export interface CodexAppServerAdapterOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  clientName?: string;
  clientTitle?: string;
  clientVersion?: string;
  model?: string;
  effort?: string;
  rpcTimeoutMs?: number;
  idleTimeoutMs?: number;
  turnTimeoutMs?: number;
}

const CODEX_APP_SERVER_CAPABILITIES: AgentBackendCapabilities = {
  nativeLoop: true,
  nativeTools: true,
  nativeSandbox: true,
  nativeApproval: true,
  nativeSession: true,
  fileEditing: true,
  streamingEvents: true,
  structuredEvents: true,
  readableState: true,
  abortableRun: true,
  resumableSession: true,
  statusTransparency: 'full',
  contextWindowTelemetry: 'native',
  nativeCompaction: true,
  compactionDuringTurn: false,
  rateLimitTelemetry: true,
  sessionRotationSafe: true,
};

const DEFAULT_CODEX_APP_SERVER_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS = 30 * 60_000;
const CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS = 2_000;
const CODEX_APP_SERVER_QUEUE_POLL_MS = 1_000;

export class CodexAppServerAgentBackendAdapter implements AgentBackendAdapter {
  readonly backendId = 'codex' as const;
  readonly kind = 'agent_backend' as const;
  readonly tier: BackendTier = 'strategic';

  private readonly sessions = new Map<string, CodexSessionState>();

  constructor(private readonly options: CodexAppServerAdapterOptions = {}) {}

  capabilities(): AgentBackendCapabilities {
    return { ...CODEX_APP_SERVER_CAPABILITIES };
  }

  async startSession(input: StartBackendSessionInput): Promise<BackendSessionRef> {
    const stableSessionRefId = `codex-app-server:${input.agentServerSessionId}`;
    const existing = this.sessions.get(stableSessionRefId);
    if (existing && !existing.disposed) {
      return existing.sessionRef;
    }
    const selection = codexRuntimeSelection(this.options, input.runtimeModel);
    if (selection.route === 'custom-provider') {
      await registerRuntimeSupervisorCodexUpstream({
        model: selection.model,
        modelName: selection.model,
        baseUrl: selection.connection.baseUrl,
        apiKey: selection.connection.apiKey,
      });
    }
    const client = CodexJsonRpcClient.spawn(this.options, input.runtimeModel);
    const rpcTimeoutMs = resolveCodexAppServerRpcTimeoutMs(this.options);
    await client.request('initialize', {
      clientInfo: {
        name: this.options.clientName || 'agent_server',
        title: this.options.clientTitle || 'AgentServer',
        version: this.options.clientVersion || '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }, { timeoutMs: rpcTimeoutMs });
    client.notify('initialized');

    const startResponse = await client.request('thread/start', {
      cwd: input.workspace,
      ephemeral: input.scope === 'stage',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      approvalPolicy: input.executionPolicy?.approvalPolicy || 'never',
      sandbox: input.executionPolicy?.sandbox || 'danger-full-access',
    }, { timeoutMs: rpcTimeoutMs });
    const threadId = readNestedString(startResponse, ['thread', 'id']);
    if (!threadId) {
      await client.close();
      throw new Error('Codex app-server thread/start did not return thread.id.');
    }

    const sessionRef: BackendSessionRef = {
      id: stableSessionRefId,
      backend: this.backendId,
      scope: input.scope,
      resumable: true,
      metadata: {
        ...input.metadata,
        threadId,
        transport: 'stdio-json-rpc',
      },
    };
    this.sessions.set(sessionRef.id, {
      sessionRef,
      client,
      workspace: input.workspace,
      threadId,
      runtimeModel: input.runtimeModel,
      executionPolicy: input.executionPolicy,
      status: 'idle',
      lastEventAt: nowIso(),
      resumable: true,
      metadata: sessionRef.metadata,
    });
    return sessionRef;
  }

  async *runTurn(input: RunBackendTurnInput): AsyncIterable<AgentBackendEvent> {
    const state = this.requireState(input.sessionRef);
    const queue = new AsyncNotificationQueue();
    const unsubscribe = state.client.onNotification((message) => queue.push(message));
    const unsubscribeRequest = state.client.onServerRequest((message) => {
      queue.push(message);
      const pendingApproval = codexPendingApproval(message);
      if (pendingApproval) {
        state.status = 'waiting_user';
        state.pendingApproval = pendingApproval;
      }
      return defaultCodexServerRequestResponse(message);
    });
    const startedAt = Date.now();
    const idleTimeoutMs = resolveCodexAppServerIdleTimeoutMs(this.options);
    const turnTimeoutMs = resolveCodexAppServerTurnTimeoutMs(this.options);
    const rpcTimeoutMs = resolveCodexAppServerRpcTimeoutMs(this.options);
    const textParts: string[] = [];
    const toolCalls: BackendStageResult['toolCalls'] = [];
    let finalUsage: SessionUsage | undefined;
    let failureReason: string | undefined;
    let failureStatus: BackendStageResult['status'] = 'failed';
    let lastNativeEventAt = Date.now();
    let interruptRequested = false;

    state.status = 'running';
    state.activeRunId = input.handoff.runId;
    state.activeStageId = input.handoff.stageId;
    state.lastEventAt = nowIso();

    const interruptActiveTurn = async (reason: string): Promise<void> => {
      if (interruptRequested || !state.activeTurnId) {
        return;
      }
      interruptRequested = true;
      await state.client.request('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        reason,
      }, { timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS }).catch(() => undefined);
    };
    const abortListener = (): void => {
      const reason = `Codex app-server turn aborted by AgentServer: ${abortSignalReason(input.abortSignal)}`;
      failureReason = failureReason || reason;
      failureStatus = 'cancelled';
      queue.close();
      void interruptActiveTurn(reason);
    };
    if (input.abortSignal?.aborted) {
      abortListener();
    } else {
      input.abortSignal?.addEventListener('abort', abortListener, { once: true });
    }

    try {
      yield {
        type: 'status',
        stageId: input.handoff.stageId,
        status: 'running',
        message: 'Codex turn/start requested.',
      };
      if (failureReason) {
        yield { type: 'error', stageId: input.handoff.stageId, error: failureReason };
      } else {
        const turnResponse = await state.client.request('turn/start', {
          threadId: state.threadId,
          cwd: state.workspace,
          approvalPolicy: input.executionPolicy?.approvalPolicy || state.executionPolicy?.approvalPolicy || 'never',
          sandboxPolicy: codexSandboxPolicy(input.executionPolicy?.sandbox || state.executionPolicy?.sandbox || 'danger-full-access'),
          ...codexTurnOverrides(this.options, input.runtimeModel || state.runtimeModel),
          input: [
            {
              type: 'text',
              text: renderCodexTurnInput(input),
            },
          ],
        }, { timeoutMs: rpcTimeoutMs });
        const turnId = readNestedString(turnResponse, ['turn', 'id']);
        state.activeTurnId = turnId || undefined;

      while (!failureReason) {
        const now = Date.now();
        const elapsedMs = now - startedAt;
        const quietMs = now - lastNativeEventAt;
        if (turnTimeoutMs > 0 && elapsedMs >= turnTimeoutMs) {
          failureStatus = 'timeout';
          failureReason = `Codex app-server turn timed out after ${turnTimeoutMs}ms without completing.`;
          yield { type: 'status', stageId: input.handoff.stageId, status: 'failed', message: failureReason };
          yield { type: 'error', stageId: input.handoff.stageId, error: failureReason };
          await interruptActiveTurn(failureReason);
          break;
        }
        if (idleTimeoutMs > 0 && quietMs >= idleTimeoutMs) {
          failureStatus = 'timeout';
          failureReason = `Codex app-server produced no native event for ${quietMs}ms; aborting stalled turn so the caller can retry or repair instead of waiting indefinitely.`;
          yield { type: 'status', stageId: input.handoff.stageId, status: 'failed', message: failureReason };
          yield { type: 'error', stageId: input.handoff.stageId, error: failureReason };
          await interruptActiveTurn(failureReason);
          break;
        }

        const nextDeadlineMs = [
          idleTimeoutMs > 0 ? idleTimeoutMs - quietMs : CODEX_APP_SERVER_QUEUE_POLL_MS,
          turnTimeoutMs > 0 ? turnTimeoutMs - elapsedMs : CODEX_APP_SERVER_QUEUE_POLL_MS,
          CODEX_APP_SERVER_QUEUE_POLL_MS,
        ]
          .filter((value) => Number.isFinite(value) && value > 0)
          .reduce((min, value) => Math.min(min, value), CODEX_APP_SERVER_QUEUE_POLL_MS);
        const next = await queue.nextOrTimeout(Math.max(1, Math.floor(nextDeadlineMs)));
        if (!next) {
          continue;
        }
        if (next.done) {
          break;
        }
        const notification = next.value;
        state.lastEventAt = nowIso();
        updateCodexContextStateFromNotification(state, notification, this.options, input.runtimeModel || state.runtimeModel);
        const normalized = normalizeCodexNotification(notification, input.handoff.stageId, toolCalls);
        if (normalized.length > 0 || notification.method === 'turn/completed' || notification.method === 'serverRequest/resolved') {
          lastNativeEventAt = Date.now();
        }
        if (notification.method === 'serverRequest/resolved') {
          state.pendingApproval = undefined;
          state.status = 'running';
        }
        for (const event of normalized) {
          if (event.type === 'text-delta') {
            textParts.push(event.text);
          }
          if (event.type === 'usage-update') {
            finalUsage = event.usage;
            state.lastUsage = event.usage;
            const existingContextWindowState = state.lastContextWindowState;
            const contextUsage = sessionUsageFromContextWindowState(existingContextWindowState?.lastUsage) || event.usage;
            state.lastContextWindowState = buildContextWindowState({
              sessionRef: state.sessionRef,
              backend: this.backendId,
              source: 'native',
              usage: contextUsage,
              maxTokens: existingContextWindowState?.maxTokens || resolveCodexContextWindowFromEnv(),
              autoCompactTokenLimit: existingContextWindowState?.autoCompactTokenLimit || resolveCodexAutoCompactLimitFromEnv(),
              lastCompactedAt: state.lastCompactedAt,
              metadata: {
                ...(existingContextWindowState?.metadata || {}),
                threadId: state.threadId,
                cumulativeUsage: event.usage,
              },
            });
          }
          if (event.type === 'error') {
            failureReason = event.error;
            failureStatus = 'failed';
          }
          yield event;
        }
        if (failureReason) {
          break;
        }

        if (
          notification.method === 'turn/completed'
          && (!turnId || readNestedString(notification.params, ['turn', 'id']) === turnId)
        ) {
          break;
        }
        }
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
      failureStatus = isAbortishError(failureReason) ? 'cancelled' : 'failed';
      yield {
        type: 'error',
        stageId: input.handoff.stageId,
        error: failureReason,
      };
    } finally {
      unsubscribe();
      unsubscribeRequest();
      input.abortSignal?.removeEventListener('abort', abortListener);
      queue.close();
      state.activeRunId = undefined;
      state.activeStageId = undefined;
      state.activeTurnId = undefined;
      state.pendingApproval = undefined;
    }

    state.status = failureReason ? 'failed' : 'idle';
    state.lastEventAt = nowIso();
    const stderrSummary = failureReason ? state.client.recentStderr() : '';
    const finalText = failureReason
      ? appendDiagnostic(failureReason, stderrSummary)
      : textParts.join('').trim();
    const result: BackendStageResult = {
      status: failureReason ? failureStatus : 'completed',
      finalText,
      filesChanged: input.handoff.workspaceFacts.dirtyFiles,
      diffSummary: input.handoff.workspaceFacts.lastKnownDiffSummary,
      toolCalls,
      testsRun: [],
      findings: [],
      handoffSummary: failureReason
        ? `Codex app-server failed: ${finalText.slice(0, 500)}`
        : finalText.slice(0, 500),
      nextActions: [],
      risks: failureReason ? [appendDiagnostic(failureReason, stderrSummary)] : [],
      artifacts: [],
      usage: finalUsage,
      nativeSessionRef: input.sessionRef,
    };

    yield {
      type: 'stage-result',
      stageId: input.handoff.stageId,
      result,
    };
  }

  async abort(input: AbortBackendRunInput): Promise<void> {
    const state = this.sessions.get(input.sessionRef.id);
    if (!state) {
      return;
    }
    if (state.activeTurnId) {
      await state.client.request('turn/interrupt', {
        threadId: state.threadId,
        turnId: state.activeTurnId,
        reason: input.reason || 'aborted by AgentServer',
      }, { timeoutMs: CODEX_APP_SERVER_INTERRUPT_TIMEOUT_MS }).catch(() => undefined);
    }
    state.status = 'idle';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
    state.activeTurnId = undefined;
    state.lastEventAt = nowIso();
    state.metadata = {
      ...(state.metadata || {}),
      abortReason: input.reason || 'aborted by AgentServer',
    };
  }

  async readState(input: ReadBackendStateInput): Promise<BackendReadableState> {
    const state = this.requireState(input.sessionRef);
    return {
      sessionRef: state.sessionRef,
      status: state.status,
      activeRunId: state.activeRunId,
      activeStageId: state.activeStageId,
      activeToolCall: state.activeToolCall,
      pendingApproval: state.pendingApproval,
      workspaceState: state.workspaceState,
      lastStage: state.lastStage,
      lastEventAt: state.lastEventAt,
      resumable: state.resumable,
      metadata: state.metadata,
    };
  }

  async readContextWindowState(input: ReadBackendContextWindowInput): Promise<BackendContextWindowState> {
    const state = this.requireState(input.sessionRef);
    if (state.lastContextWindowState) {
      return {
        ...state.lastContextWindowState,
        sessionRef: state.sessionRef,
        backend: this.backendId,
      };
    }
    return buildContextWindowState({
      sessionRef: state.sessionRef,
      backend: this.backendId,
      source: 'native',
      usage: state.lastUsage,
      maxTokens: resolveCodexContextWindowFromEnv(),
      autoCompactTokenLimit: resolveCodexAutoCompactLimitFromEnv(),
      lastCompactedAt: state.lastCompactedAt,
      message: 'Codex native token usage has not been reported for this thread yet.',
      metadata: {
        threadId: state.threadId,
        reason: input.reason,
      },
    });
  }

  async compactContext(input: CompactBackendContextInput): Promise<BackendContextCompactionResult> {
    const state = this.requireState(input.sessionRef);
    const startedAt = nowIso();
    const before = await this.readContextWindowState(input);
    if (state.activeTurnId || state.activeRunId) {
      return {
        sessionRef: state.sessionRef,
        backend: this.backendId,
        status: 'skipped',
        capabilityUsed: 'native',
        reason: 'Codex thread already has an active turn; native compaction must run while the thread is idle.',
        before,
        after: before,
        startedAt,
        completedAt: nowIso(),
        userVisibleSummary: 'Codex 上下文压缩已跳过：当前 thread 正在运行。',
        auditRefs: [state.threadId],
      };
    }

    const queue = new AsyncNotificationQueue();
    const unsubscribe = state.client.onNotification((message) => queue.push(message));
    const rpcTimeoutMs = resolveCodexAppServerRpcTimeoutMs(this.options);
    const turnTimeoutMs = resolveCodexAppServerTurnTimeoutMs(this.options);
    let sawCompactionItem = false;
    let sawCompleted = false;
    let failureReason: string | undefined;
    const previousStatus = state.status;
    state.status = 'running';
    state.lastContextWindowState = {
      ...before,
      status: 'compacting',
      lastUpdatedAt: nowIso(),
      message: input.reason || 'Codex native context compaction is running.',
    };

    try {
      await state.client.request('thread/compact/start', {
        threadId: state.threadId,
      }, { timeoutMs: rpcTimeoutMs });

      const deadline = Date.now() + Math.max(1, turnTimeoutMs);
      while (Date.now() < deadline) {
        const next = await queue.nextOrTimeout(Math.min(1_000, Math.max(1, deadline - Date.now())));
        if (!next) {
          continue;
        }
        if (next.done) {
          break;
        }
        const notification = next.value;
        state.lastEventAt = nowIso();
        updateCodexContextStateFromNotification(state, notification, this.options, state.runtimeModel);
        if (notification.method === 'error' && readBoolean(notification.params, 'willRetry') !== true) {
          failureReason = codexErrorDetail(notification.params) || JSON.stringify(notification.params);
          break;
        }
        const itemType = readString(readObject(notification.params, 'item'), 'type');
        if (itemType === 'contextCompaction') {
          sawCompactionItem = true;
          if (notification.method === 'item/completed') {
            sawCompleted = true;
          }
        }
        if (notification.method === 'turn/completed') {
          const turnStatus = readNestedString(notification.params, ['turn', 'status']);
          if (turnStatus && turnStatus !== 'completed') {
            failureReason = codexErrorDetail(notification.params) || `Codex compact turn completed with status=${turnStatus}.`;
          }
          break;
        }
        if (sawCompleted) {
          break;
        }
      }
      if (!failureReason && !sawCompleted && !sawCompactionItem) {
        failureReason = 'Codex thread/compact/start completed without contextCompaction progress notifications before timeout.';
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe();
      queue.close();
      state.status = previousStatus === 'disposed' ? 'disposed' : 'idle';
      state.lastEventAt = nowIso();
    }

    if (!failureReason) {
      state.lastCompactedAt = nowIso();
      state.lastContextWindowState = {
        ...(state.lastContextWindowState || before),
        status: 'ok',
        lastCompactedAt: state.lastCompactedAt,
        lastUpdatedAt: state.lastCompactedAt,
        message: 'Codex native context compaction completed.',
        metadata: {
          ...(state.lastContextWindowState?.metadata || {}),
          threadId: state.threadId,
          compactReason: input.reason,
        },
      };
    } else {
      state.status = 'failed';
    }
    const after = await this.readContextWindowState(input);
    return {
      sessionRef: state.sessionRef,
      backend: this.backendId,
      status: failureReason ? 'failed' : 'compacted',
      capabilityUsed: 'native',
      reason: failureReason,
      before,
      after,
      startedAt,
      completedAt: nowIso(),
      userVisibleSummary: failureReason
        ? `Codex 原生上下文压缩失败：${failureReason}`
        : 'Codex 原生上下文压缩已完成。',
      auditRefs: [state.threadId],
      metadata: {
        method: 'thread/compact/start',
        sawCompactionItem,
        sawCompleted,
      },
    };
  }

  async dispose(input: DisposeBackendSessionInput): Promise<void> {
    const state = this.sessions.get(input.sessionRef.id);
    if (!state) {
      return;
    }
    state.status = 'disposed';
    state.disposed = true;
    state.lastEventAt = nowIso();
    await state.client.close();
  }

  private requireState(sessionRef: BackendSessionRef): CodexSessionState {
    const state = this.sessions.get(sessionRef.id);
    if (!state || state.disposed) {
      throw new Error(`Codex app-server session is not active: ${sessionRef.id}`);
    }
    return state;
  }
}

class CodexJsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly notificationHandlers = new Set<(message: JsonRpcMessage) => void>();
  private readonly serverRequestHandlers = new Set<(message: JsonRpcMessage) => unknown | Promise<unknown>>();
  private readonly readline: ReadlineInterface;
  private stderrBuffer = '';

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer = `${this.stderrBuffer}${String(chunk)}`.slice(-4_000);
    });
    child.on('exit', (code, signal) => {
      const error = new Error(appendDiagnostic(
        `Codex app-server exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        this.recentStderr(),
      ));
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static spawn(options: CodexAppServerAdapterOptions, runtimeModel?: RuntimeModelInput): CodexJsonRpcClient {
    const command = options.command || process.env.AGENT_SERVER_CODEX_APP_SERVER_COMMAND || 'codex';
    const args = [...(options.args || ['app-server', '--listen', 'stdio://'])];
    args.push(...codexSpawnConfigArgs(options, runtimeModel));
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodexJsonRpcClient(child);
  }

  request(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method, params };
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const finish = (fn: () => void): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        fn();
      };
      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      const timeoutMs = options?.timeoutMs;
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex JSON-RPC request ${method} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
        timeout.unref?.();
      }
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  onServerRequest(handler: (message: JsonRpcMessage) => unknown | Promise<unknown>): () => void {
    this.serverRequestHandlers.add(handler);
    return () => this.serverRequestHandlers.delete(handler);
  }

  recentStderr(): string {
    return this.stderrBuffer
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
      .trim();
  }

  async close(): Promise<void> {
    this.readline.close();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (hasJsonRpcId(message) && message.method) {
      this.handleServerRequest(message);
      return;
    }
    if (hasJsonRpcId(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || `Codex JSON-RPC error ${message.error.code ?? ''}`.trim()));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    const handler = [...this.serverRequestHandlers][0];
    if (!handler) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported Codex server request: ${message.method || 'unknown'}`,
        },
      });
      return;
    }
    Promise.resolve()
      .then(() => handler(message))
      .then((result) => {
        this.write({ id: message.id, result });
      })
      .catch((error) => {
        this.write({
          id: message.id,
          error: {
            code: -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
  }

  private write(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

class AsyncNotificationQueue implements AsyncIterable<JsonRpcMessage> {
  private readonly items: JsonRpcMessage[] = [];
  private readonly waiters: Array<(value: IteratorResult<JsonRpcMessage>) => void> = [];
  private closed = false;

  push(message: JsonRpcMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: message, done: false });
      return;
    }
    this.items.push(message);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async nextOrTimeout(timeoutMs: number): Promise<IteratorResult<JsonRpcMessage> | null> {
    const item = this.items.shift();
    if (item) {
      return { value: item, done: false };
    }
    if (this.closed) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<JsonRpcMessage> | null>((resolve) => {
      let timeout: NodeJS.Timeout | undefined;
      const waiter = (value: IteratorResult<JsonRpcMessage>): void => {
        if (timeout) {
          clearTimeout(timeout);
        }
        resolve(value);
      };
      timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve(null);
      }, Math.max(1, timeoutMs));
      timeout.unref?.();
      this.waiters.push(waiter);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<JsonRpcMessage> {
    return {
      next: async () => {
        const item = this.items.shift();
        if (item) {
          return { value: item, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<JsonRpcMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function renderCodexTurnInput(input: RunBackendTurnInput): string {
  return [
    input.handoff.stageInstructions,
    renderNativeExecutionRequirements(input),
    '',
    'AgentServer handoff packet:',
    JSON.stringify(input.handoff, null, 2),
  ].join('\n');
}

function renderNativeExecutionRequirements(input: RunBackendTurnInput): string {
  const expectedArtifacts = readMetadataArray(input.handoff.metadata, ['input', 'expectedArtifacts']);
  const nativeTools = readMetadataArray(input.handoff.metadata, ['input', 'nativeTools']);
  const nativeToolFirst = readMetadataBoolean(input.handoff.metadata, ['runtime', 'nativeToolFirst'])
    || readMetadataBoolean(input.handoff.metadata, ['input', 'nativeToolFirst'])
    || nativeTools.length > 0
    || expectedArtifacts.length > 0;
  return [
    '',
    'AgentServer execution policy:',
    `- approval_policy=${input.executionPolicy?.approvalPolicy || 'never'}`,
    `- sandbox=${input.executionPolicy?.sandbox || 'danger-full-access'}`,
    '- native_tool_first=true: use the backend native tools/shell/network/file APIs when the task depends on current external data, downloads, verification, or workspace artifacts.',
    '- Do not answer from memory when a concrete artifact or external lookup is requested; verify with native tools and write the resulting files into the workspace when applicable.',
    ...(nativeToolFirst ? ['- The caller requested native-tool-first behavior; keep AgentServer tools as fallback only.'] : []),
    ...(nativeTools.length ? [`- Requested native tools: ${nativeTools.join(', ')}`] : []),
    ...(expectedArtifacts.length ? [`- Expected artifacts: ${expectedArtifacts.join(', ')}. Include produced file paths or clear failure reasons in the final response.`] : []),
  ].join('\n');
}

function codexSpawnConfigArgs(options: CodexAppServerAdapterOptions, runtimeModel?: RuntimeModelInput): string[] {
  return codexRuntimeSelection(options, runtimeModel).configArgs;
}

function codexRuntimeSelection(options: CodexAppServerAdapterOptions, runtimeModel?: RuntimeModelInput) {
  const modelRuntime = resolveModelRuntimeConnection({
    ...(runtimeModel || {}),
    model: runtimeModel?.model || options.model || process.env.AGENT_SERVER_CODEX_MODEL?.trim(),
  });
  const selection = resolveCodexRuntimeModelSelection({
    connection: modelRuntime,
    input: {
      model: runtimeModel?.model || options.model || null,
      modelName: runtimeModel?.modelName || null,
    },
    explicitCodexModel: options.model || process.env.AGENT_SERVER_CODEX_MODEL,
  });
  return {
    ...selection,
    connection: modelRuntime,
  };
}

function codexTurnOverrides(options: CodexAppServerAdapterOptions, runtimeModel?: RuntimeModelInput): Record<string, string> {
  const selection = codexRuntimeSelection(options, runtimeModel);
  const effort = options.effort || process.env.AGENT_SERVER_CODEX_EFFORT?.trim();
  return {
    ...(selection.model ? { model: selection.model } : {}),
    ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
    ...(effort ? { effort } : {}),
  };
}

function updateCodexContextStateFromNotification(
  state: CodexSessionState,
  notification: JsonRpcMessage,
  _options: CodexAppServerAdapterOptions,
  _runtimeModel?: RuntimeModelInput,
): void {
  if (notification.method === 'thread/tokenUsage/updated') {
    const tokenUsage = readObject(notification.params, 'tokenUsage');
    const total = readObject(tokenUsage, 'total');
    const last = readObject(tokenUsage, 'last');
    const usage = normalizeModelProviderUsage(total || last, {
      provider: readNestedString(notification.params, ['model', 'provider']),
      model: readNestedString(notification.params, ['model', 'name']),
    });
    const currentWindowUsage = normalizeModelProviderUsage(last || total, {
      provider: readNestedString(notification.params, ['model', 'provider']),
      model: readNestedString(notification.params, ['model', 'name']),
    });
    const contextWindow = readNumber(tokenUsage, 'modelContextWindow')
      || readNumber(tokenUsage, 'model_context_window')
      || state.lastContextWindowState?.maxTokens
      || resolveCodexContextWindowFromEnv();
    if (usage) {
      state.lastUsage = usage;
      state.lastContextWindowState = buildContextWindowState({
        sessionRef: state.sessionRef,
        backend: 'codex',
        source: 'native',
        usage: currentWindowUsage || usage,
        maxTokens: contextWindow,
        autoCompactTokenLimit: state.lastContextWindowState?.autoCompactTokenLimit || resolveCodexAutoCompactLimitFromEnv(),
        lastCompactedAt: state.lastCompactedAt,
        metadata: {
          threadId: state.threadId,
          turnId: readString(notification.params, 'turnId'),
          cumulativeUsage: usage,
          contextUsageScope: currentWindowUsage ? 'last' : 'total',
        },
      });
    }
    return;
  }
  const item = readObject(notification.params, 'item');
  if (readString(item, 'type') === 'contextCompaction') {
    if (notification.method === 'item/started') {
      state.lastContextWindowState = {
        ...(state.lastContextWindowState || buildContextWindowState({
          sessionRef: state.sessionRef,
          backend: 'codex',
          source: 'native',
          usage: state.lastUsage,
          maxTokens: resolveCodexContextWindowFromEnv(),
          autoCompactTokenLimit: resolveCodexAutoCompactLimitFromEnv(),
          lastCompactedAt: state.lastCompactedAt,
          metadata: { threadId: state.threadId },
        })),
        status: 'compacting',
        lastUpdatedAt: nowIso(),
        message: 'Codex native context compaction started.',
      };
    }
    if (notification.method === 'item/completed') {
      state.lastCompactedAt = nowIso();
      state.lastContextWindowState = {
        ...(state.lastContextWindowState || buildContextWindowState({
          sessionRef: state.sessionRef,
          backend: 'codex',
          source: 'native',
          usage: state.lastUsage,
          maxTokens: resolveCodexContextWindowFromEnv(),
          autoCompactTokenLimit: resolveCodexAutoCompactLimitFromEnv(),
          lastCompactedAt: state.lastCompactedAt,
          metadata: { threadId: state.threadId },
        })),
        status: 'ok',
        lastCompactedAt: state.lastCompactedAt,
        lastUpdatedAt: state.lastCompactedAt,
        message: 'Codex native context compaction completed.',
      };
    }
  }
}

function buildContextWindowState(input: {
  sessionRef: BackendSessionRef;
  backend: BackendContextWindowState['backend'];
  source: BackendContextWindowState['source'];
  usage?: SessionUsage;
  maxTokens?: number | null;
  autoCompactTokenLimit?: number | null;
  lastCompactedAt?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}): BackendContextWindowState {
  const usedTokens = usageTotal(input.usage);
  const maxTokens = positiveIntOrUndefined(input.maxTokens);
  const autoCompactTokenLimit = positiveIntOrUndefined(input.autoCompactTokenLimit);
  const ratio = usedTokens !== undefined && maxTokens ? clampRatio(usedTokens / maxTokens) : undefined;
  return {
    sessionRef: input.sessionRef,
    backend: input.backend,
    status: contextStatus(ratio),
    source: input.source,
    usedTokens,
    maxTokens,
    ratio,
    autoCompactTokenLimit,
    lastUsage: input.usage ? { ...input.usage } : undefined,
    lastUpdatedAt: nowIso(),
    lastCompactedAt: input.lastCompactedAt,
    message: input.message,
    metadata: input.metadata,
  };
}

function usageTotal(usage: SessionUsage | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (Number.isFinite(usage.total) && usage.total !== undefined) {
    return Math.max(0, Math.floor(usage.total));
  }
  return Math.max(0, Math.floor((usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)));
}

function sessionUsageFromContextWindowState(usage: BackendContextWindowState['lastUsage'] | undefined): SessionUsage | undefined {
  if (!usage) {
    return undefined;
  }
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    ...(usage.total !== undefined ? { total: usage.total } : {}),
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    ...(usage.provider ? { provider: usage.provider } : {}),
    ...(usage.model ? { model: usage.model } : {}),
    ...(usage.source ? { source: usage.source } : {}),
  };
}

function contextStatus(ratio: number | undefined): BackendContextWindowState['status'] {
  if (ratio === undefined) {
    return 'unknown';
  }
  if (ratio >= 0.95) {
    return 'blocked';
  }
  if (ratio >= 0.85) {
    return 'near-limit';
  }
  if (ratio >= 0.7) {
    return 'watch';
  }
  return 'ok';
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function positiveIntOrUndefined(value: number | null | undefined): number | undefined {
  if (!Number.isFinite(value || NaN) || !value || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolveCodexContextWindowFromEnv(): number | undefined {
  return positiveIntOrUndefined(Number.parseInt(String(process.env.AGENT_SERVER_CODEX_MODEL_CONTEXT_WINDOW || ''), 10));
}

function resolveCodexAutoCompactLimitFromEnv(): number | undefined {
  const explicit = positiveIntOrUndefined(Number.parseInt(String(process.env.AGENT_SERVER_CODEX_AUTO_COMPACT_TOKEN_LIMIT || ''), 10));
  if (explicit) {
    return explicit;
  }
  const contextWindow = resolveCodexContextWindowFromEnv();
  return contextWindow ? Math.floor(contextWindow * 0.9) : undefined;
}

function codexSandboxPolicy(sandbox: string): Record<string, unknown> {
  if (sandbox === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }
  if (sandbox === 'workspace-write') {
    return { type: 'workspaceWrite' };
  }
  return { type: 'readOnly' };
}

function appendDiagnostic(message: string, stderrSummary: string): string {
  if (!stderrSummary) {
    return message;
  }
  return `${message}\n\nCodex app-server stderr (tail):\n${stderrSummary}`;
}

function resolveCodexAppServerRpcTimeoutMs(options: CodexAppServerAdapterOptions): number {
  return resolvePositiveMs(options.rpcTimeoutMs, process.env.AGENT_SERVER_CODEX_APP_SERVER_RPC_TIMEOUT_MS, DEFAULT_CODEX_APP_SERVER_RPC_TIMEOUT_MS, 1_000);
}

function resolveCodexAppServerIdleTimeoutMs(options: CodexAppServerAdapterOptions): number {
  return resolvePositiveMs(options.idleTimeoutMs, process.env.AGENT_SERVER_CODEX_APP_SERVER_IDLE_TIMEOUT_MS, DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MS, 5_000);
}

function resolveCodexAppServerTurnTimeoutMs(options: CodexAppServerAdapterOptions): number {
  return resolvePositiveMs(options.turnTimeoutMs, process.env.AGENT_SERVER_CODEX_APP_SERVER_TURN_TIMEOUT_MS, DEFAULT_CODEX_APP_SERVER_TURN_TIMEOUT_MS, 5_000);
}

function resolvePositiveMs(optionValue: number | undefined, envValue: string | undefined, fallback: number, minimum: number): number {
  if (optionValue !== undefined) {
    if (!Number.isFinite(optionValue)) {
      return fallback;
    }
    if (optionValue <= 0) {
      return 0;
    }
    return Math.max(1, Math.floor(optionValue));
  }
  const raw = Number.parseInt(String(envValue || ''), 10);
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.max(minimum, Math.floor(raw));
}

function abortSignalReason(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason.message;
  }
  if (typeof reason === 'string') {
    return reason;
  }
  return 'aborted';
}

function isAbortishError(message: string): boolean {
  return /abort|cancel|interrupt/i.test(message);
}

function normalizeCodexNotification(
  notification: JsonRpcMessage,
  stageId: string,
  toolCalls: BackendStageResult['toolCalls'],
): SessionStreamEvent[] {
  const method = notification.method || '';
  const params = notification.params;
  if (method === 'item/agentMessage/delta') {
    return [{ type: 'text-delta', stageId, text: readString(params, 'delta') || '' }];
  }
  if (method === 'turn/started') {
    return [{ type: 'status', stageId, status: 'running', message: 'Codex turn started.' }];
  }
  if (method === 'turn/completed') {
    const turnStatus = readNestedString(params, ['turn', 'status']);
    if (turnStatus && turnStatus !== 'completed') {
      return [
        {
          type: 'status',
          stageId,
          status: 'failed',
          message: `Codex turn completed with status=${turnStatus}.`,
        },
        {
          type: 'error',
          stageId,
          error: codexErrorDetail(params) || `Codex turn completed with status=${turnStatus}.`,
        },
      ];
    }
    return [{ type: 'status', stageId, status: 'completed', message: 'Codex turn completed.' }];
  }
  if (method === 'thread/tokenUsage/updated') {
    const tokenUsage = readObject(params, 'tokenUsage');
    const total = readObject(tokenUsage, 'total');
    const last = readObject(tokenUsage, 'last');
    const usage = normalizeModelProviderUsage(total || last, {
      provider: readNestedString(params, ['model', 'provider']),
      model: readNestedString(params, ['model', 'name']),
    });
    return usage ? [{ type: 'usage-update', stageId, usage }] : [];
  }
  if (method === 'error') {
    if (readBoolean(params, 'willRetry') === true) {
      return [{
        type: 'status',
        stageId,
        status: 'running',
        message: `Codex transient error; app-server will retry. ${codexErrorDetail(params) || ''}`.trim(),
      }];
    }
    return [{ type: 'error', stageId, error: JSON.stringify(params) }];
  }
  if (isCodexApprovalRequest(method)) {
    return [{
      type: 'permission-request',
      stageId,
      requestId: String(notification.id || ''),
      toolName: codexServerRequestToolName(method),
      detail: codexServerRequestDetail(notification),
      raw: notification,
    }];
  }
  const item = readObject(params, 'item');
  const itemType = readString(item, 'type');
  if (method === 'item/started' && itemType && itemType !== 'agentMessage' && itemType !== 'reasoning') {
    const toolName = codexItemToolName(item);
    const detail = codexItemDetail(item);
    toolCalls.push({ toolName, detail, status: 'unknown' });
    return [{ type: 'tool-call', stageId, toolName, detail }];
  }
  if (method === 'item/completed' && itemType && itemType !== 'agentMessage' && itemType !== 'reasoning') {
    const toolName = codexItemToolName(item);
    return [{
      type: 'tool-result',
      stageId,
      toolName,
      detail: codexItemDetail(item),
      output: readString(item, 'aggregatedOutput') || undefined,
    }];
  }
  if (method === 'item/completed' && itemType === 'agentMessage') {
    const text = readString(item, 'text');
    return text ? [{ type: 'text-delta', stageId, text }] : [];
  }
  return [];
}

function isCodexApprovalRequest(method: string): boolean {
  return method === 'item/commandExecution/requestApproval'
    || method === 'item/fileChange/requestApproval'
    || method === 'item/permissions/requestApproval'
    || method === 'item/tool/requestUserInput'
    || method === 'mcpServer/elicitation/request';
}

function codexServerRequestToolName(method: string): string {
  if (method === 'item/commandExecution/requestApproval') {
    return 'run_command';
  }
  if (method === 'item/fileChange/requestApproval') {
    return 'apply_patch';
  }
  if (method === 'item/permissions/requestApproval') {
    return 'request_permissions';
  }
  if (method === 'mcpServer/elicitation/request') {
    return 'mcp_elicitation';
  }
  return 'request_user_input';
}

function codexServerRequestDetail(message: JsonRpcMessage): string | undefined {
  const params = isRecord(message.params) ? message.params : null;
  if (!params) {
    return message.method;
  }
  const command = Array.isArray(params.command) ? params.command.join(' ') : readString(params, 'command');
  return command
    || readString(params, 'reason')
    || readString(params, 'message')
    || readString(params, 'itemId')
    || message.method;
}

function codexPendingApproval(message: JsonRpcMessage): CodexSessionState['pendingApproval'] | undefined {
  const method = message.method || '';
  if (!isCodexApprovalRequest(method)) {
    return undefined;
  }
  return {
    id: String(message.id || ''),
    toolName: codexServerRequestToolName(method),
    risk: method === 'item/permissions/requestApproval' ? 'high' : 'medium',
    detail: codexServerRequestDetail(message),
  };
}

function defaultCodexServerRequestResponse(message: JsonRpcMessage): unknown {
  const method = message.method || '';
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
    return { decision: 'acceptForSession' };
  }
  if (method === 'item/permissions/requestApproval') {
    const params = isRecord(message.params) ? message.params : null;
    const permissions = isRecord(params?.permissions) ? params.permissions : {};
    return { permissions, scope: 'session' };
  }
  throw new Error(`AgentServer Codex adapter does not yet support server request ${method}.`);
}

function codexItemToolName(item: Record<string, unknown> | null): string {
  if (!item) {
    return 'codex.item';
  }
  const type = readString(item, 'type') || 'item';
  if (type === 'commandExecution') {
    return 'run_command';
  }
  if (type === 'fileChange') {
    return 'apply_patch';
  }
  if (type === 'mcpToolCall') {
    return readString(item, 'tool') || 'mcp_tool';
  }
  if (type === 'webSearch') {
    return 'web_search';
  }
  return `codex.${type}`;
}

function codexItemDetail(item: Record<string, unknown> | null): string | undefined {
  if (!item) {
    return undefined;
  }
  return readString(item, 'command')
    || readString(item, 'query')
    || readString(item, 'tool')
    || readString(item, 'id')
    || undefined;
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }
  return typeof current === 'string' ? current : null;
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return typeof item === 'number' && Number.isFinite(item) ? item : null;
}

function readObject(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return isRecord(item) ? item : null;
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return typeof item === 'boolean' ? item : null;
}

function codexErrorDetail(params: unknown): string | null {
  const error = readObject(params, 'error');
  return readString(error, 'message')
    || readString(params, 'message')
    || readNestedString(params, ['turn', 'error', 'message'])
    || null;
}

function readMetadataArray(metadata: Record<string, unknown> | undefined, path: string[]): string[] {
  let current: unknown = metadata;
  for (const key of path) {
    if (!isRecord(current)) {
      return [];
    }
    current = current[key];
  }
  return Array.isArray(current)
    ? current.map((item) => String(item)).filter(Boolean)
    : [];
}

function readMetadataBoolean(metadata: Record<string, unknown> | undefined, path: string[]): boolean {
  let current: unknown = metadata;
  for (const key of path) {
    if (!isRecord(current)) {
      return false;
    }
    current = current[key];
  }
  return current === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasJsonRpcId(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } {
  return typeof message.id === 'number' || typeof message.id === 'string';
}

function nowIso(): string {
  return new Date().toISOString();
}
