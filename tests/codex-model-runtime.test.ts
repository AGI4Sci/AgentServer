import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCodexRuntimeModelSelection } from '../server/runtime/codex-model-runtime.ts';

test('request llmEndpoint overrides AGENT_SERVER_CODEX_MODEL for Codex custom provider', () => {
  const selection = resolveCodexRuntimeModelSelection({
    explicitCodexModel: 'gpt-5.4-codex',
    input: {
      modelName: 'qwen/qwen3.6-plus',
    },
    connection: {
      model: 'qwen/qwen3.6-plus',
      provider: 'openrouter',
      modelName: 'qwen/qwen3.6-plus',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'request-key',
      authType: 'api-key',
      source: 'request',
    },
  });

  assert.equal(selection.route, 'custom-provider');
  assert.equal(selection.model, 'qwen/qwen3.6-plus');
  assert.notEqual(selection.model, 'gpt-5.4-codex');
});
