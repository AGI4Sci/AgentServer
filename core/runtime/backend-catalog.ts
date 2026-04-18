export const BACKEND_IDS = [
  'claude-code',
  'claude-code-rust',
  'codex',
  'hermes-agent',
  'openclaw',
  'zeroclaw',
] as const;

export type BackendType = (typeof BACKEND_IDS)[number];

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
  family: 'claude-code' | 'codex' | 'hermes' | 'openclaw' | 'zeroclaw';
  executables: readonly string[];
  capabilities: BackendCapabilities;
}

export const BACKEND_CATALOG: readonly BackendDescriptor[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    family: 'claude-code',
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
    id: 'claude-code-rust',
    label: 'Claude Code Rust',
    family: 'claude-code',
    executables: ['openteam_claude_code_rust'],
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
    id: 'codex',
    label: 'Codex',
    family: 'codex',
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
  {
    id: 'zeroclaw',
    label: 'ZeroClaw',
    family: 'zeroclaw',
    executables: ['openteam_zeroclaw'],
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

export const DEFAULT_BACKEND: BackendType = 'claude-code';

export function isBackendType(value: unknown): value is BackendType {
  return typeof value === 'string' && BACKEND_IDS.includes(value as BackendType);
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
