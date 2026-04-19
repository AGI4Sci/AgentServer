import assert from 'node:assert/strict';
import test from 'node:test';
import { ClaudeCodeBridgeAgentBackendAdapter } from '../server/runtime/adapters/claude-code-bridge-adapter.ts';

test('claude code bridge adapter exposes partial structured backend capabilities', async () => {
  const adapter = new ClaudeCodeBridgeAgentBackendAdapter();
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'claude-code');
  assert.equal(adapter.kind, 'agent_backend');
  assert.equal(adapter.tier, 'strategic');
  assert.equal(capabilities.nativeLoop, true);
  assert.equal(capabilities.nativeTools, true);
  assert.equal(capabilities.nativeSandbox, true);
  assert.equal(capabilities.nativeApproval, true);
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.abortableRun, false);
  assert.equal(capabilities.statusTransparency, 'partial');
});

test('claude code bridge adapter manages readable session lifecycle', async () => {
  const adapter = new ClaudeCodeBridgeAgentBackendAdapter();
  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-test',
    backend: 'claude-code',
    workspace: '/tmp/agent-server-claude-code-test',
    scope: 'session',
    metadata: { test: true },
  });

  assert.equal(sessionRef.backend, 'claude-code');
  assert.equal(sessionRef.resumable, true);
  assert.equal(sessionRef.metadata?.bridge, 'agent-server-supervisor');

  const idleState = await adapter.readState({ sessionRef });
  assert.equal(idleState.status, 'idle');
  assert.equal(idleState.resumable, true);
  assert.deepEqual(idleState.metadata, {
    test: true,
    bridge: 'agent-server-supervisor',
  });

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
    /Claude Code bridge session is not active/,
  );
});
