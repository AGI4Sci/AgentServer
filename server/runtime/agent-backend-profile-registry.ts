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

export type AgentBackendProviderRoute =
  | 'native'
  | 'native-custom-provider'
  | 'openai-compatible-bridge'
  | 'unsupported'
  | 'pending';

export interface AgentBackendProviderRuntimeRoute {
  provider: string;
  route: AgentBackendProviderRoute;
  reason: string;
}

export interface AgentBackendModelRuntimeSupport {
  modelSelection: string;
  authInputs: string[];
  providerRoutes: AgentBackendProviderRuntimeRoute[];
  notes: string[];
}

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
  modelRuntimeSupport: AgentBackendModelRuntimeSupport;
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
    modelRuntimeSupport: {
      modelSelection: 'Codex app-server model selected by explicit adapter option, AGENT_SERVER_CODEX_MODEL, or ModelRuntimeConnection. Explicit Codex model keeps the upstream native route; OpenAI-compatible/custom endpoints with baseUrl use a Codex custom model provider backed by AgentServer responses bridge, so model/provider choice is not limited to official Codex account models.',
      authInputs: ['CODEX_HOME auth/config', 'ChatGPT account auth', 'OpenAI auth supported by upstream Codex when configured', 'AGENT_SERVER_MODEL_* / openteam.json OpenAI-compatible endpoint for custom provider route'],
      providerRoutes: [
        {
          provider: 'codex-chatgpt',
          route: 'native',
          reason: 'Primary app-server route; preserves Codex native thread, approval, sandbox, and structured events.',
        },
        {
          provider: 'openai',
          route: 'native',
          reason: 'Allowed when upstream Codex account/config exposes the model through its native provider path.',
        },
        {
          provider: 'openai-compatible',
          route: 'native-custom-provider',
          reason: 'When a baseUrl is available, AgentServer registers a Codex custom model provider that targets the responses bridge, preserving Codex app-server loop, native tools, approvals, sandbox, sessions, and structured events.',
        },
      ],
      notes: [
        'Model selection is resolved through ModelRuntimeConnection. Non-native provider/model input without an executable baseUrl is accepted by AgentServer but is not forced into the Codex native account path.',
      ],
    },
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
    modelRuntimeSupport: {
      modelSelection: 'ModelRuntimeConnection.modelName/baseUrl/apiKey are passed into the Claude Code bridge and OpenAI-compatible env aliases, allowing non-official provider/model choices while keeping native tools first.',
      authInputs: ['AGENT_SERVER_MODEL_*', 'legacy AGENT_SERVER_ADAPTER_LLM_* compatibility env', 'openteam.json llm endpoints'],
      providerRoutes: [
        {
          provider: 'openai-compatible',
          route: 'openai-compatible-bridge',
          reason: 'Current AgentServer bridge path is wired to an OpenAI-compatible endpoint while preserving native-tool-first behavior and normalized fallback tool/status events.',
        },
        {
          provider: 'anthropic',
          route: 'pending',
          reason: 'Target native provider route should be exposed through an SDK/RPC boundary rather than a separate opaque CLI path.',
        },
      ],
      notes: [
        'Provider/model input is centralized through ModelRuntimeConnection; unsupported providers must fail or remain pending instead of silently inventing a second env/config chain.',
      ],
    },
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
    modelRuntimeSupport: {
      modelSelection: 'Gemini SDK receives AGENT_SERVER_GEMINI_MODEL, explicit adapter option model, or a ModelRuntimeConnection modelName only for Gemini-native providers.',
      authInputs: ['AGENT_SERVER_GEMINI_API_KEY', 'AGENT_SERVER_GOOGLE_API_KEY', 'AGENT_SERVER_GOOGLE_APPLICATION_CREDENTIALS', 'AGENT_SERVER_GEMINI_CLI_HOME', 'official Gemini/Google env and oauth file'],
      providerRoutes: [
        {
          provider: 'gemini',
          route: 'native',
          reason: 'Native Gemini SDK route preserves long-context/multimodal/session behavior.',
        },
        {
          provider: 'google',
          route: 'native',
          reason: 'Mapped to the same Gemini/Google auth and SDK path.',
        },
        {
          provider: 'vertex',
          route: 'native',
          reason: 'Supported through Google ADC/service-account style auth inputs when configured.',
        },
        {
          provider: 'openai-compatible',
          route: 'unsupported',
          reason: 'OpenAI-compatible model names are intentionally not passed into Gemini SDK; use a bridge backend instead.',
        },
      ],
      notes: [
        'Gemini remains blocked for live readiness until a real Gemini/Google credential is present on this machine.',
      ],
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
    modelRuntimeSupport: {
      modelSelection: 'ModelRuntimeConnection.modelName/baseUrl/apiKey are injected into the self-hosted OpenAI-compatible harness.',
      authInputs: ['AGENT_SERVER_MODEL_*', 'legacy AGENT_SERVER_ADAPTER_LLM_* compatibility env', 'openteam.json llm endpoints'],
      providerRoutes: [
        {
          provider: 'openai-compatible',
          route: 'openai-compatible-bridge',
          reason: 'White-box harness currently consumes AgentServer-managed OpenAI-compatible runtime configuration.',
        },
        {
          provider: 'custom',
          route: 'openai-compatible-bridge',
          reason: 'Custom endpoints are valid when they expose the OpenAI-compatible surface expected by the harness.',
        },
      ],
      notes: [
        'Self-hosted agent is the reference harness for context/tool/orchestration policy rather than a black-box native provider.',
      ],
    },
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
    modelRuntimeSupport: {
      ...profile.modelRuntimeSupport,
      authInputs: [...profile.modelRuntimeSupport.authInputs],
      providerRoutes: profile.modelRuntimeSupport.providerRoutes.map((route) => ({ ...route })),
      notes: [...profile.modelRuntimeSupport.notes],
    },
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
