import type {
  AgentBackendId,
  BackendTier,
  BackendType,
  ExecutionBackendKind,
} from '../../core/runtime/backend-catalog.js';
import type {
  AgentRunStageRecord,
  BackendHandoffPacket,
  BackendSessionRef,
  BackendStageResult,
} from '../agent_server/types.js';
import type { RuntimeModelInput } from './model-spec.js';
import type { LocalDevPolicyHint, SessionStreamEvent } from './session-types.js';

export interface BackendExecutionPolicy {
  approvalPolicy: 'never' | 'on-request';
  sandbox: 'danger-full-access' | 'workspace-write' | 'read-only';
}

export interface AgentBackendCapabilities {
  nativeLoop: boolean;
  nativeTools: boolean;
  nativeSandbox: boolean;
  nativeApproval: boolean;
  nativeSession: boolean;
  fileEditing: boolean;
  streamingEvents: boolean;
  structuredEvents: boolean;
  readableState: boolean;
  abortableRun: boolean;
  resumableSession: boolean;
  statusTransparency: 'full' | 'partial' | 'opaque';
  multimodalInput?: boolean;
  longContext?: boolean;
  contextWindowTelemetry?: 'native' | 'provider-usage' | 'agentserver-estimate' | 'none';
  nativeCompaction?: boolean;
  compactionDuringTurn?: boolean;
  rateLimitTelemetry?: boolean;
  sessionRotationSafe?: boolean;
}

export interface StartBackendSessionInput {
  agentServerSessionId: string;
  backend: AgentBackendId;
  workspace: string;
  scope: 'session' | 'stage';
  runtimeModel?: RuntimeModelInput;
  localDevPolicy?: LocalDevPolicyHint;
  executionPolicy?: BackendExecutionPolicy;
  metadata?: Record<string, unknown>;
}

export interface RunBackendTurnInput {
  sessionRef: BackendSessionRef;
  handoff: BackendHandoffPacket;
  runtimeModel?: RuntimeModelInput;
  localDevPolicy?: LocalDevPolicyHint;
  executionPolicy?: BackendExecutionPolicy;
  abortSignal?: AbortSignal;
}

export interface AbortBackendRunInput {
  sessionRef: BackendSessionRef;
  runId: string;
  stageId?: string;
  reason?: string;
}

export interface ReadBackendStateInput {
  sessionRef: BackendSessionRef;
}

export interface DisposeBackendSessionInput {
  sessionRef: BackendSessionRef;
  reason?: string;
}

export interface ReadBackendContextWindowInput {
  sessionRef: BackendSessionRef;
  reason?: string;
}

export interface CompactBackendContextInput {
  sessionRef: BackendSessionRef;
  reason?: string;
}

export interface BackendContextWindowState {
  sessionRef: BackendSessionRef;
  backend: AgentBackendId;
  status: 'ok' | 'watch' | 'near-limit' | 'compacting' | 'blocked' | 'unknown';
  source: 'native' | 'provider-usage' | 'agentserver-estimate' | 'unknown';
  usedTokens?: number;
  maxTokens?: number;
  ratio?: number;
  autoCompactTokenLimit?: number;
  lastUsage?: {
    input?: number;
    output?: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
    provider?: string;
    model?: string;
    source?: 'model-provider' | 'estimated';
  };
  lastUpdatedAt: string;
  lastCompactedAt?: string;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface BackendContextCompactionResult {
  sessionRef: BackendSessionRef;
  backend: AgentBackendId;
  status: 'compacted' | 'skipped' | 'failed';
  capabilityUsed: 'native' | 'agentserver' | 'fallback' | 'none';
  reason?: string;
  before?: BackendContextWindowState;
  after?: BackendContextWindowState;
  startedAt: string;
  completedAt: string;
  userVisibleSummary?: string;
  auditRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface BackendReadableState {
  sessionRef: BackendSessionRef;
  status: 'idle' | 'running' | 'waiting_user' | 'failed' | 'disposed';
  activeRunId?: string;
  activeStageId?: string;
  activeToolCall?: {
    id: string;
    name: string;
    inputSummary?: string;
  };
  pendingApproval?: {
    id: string;
    toolName?: string;
    risk?: 'low' | 'medium' | 'high';
    detail?: string;
  };
  workspaceState?: {
    dirtyFiles: string[];
    diffSummary?: string;
  };
  lastStage?: AgentRunStageRecord;
  lastEventAt?: string;
  resumable: boolean;
  metadata?: Record<string, unknown>;
}

export type AgentBackendEvent =
  | SessionStreamEvent
  | {
      type: 'stage-result';
      stageId: string;
      result: BackendStageResult;
    };

export interface AgentBackendAdapter {
  readonly backendId: AgentBackendId;
  readonly kind: Extract<ExecutionBackendKind, 'agent_backend'>;
  readonly tier: BackendTier;

  capabilities(): Promise<AgentBackendCapabilities> | AgentBackendCapabilities;
  startSession(input: StartBackendSessionInput): Promise<BackendSessionRef>;
  runTurn(input: RunBackendTurnInput): AsyncIterable<AgentBackendEvent>;
  abort(input: AbortBackendRunInput): Promise<void>;
  readState(input: ReadBackendStateInput): Promise<BackendReadableState>;
  readContextWindowState?(input: ReadBackendContextWindowInput): Promise<BackendContextWindowState>;
  compactContext?(input: CompactBackendContextInput): Promise<BackendContextCompactionResult>;
  dispose(input: DisposeBackendSessionInput): Promise<void>;
}
