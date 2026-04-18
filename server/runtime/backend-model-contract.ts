import type { BackendType } from '../../core/runtime/backend-catalog.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';
import type { RuntimeModelInput } from './model-spec.js';
import {
  buildProviderQualifiedModel,
  normalizeConfiguredRuntimeModelIdentifier,
  resolveConfiguredRuntimeModelName,
  resolveConfiguredRuntimeModelProvider,
} from './model-spec.js';

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
  'claude-code': {
    backend: 'claude-code',
    mode: 'model-name',
    description: 'Consume modelName only and let the backend own provider resolution.',
  },
  'claude-code-rust': {
    backend: 'claude-code-rust',
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
  zeroclaw: {
    backend: 'zeroclaw',
    mode: 'session-explicit',
    description: 'Preserve full identifier and inject explicit provider/modelName into session handshake.',
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
  // Single source of truth: always resolve runtime model from openteam.json (llm).
  // Team/member-level model fields are ignored by design.
  const llmModel = String(loadOpenTeamConfig().llm.model || '').trim();
  const unifiedInput: RuntimeModelInput = llmModel ? { model: llmModel } : input;
  const modelIdentifier = normalizeConfiguredRuntimeModelIdentifier(unifiedInput) || null;
  const modelProvider = resolveConfiguredRuntimeModelProvider(unifiedInput) || null;
  const modelName = resolveConfiguredRuntimeModelName(unifiedInput) || null;

  let runtimeModel: string | null = null;
  if (contract.mode === 'model-name') {
    runtimeModel = modelName;
  } else if (contract.mode === 'provider-qualified') {
    runtimeModel = buildProviderQualifiedModel(modelIdentifier) || modelIdentifier;
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
