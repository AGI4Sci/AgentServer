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
import type { SessionStreamEvent } from './session-types.js';

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
}

export interface StartBackendSessionInput {
  agentServerSessionId: string;
  backend: AgentBackendId;
  workspace: string;
  scope: 'session' | 'stage';
  metadata?: Record<string, unknown>;
}

export interface RunBackendTurnInput {
  sessionRef: BackendSessionRef;
  handoff: BackendHandoffPacket;
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
  dispose(input: DisposeBackendSessionInput): Promise<void>;
}
