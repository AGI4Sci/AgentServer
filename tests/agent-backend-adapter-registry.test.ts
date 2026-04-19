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

  assert.deepEqual(available.map((item) => item.id), ['codex', 'claude-code', 'gemini', 'self-hosted-agent']);
  assert.equal(available.find((item) => item.id === 'codex')?.runtimeBackendId, 'codex');
  assert.equal(available.find((item) => item.id === 'codex')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'claude-code')?.runtimeBackendId, 'claude-code');
  assert.equal(available.find((item) => item.id === 'claude-code')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'gemini')?.runtimeBackendId, undefined);
  assert.equal(available.find((item) => item.id === 'gemini')?.productionComplete, false);
  assert.equal(available.find((item) => item.id === 'self-hosted-agent')?.runtimeBackendId, 'openteam_agent');
  assert.equal(available.find((item) => item.id === 'self-hosted-agent')?.productionComplete, false);
});

test('adapter registry normalizes strategic and runtime ids', () => {
  assert.equal(normalizeAdapterKey('self-hosted-agent'), 'self-hosted-agent');
  assert.equal(normalizeAdapterKey('openteam_agent'), 'self-hosted-agent');
  assert.equal(normalizeAdapterKey('codex'), 'codex');
  assert.equal(normalizeAdapterKey('claude-code'), 'claude-code');
  assert.equal(normalizeAdapterKey('gemini'), 'gemini');
});

test('adapter registry creates only implemented structured adapters', () => {
  assert.equal(hasAgentBackendAdapter('self-hosted-agent'), true);
  assert.equal(hasAgentBackendAdapter('openteam_agent'), true);
  assert.equal(hasAgentBackendAdapter('codex'), true);
  assert.equal(hasAgentBackendAdapter('claude-code'), true);
  assert.equal(hasAgentBackendAdapter('gemini'), true);

  const adapter = createAgentBackendAdapter('openteam_agent');
  assert.equal(adapter.backendId, 'openteam_agent');

  const codexAdapter = createAgentBackendAdapter('codex');
  assert.equal(codexAdapter.backendId, 'codex');

  const claudeCodeAdapter = createAgentBackendAdapter('claude-code');
  assert.equal(claudeCodeAdapter.backendId, 'claude-code');

  const geminiAdapter = createAgentBackendAdapter('gemini');
  assert.equal(geminiAdapter.backendId, 'gemini');
});

test('adapter registry rejects non-strategic runtime backends', () => {
  assert.throws(
    () => normalizeAdapterKey('hermes-agent'),
    /Backend is not a strategic agent backend/,
  );
});
