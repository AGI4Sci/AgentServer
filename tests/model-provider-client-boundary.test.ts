import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const LLM_CALL_SITES = [
  'server/runtime/workers/openai-compatible-stream.ts',
  'server/runtime/shared/local-dev-agent.ts',
  'server/runtime/shared/openteam-agent-local-dev-agent.ts',
  'server/runtime-supervisor/codex-chat-responses-adapter.ts',
] as const;

test('AgentServer LLM call sites use the shared model provider client', async () => {
  for (const file of LLM_CALL_SITES) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} should not call fetch directly for LLM requests`);
    assert.doesNotMatch(source, /\/chat\/completions/, `${file} should not build chat.completions URLs directly`);
  }
});
