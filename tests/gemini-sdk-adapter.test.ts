import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiSdkAgentBackendAdapter } from '../server/runtime/adapters/gemini-sdk-adapter.ts';

test('gemini sdk adapter declares partial structured capabilities', () => {
  const adapter = new GeminiSdkAgentBackendAdapter({
    sdkModule: '@google/gemini-cli-sdk',
  });
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'gemini');
  assert.equal(adapter.kind, 'agent_backend');
  assert.equal(adapter.tier, 'strategic');
  assert.equal(capabilities.nativeLoop, true);
  assert.equal(capabilities.nativeTools, true);
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.abortableRun, true);
  assert.equal(capabilities.statusTransparency, 'partial');
  assert.equal(capabilities.longContext, true);
  assert.equal(capabilities.multimodalInput, true);
  assert.equal(capabilities.contextWindowTelemetry, 'provider-usage');
  assert.equal(capabilities.nativeCompaction, false);
  assert.equal(capabilities.compactionDuringTurn, false);
  assert.equal(capabilities.rateLimitTelemetry, true);
  assert.equal(capabilities.sessionRotationSafe, true);
});

test('gemini sdk adapter marks context compaction as agentserver session-rotate fallback', async () => {
  const adapter = new GeminiSdkAgentBackendAdapter({
    sdkModule: '@google/gemini-cli-sdk',
  });
  const sessionRef = {
    id: 'gemini-sdk:test-session',
    backend: 'gemini' as const,
    scope: 'session' as const,
    resumable: true,
    metadata: { sessionId: 'test-session' },
  };
  (adapter as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionRef.id, {
    sessionRef,
    workspace: '/tmp',
    agent: {},
    session: { id: 'test-session', sendStream: async function* () {} },
    status: 'idle',
    lastEventAt: new Date().toISOString(),
    resumable: true,
    metadata: sessionRef.metadata,
  });

  const state = await adapter.readContextWindowState({ sessionRef, reason: 'contract-smoke' });
  assert.equal(state.backend, 'gemini');
  assert.equal(state.source, 'unknown');
  assert.equal(state.metadata?.fallback, 'agentserver/session-rotate');
  assert.equal(state.metadata?.compactCapability, 'session-rotate');

  const compact = await adapter.compactContext({ sessionRef, reason: 'contract-smoke' });
  assert.equal(compact.status, 'skipped');
  assert.equal(compact.capabilityUsed, 'fallback');
  assert.equal(compact.metadata?.fallback, 'agentserver/session-rotate');
  assert.match(compact.userVisibleSummary || '', /session rotation fallback/);
});
