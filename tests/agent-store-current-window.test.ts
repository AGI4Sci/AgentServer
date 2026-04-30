import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('AgentStore keeps turns as cold ledger and bounds current work with recoverable refs', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agentserver-current-window-'));
  process.env.AGENT_SERVER_DATA_DIR = dataRoot;
  process.env.AGENT_SERVER_CURRENT_WORK_TURN_LIMIT = '5';
  process.env.AGENT_SERVER_CURRENT_WORK_CONTENT_LIMIT = '120';
  process.env.AGENT_SERVER_TURN_LOG_CONTENT_LIMIT = '240';

  const { AgentStore } = await import('../server/agent_server/store.ts');
  const store = new AgentStore();
  const agentId = `agent-current-window-${Date.now()}`;
  const sessionId = 'session-current-window';

  for (let index = 1; index <= 30; index += 1) {
    await store.appendTurn(agentId, sessionId, {
      kind: 'turn',
      turnId: `turn-${index}`,
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `turn ${index} ${'large-content '.repeat(10_000)}`,
      createdAt: new Date(2026, 3, 28, 0, index).toISOString(),
      turnNumber: index,
    });
  }

  const turns = await store.listTurns(agentId, sessionId);
  const current = await store.listCurrentWork(agentId, sessionId);
  const currentTurns = current.filter((entry) => entry.kind === 'turn');
  const partialTags = current.filter((entry) => entry.kind === 'partial_compaction');

  assert.equal(turns.length, 30);
  assert.ok(turns.every((turn) => turn.contentOmitted === true));
  assert.ok(turns.every((turn) => typeof turn.contentRef === 'string' && turn.contentRef.includes('artifacts/turn-content/')));
  assert.ok(currentTurns.length <= 24);
  assert.ok(partialTags.length >= 1);
  assert.match(String(partialTags.at(-1)?.archived), /work\/log\/turns\.jsonl @turn_/);

  const firstRef = turns[0]?.contentRef;
  assert.ok(firstRef);
  assert.equal(existsSync(join(dataRoot, 'agents', agentId, 'sessions', sessionId, firstRef)), true);
});
