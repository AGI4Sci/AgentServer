import {
  getBackendDescriptor,
  type BackendTier,
  type BackendType,
} from '../../../core/runtime/backend-catalog.js';
import type {
  AbortBackendRunInput,
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
  BackendReadableState,
  DisposeBackendSessionInput,
  ReadBackendStateInput,
  RunBackendTurnInput,
  StartBackendSessionInput,
} from '../agent-backend-adapter-contract.js';
import type {
  BackendSessionRef,
  BackendStageResult,
} from '../../agent_server/types.js';
import type { WorkerRuntimeType } from '../team-worker-types.js';
import { runSessionViaSupervisor } from '../supervisor-session-runner.js';
import type { SessionStreamEvent } from '../session-types.js';
import { resolveBackendModelSelection } from '../backend-model-contract.js';
import { resolveAdapterLlmEndpointOverride } from './llm-endpoint-override.js';

export type SupervisorCompatBackendId = Extract<BackendType, 'hermes-agent' | 'openclaw'>;

type SupervisorCompatSessionState = BackendReadableState & {
  workspace: string;
  disposed?: boolean;
};

const SUPERVISOR_COMPAT_CAPABILITIES: Record<SupervisorCompatBackendId, AgentBackendCapabilities> = {
  'hermes-agent': {
    nativeLoop: true,
    nativeTools: true,
    nativeSandbox: false,
    nativeApproval: false,
    nativeSession: true,
    fileEditing: true,
    streamingEvents: true,
    structuredEvents: true,
    readableState: true,
    abortableRun: false,
    resumableSession: true,
    statusTransparency: 'partial',
  },
  openclaw: {
    nativeLoop: true,
    nativeTools: true,
    nativeSandbox: true,
    nativeApproval: false,
    nativeSession: true,
    fileEditing: true,
    streamingEvents: true,
    structuredEvents: true,
    readableState: true,
    abortableRun: false,
    resumableSession: true,
    statusTransparency: 'partial',
  },
};

export class SupervisorCompatAgentBackendAdapter implements AgentBackendAdapter {
  readonly kind = 'agent_backend' as const;
  readonly tier: BackendTier;

  private readonly sessions = new Map<string, SupervisorCompatSessionState>();
  private readonly label: string;

  constructor(readonly backendId: SupervisorCompatBackendId) {
    const descriptor = getBackendDescriptor(backendId);
    this.tier = descriptor.tier;
    this.label = descriptor.label;
  }

  capabilities(): AgentBackendCapabilities {
    return { ...SUPERVISOR_COMPAT_CAPABILITIES[this.backendId] };
  }

  async startSession(input: StartBackendSessionInput): Promise<BackendSessionRef> {
    const sessionRef: BackendSessionRef = {
      id: `${this.backendId}:${input.agentServerSessionId}`,
      backend: this.backendId,
      scope: input.scope,
      resumable: true,
      metadata: {
        ...(input.metadata || {}),
        bridge: 'agent-server-supervisor-compat',
        tier: this.tier,
      },
    };
    this.sessions.set(sessionRef.id, {
      sessionRef,
      workspace: input.workspace,
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
    state.lastEventAt = nowIso();

    const modelSelection = resolveBackendModelSelection(this.backendId, {
      llmEndpoint: resolveAdapterLlmEndpointOverride(),
    });
    const events: SessionStreamEvent[] = [];
    const output = await runSessionViaSupervisor(
      this.backendId as WorkerRuntimeType,
      {
        task: input.handoff.userRequest,
        context: renderCompatContext(this.label, input),
      },
      {
        backend: this.backendId,
        teamId: 'agent-server',
        agentId: `${this.backendId}-${input.handoff.runId}`,
        cwd: state.workspace,
        requestId: input.handoff.runId,
        sessionKey: input.sessionRef.id,
        sessionMode: input.sessionRef.scope === 'session' ? 'persistent' : 'ephemeral',
        persistentKey: input.sessionRef.id,
        model: modelSelection.runtimeModel || undefined,
        modelProvider: modelSelection.modelProvider || undefined,
        modelName: modelSelection.modelName || undefined,
        llmEndpoint: resolveAdapterLlmEndpointOverride(),
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
        : `${this.label} compatibility adapter failed: ${output.error.slice(0, 500)}`,
      nextActions: [],
      risks: output.success ? [] : [output.error],
      artifacts: [],
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

  private requireState(sessionRef: BackendSessionRef): SupervisorCompatSessionState {
    const state = this.sessions.get(sessionRef.id);
    if (!state || state.disposed) {
      throw new Error(`${this.label} compatibility session is not active: ${sessionRef.id}`);
    }
    return state;
  }
}

function renderCompatContext(label: string, input: RunBackendTurnInput): string {
  return [
    `You are running as the ${label} ecosystem backend inside AgentServer.`,
    'Use your native backend loop and tools when available.',
    'Treat the handoff packet as the canonical cross-backend context for this stage.',
    'This backend is an ecosystem/compatibility entry point, so do not assume strategic routing ownership unless explicitly requested.',
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
  state: SupervisorCompatSessionState,
  event: SessionStreamEvent,
): void {
  if (event.type === 'status') {
    state.status = event.status === 'waiting_permission' ? 'waiting_user' : 'running';
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
  }
  if (event.type === 'permission-request') {
    state.status = 'waiting_user';
    state.pendingApproval = {
      id: event.requestId,
      toolName: event.toolName,
      detail: event.detail,
    };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
