import { writeFileSync } from 'fs';
import { join } from 'path';
import { ensureBackendStateDirs, getBackendConfigPath } from '../../../core/runtime/backend-paths.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from '../model-spec.js';
import type { RuntimeModelInput } from '../model-spec.js';
import { listConfiguredLlmEndpoints, loadOpenTeamConfig } from '../../utils/openteam-config.js';

export type RuntimeBackendConnection = {
  model: string | null;
  provider: string | null;
  modelName: string | null;
  baseUrl: string | null;
  apiKey: string | null;
};

function trim(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function escapeToml(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');
}

function resolveFallbackRuntimeModelInput(): RuntimeModelInput {
  const config = loadOpenTeamConfig();
  return {
    model: trim(config.llm.model),
    modelProvider: trim(config.llm.provider),
    modelName: trim(config.llm.model),
  };
}

export function resolveRuntimeBackendConnection(input: RuntimeModelInput): RuntimeBackendConnection {
  return resolveRuntimeBackendConnectionCandidates(input)[0] ?? {
    model: null,
    provider: null,
    modelName: null,
    baseUrl: null,
    apiKey: null,
  };
}

export function resolveRuntimeBackendConnectionCandidates(
  input: RuntimeModelInput,
  override?: Partial<RuntimeBackendConnection> | null,
): RuntimeBackendConnection[] {
  const config = loadOpenTeamConfig();
  const fallbackModelInput = resolveFallbackRuntimeModelInput();
  const explicitRequestedModel = normalizeConfiguredRuntimeModelIdentifier(input) || null;
  const explicitRequestedProvider = resolveConfiguredRuntimeModelProvider(input) || null;
  const explicitRequestedModelName = resolveConfiguredRuntimeModelName(input) || null;
  const defaultRequestedModel = normalizeConfiguredRuntimeModelIdentifier(fallbackModelInput) || null;
  const defaultRequestedProvider = resolveConfiguredRuntimeModelProvider(fallbackModelInput) || null;
  const defaultRequestedModelName = resolveConfiguredRuntimeModelName(fallbackModelInput) || null;
  const candidates: RuntimeBackendConnection[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: RuntimeBackendConnection): void => {
    const key = [
      candidate.baseUrl || '',
      candidate.modelName || '',
      candidate.apiKey || '',
      candidate.provider || '',
    ].join('::');
    if (!candidate.baseUrl || !candidate.modelName || seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  if (input.llmEndpoint?.baseUrl || input.llmEndpoint?.modelName) {
    pushCandidate({
      model: explicitRequestedModel || trim(input.llmEndpoint?.modelName) || defaultRequestedModel,
      provider: explicitRequestedProvider || trim(input.llmEndpoint?.provider) || defaultRequestedProvider,
      modelName: explicitRequestedModelName || trim(input.llmEndpoint?.modelName) || defaultRequestedModelName,
      baseUrl: trim(input.llmEndpoint?.baseUrl),
      apiKey: trim(input.llmEndpoint?.apiKey),
    });
  }

  if (override?.baseUrl || override?.modelName) {
    pushCandidate({
      model: trim(override.model) || explicitRequestedModel || defaultRequestedModel,
      provider: trim(override.provider) || explicitRequestedProvider || defaultRequestedProvider,
      modelName: trim(override.modelName) || explicitRequestedModelName || defaultRequestedModelName,
      baseUrl: trim(override.baseUrl),
      apiKey: trim(override.apiKey),
    });
  }

  for (const endpoint of listConfiguredLlmEndpoints(config)) {
    pushCandidate({
      model: explicitRequestedModel || trim(endpoint.model) || defaultRequestedModel,
      provider: explicitRequestedProvider || trim(endpoint.provider) || defaultRequestedProvider,
      modelName: explicitRequestedModelName || trim(endpoint.model) || defaultRequestedModelName,
      baseUrl: trim(endpoint.baseUrl),
      apiKey: trim(endpoint.apiKey),
    });
  }

  return candidates;
}

function resolveModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/models')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

async function readAvailableModels(response: Response): Promise<string[]> {
  try {
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload?.data)) {
      return [];
    }
    return payload.data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((item): item is string => item.length > 0);
  } catch {
    return [];
  }
}

function resolveModelAvailabilityError(modelName: string | null, availableModels: string[]): string | null {
  if (!availableModels.length) {
    return 'models endpoint returned no available models';
  }
  if (modelName && !availableModels.includes(modelName)) {
    return `configured model "${modelName}" is not present in models list`;
  }
  return null;
}

async function isHealthyRuntimeBackendConnection(
  candidate: RuntimeBackendConnection,
  timeoutMs: number,
): Promise<boolean> {
  if (!candidate.baseUrl?.trim() || !candidate.modelName?.trim()) {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(resolveModelsUrl(candidate.baseUrl), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${candidate.apiKey || ''}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return false;
    }
    const availableModels = await readAvailableModels(response);
    return !resolveModelAvailabilityError(candidate.modelName, availableModels);
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveHealthyRuntimeBackendConnection(
  input: RuntimeModelInput,
  options?: {
    override?: Partial<RuntimeBackendConnection> | null;
    timeoutMs?: number;
  },
): Promise<RuntimeBackendConnection> {
  const candidates = resolveRuntimeBackendConnectionCandidates(input, options?.override);
  const fallback = candidates[0] ?? {
    model: null,
    provider: null,
    modelName: null,
    baseUrl: null,
    apiKey: null,
  };
  const timeoutMs = Math.max(200, options?.timeoutMs ?? 1_500);
  for (const candidate of candidates) {
    if (await isHealthyRuntimeBackendConnection(candidate, timeoutMs)) {
      return candidate;
    }
  }
  return fallback;
}

export function ensureOpenClawRuntimeConfig(params: {
  gatewayPort: number;
  model: RuntimeModelInput;
}): string {
  const connection = resolveRuntimeBackendConnection(params.model);
  const { stateDir } = ensureBackendStateDirs('openclaw');
  const legacyConfigPath = getBackendConfigPath('openclaw');
  const configPath = join(stateDir, 'openclaw.json');
  const providerKey = connection.provider || 'custom';
  const modelName = connection.modelName || 'default-model';
  const providerConfig: Record<string, unknown> = {
    api: 'openai-completions',
    models: [
      {
        id: modelName,
        name: modelName,
        api: 'openai-completions',
      },
    ],
  };

  if (connection.baseUrl) {
    providerConfig.baseUrl = connection.baseUrl;
  }
  if (connection.apiKey) {
    providerConfig.apiKey = connection.apiKey;
  }

  const config = {
    gateway: {
      bind: 'loopback',
      auth: {
        mode: 'none',
      },
      port: params.gatewayPort,
    },
    models: {
      mode: 'replace',
      providers: {
        [providerKey]: providerConfig,
      },
    },
  };

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(configPath, serialized, 'utf-8');
  writeFileSync(legacyConfigPath, serialized, 'utf-8');
  return configPath;
}

export function ensureZeroClawRuntimeConfig(params: {
  stateDir: string;
  gatewayPort: number;
  model: RuntimeModelInput;
}): string {
  const connection = resolveRuntimeBackendConnection(params.model);
  const provider = connection.provider || 'openrouter';
  const resolvedProvider = provider === 'custom' && connection.baseUrl
    ? `custom:${connection.baseUrl}`
    : provider;
  const modelName = connection.modelName || 'default-model';
  const configPath = join(params.stateDir, 'config.toml');
  const lines = [
    connection.apiKey ? `api_key = "${escapeToml(connection.apiKey)}"` : null,
    `default_provider = "${escapeToml(resolvedProvider)}"`,
    `default_model = "${escapeToml(modelName)}"`,
    'default_temperature = 0.2',
    '',
    '[gateway]',
    'host = "127.0.0.1"',
    `port = ${params.gatewayPort}`,
    'require_pairing = false',
    'allow_public_bind = false',
    'session_persistence = true',
    'session_ttl_hours = 0',
    '',
  ].filter((value): value is string => value != null);

  writeFileSync(configPath, `${lines.join('\n')}`, 'utf-8');
  return configPath;
}
