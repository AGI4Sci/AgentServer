import type {
  BackendType,
  StrategicAgentBackend,
} from '../../core/runtime/backend-catalog.js';
import type { AgentBackendCapabilities } from './agent-backend-adapter-contract.js';

export type AgentBackendImplementationStatus =
  | 'planned'
  | 'prototype'
  | 'available';

export type AgentBackendTransportKind =
  | 'app_server'
  | 'sdk'
  | 'json_rpc'
  | 'stdio_rpc'
  | 'http_stream'
  | 'websocket_stream'
  | 'local_runtime_api'
  | 'schema_bridge'
  | 'direct_harness'
  | 'cli_bridge';

export interface StrategicAgentBackendProfile {
  id: StrategicAgentBackend;
  runtimeBackendId?: BackendType;
  label: string;
  implementationStatus: AgentBackendImplementationStatus;
  currentTransport: AgentBackendTransportKind[];
  preferredTransport: AgentBackendTransportKind[];
  fallbackTransport: AgentBackendTransportKind[];
  currentCapabilities: AgentBackendCapabilities;
  targetCapabilities: AgentBackendCapabilities;
  upstreamSourcePolicy: 'isolated' | 'patch-required';
  upstreamOverrideDoc: string;
  notes: string[];
}

const NO_CAPABILITIES: AgentBackendCapabilities = {
  nativeLoop: false,
  nativeTools: false,
  nativeSandbox: false,
  nativeApproval: false,
  nativeSession: false,
  fileEditing: false,
  streamingEvents: false,
  structuredEvents: false,
  readableState: false,
  abortableRun: false,
  resumableSession: false,
  statusTransparency: 'opaque',
};

const FULL_CODE_AGENT_TARGET: AgentBackendCapabilities = {
  nativeLoop: true,
  nativeTools: true,
  nativeSandbox: true,
  nativeApproval: true,
  nativeSession: true,
  fileEditing: true,
  streamingEvents: true,
  structuredEvents: true,
  readableState: true,
  abortableRun: true,
  resumableSession: true,
  statusTransparency: 'full',
};

const PARTIAL_LEGACY_LAUNCHER: AgentBackendCapabilities = {
  nativeLoop: true,
  nativeTools: true,
  nativeSandbox: true,
  nativeApproval: false,
  nativeSession: true,
  fileEditing: true,
  streamingEvents: true,
  structuredEvents: false,
  readableState: false,
  abortableRun: false,
  resumableSession: true,
  statusTransparency: 'partial',
};

const SELF_HOSTED_TARGET: AgentBackendCapabilities = {
  ...FULL_CODE_AGENT_TARGET,
  nativeApproval: true,
  nativeSandbox: true,
};

