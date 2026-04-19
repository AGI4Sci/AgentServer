import type { BackendType } from '../../core/runtime/backend-catalog.js';
import type { RuntimeModelInput } from './model-spec.js';
import { resolveModelRuntimeConnection } from './model-runtime-resolver.js';

export type BackendModelContractMode =
  | 'model-name'
  | 'provider-qualified'
  | 'normalized-identifier'
  | 'session-explicit';

export interface BackendModelContract {
  backend: BackendType;
  mode: BackendModelContractMode;
  description: string;
}

export interface BackendModelSelection {
  backend: BackendType;
  mode: BackendModelContractMode;
  modelIdentifier: string | null;
  modelProvider: string | null;
  modelName: string | null;
  runtimeModel: string | null;
}

const BACKEND_MODEL_CONTRACTS: Record<BackendType, BackendModelContract> = {
  'openteam_agent': {
    backend: 'openteam_agent',
    mode: 'model-name',
    description: 'Consume modelName through AI SDK OpenAI-compatible provider and keep harness policy inside the backend.',
  },
  'claude-code': {
    backend: 'claude-code',
    mode: 'model-name',
    description: 'Consume modelName only and let the backend own provider resolution.',
  },
  codex: {
    backend: 'codex',
    mode: 'model-name',
    description: 'Consume modelName only and let the backend own provider resolution.',
  },
  'hermes-agent': {
    backend: 'hermes-agent',
    mode: 'provider-qualified',
    description: 'Consume provider/modelName when available; Hermes keeps its own provider and memory strategy internally.',
  },
  openclaw: {
    backend: 'openclaw',
    mode: 'provider-qualified',
    description: 'Consume provider/modelName when available.',
  },
};

export function getBackendModelContract(backend: BackendType): BackendModelContract {
  return BACKEND_MODEL_CONTRACTS[backend];
}

export function listBackendModelContracts(): BackendModelContract[] {
  return Object.values(BACKEND_MODEL_CONTRACTS);
}

export function resolveBackendModelSelection(
  backend: BackendType,
  input: RuntimeModelInput,
): BackendModelSelection {
  const contract = getBackendModelContract(backend);
  const connection = resolveModelRuntimeConnection(input);
  const modelIdentifier = connection.model;
  const modelProvider = connection.provider;
  const modelName = connection.modelName;

  let runtimeModel: string | null = null;
  if (contract.mode === 'model-name') {
    runtimeModel = modelName;
  } else if (contract.mode === 'provider-qualified') {
    runtimeModel = modelProvider && modelName ? `${modelProvider}/${modelName}` : modelIdentifier;
  } else if (contract.mode === 'normalized-identifier' || contract.mode === 'session-explicit') {
    runtimeModel = modelIdentifier;
  }

  return {
    backend,
    mode: contract.mode,
    modelIdentifier,
    modelProvider,
    modelName,
    runtimeModel,
  };
}
