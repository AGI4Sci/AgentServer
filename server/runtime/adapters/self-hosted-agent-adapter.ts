import type { BackendTier } from '../../../core/runtime/backend-catalog.js';
import type {
  BackendReadableState,
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
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
import { runSessionViaSupervisor } from '../supervisor-session-runner.js';
import type { SessionStreamEvent } from '../session-types.js';
import { resolveBackendModelSelection } from '../backend-model-contract.js';
import { resolveAdapterLlmEndpointOverride } from './llm-endpoint-override.js';

type SelfHostedSessionState = BackendReadableState & {
  workspace: string;
  disposed?: boolean;
};

const SELF_HOSTED_CAPABILITIES: AgentBackendCapabilities = {
  nativeLoop: false,
  nativeTools: false,
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
};

export class SelfHostedAgentBackendAdapter implements AgentBackendAdapter {
  readonly backendId = 'openteam_agent' as const;
  readonly kind = 'agent_backend' as const;
  readonly tier: BackendTier = 'strategic';

  private readonly sessions = new Map<string, SelfHostedSessionState>();

  capabilities(): AgentBackendCapabilities {
    return { ...SELF_HOSTED_CAPABILITIES };
  }

  async startSession(input: StartBackendSessionInput): Promise<BackendSessionRef> {
    const id = `self-hosted:${input.agentServerSessionId}`;
    const existing = this.sessions.get(id);
    if (existing && !existing.disposed) {
      return existing.sessionRef;
    }
    const sessionRef: BackendSessionRef = {
      id,
      backend: this.backendId,
      scope: input.scope,
      resumable: true,
      metadata: input.metadata,
    };
    this.sessions.set(sessionRef.id, {
      sessionRef,
      workspace: input.workspace,
      status: 'idle',
      resumable: true,
      metadata: input.metadata,
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

    const events: SessionStreamEvent[] = [];
    const modelSelection = resolveBackendModelSelection(this.backendId, {
      ...(input.runtimeModel || {}),
      llmEndpoint: input.runtimeModel?.llmEndpoint || resolveAdapterLlmEndpointOverride(),
    });
    const output = await runSessionViaSupervisor(
      this.backendId,
      {
        task: input.handoff.userRequest,
        context: renderSelfHostedContext(input),
      },
      {
        backend: this.backendId,
        teamId: 'agent-server',
        agentId: `self-hosted-${input.handoff.runId}`,
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
          events.push(withStageId(event, input.handoff.stageId));
        },
      },
    );

    for (const event of events) {
      yield event;
    }

    state.status = output.success ? 'idle' : 'failed';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
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
        : `Self-hosted agent failed: ${output.error.slice(0, 500)}`,
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

  private requireState(sessionRef: BackendSessionRef): SelfHostedSessionState {
    const state = this.sessions.get(sessionRef.id);
    if (!state || state.disposed) {
      throw new Error(`Self-hosted agent session is not active: ${sessionRef.id}`);
    }
    return state;
  }
}

function renderSelfHostedContext(input: RunBackendTurnInput): string {
  return [
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

function nowIso(): string {
  return new Date().toISOString();
}
