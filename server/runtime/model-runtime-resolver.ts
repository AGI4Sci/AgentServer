import { loadOpenTeamConfig, listConfiguredLlmEndpoints } from '../utils/openteam-config.js';
import type { RuntimeModelInput } from './model-spec.js';
import {
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from './model-spec.js';

export type ModelRuntimeAuthType =
  | 'api-key'
  | 'oauth'
  | 'adc'
  | 'service-account'
  | 'chatgpt'
  | 'unknown';

export type ModelRuntimeSource =
  | 'request'
  | 'agent-server-env'
  | 'compat-agent-backend-env'
  | 'override'
  | 'openteam-config';

export type ModelRuntimeConnection = {
  model: string | null;
  provider: string | null;
  modelName: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  authType: ModelRuntimeAuthType;
  source: ModelRuntimeSource;
};

export type ModelRuntimeConnectionOverride = Partial<Omit<ModelRuntimeConnection, 'source' | 'authType'>> & {
  authType?: ModelRuntimeAuthType | string | null;
  source?: ModelRuntimeSource;
};

function trim(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeAuthType(value: string | null | undefined): ModelRuntimeAuthType {
  const normalized = trim(value)?.toLowerCase();
  if (
    normalized === 'api-key'
    || normalized === 'oauth'
    || normalized === 'adc'
    || normalized === 'service-account'
    || normalized === 'chatgpt'
  ) {
    return normalized;
  }
  return 'unknown';
}

function defaultAuthType(params: { apiKey?: string | null; provider?: string | null }): ModelRuntimeAuthType {
  if (params.apiKey) {
    return 'api-key';
  }
  const provider = params.provider?.toLowerCase();
  if (provider === 'vertex' || provider === 'google-vertex' || provider === 'gcp') {
    return 'adc';
  }
  return 'unknown';
}

function resolveFallbackRuntimeModelInput(): RuntimeModelInput {
  const config = loadOpenTeamConfig();
  return {
    model: trim(config.llm.model),
    modelProvider: trim(config.llm.provider),
    modelName: trim(config.llm.model),
  };
}

export function resolveAgentServerModelEnvOverride(env: NodeJS.ProcessEnv = process.env): ModelRuntimeConnectionOverride | null {
  const canonical = {
    model: trim(env.AGENT_SERVER_MODEL),
    provider: trim(env.AGENT_SERVER_MODEL_PROVIDER),
    modelName: trim(env.AGENT_SERVER_MODEL_NAME),
    baseUrl: trim(env.AGENT_SERVER_MODEL_BASE_URL),
    apiKey: trim(env.AGENT_SERVER_MODEL_API_KEY),
    authType: normalizeAuthType(env.AGENT_SERVER_MODEL_AUTH_TYPE),
  };
  if (canonical.model || canonical.provider || canonical.modelName || canonical.baseUrl || canonical.apiKey || canonical.authType !== 'unknown') {
    return {
      ...canonical,
      source: 'agent-server-env',
    };
  }

  const compat = {
    provider: trim(env.AGENT_SERVER_ADAPTER_LLM_PROVIDER),
    modelName: trim(env.AGENT_SERVER_ADAPTER_LLM_MODEL),
    baseUrl: trim(env.AGENT_SERVER_ADAPTER_LLM_BASE_URL),
    apiKey: trim(env.AGENT_SERVER_ADAPTER_LLM_API_KEY),
  };
  if (compat.provider || compat.modelName || compat.baseUrl || compat.apiKey) {
    return {
      ...compat,
      model: compat.provider && compat.modelName ? `${compat.provider}/${compat.modelName}` : compat.modelName,
      authType: defaultAuthType(compat),
      source: 'compat-agent-backend-env',
    };
  }

  return null;
}

export function resolveModelRuntimeConnection(input: RuntimeModelInput): ModelRuntimeConnection {
  return resolveModelRuntimeConnectionCandidates(input)[0] ?? {
    model: null,
    provider: null,
    modelName: null,
    baseUrl: null,
    apiKey: null,
    authType: 'unknown',
    source: 'openteam-config',
  };
}

export function resolveModelRuntimeConnectionCandidates(
  input: RuntimeModelInput,
  override?: ModelRuntimeConnectionOverride | null,
): ModelRuntimeConnection[] {
  const config = loadOpenTeamConfig();
  const fallbackModelInput = resolveFallbackRuntimeModelInput();
  const explicitRequestedModel = normalizeConfiguredRuntimeModelIdentifier(input) || null;
  const explicitRequestedProvider = resolveConfiguredRuntimeModelProvider(input) || null;
  const explicitRequestedModelName = resolveConfiguredRuntimeModelName(input) || null;
  const defaultRequestedModel = normalizeConfiguredRuntimeModelIdentifier(fallbackModelInput) || null;
  const defaultRequestedProvider = resolveConfiguredRuntimeModelProvider(fallbackModelInput) || null;
  const defaultRequestedModelName = resolveConfiguredRuntimeModelName(fallbackModelInput) || null;
  const candidates: ModelRuntimeConnection[] = [];
  const seen = new Set<string>();
  const pushCandidate = (candidate: ModelRuntimeConnection): void => {
    const key = [
      candidate.baseUrl || '',
      candidate.modelName || '',
      candidate.apiKey || '',
      candidate.provider || '',
      candidate.source,
    ].join('::');
    if (!candidate.modelName || seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  if (input.llmEndpoint?.baseUrl || input.llmEndpoint?.modelName || input.llmEndpoint?.provider) {
    const apiKey = trim(input.llmEndpoint?.apiKey);
    const provider = explicitRequestedProvider || trim(input.llmEndpoint?.provider) || defaultRequestedProvider;
    pushCandidate({
      model: explicitRequestedModel || trim(input.llmEndpoint?.modelName) || defaultRequestedModel,
      provider,
      modelName: explicitRequestedModelName || trim(input.llmEndpoint?.modelName) || defaultRequestedModelName,
      baseUrl: trim(input.llmEndpoint?.baseUrl),
      apiKey,
      authType: defaultAuthType({ apiKey, provider }),
      source: 'request',
    });
  }

  const envOverride = resolveAgentServerModelEnvOverride();
  for (const nextOverride of [envOverride, override].filter(Boolean) as ModelRuntimeConnectionOverride[]) {
    const apiKey = trim(nextOverride.apiKey);
    const provider = trim(nextOverride.provider) || explicitRequestedProvider || defaultRequestedProvider;
    const modelName = trim(nextOverride.modelName) || explicitRequestedModelName || resolveConfiguredRuntimeModelName({ model: nextOverride.model }) || defaultRequestedModelName;
    pushCandidate({
      model: trim(nextOverride.model) || (provider && modelName ? `${provider}/${modelName}` : modelName) || explicitRequestedModel || defaultRequestedModel,
      provider,
      modelName,
      baseUrl: trim(nextOverride.baseUrl),
      apiKey,
      authType: normalizeAuthType(String(nextOverride.authType || '')) !== 'unknown'
        ? normalizeAuthType(String(nextOverride.authType))
        : defaultAuthType({ apiKey, provider }),
      source: nextOverride.source || 'override',
    });
  }

  for (const endpoint of listConfiguredLlmEndpoints(config)) {
    const apiKey = trim(endpoint.apiKey);
    const provider = explicitRequestedProvider || trim(endpoint.provider) || defaultRequestedProvider;
    pushCandidate({
      model: explicitRequestedModel || trim(endpoint.model) || defaultRequestedModel,
      provider,
      modelName: explicitRequestedModelName || trim(endpoint.model) || defaultRequestedModelName,
      baseUrl: trim(endpoint.baseUrl),
      apiKey,
      authType: defaultAuthType({ apiKey, provider }),
      source: 'openteam-config',
    });
  }

  return candidates;
}

export function toOpenAICompatibleRuntimeEnv(connection: ModelRuntimeConnection): Record<string, string> {
  const env: Record<string, string> = {};
  if (connection.baseUrl) {
    env.API_BASE_URL = connection.baseUrl;
    env.LLM_BASE_URL = connection.baseUrl;
    env.OPENAI_BASE_URL = connection.baseUrl;
    env.ANTHROPIC_BASE_URL = connection.baseUrl;
    env.CLAUDE_CODE_API_BASE_URL = connection.baseUrl;
  }
  if (connection.apiKey) {
    env.LLM_API_KEY = connection.apiKey;
    env.OPENAI_API_KEY = connection.apiKey;
    env.ANTHROPIC_API_KEY = connection.apiKey;
  }
  if (connection.modelName) {
    env.LLM_MODEL_NAME = connection.modelName;
    env.OPENAI_MODEL = connection.modelName;
    env.OPENTEAM_MODEL = connection.modelName;
  }
  return env;
}
