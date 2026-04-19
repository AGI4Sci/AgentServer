import type {
  BackendType,
  StrategicAgentBackend,
} from '../../core/runtime/backend-catalog.js';
import type { AgentBackendAdapter } from './agent-backend-adapter-contract.js';
import {
  getStrategicAgentBackendProfile,
  isProductionCompleteAgentBackend,
  listStrategicAgentBackendProfiles,
  type StrategicAgentBackendProfile,
} from './agent-backend-profile-registry.js';
import { ClaudeCodeBridgeAgentBackendAdapter } from './adapters/claude-code-bridge-adapter.js';
import { CodexAppServerAgentBackendAdapter } from './adapters/codex-app-server-adapter.js';
import { GeminiSdkAgentBackendAdapter } from './adapters/gemini-sdk-adapter.js';
import { SelfHostedAgentBackendAdapter } from './adapters/self-hosted-agent-adapter.js';

export type AgentBackendAdapterKey = StrategicAgentBackend | BackendType;

export interface AvailableAgentBackendAdapter {
  id: StrategicAgentBackend;
  runtimeBackendId?: BackendType;
  profile: StrategicAgentBackendProfile;
  productionComplete: boolean;
}

type AgentBackendAdapterFactory = () => AgentBackendAdapter;

const AGENT_BACKEND_ADAPTER_FACTORIES: Partial<Record<StrategicAgentBackend, AgentBackendAdapterFactory>> = {
  codex: () => new CodexAppServerAgentBackendAdapter(),
  'claude-code': () => new ClaudeCodeBridgeAgentBackendAdapter(),
  gemini: () => new GeminiSdkAgentBackendAdapter(),
  'self-hosted-agent': () => new SelfHostedAgentBackendAdapter(),
};

const RUNTIME_BACKEND_TO_STRATEGIC: Partial<Record<BackendType, StrategicAgentBackend>> = {
  openteam_agent: 'self-hosted-agent',
  'claude-code': 'claude-code',
  codex: 'codex',
};

export function listAvailableAgentBackendAdapters(): AvailableAgentBackendAdapter[] {
  return listStrategicAgentBackendProfiles()
    .filter((profile) => Boolean(AGENT_BACKEND_ADAPTER_FACTORIES[profile.id]))
    .map((profile) => ({
      id: profile.id,
      runtimeBackendId: profile.runtimeBackendId,
      profile,
      productionComplete: isProductionCompleteAgentBackend(profile),
    }));
}

export function hasAgentBackendAdapter(key: AgentBackendAdapterKey): boolean {
  return Boolean(AGENT_BACKEND_ADAPTER_FACTORIES[normalizeAdapterKey(key)]);
}

export function createAgentBackendAdapter(key: AgentBackendAdapterKey): AgentBackendAdapter {
  const strategicKey = normalizeAdapterKey(key);
  const factory = AGENT_BACKEND_ADAPTER_FACTORIES[strategicKey];
  if (!factory) {
    const profile = getStrategicAgentBackendProfile(strategicKey);
    throw new Error([
      `Agent backend adapter is not implemented yet: ${strategicKey}`,
      `currentTransport=${profile.currentTransport.join(',') || 'none'}`,
      `preferredTransport=${profile.preferredTransport.join(',') || 'none'}`,
      `statusTransparency=${profile.currentCapabilities.statusTransparency}`,
    ].join('; '));
  }
  return factory();
}

export function normalizeAdapterKey(key: AgentBackendAdapterKey): StrategicAgentBackend {
  if (key === 'openteam_agent') {
    return 'self-hosted-agent';
  }
  if (key === 'claude-code' || key === 'codex') {
    return key;
  }
  if (key === 'gemini' || key === 'self-hosted-agent') {
    return key;
  }
  const strategic = RUNTIME_BACKEND_TO_STRATEGIC[key as BackendType];
  if (strategic) {
    return strategic;
  }
  throw new Error(`Backend is not a strategic agent backend: ${key}`);
}
