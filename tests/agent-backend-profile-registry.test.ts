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
    assert.ok(profile.modelRuntimeSupport.modelSelection.length > 0, profile.id);
    assert.ok(profile.modelRuntimeSupport.authInputs.length > 0, profile.id);
    assert.ok(profile.modelRuntimeSupport.providerRoutes.length > 0, profile.id);
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
  assert.equal(
    codex.modelRuntimeSupport.providerRoutes.find((route) => route.provider === 'codex-chatgpt')?.route,
    'native',
  );
  assert.equal(
    codex.modelRuntimeSupport.providerRoutes.find((route) => route.provider === 'openai-compatible')?.route,
    'native-custom-provider',
  );
  assert.match(codex.modelRuntimeSupport.modelSelection, /ModelRuntimeConnection/);
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
  assert.equal(
    claudeCode.modelRuntimeSupport.providerRoutes.find((route) => route.provider === 'openai-compatible')?.route,
    'openai-compatible-bridge',
  );
  assert.match(claudeCode.modelRuntimeSupport.modelSelection, /ModelRuntimeConnection/);
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
  assert.equal(
    gemini.modelRuntimeSupport.providerRoutes.find((route) => route.provider === 'gemini')?.route,
    'native',
  );
  assert.equal(
    gemini.modelRuntimeSupport.providerRoutes.find((route) => route.provider === 'openai-compatible')?.route,
    'unsupported',
  );
});

test('self-hosted profile documents the OpenAI-compatible reference harness route', () => {
  const selfHosted = getStrategicAgentBackendProfile('self-hosted-agent');

  assert.equal(selfHosted.runtimeBackendId, 'openteam_agent');
  assert.equal(selfHosted.modelRuntimeSupport.providerRoutes[0]?.provider, 'openai-compatible');
  assert.equal(selfHosted.modelRuntimeSupport.providerRoutes[0]?.route, 'openai-compatible-bridge');
});
