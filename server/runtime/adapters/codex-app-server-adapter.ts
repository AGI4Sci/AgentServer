import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import type { BackendTier } from '../../../core/runtime/backend-catalog.js';
import type {
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
  BackendReadableState,
  AbortBackendRunInput,
  DisposeBackendSessionInput,
  ReadBackendStateInput,
  RunBackendTurnInput,
  StartBackendSessionInput,
} from '../agent-backend-adapter-contract.js';
import type {
  BackendSessionRef,
  BackendStageResult,
} from '../../agent_server/types.js';
import type { SessionStreamEvent } from '../session-types.js';

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
  activeTurnId?: string;
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
};

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
    const client = CodexJsonRpcClient.spawn(this.options);
    await client.request('initialize', {
      clientInfo: {
        name: this.options.clientName || 'agent_server',
        title: this.options.clientTitle || 'AgentServer',
        version: this.options.clientVersion || '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    client.notify('initialized');

    const startResponse = await client.request('thread/start', {
      cwd: input.workspace,
      ephemeral: input.scope === 'stage',
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });
    const threadId = readNestedString(startResponse, ['thread', 'id']);
    if (!threadId) {
      await client.close();
      throw new Error('Codex app-server thread/start did not return thread.id.');
    }

    const sessionRef: BackendSessionRef = {
      id: `codex-app-server:${threadId}`,
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
    const textParts: string[] = [];
    const toolCalls: BackendStageResult['toolCalls'] = [];
    let failureReason: string | undefined;

    state.status = 'running';
    state.activeRunId = input.handoff.runId;
    state.activeStageId = input.handoff.stageId;
    state.lastEventAt = nowIso();

    try {
      yield {
        type: 'status',
        stageId: input.handoff.stageId,
        status: 'running',
        message: 'Codex turn/start requested.',
      };
      const turnResponse = await state.client.request('turn/start', {
        threadId: state.threadId,
        cwd: state.workspace,
        ...codexTurnOverrides(this.options),
        input: [
          {
            type: 'text',
            text: renderCodexTurnInput(input),
          },
        ],
      });
      const turnId = readNestedString(turnResponse, ['turn', 'id']);
      state.activeTurnId = turnId || undefined;

      for await (const notification of queue) {
        state.lastEventAt = nowIso();
        const normalized = normalizeCodexNotification(notification, input.handoff.stageId, toolCalls);
        if (notification.method === 'serverRequest/resolved') {
          state.pendingApproval = undefined;
          state.status = 'running';
        }
        for (const event of normalized) {
          if (event.type === 'text-delta') {
            textParts.push(event.text);
          }
          if (event.type === 'error') {
            failureReason = event.error;
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
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
      yield {
        type: 'error',
        stageId: input.handoff.stageId,
        error: failureReason,
      };
    } finally {
      unsubscribe();
      unsubscribeRequest();
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
      status: failureReason ? 'failed' : 'completed',
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
      });
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

  static spawn(options: CodexAppServerAdapterOptions): CodexJsonRpcClient {
    const command = options.command || process.env.AGENT_SERVER_CODEX_APP_SERVER_COMMAND || 'codex';
    const args = options.args || ['app-server', '--listen', 'stdio://'];
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodexJsonRpcClient(child);
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    '',
    'AgentServer handoff packet:',
    JSON.stringify(input.handoff, null, 2),
  ].join('\n');
}

function codexTurnOverrides(options: CodexAppServerAdapterOptions): Record<string, string> {
  const model = options.model || process.env.AGENT_SERVER_CODEX_MODEL?.trim();
  const effort = options.effort || process.env.AGENT_SERVER_CODEX_EFFORT?.trim();
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

function appendDiagnostic(message: string, stderrSummary: string): string {
  if (!stderrSummary) {
    return message;
  }
  return `${message}\n\nCodex app-server stderr (tail):\n${stderrSummary}`;
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
    return { decision: 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    return { permissions: {}, scope: 'turn' };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasJsonRpcId(message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } {
  return typeof message.id === 'number' || typeof message.id === 'string';
}

function nowIso(): string {
  return new Date().toISOString();
}
