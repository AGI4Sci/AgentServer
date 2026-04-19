import assert from 'node:assert/strict';
import test from 'node:test';
import { SelfHostedAgentBackendAdapter } from '../server/runtime/adapters/self-hosted-agent-adapter.ts';

test('self-hosted adapter exposes formal adapter capabilities and readable state', async () => {
  const adapter = new SelfHostedAgentBackendAdapter();
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'openteam_agent');
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.statusTransparency, 'partial');

  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-test',
    backend: 'openteam_agent',
    workspace: '/tmp/agent-server-self-hosted-test',
    scope: 'session',
    metadata: { test: true },
  });
  assert.equal(sessionRef.backend, 'openteam_agent');
  assert.equal(sessionRef.resumable, true);

  const idleState = await adapter.readState({ sessionRef });
  assert.equal(idleState.status, 'idle');
  assert.equal(idleState.resumable, true);
  assert.deepEqual(idleState.metadata, { test: true });

  await adapter.abort({
    sessionRef,
    runId: 'run-test',
    reason: 'unit test',
  });
  const abortedState = await adapter.readState({ sessionRef });
  assert.equal(abortedState.status, 'failed');
  assert.equal(abortedState.metadata?.abortReason, 'unit test');

  await adapter.dispose({ sessionRef, reason: 'done' });
  await assert.rejects(
    adapter.readState({ sessionRef }),
    /Self-hosted agent session is not active/,
  );
});
