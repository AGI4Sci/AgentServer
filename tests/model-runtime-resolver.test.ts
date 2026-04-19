import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveAgentServerModelEnvOverride,
  resolveModelRuntimeConnection,
  resolveModelRuntimeConnectionCandidates,
  toOpenAICompatibleRuntimeEnv,
} from '../server/runtime/model-runtime-resolver.js';

const MODEL_ENV_KEYS = [
  'AGENT_SERVER_MODEL',
  'AGENT_SERVER_MODEL_PROVIDER',
  'AGENT_SERVER_MODEL_NAME',
  'AGENT_SERVER_MODEL_BASE_URL',
  'AGENT_SERVER_MODEL_API_KEY',
  'AGENT_SERVER_MODEL_AUTH_TYPE',
  'AGENT_SERVER_ADAPTER_LLM_PROVIDER',
  'AGENT_SERVER_ADAPTER_LLM_MODEL',
  'AGENT_SERVER_ADAPTER_LLM_BASE_URL',
  'AGENT_SERVER_ADAPTER_LLM_API_KEY',
] as const;

function withModelEnv(values: Partial<Record<typeof MODEL_ENV_KEYS[number], string>>, fn: () => void): void {
  const snapshot = new Map<string, string | undefined>();
  for (const key of MODEL_ENV_KEYS) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('canonical AgentServer model env is the preferred runtime override', () => {
  withModelEnv({
    AGENT_SERVER_MODEL_PROVIDER: 'openai-compatible',
    AGENT_SERVER_MODEL_NAME: 'agent-server-model',
    AGENT_SERVER_MODEL_BASE_URL: 'http://127.0.0.1:3888/v1',
    AGENT_SERVER_MODEL_API_KEY: 'secret',
    AGENT_SERVER_MODEL_AUTH_TYPE: 'api-key',
    AGENT_SERVER_ADAPTER_LLM_MODEL: 'legacy-model',
  }, () => {
    const override = resolveAgentServerModelEnvOverride();
    assert.equal(override?.source, 'agent-server-env');
    assert.equal(override?.modelName, 'agent-server-model');

    const connection = resolveModelRuntimeConnection({});
    assert.equal(connection.source, 'agent-server-env');
    assert.equal(connection.provider, 'openai-compatible');
    assert.equal(connection.modelName, 'agent-server-model');
    assert.equal(connection.baseUrl, 'http://127.0.0.1:3888/v1');
    assert.equal(connection.authType, 'api-key');
  });
});

test('legacy adapter LLM env remains a compatibility runtime override', () => {
  withModelEnv({
    AGENT_SERVER_ADAPTER_LLM_PROVIDER: 'openai-compatible',
    AGENT_SERVER_ADAPTER_LLM_MODEL: 'legacy-model',
    AGENT_SERVER_ADAPTER_LLM_BASE_URL: 'http://127.0.0.1:3999/v1',
    AGENT_SERVER_ADAPTER_LLM_API_KEY: 'legacy-secret',
  }, () => {
    const connection = resolveModelRuntimeConnection({});
    assert.equal(connection.source, 'compat-agent-backend-env');
    assert.equal(connection.provider, 'openai-compatible');
    assert.equal(connection.modelName, 'legacy-model');
    assert.equal(connection.model, 'openai-compatible/legacy-model');
    assert.equal(connection.authType, 'api-key');
  });
});

test('request llmEndpoint wins before env and openteam config candidates', () => {
  withModelEnv({
    AGENT_SERVER_MODEL_NAME: 'env-model',
    AGENT_SERVER_MODEL_BASE_URL: 'http://127.0.0.1:3888/v1',
  }, () => {
    const candidates = resolveModelRuntimeConnectionCandidates({
      modelProvider: 'request-provider',
      modelName: 'request-model',
      llmEndpoint: {
        baseUrl: 'http://127.0.0.1:4000/v1',
        apiKey: 'request-key',
        modelName: 'endpoint-model',
      },
    });
    assert.equal(candidates[0]?.source, 'request');
    assert.equal(candidates[0]?.provider, 'request-provider');
    assert.equal(candidates[0]?.modelName, 'request-model');
    assert.equal(candidates[0]?.baseUrl, 'http://127.0.0.1:4000/v1');
    assert.equal(candidates[1]?.source, 'agent-server-env');
  });
});

test('OpenAI-compatible env mapper writes all bridge aliases from one connection', () => {
  const env = toOpenAICompatibleRuntimeEnv({
    model: 'openai-compatible/agent-server-model',
    provider: 'openai-compatible',
    modelName: 'agent-server-model',
    baseUrl: 'http://127.0.0.1:3888/v1',
    apiKey: 'secret',
    authType: 'api-key',
    source: 'agent-server-env',
  });

  assert.equal(env.API_BASE_URL, 'http://127.0.0.1:3888/v1');
  assert.equal(env.OPENAI_BASE_URL, 'http://127.0.0.1:3888/v1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3888/v1');
  assert.equal(env.OPENAI_API_KEY, 'secret');
  assert.equal(env.ANTHROPIC_API_KEY, 'secret');
  assert.equal(env.OPENTEAM_MODEL, 'agent-server-model');
});
