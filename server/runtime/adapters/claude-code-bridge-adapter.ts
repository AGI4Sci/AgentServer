import type { BackendTier } from '../../../core/runtime/backend-catalog.js';
import type {
  AbortBackendRunInput,
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
  BackendReadableState,
  BackendContextCompactionResult,
  BackendContextWindowState,
  DisposeBackendSessionInput,
  CompactBackendContextInput,
  ReadBackendStateInput,
  ReadBackendContextWindowInput,
  RunBackendTurnInput,
  StartBackendSessionInput,
} from '../agent-backend-adapter-contract.js';
import type {
  BackendSessionRef,
  BackendStageResult,
} from '../../agent_server/types.js';
import { runSessionViaSupervisor } from '../supervisor-session-runner.js';
import type { SessionStreamEvent, SessionUsage } from '../session-types.js';
import { resolveBackendModelSelection } from '../backend-model-contract.js';
import { resolveAdapterLlmEndpointOverride } from './llm-endpoint-override.js';

type ClaudeCodeSessionState = BackendReadableState & {
  workspace: string;
  runtimeModel?: StartBackendSessionInput['runtimeModel'];
  localDevPolicy?: StartBackendSessionInput['localDevPolicy'];
  lastUsage?: SessionUsage;
  lastContextWindowState?: BackendContextWindowState;
  lastCompactedAt?: string;
  disposed?: boolean;
};

const CLAUDE_CODE_BRIDGE_CAPABILITIES: AgentBackendCapabilities = {
  nativeLoop: true,
  nativeTools: true,
  nativeSandbox: true,
  nativeApproval: true,
  nativeSession: true,
  fileEditing: true,
  streamingEvents: true,
  structuredEvents: true,
  readableState: true,
  abortableRun: false,
  resumableSession: true,
  statusTransparency: 'partial',
  contextWindowTelemetry: 'provider-usage',
  nativeCompaction: true,
  compactionDuringTurn: false,
  rateLimitTelemetry: false,
  sessionRotationSafe: true,
};

export class ClaudeCodeBridgeAgentBackendAdapter implements AgentBackendAdapter {
  readonly backendId = 'claude-code' as const;
  readonly kind = 'agent_backend' as const;
  readonly tier: BackendTier = 'strategic';

  private readonly sessions = new Map<string, ClaudeCodeSessionState>();

  capabilities(): AgentBackendCapabilities {
    return { ...CLAUDE_CODE_BRIDGE_CAPABILITIES };
  }

  async startSession(input: StartBackendSessionInput): Promise<BackendSessionRef> {
    const id = `claude-code:${input.agentServerSessionId}`;
    const existing = this.sessions.get(id);
    if (existing && !existing.disposed) {
      return existing.sessionRef;
    }
    const sessionRef: BackendSessionRef = {
      id,
      backend: this.backendId,
      scope: input.scope,
      resumable: true,
      metadata: {
        ...(input.metadata || {}),
        bridge: 'agent-server-supervisor',
        nativeCompaction: '/compact',
        nativeContextSignals: ['usage-update', 'compact_boundary', 'status=compacting'],
      },
    };
    this.sessions.set(sessionRef.id, {
      sessionRef,
      workspace: input.workspace,
      runtimeModel: input.runtimeModel,
      localDevPolicy: input.localDevPolicy,
      status: 'idle',
      resumable: true,
      metadata: sessionRef.metadata,
    });
    return sessionRef;
  }

