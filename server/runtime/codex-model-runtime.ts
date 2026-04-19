import { getCodexAdapterBaseUrl } from '../runtime-supervisor/codex-chat-responses-adapter.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';
import type { ModelRuntimeConnection } from './model-runtime-resolver.js';
import {
  resolveRuntimeModelName,
} from './model-spec.js';

export interface CodexRuntimeModelInput {
  model?: string | null;
  modelName?: string | null;
}

export interface CodexRuntimeModelSelection {
  model: string | null;
  modelProvider: string | null;
  configArgs: string[];
  route: 'native' | 'custom-provider' | 'default-native';
}

function trim(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

export function isCodexNativeProvider(provider: string | null | undefined): boolean {
  const normalized = trim(provider)?.toLowerCase();
  return !normalized
    || normalized === 'codex'
    || normalized === 'openai'
    || normalized === 'chatgpt'
    || normalized === 'codex-chatgpt';
}

export function shouldUseCodexCustomProvider(connection: Pick<ModelRuntimeConnection, 'baseUrl'>): boolean {
  if (!trim(connection.baseUrl)) {
    return false;
  }
  if (process.env.OPENTEAM_CODEX_FORCE_OPENAI_PROVIDER === '1') {
    return false;
  }
  return true;
}

export function buildCodexCustomProviderConfigArgs(
  connection: Pick<ModelRuntimeConnection, 'baseUrl'>,
): { configArgs: string[]; modelProvider: string | null } {
  if (!shouldUseCodexCustomProvider(connection)) {
    return {
      configArgs: [],
      modelProvider: null,
    };
  }

  const providerId = loadOpenTeamConfig().runtime.codex.providerId.trim() || 'openteam_local';
  const escapedBaseUrl = escapeTomlBasicString(getCodexAdapterBaseUrl());
  return {
    configArgs: [
      '--config',
      `model_provider="${providerId}"`,
      '--config',
      `model_providers.${providerId}={name="AgentServer OpenAI-Compatible Bridge",base_url="${escapedBaseUrl}",wire_api="responses",supports_websockets=false}`,
    ],
    modelProvider: providerId,
  };
}

export function resolveCodexRuntimeModelSelection(params: {
  input?: CodexRuntimeModelInput | null;
  connection: ModelRuntimeConnection;
  explicitCodexModel?: string | null;
}): CodexRuntimeModelSelection {
  const explicitCodexModel = trim(params.explicitCodexModel);
  const inputModelName = trim(params.input?.modelName);
  const inputRuntimeModelName = resolveRuntimeModelName(params.input?.model);

  if (explicitCodexModel) {
    return {
      model: explicitCodexModel,
      modelProvider: isCodexNativeProvider(params.connection.provider) ? params.connection.provider || null : null,
      configArgs: [],
      route: 'native',
    };
  }

  const customProvider = buildCodexCustomProviderConfigArgs(params.connection);

  if (customProvider.modelProvider) {
    return {
      model: inputModelName || inputRuntimeModelName || trim(params.connection.modelName),
      modelProvider: customProvider.modelProvider,
      configArgs: customProvider.configArgs,
      route: 'custom-provider',
    };
  }

  if (isCodexNativeProvider(params.connection.provider)) {
    return {
      model: inputModelName || inputRuntimeModelName || trim(params.connection.modelName),
      modelProvider: params.connection.provider || null,
      configArgs: [],
      route: 'native',
    };
  }

  return {
    model: null,
    modelProvider: null,
    configArgs: [],
    route: 'default-native',
  };
}