export const STRATEGIC_AGENT_BACKEND_PROFILES: readonly StrategicAgentBackendProfile[] = [
  {
    id: 'codex',
    runtimeBackendId: 'codex',
    label: 'Codex',
    implementationStatus: 'prototype',
    currentTransport: ['app_server'],
    preferredTransport: ['app_server', 'sdk', 'json_rpc', 'websocket_stream'],
    fallbackTransport: ['cli_bridge'],
    currentCapabilities: FULL_CODE_AGENT_TARGET,
    targetCapabilities: FULL_CODE_AGENT_TARGET,
    upstreamSourcePolicy: 'isolated',
    upstreamOverrideDoc: 'docs/upstream-backend-overrides.md#codex',
    notes: [
      'AgentServer has a Codex app-server JSON-RPC adapter prototype.',
      'Production completeness remains false until the adapter is promoted from prototype to available after live smoke.',
    ],
  },
  {
    id: 'claude-code',
    runtimeBackendId: 'claude-code',
    label: 'Claude Code',
    implementationStatus: 'prototype',
    currentTransport: ['schema_bridge', 'cli_bridge'],
    preferredTransport: ['sdk', 'json_rpc', 'stdio_rpc', 'schema_bridge'],
    fallbackTransport: ['cli_bridge'],
    currentCapabilities: {
      ...PARTIAL_LEGACY_LAUNCHER,
      nativeApproval: true,
      structuredEvents: true,
      readableState: true,
    },
    targetCapabilities: FULL_CODE_AGENT_TARGET,
    upstreamSourcePolicy: 'isolated',
    upstreamOverrideDoc: 'docs/upstream-backend-overrides.md#claude-code',
    notes: [
      'AgentServer has a Claude Code bridge adapter prototype over the existing supervisor normalized event stream.',
      'Current path remains partial because abort/resume and complete native state are not yet exposed as a first-class SDK/RPC boundary.',
      'Claude Code remains preferred for implementation and coherent multi-file edits.',
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    implementationStatus: 'prototype',
    currentTransport: ['sdk'],
    preferredTransport: ['sdk', 'app_server', 'http_stream', 'websocket_stream', 'schema_bridge'],
    fallbackTransport: ['cli_bridge'],
    currentCapabilities: {
      nativeLoop: true,
      nativeTools: true,
      nativeSandbox: true,
      nativeApproval: false,
      nativeSession: true,
      fileEditing: true,
      streamingEvents: true,
      structuredEvents: true,
      readableState: true,
      abortableRun: true,
      resumableSession: true,
      statusTransparency: 'partial',
      multimodalInput: true,
      longContext: true,
    },
    targetCapabilities: {
      ...FULL_CODE_AGENT_TARGET,
      multimodalInput: true,
      longContext: true,
    },
    upstreamSourcePolicy: 'isolated',
    upstreamOverrideDoc: 'docs/upstream-backend-overrides.md#gemini',
    notes: [
      'AgentServer has a Gemini CLI SDK adapter prototype.',
      'The SDK path covers core loop, tool execution, and session context, while advanced hooks/subagents/ACP remain capability gaps.',
    ],
  },
  {
    id: 'self-hosted-agent',
    runtimeBackendId: 'openteam_agent',
    label: 'Self-hosted Agent',
    implementationStatus: 'prototype',
    currentTransport: ['direct_harness'],
    preferredTransport: ['direct_harness', 'local_runtime_api', 'schema_bridge'],
    fallbackTransport: [],
    currentCapabilities: {
      ...NO_CAPABILITIES,
      streamingEvents: true,
      structuredEvents: true,
      readableState: true,
      statusTransparency: 'partial',
    },
    targetCapabilities: SELF_HOSTED_TARGET,
    upstreamSourcePolicy: 'isolated',
    upstreamOverrideDoc: 'docs/upstream-backend-overrides.md',
    notes: [
      'Self-hosted agent is the white-box reference path for context/tool/orchestration experiments.',
      'It should become the reference implementation for the formal status-transparent adapter contract.',
    ],
  },
] as const;

export function listStrategicAgentBackendProfiles(): StrategicAgentBackendProfile[] {
  return STRATEGIC_AGENT_BACKEND_PROFILES.map((profile) => ({
    ...profile,
    currentTransport: [...profile.currentTransport],
    preferredTransport: [...profile.preferredTransport],
    fallbackTransport: [...profile.fallbackTransport],
    currentCapabilities: { ...profile.currentCapabilities },
    targetCapabilities: { ...profile.targetCapabilities },
    notes: [...profile.notes],
  }));
}

export function getStrategicAgentBackendProfile(
  backend: StrategicAgentBackend,
): StrategicAgentBackendProfile {
  const profile = STRATEGIC_AGENT_BACKEND_PROFILES.find((item) => item.id === backend);
  if (!profile) {
    throw new Error(`Unknown strategic agent backend: ${backend}`);
  }
  return listStrategicAgentBackendProfiles().find((item) => item.id === backend) || profile;
}

export function isProductionCompleteAgentBackend(profile: StrategicAgentBackendProfile): boolean {
  const capabilities = profile.currentCapabilities;
  return profile.implementationStatus === 'available'
    && capabilities.nativeLoop
    && capabilities.nativeTools
    && capabilities.nativeSandbox
    && capabilities.nativeSession
    && capabilities.fileEditing
    && capabilities.streamingEvents
    && capabilities.structuredEvents
    && capabilities.readableState
    && capabilities.abortableRun
    && capabilities.resumableSession
    && capabilities.statusTransparency === 'full'
    && profile.upstreamSourcePolicy === 'isolated';
}
