import type { RuntimeModelInput } from '../model-spec.js';
import { resolveAgentServerModelEnvOverride } from '../model-runtime-resolver.js';

export function resolveAdapterLlmEndpointOverride(): RuntimeModelInput['llmEndpoint'] {
  const override = resolveAgentServerModelEnvOverride();
  const baseUrl = override?.baseUrl?.trim();
  const modelName = override?.modelName?.trim();
  const apiKey = override?.apiKey?.trim();
  const provider = override?.provider?.trim();
  if (!baseUrl && !modelName && !apiKey && !provider) {
    return null;
  }
  return {
    baseUrl,
    modelName,
    apiKey,
    provider,
  };
}
