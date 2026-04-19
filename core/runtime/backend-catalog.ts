export const BACKEND_IDS = [
  'openteam_agent',
  'claude-code',
  'codex',
  'hermes-agent',
  'openclaw',
] as const;

export type BackendType = (typeof BACKEND_IDS)[number];

export type BackendTier = 'strategic' | 'experimental' | 'compatibility' | 'legacy';

export type ExecutionBackendKind = 'model_provider' | 'agent_backend';

export const STRATEGIC_AGENT_BACKENDS = [
  'codex',
  'claude-code',
  'gemini',
  'self-hosted-agent',
] as const;

export type StrategicAgentBackend = (typeof STRATEGIC_AGENT_BACKENDS)[number];

export type AgentBackendId = BackendType | StrategicAgentBackend;

export interface BackendCapabilities {
  persistentSession: boolean;
  permissionRequest: boolean;
  interrupt: boolean;
  toolInputStreaming: boolean;
  nativeToolUse: boolean;
  managedLauncher: boolean;
}

export interface BackendDescriptor {
  id: BackendType;
  label: string;
  family: 'openteam' | 'claude-code' | 'codex' | 'hermes' | 'openclaw';
  tier: BackendTier;
  kind: ExecutionBackendKind;
  executables: readonly string[];
  capabilities: BackendCapabilities;
}

export const BACKEND_CATALOG: readonly BackendDescriptor[] = [
  {
    id: 'openteam_agent',
    label: 'OpenTeam Agent',
    family: 'openteam',
    tier: 'strategic',
    kind: 'agent_backend',
    executables: [],
    capabilities: {
      persistentSession: false,
      permissionRequest: false,
      interrupt: false,
      toolInputStreaming: false,
      nativeToolUse: false,
      managedLauncher: false,
    },
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    family: 'claude-code',
    tier: 'strategic',
    kind: 'agent_backend',
    executables: ['openteam_claude_code', 'openteam_claude_code.cmd'],
    capabilities: {
      persistentSession: true,
      permissionRequest: true,
      interrupt: true,
      toolInputStreaming: false,
      nativeToolUse: true,
      managedLauncher: true,
    },
  },
  {
    id: 'codex',
    label: 'Codex',
    family: 'codex',
    tier: 'strategic',
    kind: 'agent_backend',
    executables: ['openteam_codex'],
    capabilities: {
      persistentSession: true,
      permissionRequest: false,
      interrupt: true,
      toolInputStreaming: false,
      nativeToolUse: true,
      managedLauncher: true,
    },
  },
  {
    id: 'hermes-agent',
    label: 'Hermes Agent',
    family: 'hermes',
    tier: 'experimental',
    kind: 'agent_backend',
    executables: ['openteam_hermes_agent', 'openteam_hermes_agent.cmd'],
    capabilities: {
      persistentSession: true,
      permissionRequest: false,
      interrupt: true,
      toolInputStreaming: false,
      nativeToolUse: true,
      managedLauncher: true,
    },
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    family: 'openclaw',
    tier: 'compatibility',
    kind: 'agent_backend',
    executables: ['openteam_openclaw', 'openteam_openclaw.cmd'],
    capabilities: {
      persistentSession: true,
      permissionRequest: false,
      interrupt: true,
      toolInputStreaming: false,
      nativeToolUse: true,
      managedLauncher: true,
    },
  },
] as const;

export const DEFAULT_BACKEND: BackendType = 'codex';

export function isBackendType(value: unknown): value is BackendType {
  return typeof value === 'string' && BACKEND_IDS.includes(value as BackendType);
}

export function listEnabledBackendIds(): readonly BackendType[] {
  const raw = process.env.AGENT_SERVER_ENABLED_BACKENDS?.trim();
  if (!raw) {
    return BACKEND_IDS;
  }
  const enabled = raw
    .split(',')
    .map((item) => item.trim())
    .filter(isBackendType);
  return enabled.length > 0 ? enabled : BACKEND_IDS;
}

export function isBackendEnabled(backend: BackendType): boolean {
  return listEnabledBackendIds().includes(backend);
}

export function listBackendDescriptors(): BackendDescriptor[] {
  const enabled = new Set(listEnabledBackendIds());
  return BACKEND_CATALOG.filter((backend) => enabled.has(backend.id)).map((backend) => ({ ...backend }));
}

export function listStrategicAgentBackends(): readonly StrategicAgentBackend[] {
  return STRATEGIC_AGENT_BACKENDS;
}

export function listRegisteredStrategicBackendIds(): BackendType[] {
  return listBackendDescriptors()
    .filter((backend) => backend.tier === 'strategic')
    .map((backend) => backend.id);
}

export function normalizeBackendType(value: unknown, fallback: BackendType = DEFAULT_BACKEND): BackendType {
  return isBackendType(value) ? value : fallback;
}

export function getBackendDescriptor(backend: BackendType): BackendDescriptor {
  return BACKEND_CATALOG.find((item) => item.id === backend) || BACKEND_CATALOG[0];
}

export function listBackendExecutableNames(backend: BackendType): readonly string[] {
  return getBackendDescriptor(backend).executables;
}

export function getBackendCapabilities(backend: BackendType): BackendCapabilities {
  return getBackendDescriptor(backend).capabilities;
}
