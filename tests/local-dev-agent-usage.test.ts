import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runLocalDevToolAgentWithRequester } from '../server/runtime/shared/local-dev-agent.ts';

test('local dev tool agent sums provider usage without counting tool output as LLM output', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-server-local-dev-usage-'));
  await writeFile(join(workspace, 'README.md'), '# usage smoke\n', 'utf8');

  const completions = [
    {
      text: '<tool name="list_dir"><path>.</path></tool>',
      usage: {
        input: 10,
        output: 2,
        total: 12,
        provider: 'test-provider',
        model: 'test-model',
        source: 'model-provider' as const,
      },
    },
    {
      text: 'I saw README.md.',
      usage: {
        input: 30,
        output: 4,
        total: 34,
        provider: 'test-provider',
        model: 'test-model',
        source: 'model-provider' as const,
      },
    },
  ];

  const result = await runLocalDevToolAgentWithRequester({
    modelLabel: 'usage-test-model',
    prompt: 'List the workspace and summarize it.',
    cwd: workspace,
    maxSteps: 3,
    requestTextCompletion: async () => {
      const next = completions.shift();
      if (!next) throw new Error('unexpected extra LLM call');
      return next;
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.usage?.input, 40);
  assert.equal(result.usage?.output, 6);
  assert.equal(result.usage?.total, 46);
  assert.equal(result.usage?.source, 'model-provider');
});