  async *runTurn(input: RunBackendTurnInput): AsyncIterable<AgentBackendEvent> {
    const state = this.requireState(input.sessionRef);
    const startedAt = Date.now();
    state.status = 'running';
    state.activeRunId = input.handoff.runId;
    state.activeStageId = input.handoff.stageId;
    state.runtimeModel = input.runtimeModel || state.runtimeModel;
    state.localDevPolicy = input.localDevPolicy || state.localDevPolicy;
    state.lastEventAt = nowIso();

    const events: SessionStreamEvent[] = [];
    const modelSelection = resolveBackendModelSelection(this.backendId, {
      ...(input.runtimeModel || {}),
      llmEndpoint: input.runtimeModel?.llmEndpoint || resolveAdapterLlmEndpointOverride(),
    });
    const output = await runSessionViaSupervisor(
      this.backendId,
      {
        task: input.handoff.userRequest,
        context: renderClaudeCodeContext(input),
      },
      {
        backend: this.backendId,
        teamId: 'agent-server',
        agentId: stableClaudeAgentId(input.sessionRef.id),
        cwd: state.workspace,
        requestId: input.handoff.runId,
        sessionKey: input.sessionRef.id,
        sessionMode: input.sessionRef.scope === 'session' ? 'persistent' : 'ephemeral',
        persistentKey: input.sessionRef.id,
        model: modelSelection.runtimeModel || undefined,
        modelProvider: modelSelection.modelProvider || undefined,
        modelName: modelSelection.modelName || undefined,
        llmEndpoint: input.runtimeModel?.llmEndpoint || resolveAdapterLlmEndpointOverride(),
        localDevPolicy: input.localDevPolicy,
      },
      {
        onEvent: (event) => {
          state.lastEventAt = nowIso();
          const normalized = withStageId(event, input.handoff.stageId);
          updateReadableStateFromEvent(state, normalized);
          events.push(normalized);
        },
      },
    );

    for (const event of events) {
      yield event;
    }

    state.status = output.success ? 'idle' : 'failed';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
    state.activeToolCall = undefined;
    state.pendingApproval = undefined;
    state.lastEventAt = nowIso();
    if (output.usage) {
      state.lastUsage = output.usage;
      state.lastContextWindowState = buildClaudeContextWindowState(state, {
        usage: output.usage,
        source: output.usage.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
      });
    }

    const result: BackendStageResult = {
      status: output.success ? 'completed' : 'failed',
      finalText: output.success ? output.result : output.error,
      filesChanged: input.handoff.workspaceFacts.dirtyFiles,
      diffSummary: input.handoff.workspaceFacts.lastKnownDiffSummary,
      toolCalls: events
        .filter((event) => event.type === 'tool-call')
        .map((event) => ({
          toolName: event.toolName,
          detail: event.detail,
          status: 'unknown' as const,
        })),
      testsRun: [],
      findings: [],
      handoffSummary: output.success
        ? output.result.slice(0, 500)
        : `Claude Code bridge failed: ${output.error.slice(0, 500)}`,
      nextActions: [],
      risks: output.success ? [] : [output.error],
      artifacts: [],
      usage: output.usage,
      nativeSessionRef: input.sessionRef,
    };
    state.lastStage = {
      id: input.handoff.stageId,
      runId: input.handoff.runId,
      type: input.handoff.stageType,
      backend: this.backendId,
      status: result.status,
      dependsOn: [],
      input: input.handoff,
      result,
      metrics: {
        durationMs: Math.max(0, Date.now() - startedAt),
        toolCallCount: result.toolCalls.length,
        usage: output.usage,
      },
      audit: {
        backend: this.backendId,
        backendKind: this.kind,
        backendTier: this.tier,
        inputSummary: input.handoff.userRequest.slice(0, 500),
        outputSummary: result.finalText?.slice(0, 500),
        failureReason: output.success ? undefined : output.error,
        nativeSessionRef: input.sessionRef,
      },
      createdAt: new Date(startedAt).toISOString(),
      completedAt: nowIso(),
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
    state.status = 'failed';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
    state.activeToolCall = undefined;
    state.pendingApproval = undefined;
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
    return buildClaudeContextWindowState(state, {
      usage: state.lastUsage,
      source: state.lastUsage?.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
      message: 'Claude Code has not reported token usage for this bridge session yet.',
      metadata: { reason: input.reason },
    });
  }

  async compactContext(input: CompactBackendContextInput): Promise<BackendContextCompactionResult> {
    const state = this.requireState(input.sessionRef);
    const startedAt = nowIso();
    const before = await this.readContextWindowState(input);
    if (state.activeRunId) {
      return {
        sessionRef: state.sessionRef,
        backend: this.backendId,
        status: 'skipped',
        capabilityUsed: 'native',
        reason: 'Claude Code bridge session already has an active run; /compact must run while the session is idle.',
        before,
        after: before,
        startedAt,
        completedAt: nowIso(),
        userVisibleSummary: 'Claude Code 上下文压缩已跳过：当前 session 正在运行。',
        metadata: { method: '/compact' },
      };
    }

    const reason = sanitizeSlashCommandReason(input.reason || 'AgentServer context-window maintenance');
    const modelSelection = resolveBackendModelSelection(this.backendId, {
      ...(state.runtimeModel || {}),
      llmEndpoint: state.runtimeModel?.llmEndpoint || resolveAdapterLlmEndpointOverride(),
    });
    const events: SessionStreamEvent[] = [];
    let outputText = '';
    let failureReason: string | undefined;

    state.status = 'running';
    state.lastContextWindowState = {
      ...before,
      status: 'compacting',
      lastUpdatedAt: nowIso(),
      message: 'Claude Code native /compact is running.',
    };

    try {
      const output = await runSessionViaSupervisor(
        this.backendId,
        {
          task: `/compact ${reason}`,
          context: '',
        },
        {
          backend: this.backendId,
          teamId: 'agent-server',
          agentId: stableClaudeAgentId(input.sessionRef.id),
          cwd: state.workspace,
          requestId: `compact-${Date.now()}`,
          sessionKey: input.sessionRef.id,
          sessionMode: input.sessionRef.scope === 'session' ? 'persistent' : 'ephemeral',
          persistentKey: input.sessionRef.id,
          model: modelSelection.runtimeModel || undefined,
          modelProvider: modelSelection.modelProvider || undefined,
          modelName: modelSelection.modelName || undefined,
          llmEndpoint: state.runtimeModel?.llmEndpoint || resolveAdapterLlmEndpointOverride(),
          localDevPolicy: state.localDevPolicy,
          forceNativeRuntime: true,
        },
        {
          onEvent: (event) => {
            state.lastEventAt = nowIso();
            const normalized = withStageId(event, `compact-${Date.now()}`);
            updateReadableStateFromEvent(state, normalized);
            events.push(normalized);
          },
        },
      );
      outputText = output.success ? output.result : output.error;
      failureReason = output.success ? undefined : output.error;
      if (output.usage) {
        state.lastUsage = output.usage;
      }
    } catch (error) {
      failureReason = error instanceof Error ? error.message : String(error);
    }

    if (!failureReason) {
      state.lastCompactedAt = nowIso();
      state.lastContextWindowState = buildClaudeContextWindowState(state, {
        usage: state.lastUsage,
        source: state.lastUsage?.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
        status: 'ok',
        message: 'Claude Code native /compact completed.',
        metadata: { method: '/compact', reason, output: outputText.slice(0, 500) },
      });
    }
    state.status = failureReason ? 'failed' : 'idle';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
    state.activeToolCall = undefined;
    state.pendingApproval = undefined;
    state.lastEventAt = nowIso();

    const after = await this.readContextWindowState(input);
    const noMessagesToCompact = failureReason ? /no messages|nothing to compact/i.test(failureReason) : false;
    return {
      sessionRef: state.sessionRef,
      backend: this.backendId,
      status: failureReason ? (noMessagesToCompact ? 'skipped' : 'failed') : 'compacted',
      capabilityUsed: 'native',
      reason: failureReason,
      before,
      after,
      startedAt,
      completedAt: nowIso(),
      userVisibleSummary: failureReason
        ? `Claude Code 原生 /compact 未完成：${failureReason}`
        : 'Claude Code 原生 /compact 已完成。',
      metadata: {
        method: '/compact',
        eventCount: events.length,
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
    state.metadata = {
      ...(state.metadata || {}),
      disposeReason: input.reason,
    };
  }

  private requireState(sessionRef: BackendSessionRef): ClaudeCodeSessionState {
    const state = this.sessions.get(sessionRef.id);
    if (!state || state.disposed) {
      throw new Error(`Claude Code bridge session is not active: ${sessionRef.id}`);
    }
    return state;
  }
}

function renderClaudeCodeContext(input: RunBackendTurnInput): string {
  return [
    'You are running as the Claude Code strategic backend inside AgentServer.',
    'Use your native coding loop, tools, approval model, and workspace editing behavior first.',
    'Only use AgentServer-provided fallback tools when the native backend cannot perform the action directly.',
    'Treat the handoff packet as the canonical cross-backend context for this stage.',
    '',
    input.handoff.stageInstructions,
    '',
    'Backend handoff packet:',
    JSON.stringify(input.handoff, null, 2),
  ].join('\n');
}

function withStageId(event: SessionStreamEvent, stageId: string): SessionStreamEvent {
  if (event.type === 'result') {
    return event;
  }
  return { ...event, stageId };
}

function updateReadableStateFromEvent(
  state: ClaudeCodeSessionState,
  event: SessionStreamEvent,
): void {
  if (event.type === 'status') {
    state.status = event.status === 'waiting_permission'
      ? 'waiting_user'
      : event.status === 'failed'
        ? 'failed'
        : event.status === 'completed'
          ? 'idle'
          : 'running';
    if (/compact/i.test(event.message || '')) {
      state.lastContextWindowState = buildClaudeContextWindowState(state, {
        usage: state.lastUsage,
        source: state.lastUsage?.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
        status: event.status === 'completed' ? 'ok' : 'compacting',
        message: event.message,
      });
    }
  }
  if (event.type === 'tool-call') {
    state.activeToolCall = {
      id: `${event.toolName}:${Date.now()}`,
      name: event.toolName,
      inputSummary: event.detail,
    };
  }
  if (event.type === 'tool-result') {
    state.activeToolCall = undefined;
    if (event.toolName === 'claude_code.compact') {
      state.lastCompactedAt = nowIso();
      state.lastContextWindowState = buildClaudeContextWindowState(state, {
        usage: state.lastUsage,
        source: state.lastUsage?.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
        status: 'ok',
        message: 'Claude Code native context compaction completed.',
      });
    }
  }
  if (event.type === 'permission-request') {
    state.status = 'waiting_user';
    state.pendingApproval = {
      id: event.requestId,
      toolName: event.toolName,
      detail: event.detail,
    };
  }
  if (event.type === 'usage-update') {
    state.lastUsage = event.usage;
    state.lastContextWindowState = buildClaudeContextWindowState(state, {
      usage: event.usage,
      source: event.usage.source === 'estimated' ? 'agentserver-estimate' : 'provider-usage',
    });
  }
}

function buildClaudeContextWindowState(
  state: ClaudeCodeSessionState,
  input: {
    usage?: SessionUsage;
    source: BackendContextWindowState['source'];
    status?: BackendContextWindowState['status'];
    message?: string;
    metadata?: Record<string, unknown>;
  },
): BackendContextWindowState {
  const usedTokens = usageTotal(input.usage);
  const maxTokens = resolveClaudeContextWindowFromEnv();
  const ratio = usedTokens !== undefined && maxTokens ? clampRatio(usedTokens / maxTokens) : undefined;
  return {
    sessionRef: state.sessionRef,
    backend: 'claude-code',
    status: input.status || contextStatus(ratio),
    source: input.source,
    usedTokens,
    maxTokens,
    ratio,
    lastUsage: input.usage ? { ...input.usage } : undefined,
    lastUpdatedAt: nowIso(),
    lastCompactedAt: state.lastCompactedAt,
    message: input.message,
    metadata: {
      bridge: 'agent-server-supervisor',
      nativeCompaction: '/compact',
      ...(input.metadata || {}),
    },
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

function resolveClaudeContextWindowFromEnv(): number | undefined {
  const value = Number.parseInt(String(process.env.AGENT_SERVER_CLAUDE_CODE_MODEL_CONTEXT_WINDOW || ''), 10);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function sanitizeSlashCommandReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

function stableClaudeAgentId(sessionRefId: string): string {
  return `claude-code-${sessionRefId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 80)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
