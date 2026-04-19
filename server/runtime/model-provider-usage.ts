import type { SessionUsage } from './session-types.js';

export interface ModelProviderUsageMetadata {
  provider?: string | null;
  model?: string | null;
}

export function normalizeModelProviderUsage(
  raw: unknown,
  metadata: ModelProviderUsageMetadata = {},
): SessionUsage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const value = raw as Record<string, unknown>;
  const input = readNumber(
    value.input
      ?? value.inputTokens
      ?? value.input_tokens
      ?? value.promptTokens
      ?? value.prompt_tokens,
  );
  const output = readNumber(
    value.output
      ?? value.outputTokens
      ?? value.output_tokens
      ?? value.completionTokens
      ?? value.completion_tokens,
  );
  const cacheRead = readNumber(
    value.cacheRead
      ?? value.cachedTokens
      ?? value.cachedInputTokens
      ?? value.cached_input_tokens
      ?? value.cache_read_input_tokens,
  );
  const cacheWrite = readNumber(
    value.cacheWrite
      ?? value.cacheCreationInputTokens
      ?? value.cache_creation_input_tokens,
  );
  const total = readNumber(
    value.total
      ?? value.totalTokens
      ?? value.total_tokens,
  ) || input + output + cacheRead + cacheWrite;
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0 && total <= 0) {
    return undefined;
  }
  const provider = metadata.provider?.trim();
  const model = metadata.model?.trim();
  return {
    input,
    output,
    total,
    cacheRead: cacheRead || undefined,
    cacheWrite: cacheWrite || undefined,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    source: 'model-provider',
  };
}

export function mergeModelProviderUsage(usages: Array<SessionUsage | undefined>): SessionUsage | undefined {
  const available = usages.filter((usage): usage is SessionUsage => Boolean(usage));
  if (available.length === 0) {
    return undefined;
  }
  const merged = available.reduce<SessionUsage>((acc, usage) => ({
    input: acc.input + usage.input,
    output: acc.output + usage.output,
    total: (acc.total ?? acc.input + acc.output) + (usage.total ?? usage.input + usage.output),
    cacheRead: (acc.cacheRead ?? 0) + (usage.cacheRead ?? 0) || undefined,
    cacheWrite: (acc.cacheWrite ?? 0) + (usage.cacheWrite ?? 0) || undefined,
    provider: acc.provider === usage.provider ? acc.provider : acc.provider || usage.provider,
    model: acc.model === usage.model ? acc.model : acc.model || usage.model,
    source: 'model-provider',
  }), {
    input: 0,
    output: 0,
    total: 0,
    source: 'model-provider',
  });
  return {
    ...merged,
    cacheRead: merged.cacheRead || undefined,
    cacheWrite: merged.cacheWrite || undefined,
  };
}

function readNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
