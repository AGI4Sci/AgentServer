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
});
