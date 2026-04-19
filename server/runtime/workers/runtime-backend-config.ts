import { writeFileSync } from 'fs';
import { join } from 'path';
import { ensureBackendStateDirs, getBackendConfigPath } from '../../../core/runtime/backend-paths.js';
import type { RuntimeModelInput } from '../model-spec.js';
import {
  type ModelRuntimeConnection,
  type ModelRuntimeConnectionOverride,
  resolveModelRuntimeConnection,
  resolveModelRuntimeConnectionCandidates,
} from '../model-runtime-resolver.js';

export type RuntimeBackendConnection = ModelRuntimeConnection;

function trim(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function resolveRuntimeBackendConnection(input: RuntimeModelInput): RuntimeBackendConnection {
  return resolveModelRuntimeConnection(input);
}

export function resolveRuntimeBackendConnectionCandidates(
  input: RuntimeModelInput,
  override?: ModelRuntimeConnectionOverride | null,
): RuntimeBackendConnection[] {
  return resolveModelRuntimeConnectionCandidates(input, override);
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
    authType: 'unknown',
    source: 'openteam-config',
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
