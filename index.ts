export {
  BACKEND_CATALOG,
  DEFAULT_BACKEND,
  createAgentClient,
  getBackendCapabilities,
  listSupportedBackends,
} from './sdk/index.js';

export type {
  AgentClient,
  AgentClientMode,
  AgentManifest,
  AgentRunRecord,
  AgentServerRunRequest,
  AgentServerRunResult,
  AgentTaskOptions,
  BackendCapabilities,
  BackendDescriptor,
  BackendType,
  CreateAgentClientOptions,
  CreateAgentRequest,
  SessionStreamEvent,
} from './sdk/index.js';
