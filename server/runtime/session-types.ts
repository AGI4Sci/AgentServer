import type { BackendType } from '../../core/runtime/backend-catalog.js';
import type { BackendStageResult } from '../agent_server/types.js';
import type { RuntimeModelInput } from './model-spec.js';
import type { RuntimeEventProtocolVersion } from './runtime-event-contract.js';

export interface SessionInput {
  task: string;
  context: string;
}

export interface SessionUsage {
  input: number;
  output: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  provider?: string;
  model?: string;
  source?: 'model-provider' | 'estimated';
}

export interface LocalDevPolicyHint {
  isSourceTask?: boolean;
  maxSteps?: number;
  forceSummaryOnBudgetExhausted?: boolean;
}

export type SessionOutput =
  | {
      success: true;
      result: string;
      error?: undefined;
      usage?: SessionUsage;
    }
  | {
      success: false;
      error: string;
      result?: undefined;
      usage?: SessionUsage;
    };

export type SessionClientType = BackendType;
export type RuntimeSessionMode = 'ephemeral' | 'persistent';

export interface RuntimeEventBase {
  protocolVersion?: RuntimeEventProtocolVersion;
  raw?: unknown;
}

export interface ToolRouteEventFields {
  workspaceId?: string;
  primaryWorker?: string;
  fallbackWorkers?: string[];
  routeReason?: string;
}

export interface RunSessionOptions {
  backend?: SessionClientType;
  agentId: string;
  teamId: string;
  projectScope?: string;
  requestId?: string;
  sessionKey?: string;
  messageId?: string;
  sourceClientId?: string | null;
  isPrivate?: boolean;
  cwd?: string;
  timeoutMs?: number;
  model?: string;
  modelProvider?: string;
  modelName?: string;
  llmEndpoint?: RuntimeModelInput['llmEndpoint'];
  sessionMode?: RuntimeSessionMode;
  persistentKey?: string;
  toolMode?: 'auto' | 'none';
  localDevPolicy?: LocalDevPolicyHint;
  forceNativeRuntime?: boolean;
}

export type SessionStreamEvent =
  | ({
      type: 'run-plan';
      runId: string;
      stageId?: string;
      backend: string;
      plan: string[];
      message?: string;
    } & RuntimeEventBase)
  | ({
      type: 'stage-start';
      runId: string;
      stageId: string;
      backend: string;
      message?: string;
      detail?: string;
    } & RuntimeEventBase)
  | ({
      type: 'text-delta';
      stageId?: string;
      text: string;
    } & RuntimeEventBase)
  | ({
      type: 'status';
      stageId?: string;
      status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed';
      message?: string;
    } & RuntimeEventBase)
  | ({
      type: 'tool-call';
      stageId?: string;
      toolName: string;
      detail?: string;
    } & RuntimeEventBase & ToolRouteEventFields)
  | ({
      type: 'tool-result';
      stageId?: string;
      toolName: string;
      detail?: string;
      output?: string;
    } & RuntimeEventBase & ToolRouteEventFields)
  | ({
      type: 'permission-request';
      stageId?: string;
      requestId: string;
      toolName: string;
      detail?: string;
    } & RuntimeEventBase)
  | ({
      type: 'stage-result';
      stageId: string;
      result: BackendStageResult;
    } & RuntimeEventBase)
  | ({
      type: 'error';
      stageId?: string;
      error: string;
    } & RuntimeEventBase)
  | ({
      type: 'usage-update';
      stageId?: string;
      usage: SessionUsage;
    } & RuntimeEventBase)
  | ({
      type: 'result';
      output: SessionOutput;
      usage?: SessionUsage;
    } & RuntimeEventBase);

export interface SessionRunner {
  run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput>;
  runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: {
      onEvent: (event: SessionStreamEvent) => void;
    },
  ): Promise<SessionOutput>;
}

export function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n\n${error.stack}` : error.message;
  }
  return String(error);
}
