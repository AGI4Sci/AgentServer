import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentBackendAdapter,
  hasAgentBackendAdapter,
  listAvailableAgentBackendAdapters,
  normalizeAdapterKey,
} from '../server/runtime/agent-backend-adapter-registry.ts';

test('adapter registry exposes implemented adapters without pretending production completeness', () => {
  const available = listAvailableAgentBackendAdapters();

  assert.deepEqual(available.map((item) => item.id), [
    'codex',
    'claude-code',
    'gemini',
    'self-hosted-agent',
    'hermes-agent',
    'openclaw',
  ]);
  assert.equal(available.find((item) => item.id === 'codex')?.runtimeBackendId, 'codex');
  assert.equal(available.find((item) => item.id === 'codex')?.category, 'strategic');
  assert.equal(available.find((item) => item.id === 'codex')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'claude-code')?.runtimeBackendId, 'claude-code');
  assert.equal(available.find((item) => item.id === 'claude-code')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'gemini')?.runtimeBackendId, undefined);
  assert.equal(available.find((item) => item.id === 'gemini')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'self-hosted-agent')?.runtimeBackendId, 'openteam_agent');
  assert.equal(available.find((item) => item.id === 'self-hosted-agent')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'hermes-agent')?.runtimeBackendId, 'hermes-agent');
  assert.equal(available.find((item) => item.id === 'hermes-agent')?.category, 'ecosystem');
  assert.equal(available.find((item) => item.id === 'openclaw')?.runtimeBackendId, 'openclaw');
  assert.equal(available.find((item) => item.id === 'openclaw')?.category, 'ecosystem');
});

test('adapter registry normalizes strategic and runtime ids', () => {
  assert.equal(normalizeAdapterKey('self-hosted-agent'), 'self-hosted-agent');
  assert.equal(normalizeAdapterKey('openteam_agent'), 'self-hosted-agent');
  assert.equal(normalizeAdapterKey('codex'), 'codex');
  assert.equal(normalizeAdapterKey('claude-code'), 'claude-code');
  assert.equal(normalizeAdapterKey('gemini'), 'gemini');
  assert.equal(normalizeAdapterKey('hermes-agent'), 'hermes-agent');
  assert.equal(normalizeAdapterKey('openclaw'), 'openclaw');
});

test('adapter registry creates only implemented structured adapters', () => {
  assert.equal(hasAgentBackendAdapter('self-hosted-agent'), true);
  assert.equal(hasAgentBackendAdapter('openteam_agent'), true);
  assert.equal(hasAgentBackendAdapter('codex'), true);
  assert.equal(hasAgentBackendAdapter('claude-code'), true);
  assert.equal(hasAgentBackendAdapter('gemini'), true);
  assert.equal(hasAgentBackendAdapter('hermes-agent'), true);
  assert.equal(hasAgentBackendAdapter('openclaw'), true);

  const adapter = createAgentBackendAdapter('openteam_agent');
  assert.equal(adapter.backendId, 'openteam_agent');

  const codexAdapter = createAgentBackendAdapter('codex');
  assert.equal(codexAdapter.backendId, 'codex');

  const claudeCodeAdapter = createAgentBackendAdapter('claude-code');
  assert.equal(claudeCodeAdapter.backendId, 'claude-code');

  const geminiAdapter = createAgentBackendAdapter('gemini');
  assert.equal(geminiAdapter.backendId, 'gemini');

  const hermesAdapter = createAgentBackendAdapter('hermes-agent');
  assert.equal(hermesAdapter.backendId, 'hermes-agent');
  assert.equal(hermesAdapter.tier, 'experimental');

  const openClawAdapter = createAgentBackendAdapter('openclaw');
  assert.equal(openClawAdapter.backendId, 'openclaw');
  assert.equal(openClawAdapter.tier, 'compatibility');
});

test('adapter registry rejects runtime backends that are neither strategic nor ecosystem adapters', () => {
  assert.throws(
    () => normalizeAdapterKey('unknown-backend' as never),
    /Backend is not a strategic agent backend/,
  );
});
