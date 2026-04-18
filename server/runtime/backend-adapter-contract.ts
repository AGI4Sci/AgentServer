import type { BackendCapabilities, BackendType } from '../../core/runtime/backend-catalog.js';
import type { SessionOutput } from './session-types.js';
import type {
  DisposeWorkerSessionOptions,
  EnsureWorkerSessionOptions,
  WorkerEvent,
  WorkerRunRequest,
  WorkerSessionStatus,
} from './team-worker-types.js';

export interface BackendRuntimeSession {
  status: WorkerSessionStatus;
}

export interface BackendAdapter {
  readonly id: BackendType;
  readonly capabilities: BackendCapabilities;

  ensureSession(options: EnsureWorkerSessionOptions): Promise<WorkerSessionStatus>;
  run(
    request: WorkerRunRequest,
    handlers: {
      onEvent: (event: WorkerEvent) => void;
    },
  ): Promise<SessionOutput>;
  interrupt?(request: WorkerRunRequest): Promise<void>;
  dispose?(options: DisposeWorkerSessionOptions): Promise<WorkerSessionStatus | null> | WorkerSessionStatus | null;
}
