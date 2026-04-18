import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from './paths.js';

export interface OpenTeamConfig {
  server: {
    port: number;
    cleanupAgentInstancesOnShutdown: boolean;
  };
  llm: {
    baseUrl: string;
    apiKey: string;
    model: string;
    provider: string | null;
    fallbacks?: OpenTeamLlmEndpointConfig[];
  };
  runtime: {
    supervisor: {
      port: number;
      snapshotFlushMs: number;
    };
    blackboard: {
      leaseDurationMs: number;
      leaseSweepIntervalMs: number;
    };
    worker: {
      idleTtlMs: number;
      idleSweepMs: number;
      gatewayStartTimeoutMs: number;
      runStallTimeoutMs: number;
    };
    executor: {
      reportGraceMs: number;
      exposeRuntimeToolCalls: boolean;
      deliveryTimeoutMs: number;
      toolDeliveryTimeoutMs: number;
      coordinatorDecomposeStallTimeoutMs: number;
    };
    localDev: {
      toolMaxSteps: number;
      sourceTaskToolMaxSteps: number;
      sourceTaskLocalExplorationSoftLimit: number;
      forceSummaryOnBudgetExhausted: boolean;
      sourceTaskForceSummaryOnBudgetExhausted: boolean;
    };
    ws: {
      deliveryContextTtlMs: number;
    };
    harness: {
      abandonmentMs: number;
      sweepIntervalMs: number;
    };
    workspace: {
      leaseHeartbeatIntervalMs: number;
    };
    openclaw: {
      gatewayBasePort: number;
    };
    zeroclaw: {
      gatewayBasePort: number;
    };
    codex: {
      responseStoreLimit: number;
      providerId: string;
      launchHealthcheckTimeoutMs: number;
      responsesBaseUrl: string | null;
    };
  };
  retrieval: {
    coordinator: {
      maxAttemptsPerRequest: number;
      limit: number;
    };
    compressPolicy: {
      enabled: boolean;
      minHitCount: number;
      minTotalSnippetChars: number;
      minDistinctSources: number;
      minQueryTokenCountForAmbiguousQuery: number;
      maxSpecificEntitySignalsForAmbiguousQuery: number;
    };
    ranking: {
      maxEntitiesPerBlock: number;
      summaryMaxChars: number;
      entityMatchShortCircuitScore: number;
      fulltextShortCircuitMinScore: number;
      fulltextShortCircuitMinHits: number;
      rerankPoolMultiplier: number;
      rerankPoolMinLimit: number;
      finalScoreThresholdBase: number;
      finalScoreThresholdPerToken: number;
    };
  };
  integrations: {
    scpHub: {
      baseUrl: string;
      apiKey: string;
    };
    toolEndpoints: OpenTeamToolEndpointConfig[];
  };
}

export interface OpenTeamLlmEndpointConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string | null;
  label?: string;
}

