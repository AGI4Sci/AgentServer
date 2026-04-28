import type { SessionInput, SessionOutput, SessionStreamEvent } from './session-types.js';
import type { BackendModelContract } from './backend-model-contract.js';
import type { RuntimeSessionSnapshotFile } from './supervisor-snapshot-store.js';
import type {
  DisposeWorkerSessionOptions,
  EnsureWorkerSessionOptions,
  WorkerRuntimeType,
  WorkerRunRequest,
  WorkerSessionStatus,
} from './team-worker-types.js';

export interface SupervisorHealthResponse {
  ok: true;
  service: 'runtime-supervisor';
  pid: number;
  startedAt: string;
  projectRoot: string;
  sourceVersion?: string;
}

export interface SupervisorEnsureSessionRequest {
  runtime: WorkerRuntimeType;
  options: EnsureWorkerSessionOptions;
}

export interface SupervisorDisposeSessionRequest {
  runtime: WorkerRuntimeType;
  options: DisposeWorkerSessionOptions;
}

export interface SupervisorShutdownSessionsRequest {
  runtime: WorkerRuntimeType;
  teamId: string;
  projectScope?: string;
  reason?: string;
}

export interface SupervisorCodexUpstreamRegisterRequest {
  model?: string | null;
  modelName?: string | null;
  baseUrl?: string | null;
  apiKey?: string | null;
}

export interface SupervisorListSessionsRequest {
  runtime: WorkerRuntimeType;
  teamId: string;
  projectScope?: string;
}

export interface SupervisorRunRequest {
  request: WorkerRunRequest;
}

export interface SupervisorRuntimeSummary {
  runtime: WorkerRuntimeType;
  sessionCount: number;
  readyCount: number;
  busyCount: number;
  errorCount: number;
}

export interface SupervisorDiagnosticsResponse {
  ok: true;
  service: 'runtime-supervisor';
  pid: number;
  startedAt: string;
  projectRoot: string;
  sourceVersion?: string;
  contracts: BackendModelContract[];
  sessions: WorkerSessionStatus[];
  snapshot: RuntimeSessionSnapshotFile;
  summary: SupervisorRuntimeSummary[];
  restore: {
    inProgress: boolean;
    lastStartedAt: string | null;
    lastCompletedAt: string | null;
    restoredCount: number;
    errorCount: number;
    errors: string[];
  };
}

export interface SupervisorJsonResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface SupervisorRunStreamEnvelope {
  event: SessionStreamEvent;
}

export type {
  SessionInput,
  SessionOutput,
  WorkerRunRequest,
  WorkerSessionStatus,
};
