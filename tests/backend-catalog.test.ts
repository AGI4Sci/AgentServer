import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BACKEND,
  getBackendDescriptor,
  listRegisteredStrategicBackendIds,
  listStrategicAgentBackends,
} from '../core/runtime/backend-catalog.ts';

test('default backend is Codex', () => {
  assert.equal(DEFAULT_BACKEND, 'codex');
});

test('backend catalog distinguishes strategic roadmap from registered runtime backends', () => {
  assert.deepEqual(listStrategicAgentBackends(), [
    'codex',
    'claude-code',
    'gemini',
    'self-hosted-agent',
  ]);

  assert.deepEqual(listRegisteredStrategicBackendIds(), [
    'openteam_agent',
    'claude-code',
    'codex',
  ]);
});

test('backend descriptors expose tier and execution kind', () => {
  assert.equal(getBackendDescriptor('codex').tier, 'strategic');
  assert.equal(getBackendDescriptor('codex').kind, 'agent_backend');
  assert.equal(getBackendDescriptor('hermes-agent').tier, 'experimental');
  assert.equal(getBackendDescriptor('openclaw').tier, 'compatibility');
});
