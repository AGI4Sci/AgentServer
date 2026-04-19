import type { RuntimeModelInput } from '../model-spec.js';

export function resolveAdapterLlmEndpointOverride(): RuntimeModelInput['llmEndpoint'] {
  const baseUrl = process.env.AGENT_SERVER_ADAPTER_LLM_BASE_URL?.trim();
  const modelName = process.env.AGENT_SERVER_ADAPTER_LLM_MODEL?.trim();
  const apiKey = process.env.AGENT_SERVER_ADAPTER_LLM_API_KEY?.trim();
  const provider = process.env.AGENT_SERVER_ADAPTER_LLM_PROVIDER?.trim();
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
