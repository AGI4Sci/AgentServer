import assert from 'node:assert/strict';
import test from 'node:test';
import { SupervisorCompatAgentBackendAdapter } from '../server/runtime/adapters/supervisor-compat-agent-adapter.ts';

test('openclaw compatibility adapter exposes the formal agent backend lifecycle', async () => {
  const adapter = new SupervisorCompatAgentBackendAdapter('openclaw');
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'openclaw');
  assert.equal(adapter.kind, 'agent_backend');
  assert.equal(adapter.tier, 'compatibility');
  assert.equal(capabilities.nativeLoop, true);
  assert.equal(capabilities.nativeTools, true);
  assert.equal(capabilities.nativeSandbox, true);
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.statusTransparency, 'partial');

  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-test',
    backend: 'openclaw',
    workspace: '/tmp/agent-server-openclaw-test',
    scope: 'session',
    metadata: { test: true },
  });
  assert.equal(sessionRef.backend, 'openclaw');
  assert.equal(sessionRef.resumable, true);
  assert.equal(sessionRef.metadata?.bridge, 'agent-server-supervisor-compat');

  const idleState = await adapter.readState({ sessionRef });
  assert.equal(idleState.status, 'idle');
  assert.equal(idleState.resumable, true);
  assert.equal(idleState.metadata?.tier, 'compatibility');

  await adapter.abort({ sessionRef, runId: 'run-test', reason: 'unit test' });
  const abortedState = await adapter.readState({ sessionRef });
  assert.equal(abortedState.status, 'failed');
  assert.equal(abortedState.metadata?.abortReason, 'unit test');

  await adapter.dispose({ sessionRef, reason: 'done' });
  await assert.rejects(
    adapter.readState({ sessionRef }),
    /OpenClaw compatibility session is not active/,
  );
});

test('hermes compatibility adapter exposes partial structured state without becoming strategic', async () => {
  const adapter = new SupervisorCompatAgentBackendAdapter('hermes-agent');
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'hermes-agent');
  assert.equal(adapter.kind, 'agent_backend');
  assert.equal(adapter.tier, 'experimental');
  assert.equal(capabilities.nativeLoop, true);
  assert.equal(capabilities.nativeTools, true);
  assert.equal(capabilities.nativeSandbox, false);
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.statusTransparency, 'partial');

  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-test',
    backend: 'hermes-agent',
    workspace: '/tmp/agent-server-hermes-test',
    scope: 'stage',
    metadata: { test: true },
  });
  assert.equal(sessionRef.backend, 'hermes-agent');
  assert.equal(sessionRef.scope, 'stage');

  const idleState = await adapter.readState({ sessionRef });
  assert.equal(idleState.status, 'idle');
  assert.equal(idleState.metadata?.tier, 'experimental');

  await adapter.dispose({ sessionRef, reason: 'done' });
  await assert.rejects(
    adapter.readState({ sessionRef }),
    /Hermes Agent compatibility session is not active/,
  );
});
