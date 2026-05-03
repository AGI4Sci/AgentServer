import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('run preflight compacts large current work before backend dispatch', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agentserver-preflight-compact-'));
  process.env.AGENT_SERVER_DATA_DIR = dataRoot;
  const { AgentServerService } = await import('../server/agent_server/service.ts');
  const { AgentStore } = await import('../server/agent_server/store.ts');

  const store = new AgentStore();
  const service = new AgentServerService(store);
  const workspace = await mkdtemp(join(tmpdir(), 'agentserver-preflight-workspace-'));
  const agent = await service.createAgent({
    id: `agent-preflight-compact-${Date.now()}`,
    backend: 'codex',
    workingDirectory: workspace,
  });
  await seedLargeCurrentWork(store, agent.id, agent.activeSessionId);

  let dispatched = false;
  (service as unknown as {
    runSingleStageBackendTurn: AgentServerService['runSingleStageBackendTurn'];
  }).runSingleStageBackendTurn = async () => {
    dispatched = true;
    return {
      output: { success: true, result: 'dispatch-ok' },
      executionPath: 'legacy_supervisor',
    };
  };

  const streamed: unknown[] = [];
  const run = await service.sendMessage(agent.id, {
    message: 'continue with current work',
    contextPolicy: {
      includeCurrentWork: true,
      includeRecentTurns: false,
      includePersistent: false,
      includeMemory: false,
    },
  }, {
    onEvent: (event) => streamed.push(event),
  });

  assert.equal(dispatched, true);
  assert.equal(run.status, 'completed');
  const eventTypes = run.events.map((event) => event.type);
  assert.ok(eventTypes.indexOf('contextWindowState') >= 0, 'preflight should emit contextWindowState');
  assert.ok(eventTypes.indexOf('contextCompaction') >= 0, 'preflight should emit contextCompaction');
  assert.ok(eventTypes.indexOf('contextCompaction') < eventTypes.indexOf('stage-start'), 'compaction should happen before dispatch');
  const compactionEvent = run.events.find((event) => event.type === 'contextCompaction');
  assert.equal(compactionEvent?.contextCompaction.status, 'compacted');
  assert.ok(run.contextRefs?.some((ref) => ref.kind === 'context-compaction'));
  assert.equal(typeof run.metadata?.agentServerPreflight, 'object');
  assert.ok(streamed.some((event) => isRecord(event) && event.type === 'contextCompaction'));
});

test('compact failure slims current work and continues with recovery diagnostics', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agentserver-preflight-compact-failure-'));
  process.env.AGENT_SERVER_DATA_DIR = dataRoot;
  const { AgentServerService } = await import('../server/agent_server/service.ts');
  const { AgentStore } = await import('../server/agent_server/store.ts');

  const store = new AgentStore();
  const service = new AgentServerService(store);
  const workspace = await mkdtemp(join(tmpdir(), 'agentserver-preflight-failure-workspace-'));
  const agent = await service.createAgent({
    id: `agent-preflight-compact-failure-${Date.now()}`,
    backend: 'codex',
    workingDirectory: workspace,
  });
  await seedLargeCurrentWork(store, agent.id, agent.activeSessionId, 'FAILURE-CURRENT-WORK-MARKER');

  let compactCalls = 0;
  (service as unknown as {
    compactSessionWork: () => Promise<null>;
  }).compactSessionWork = async () => {
    compactCalls += 1;
    if (compactCalls === 1) {
      throw new Error('mock compact failed');
    }
    return null;
  };
  let dispatchedContext = '';
  (service as unknown as {
    runSingleStageBackendTurn: AgentServerService['runSingleStageBackendTurn'];
  }).runSingleStageBackendTurn = async (input) => {
    dispatchedContext = input.executionContext;
    return {
      output: { success: true, result: 'dispatch-after-compact-failure' },
      executionPath: 'legacy_supervisor',
    };
  };

  const run = await service.sendMessage(agent.id, {
    message: 'repair rerun after failure',
    contextPolicy: {
      includeCurrentWork: true,
      includeRecentTurns: false,
      includePersistent: false,
      includeMemory: false,
    },
    metadata: {
      repair: true,
      priorAttempts: [{ id: 'attempt-1', status: 'failed' }, { id: 'attempt-2', status: 'failed' }],
      handoffBudget: { slimmed: true, rawRef: '.bioagent/handoff/raw.json' },
    },
  });

  assert.equal(run.status, 'completed');
  const compactionEvent = run.events.find((event) => event.type === 'contextCompaction');
  assert.equal(compactionEvent?.contextCompaction.status, 'failed');
  assert.ok(run.contextRefs?.some((ref) => ref.kind === 'context-compaction-failure'));
  assert.match(dispatchedContext, /Current work:\n- \(empty\)/, 'failed compact should omit the hot current-work block from dispatch context');
  assert.doesNotMatch(dispatchedContext, /FAILURE-CURRENT-WORK-MARKER[\s\S]*FAILURE-CURRENT-WORK-MARKER[\s\S]*FAILURE-CURRENT-WORK-MARKER/, 'failed compact should not inline the raw current-work transcript');
  assert.match(dispatchedContext, /context-compaction-failure:/, 'dispatch context should carry recovery context');
  assert.equal(run.metadata?.agentServerPreflight && typeof run.metadata.agentServerPreflight, 'object');
});

test('run preflight honors request-provided context window limits', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'agentserver-preflight-window-limit-'));
  process.env.AGENT_SERVER_DATA_DIR = dataRoot;
  const { AgentServerService } = await import('../server/agent_server/service.ts');
  const { AgentStore } = await import('../server/agent_server/store.ts');

  const store = new AgentStore();
  const service = new AgentServerService(store);
  const workspace = await mkdtemp(join(tmpdir(), 'agentserver-preflight-window-workspace-'));
  const agent = await service.createAgent({
    id: `agent-preflight-window-${Date.now()}`,
    backend: 'codex',
    workingDirectory: workspace,
  });

  (service as unknown as {
    runSingleStageBackendTurn: AgentServerService['runSingleStageBackendTurn'];
  }).runSingleStageBackendTurn = async () => ({
    output: { success: true, result: 'dispatch-ok' },
    executionPath: 'legacy_supervisor',
  });

  const run = await service.sendMessage(agent.id, {
    message: 'check configured window',
    contextPolicy: {
      includeCurrentWork: true,
      includeRecentTurns: false,
      includePersistent: false,
      includeMemory: false,
    },
    metadata: {
      maxContextWindowTokens: 64_000,
    },
  });

  const contextEvent = run.events.find((event) => event.type === 'contextWindowState');
  assert.equal(contextEvent?.contextWindowState?.windowTokens, 64_000);
  assert.equal(run.metadata?.agentServerPreflight && typeof run.metadata.agentServerPreflight, 'object');
});

async function seedLargeCurrentWork(
  store: InstanceType<typeof import('../server/agent_server/store.ts').AgentStore>,
  agentId: string,
  sessionId: string,
  marker = 'CURRENT-WORK-MARKER',
): Promise<void> {
  for (let index = 1; index <= 8; index += 1) {
    await store.appendTurn(agentId, sessionId, {
      kind: 'turn',
      turnId: `seed-${index}`,
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: `${marker} turn ${index} completed verified ${'large current work '.repeat(2_000)}`,
      createdAt: new Date(2026, 4, 1, 0, index).toISOString(),
      turnNumber: index,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
