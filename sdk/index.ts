import {
  BACKEND_CATALOG,
  DEFAULT_BACKEND,
  getBackendCapabilities,
  listBackendDescriptors,
  type BackendCapabilities,
  type BackendDescriptor,
  type BackendType,
} from '../core/runtime/backend-catalog.js';
import {
  classifyTool,
  createDefaultToolRoutingPolicy,
  planToolRoute,
  type ToolClassification,
  type ToolKind,
  type ToolOutputPolicy,
  type ToolRoutePlan,
  type ToolRouteTarget,
  type ToolRouteWorkerPlan,
  type ToolRoutingPolicy,
  type ToolRoutingRule,
  type WorkerCapability,
  type WorkerKind,
  type WorkerProfile,
  type WorkspaceSpec,
} from '../core/runtime/tool-routing.js';
import {
  createAgentServerHttpClient,
  type AgentServerHttpClient,
} from '../server/agent_server/http-client.js';
import { AgentServerService } from '../server/agent_server/service.js';
import type {
  AgentManifest,
  AgentRunRecord,
  AgentRunStreamOptions,
  AgentServerRunRequest,
  AgentServerRunResult,
  CreateAgentRequest,
} from '../server/agent_server/types.js';
import type { SessionStreamEvent } from '../server/runtime/session-types.js';

export type AgentClientMode = 'local' | 'http';

export interface CreateAgentClientOptions {
  service?: AgentServerService;
  baseUrl?: string;
  defaultBackend?: BackendType;
  defaultWorkspace?: string;
  defaultSystemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentTaskOptions {
  agentId?: string;
  name?: string;
  backend?: BackendType;
  workspace?: string;
  workingDirectory?: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  inputMetadata?: Record<string, unknown>;
  runtimeMetadata?: Record<string, unknown>;
  contextPolicy?: AgentServerRunRequest['contextPolicy'];
  runtime?: Omit<NonNullable<AgentServerRunRequest['runtime']>, 'backend' | 'cwd' | 'metadata'>;
  onEvent?: (event: SessionStreamEvent) => void;
}

export interface AgentClient {
  readonly mode: AgentClientMode;
  createAgent(input: CreateAgentRequest): Promise<AgentManifest>;
  getAgent(agentId: string): Promise<AgentManifest>;
  listAgents(): Promise<AgentManifest[]>;
  listRuns(agentId: string): Promise<AgentRunRecord[]>;
  runTask(task: string | AgentServerRunRequest, options?: AgentTaskOptions): Promise<AgentServerRunResult>;
  runText(task: string | AgentServerRunRequest, options?: AgentTaskOptions): Promise<string>;
  getRun(runId: string): Promise<AgentRunRecord>;
  listBackends(): BackendDescriptor[];
  getBackendCapabilities(backend: BackendType): BackendCapabilities;
}

function buildRunRequest(
  task: string | AgentServerRunRequest,
  defaults: CreateAgentClientOptions,
  options: AgentTaskOptions = {},
): AgentServerRunRequest {
  if (typeof task !== 'string') {
    return task;
  }
  const workspace = options.workspace
    || options.workingDirectory
    || defaults.defaultWorkspace;
  if (!workspace) {
    throw new Error('workspace is required. Pass defaultWorkspace to createAgentClient() or workspace to runTask().');
  }
  const backend = options.backend || defaults.defaultBackend || DEFAULT_BACKEND;
  const agentId = options.agentId || `agent-sdk-${backend}`;
  return {
    agent: {
      id: agentId,
      name: options.name || agentId,
      backend,
      workspace,
      systemPrompt: options.systemPrompt || defaults.defaultSystemPrompt,
      reconcileExisting: true,
      metadata: {
        ...(defaults.metadata || {}),
        ...(options.metadata || {}),
      },
    },
    input: {
      text: task,
      metadata: options.inputMetadata,
    },
    contextPolicy: options.contextPolicy,
    runtime: {
      ...(options.runtime || {}),
      backend,
      cwd: workspace,
      metadata: options.runtimeMetadata,
    },
    metadata: {
      ...(defaults.metadata || {}),
      ...(options.metadata || {}),
    },
  };
}

function listBackends(): BackendDescriptor[] {
  return listBackendDescriptors();
}

export function listSupportedBackends(): BackendDescriptor[] {
  return listBackends();
}

export function createAgentClient(options: CreateAgentClientOptions = {}): AgentClient {
  if (options.service && options.baseUrl) {
    throw new Error('Pass either service or baseUrl, not both.');
  }

  const mode: AgentClientMode = options.baseUrl ? 'http' : 'local';
  const service = options.service || (mode === 'local' ? new AgentServerService() : null);
  const httpClient: AgentServerHttpClient | null = options.baseUrl
    ? createAgentServerHttpClient(options.baseUrl)
    : null;

  async function runTask(
    task: string | AgentServerRunRequest,
    taskOptions: AgentTaskOptions = {},
  ): Promise<AgentServerRunResult> {
    const request = buildRunRequest(task, options, taskOptions);
    if (httpClient) {
      if (taskOptions.onEvent) {
        return await httpClient.runTaskStream(request, {
          onEvent: taskOptions.onEvent,
        });
      }
      return await httpClient.runTask(request);
    }
    return await service!.runTask(request, {
      onEvent: taskOptions.onEvent,
    } satisfies AgentRunStreamOptions);
  }

  return {
    mode,
    async createAgent(input) {
      if (httpClient) {
        return await httpClient.createAgent(input);
      }
      return await service!.createAgent(input);
    },
    async getAgent(agentId) {
      if (httpClient) {
        return await httpClient.getAgent(agentId);
      }
      return await service!.getAgent(agentId);
    },
    async listAgents() {
      if (httpClient) {
        return await httpClient.listAgents();
      }
      return await service!.listAgents();
    },
    async listRuns(agentId) {
      if (httpClient) {
        return await httpClient.listRuns(agentId);
      }
      return await service!.listRuns(agentId);
    },
    runTask,
    async runText(task, taskOptions = {}) {
      const result = await runTask(task, taskOptions);
      if (!result.run.output.success) {
        throw new Error(result.run.output.error);
      }
      return result.run.output.result;
    },
    async getRun(runId) {
      if (httpClient) {
        return await httpClient.getRun(runId);
      }
      return await service!.getRun(runId);
    },
    listBackends,
    getBackendCapabilities,
  };
}

export {
  BACKEND_CATALOG,
  DEFAULT_BACKEND,
  classifyTool,
  createDefaultToolRoutingPolicy,
  getBackendCapabilities,
  planToolRoute,
};

export type {
  AgentManifest,
  AgentRunRecord,
  AgentServerRunRequest,
  AgentServerRunResult,
  BackendCapabilities,
  BackendDescriptor,
  BackendType,
  CreateAgentRequest,
  SessionStreamEvent,
  ToolClassification,
  ToolKind,
  ToolOutputPolicy,
  ToolRoutePlan,
  ToolRouteTarget,
  ToolRouteWorkerPlan,
  ToolRoutingPolicy,
  ToolRoutingRule,
  WorkerCapability,
  WorkerKind,
  WorkerProfile,
  WorkspaceSpec,
};