export interface OpenTeamToolEndpointConfig {
  id: string;
  name?: string;
  kind: string;
  transport: string;
  location?: 'local' | 'lan' | 'remote' | 'cloud' | 'lab';
  networkMode?: string;
  capabilities?: string[];
  permissions?: string[];
  enabled?: boolean;
  source?: string;
  provider?: string;
  tags?: string[];
  diagnostics?: string;
  config?: Record<string, unknown>;
  workspace?: {
    root?: string;
    read?: boolean;
    write?: boolean;
    shell?: boolean;
    git?: boolean;
  };
  safety?: {
    riskLevel?: 'low' | 'medium' | 'high' | 'critical';
    riskClasses?: string[];
    requiresApprovalFor?: string[];
    allowedCommands?: string[];
    deniedCommands?: string[];
    allowedRoots?: string[];
  };
  evidence?: {
    recordCommands?: boolean;
    recordFiles?: boolean;
    recordTelemetry?: boolean;
    recordArtifacts?: boolean;
  };
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

export const OPENTEAM_CONFIG_PATH = process.env.OPENTEAM_CONFIG_PATH?.trim() || join(PROJECT_ROOT, 'openteam.json');

const DEFAULT_OPENTEAM_CONFIG: OpenTeamConfig = {
  server: {
    port: 3456,
    cleanupAgentInstancesOnShutdown: false,
  },
  llm: {
    baseUrl: 'http://127.0.0.1:18000/v1',
    apiKey: 'EMPTY',
    model: 'glm-5-fp8',
    provider: null,
    fallbacks: [],
  },
  runtime: {
    supervisor: {
      port: 8766,
      snapshotFlushMs: 10_000,
    },
    blackboard: {
      leaseDurationMs: 5 * 60_000,
      leaseSweepIntervalMs: 30_000,
    },
    worker: {
      idleTtlMs: 15 * 60_000,
      idleSweepMs: 60_000,
      gatewayStartTimeoutMs: 120_000,
      runStallTimeoutMs: 120_000,
    },
    executor: {
      reportGraceMs: 3 * 60_000,
      exposeRuntimeToolCalls: false,
      deliveryTimeoutMs: 90_000,
      toolDeliveryTimeoutMs: 4 * 60_000,
      coordinatorDecomposeStallTimeoutMs: 45_000,
    },
    localDev: {
      toolMaxSteps: 20,
      sourceTaskToolMaxSteps: 32,
      sourceTaskLocalExplorationSoftLimit: 6,
      forceSummaryOnBudgetExhausted: true,
      sourceTaskForceSummaryOnBudgetExhausted: true,
    },
    ws: {
      deliveryContextTtlMs: 5 * 60_000,
    },
    harness: {
      abandonmentMs: 3 * 60_000,
      sweepIntervalMs: 30_000,
    },
    workspace: {
      leaseHeartbeatIntervalMs: 60_000,
    },
    openclaw: {
      gatewayBasePort: 18_789,
    },
    zeroclaw: {
      gatewayBasePort: 42_617,
    },
    codex: {
      responseStoreLimit: 256,
      providerId: 'openteam_local',
      launchHealthcheckTimeoutMs: 20_000,
      responsesBaseUrl: null,
    },
  },
  retrieval: {
    coordinator: {
      maxAttemptsPerRequest: 1,
      limit: 5,
    },
    compressPolicy: {
      enabled: true,
      minHitCount: 4,
      minTotalSnippetChars: 1_800,
      minDistinctSources: 2,
      minQueryTokenCountForAmbiguousQuery: 4,
      maxSpecificEntitySignalsForAmbiguousQuery: 1,
    },
    ranking: {
      maxEntitiesPerBlock: 32,
      summaryMaxChars: 280,
      entityMatchShortCircuitScore: 8,
      fulltextShortCircuitMinScore: 6,
      fulltextShortCircuitMinHits: 3,
      rerankPoolMultiplier: 2,
      rerankPoolMinLimit: 8,
      finalScoreThresholdBase: 6,
      finalScoreThresholdPerToken: 2,
    },
  },
  integrations: {
    scpHub: {
      baseUrl: 'https://scphub.intern-ai.org.cn',
      apiKey: '',
    },
    toolEndpoints: [],
  },
};

function cloneDefaultConfig(): OpenTeamConfig {
  return JSON.parse(JSON.stringify(DEFAULT_OPENTEAM_CONFIG)) as OpenTeamConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!override) {
    return base;
  }
  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    const current = next[key];
    if (isRecord(current) && isRecord(value)) {
      next[key] = deepMerge({ ...current }, value);
      continue;
    }
    next[key] = value;
  }
  return next;
}

