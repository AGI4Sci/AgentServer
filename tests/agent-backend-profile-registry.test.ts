import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getStrategicAgentBackendProfile,
  isProductionCompleteAgentBackend,
  listStrategicAgentBackendProfiles,
} from '../server/runtime/agent-backend-profile-registry.ts';

test('strategic agent backend profiles cover the long-term backend set', () => {
  assert.deepEqual(
    listStrategicAgentBackendProfiles().map((profile) => profile.id),
    ['codex', 'claude-code', 'gemini', 'self-hosted-agent'],
  );
});

test('current strategic profiles do not overstate production completeness', () => {
  for (const profile of listStrategicAgentBackendProfiles()) {
    assert.equal(isProductionCompleteAgentBackend(profile), false, profile.id);
    assert.equal(profile.upstreamSourcePolicy, 'isolated', profile.id);
    assert.match(profile.upstreamOverrideDoc, /^docs\/upstream-backend-overrides\.md/);
  }
});

test('codex profile prefers structured transport over cli bridge', () => {
  const codex = getStrategicAgentBackendProfile('codex');

  assert.deepEqual(codex.currentTransport, ['app_server']);
  assert.ok(codex.preferredTransport.includes('app_server'));
  assert.ok(codex.preferredTransport.includes('sdk'));
  assert.equal(codex.currentCapabilities.statusTransparency, 'full');
  assert.equal(codex.currentCapabilities.readableState, true);
  assert.equal(codex.targetCapabilities.statusTransparency, 'full');
  assert.equal(codex.targetCapabilities.readableState, true);
});

test('claude code profile is a partial bridge prototype with structured events', () => {
  const claudeCode = getStrategicAgentBackendProfile('claude-code');

  assert.equal(claudeCode.implementationStatus, 'prototype');
  assert.equal(claudeCode.runtimeBackendId, 'claude-code');
  assert.deepEqual(claudeCode.currentTransport, ['schema_bridge', 'cli_bridge']);
  assert.equal(claudeCode.currentCapabilities.nativeLoop, true);
  assert.equal(claudeCode.currentCapabilities.structuredEvents, true);
  assert.equal(claudeCode.currentCapabilities.readableState, true);
  assert.equal(claudeCode.currentCapabilities.abortableRun, false);
  assert.equal(claudeCode.currentCapabilities.statusTransparency, 'partial');
  assert.equal(claudeCode.targetCapabilities.statusTransparency, 'full');
});

test('gemini profile uses sdk prototype and targets long-context multimodal capability', () => {
  const gemini = getStrategicAgentBackendProfile('gemini');

  assert.equal(gemini.implementationStatus, 'prototype');
  assert.equal(gemini.runtimeBackendId, undefined);
  assert.deepEqual(gemini.currentTransport, ['sdk']);
  assert.equal(gemini.currentCapabilities.statusTransparency, 'partial');
  assert.equal(gemini.currentCapabilities.longContext, true);
  assert.equal(gemini.currentCapabilities.multimodalInput, true);
  assert.equal(gemini.targetCapabilities.longContext, true);
  assert.equal(gemini.targetCapabilities.multimodalInput, true);
});
