import type { LocalDevPolicyHint } from './session-types.js';

export interface RuntimeModelSpec {
  raw: string;
  provider: string | null;
  modelName: string;
}

export interface RuntimeModelInput {
  model?: string | null;
  modelProvider?: string | null;
  modelName?: string | null;
  localDevPolicy?: LocalDevPolicyHint;
}

function trimSegment(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function parseRuntimeModelSpec(model: string | null | undefined): RuntimeModelSpec | null {
  const raw = trimSegment(model);
  if (!raw) {
    return null;
  }

  const slashIndex = raw.indexOf('/');
  const colonIndex = raw.indexOf(':');
  let provider: string | null = null;
  let modelName = raw;

  if (slashIndex > 0) {
    provider = trimSegment(raw.slice(0, slashIndex));
    modelName = raw.slice(slashIndex + 1).trim();
  } else if (colonIndex > 0) {
    provider = trimSegment(raw.slice(0, colonIndex));
    modelName = raw.slice(colonIndex + 1).trim();
  }

  if (!modelName) {
    modelName = raw;
    provider = null;
  }

  return {
    raw,
    provider,
    modelName,
  };
}

export function resolveConfiguredRuntimeModel(input: RuntimeModelInput): RuntimeModelSpec | null {
  const provider = trimSegment(input.modelProvider);
  const modelName = trimSegment(input.modelName);
  if (modelName) {
    return {
      raw: provider ? `${provider}/${modelName}` : modelName,
      provider,
      modelName,
    };
  }
  return parseRuntimeModelSpec(input.model);
}

export function resolveConfiguredRuntimeModelName(input: RuntimeModelInput): string | undefined {
  return resolveConfiguredRuntimeModel(input)?.modelName;
}

export function resolveConfiguredRuntimeModelProvider(input: RuntimeModelInput): string | undefined {
  return resolveConfiguredRuntimeModel(input)?.provider || undefined;
}

export function normalizeRuntimeModelIdentifier(model: string | null | undefined): string | undefined {
  const spec = parseRuntimeModelSpec(model);
  return spec ? spec.raw : undefined;
}

export function resolveRuntimeModelName(model: string | null | undefined): string | undefined {
  const spec = parseRuntimeModelSpec(model);
  return spec?.modelName;
}

export function resolveRuntimeModelProvider(model: string | null | undefined): string | undefined {
  const spec = parseRuntimeModelSpec(model);
  return spec?.provider || undefined;
}

export function buildProviderQualifiedModel(model: string | null | undefined): string | undefined {
  const spec = parseRuntimeModelSpec(model);
  if (!spec) {
    return undefined;
  }
  return spec.provider ? `${spec.provider}/${spec.modelName}` : spec.modelName;
}

export function normalizeConfiguredRuntimeModelIdentifier(input: RuntimeModelInput): string | undefined {
  return resolveConfiguredRuntimeModel(input)?.raw;
}