function normalizeConfig(raw: unknown): OpenTeamConfig {
  if (!isRecord(raw)) {
    throw new Error(`openteam.json must contain a JSON object: ${OPENTEAM_CONFIG_PATH}`);
  }
  const normalized = deepMerge(
    cloneDefaultConfig() as unknown as Record<string, unknown>,
    raw as Record<string, unknown>,
  ) as unknown as OpenTeamConfig;
  const llmFallbacks = normalizeLlmFallbacks(normalized.llm.fallbacks);
  normalized.llm = {
    ...normalizeLlmEndpointConfig(normalized.llm),
    fallbacks: llmFallbacks,
  };
  normalized.integrations.toolEndpoints = normalizeToolEndpoints(normalized.integrations.toolEndpoints);
  return normalized;
}

function normalizeLlmEndpointConfig(
  input: Partial<OpenTeamLlmEndpointConfig> | null | undefined,
): OpenTeamLlmEndpointConfig {
  return {
    baseUrl: String(input?.baseUrl || '').trim(),
    apiKey: String(input?.apiKey || '').trim(),
    model: String(input?.model || '').trim(),
    provider: typeof input?.provider === 'string' && input.provider.trim()
      ? input.provider.trim()
      : null,
    ...(typeof input?.label === 'string' && input.label.trim()
      ? { label: input.label.trim() }
      : {}),
  };
}

function normalizeLlmFallbacks(input: unknown): OpenTeamLlmEndpointConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((entry) => (isRecord(entry) ? normalizeLlmEndpointConfig(entry) : null))
    .filter((entry): entry is OpenTeamLlmEndpointConfig => {
      return Boolean(entry?.baseUrl && entry.model);
    });
}

function normalizeToolEndpoints(input: unknown): OpenTeamToolEndpointConfig[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const endpoints: OpenTeamToolEndpointConfig[] = [];
  for (const entry of input) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = String(entry.id || '').trim();
    const kind = String(entry.kind || '').trim();
    const transport = String(entry.transport || '').trim();
    if (!id || !kind || !transport) {
      continue;
    }
    endpoints.push({
        id,
        kind,
        transport,
        ...(typeof entry.name === 'string' && entry.name.trim() ? { name: entry.name.trim() } : {}),
        ...(typeof entry.location === 'string' ? { location: entry.location as OpenTeamToolEndpointConfig['location'] } : {}),
        ...(typeof entry.networkMode === 'string' && entry.networkMode.trim() ? { networkMode: entry.networkMode.trim() } : {}),
        ...(Array.isArray(entry.capabilities) ? { capabilities: entry.capabilities.map((item) => String(item || '').trim()).filter(Boolean) } : {}),
        ...(Array.isArray(entry.permissions) ? { permissions: entry.permissions.map((item) => String(item || '').trim()).filter(Boolean) } : {}),
        ...(typeof entry.enabled === 'boolean' ? { enabled: entry.enabled } : {}),
        ...(typeof entry.source === 'string' && entry.source.trim() ? { source: entry.source.trim() } : {}),
        ...(typeof entry.provider === 'string' && entry.provider.trim() ? { provider: entry.provider.trim() } : {}),
        ...(Array.isArray(entry.tags) ? { tags: entry.tags.map((item) => String(item || '').trim()).filter(Boolean) } : {}),
        ...(typeof entry.diagnostics === 'string' && entry.diagnostics.trim() ? { diagnostics: entry.diagnostics.trim() } : {}),
        ...(isRecord(entry.config) ? { config: entry.config } : {}),
        ...(isRecord(entry.workspace) ? { workspace: entry.workspace as OpenTeamToolEndpointConfig['workspace'] } : {}),
        ...(isRecord(entry.safety) ? { safety: entry.safety as OpenTeamToolEndpointConfig['safety'] } : {}),
        ...(isRecord(entry.evidence) ? { evidence: entry.evidence as OpenTeamToolEndpointConfig['evidence'] } : {}),
    });
  }
  return endpoints;
}

