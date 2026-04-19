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
import { SupervisorCompatAgentBackendAdapter } from './adapters/supervisor-compat-agent-adapter.js';

export type AgentBackendAdapterKey = StrategicAgentBackend | BackendType;

export interface AvailableAgentBackendAdapter {
  id: AgentBackendAdapterKey;
  runtimeBackendId?: BackendType;
  profile?: StrategicAgentBackendProfile;
  category: 'strategic' | 'ecosystem';
  productionComplete: boolean;
}

type AgentBackendAdapterFactory = () => AgentBackendAdapter;

const AGENT_BACKEND_ADAPTER_FACTORIES: Partial<Record<StrategicAgentBackend, AgentBackendAdapterFactory>> = {
  codex: () => new CodexAppServerAgentBackendAdapter(),
  'claude-code': () => new ClaudeCodeBridgeAgentBackendAdapter(),
  gemini: () => new GeminiSdkAgentBackendAdapter(),
  'self-hosted-agent': () => new SelfHostedAgentBackendAdapter(),
};

const ECOSYSTEM_BACKEND_ADAPTER_FACTORIES: Partial<Record<BackendType, AgentBackendAdapterFactory>> = {
  'hermes-agent': () => new SupervisorCompatAgentBackendAdapter('hermes-agent'),
  openclaw: () => new SupervisorCompatAgentBackendAdapter('openclaw'),
};

const RUNTIME_BACKEND_TO_STRATEGIC: Partial<Record<BackendType, StrategicAgentBackend>> = {
  openteam_agent: 'self-hosted-agent',
  'claude-code': 'claude-code',
  codex: 'codex',
};

export function listAvailableAgentBackendAdapters(): AvailableAgentBackendAdapter[] {
  const strategic = listStrategicAgentBackendProfiles()
    .filter((profile) => Boolean(AGENT_BACKEND_ADAPTER_FACTORIES[profile.id]))
    .map((profile) => ({
      id: profile.id,
      runtimeBackendId: profile.runtimeBackendId,
      profile,
      category: 'strategic' as const,
      productionComplete: isProductionCompleteAgentBackend(profile),
    }));
  const ecosystem = (Object.keys(ECOSYSTEM_BACKEND_ADAPTER_FACTORIES) as BackendType[]).map((id) => ({
    id,
    runtimeBackendId: id,
    category: 'ecosystem' as const,
    productionComplete: false,
  }));
  return [...strategic, ...ecosystem];
}

export function hasAgentBackendAdapter(key: AgentBackendAdapterKey): boolean {
  const normalized = normalizeAdapterKey(key);
  if (isEcosystemBackend(normalized)) {
    return Boolean(ECOSYSTEM_BACKEND_ADAPTER_FACTORIES[normalized]);
  }
  if (!isStrategicBackend(normalized)) {
    return false;
  }
  return Boolean(AGENT_BACKEND_ADAPTER_FACTORIES[normalized]);
}

export function createAgentBackendAdapter(key: AgentBackendAdapterKey): AgentBackendAdapter {
  const strategicKey = normalizeAdapterKey(key);
  if (isEcosystemBackend(strategicKey)) {
    const factory = ECOSYSTEM_BACKEND_ADAPTER_FACTORIES[strategicKey];
    if (!factory) {
      throw new Error(`Agent backend adapter is not implemented yet: ${strategicKey}`);
    }
    return factory();
  }
  if (!isStrategicBackend(strategicKey)) {
    throw new Error(`Backend is not a strategic agent backend: ${strategicKey}`);
  }
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

export function normalizeAdapterKey(key: AgentBackendAdapterKey): AgentBackendAdapterKey {
  if (key === 'openteam_agent') {
    return 'self-hosted-agent';
  }
  if (key === 'claude-code' || key === 'codex') {
    return key;
  }
  if (key === 'gemini' || key === 'self-hosted-agent') {
    return key;
  }
  if (key === 'hermes-agent' || key === 'openclaw') {
    return key;
  }
  const strategic = RUNTIME_BACKEND_TO_STRATEGIC[key as BackendType];
  if (strategic) {
    return strategic;
  }
  throw new Error(`Backend is not a strategic agent backend: ${key}`);
}

function isEcosystemBackend(key: AgentBackendAdapterKey): key is Extract<BackendType, 'hermes-agent' | 'openclaw'> {
  return key === 'hermes-agent' || key === 'openclaw';
}

function isStrategicBackend(key: AgentBackendAdapterKey): key is StrategicAgentBackend {
  return key === 'codex'
    || key === 'claude-code'
    || key === 'gemini'
    || key === 'self-hosted-agent';
}
