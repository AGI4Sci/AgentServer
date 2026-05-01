import type {
  RuntimeSessionMode,
  RunSessionOptions,
  SessionInput,
  SessionOutput,
  SessionUsage,
} from './session-types.js';
import type { RuntimeEventProtocolVersion } from './runtime-event-contract.js';

export type WorkerRuntimeType =
  | 'openteam_agent'
  | 'claude-code'
  | 'codex'
  | 'hermes-agent'
  | 'openclaw';

export interface WorkerSessionStatus {
  cacheKey?: string | null;
  runtime: WorkerRuntimeType;
  teamId: string;
  agentId: string;
  projectScope?: string | null;
  cwd: string | null;
  model: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  sessionMode?: RuntimeSessionMode;
  persistentKey?: string | null;
  currentRequestId?: string | null;
  currentSessionKey?: string | null;
  lastRequestId?: string | null;
  lastSessionKey?: string | null;
  pid: number | null;
  sessionReady: boolean;
  online: boolean;
  busy: boolean;
  status: 'starting' | 'ready' | 'busy' | 'error' | 'offline';
  startedAt?: string;
  lastUsedAt?: string;
  lastEventAt?: string;
  lastError?: string | null;
}

export interface WorkerEventBase {
  protocolVersion?: RuntimeEventProtocolVersion;
  raw?: unknown;
}

export interface EnsureWorkerSessionOptions {
  teamId: string;
  agentId: string;
  projectScope?: string;
  cwd?: string;
  model?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  sessionMode?: RuntimeSessionMode;
  persistentKey?: string;
  healthcheck?: 'none' | 'launch';
}

export interface DisposeWorkerSessionOptions {
  teamId: string;
  agentId: string;
  projectScope?: string;
  cacheKey?: string | null;
  persistentKey?: string | null;
  reason?: string;
}

export interface WorkerRunRequest {
  type: 'run';
  runtime: WorkerRuntimeType;
  teamId: string;
  agentId: string;
  projectScope?: string;
  requestId: string;
  sessionKey: string;
  input: SessionInput;
  options: RunSessionOptions;
}

export type WorkerRequest =
  | {
      type: 'init';
      runtime: WorkerRuntimeType;
      teamId: string;
    }
  | WorkerRunRequest
  | {
      type: 'interrupt';
      runtime: WorkerRuntimeType;
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
    }
  | {
      type: 'shutdown';
      runtime: WorkerRuntimeType;
      teamId: string;
    };

export type WorkerEvent =
  | ({
      type: 'status';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed';
      message?: string;
    } & WorkerEventBase)
  | ({
      type: 'text-delta';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      text: string;
    } & WorkerEventBase)
  | ({
      type: 'tool-call';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      toolName: string;
      detail?: string;
    } & WorkerEventBase)
  | ({
      type: 'tool-result';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      toolName: string;
      detail?: string;
      output?: string;
    } & WorkerEventBase)
  | ({
      type: 'permission-request';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      permissionId: string;
      toolName: string;
      detail?: string;
    } & WorkerEventBase)
  | ({
      type: 'error';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      error: string;
    } & WorkerEventBase)
  | ({
      type: 'usage-update';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      usage: SessionUsage;
    } & WorkerEventBase)
  | ({
      type: 'result';
      teamId: string;
      agentId: string;
      requestId: string;
      sessionKey: string;
      output: SessionOutput;
      usage?: SessionUsage;
    } & WorkerEventBase);