export function loadOpenTeamConfig(): OpenTeamConfig {
  if (!existsSync(OPENTEAM_CONFIG_PATH)) {
    throw new Error(`openteam.json not found: ${OPENTEAM_CONFIG_PATH}`);
  }
  const raw = JSON.parse(readFileSync(OPENTEAM_CONFIG_PATH, 'utf-8')) as unknown;
  const normalized = normalizeConfig(raw);
  const exposeRuntimeToolCallsOverride = process.env.OPENTEAM_EXPOSE_RUNTIME_TOOL_CALLS?.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(exposeRuntimeToolCallsOverride || '')) {
    normalized.runtime.executor.exposeRuntimeToolCalls = true;
  } else if (['0', 'false', 'no', 'off'].includes(exposeRuntimeToolCallsOverride || '')) {
    normalized.runtime.executor.exposeRuntimeToolCalls = false;
  }
  return normalized;
}

export function applyOpenTeamConfigEnv(options?: { overwrite?: boolean }): OpenTeamConfig {
  const config = loadOpenTeamConfig();
  const overwrite = options?.overwrite === true;
  const mappings: Array<[string, string | null | undefined]> = [
    ['MODEL_BACKEND_BASE_URL', config.llm.baseUrl],
    ['MODEL_BACKEND_API_KEY', config.llm.apiKey],
    ['MODEL_BACKEND_MODEL', config.llm.model],
    ['OPENAI_BASE_URL', config.llm.baseUrl],
    ['OPENAI_API_KEY', config.llm.apiKey],
    ['OPENAI_MODEL', config.llm.model],
    ['LLM_BASE_URL', config.llm.baseUrl],
    ['LLM_API_KEY', config.llm.apiKey],
    ['LLM_MODEL_NAME', config.llm.model],
    ['CODEX_API_KEY', config.llm.apiKey],
    ['API_BASE_URL', config.llm.baseUrl],
    ['ANTHROPIC_BASE_URL', config.llm.baseUrl],
    ['CLAUDE_CODE_API_BASE_URL', config.llm.baseUrl],
    ['ANTHROPIC_API_KEY', config.llm.apiKey],
    ['OPENTEAM_MODEL', config.llm.model],
  ];

  for (const [name, value] of mappings) {
    if (value == null || value === '') {
      continue;
    }
    if (!overwrite && process.env[name]?.trim()) {
      continue;
    }
    process.env[name] = value;
  }

  return config;
}

export function getPrimaryLlmEndpoint(config?: OpenTeamConfig): OpenTeamLlmEndpointConfig {
  const resolved = config ?? loadOpenTeamConfig();
  return normalizeLlmEndpointConfig(resolved.llm);
}

export function listConfiguredLlmEndpoints(config?: OpenTeamConfig): OpenTeamLlmEndpointConfig[] {
  const resolved = config ?? loadOpenTeamConfig();
  return [
    getPrimaryLlmEndpoint(resolved),
    ...normalizeLlmFallbacks(resolved.llm.fallbacks),
  ];
}

export function resolveConfiguredServerPort(): number {
  const envPort = Number.parseInt(
    process.env.OPENTEAM_SERVER_PORT?.trim() || process.env.PORT?.trim() || '',
    10,
  );
  if (Number.isFinite(envPort) && envPort > 0) {
    return envPort;
  }

  try {
    const port = Number.parseInt(`${loadOpenTeamConfig().server.port}`, 10);
    if (Number.isFinite(port) && port > 0) {
      return port;
    }
  } catch {
    // Fall back to env/default when config is unavailable.
  }

  return DEFAULT_OPENTEAM_CONFIG.server.port;
}

export function saveOpenTeamConfig(config: OpenTeamConfig): OpenTeamConfig {
  const normalized = normalizeConfig(config);
  writeFileSync(OPENTEAM_CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  return normalized;
}

export function updateOpenTeamConfig(
  updater: (config: OpenTeamConfig) => OpenTeamConfig,
): OpenTeamConfig {
  return saveOpenTeamConfig(updater(loadOpenTeamConfig()));
}
