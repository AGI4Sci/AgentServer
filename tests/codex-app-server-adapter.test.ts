import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CodexAppServerAgentBackendAdapter } from '../server/runtime/adapters/codex-app-server-adapter.ts';

test('codex app-server adapter declares structured production-target capabilities', () => {
  const adapter = new CodexAppServerAgentBackendAdapter({
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
  });
  const capabilities = adapter.capabilities();

  assert.equal(adapter.backendId, 'codex');
  assert.equal(adapter.kind, 'agent_backend');
  assert.equal(adapter.tier, 'strategic');
  assert.equal(capabilities.nativeLoop, true);
  assert.equal(capabilities.nativeTools, true);
  assert.equal(capabilities.nativeSandbox, true);
  assert.equal(capabilities.nativeApproval, true);
  assert.equal(capabilities.structuredEvents, true);
  assert.equal(capabilities.readableState, true);
  assert.equal(capabilities.abortableRun, true);
  assert.equal(capabilities.statusTransparency, 'full');
});

test('codex app-server adapter surfaces server-side approval requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-codex-fake-'));
  const fakeServerPath = join(dir, 'fake-codex-app-server.mjs');
  await writeFile(fakeServerPath, `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') {
    return;
  }
  if (message.method === 'thread/start') {
    write({ id: message.id, result: { thread: { id: 'thread-1' } } });
    return;
  }
  if (message.method === 'turn/start') {
    write({ id: message.id, result: { turn: { id: 'turn-1' } } });
    write({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        command: ['npm', 'test'],
        cwd: process.cwd(),
        reason: 'run tests',
      },
    });
    return;
  }
  if (message.id === 'approval-1') {
    if (message.result?.decision !== 'decline') {
      write({ method: 'error', params: { error: { message: 'expected decline' } } });
      return;
    }
    write({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'approval-1' } });
    write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'done' } });
    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  }
});
`, 'utf8');

  const adapter = new CodexAppServerAgentBackendAdapter({
    command: process.execPath,
    args: [fakeServerPath],
  });
  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-1',
    backend: 'codex',
    workspace: dir,
    scope: 'stage',
  });

  const events = [];
  for await (const event of adapter.runTurn({
    sessionRef,
    handoff: {
      runId: 'run-1',
      stageId: 'stage-1',
      stageType: 'implement',
      targetBackend: 'codex',
      stageInstructions: 'run a fake turn',
      canonicalContext: [],
      priorStageSummaries: [],
      workspaceFacts: {
        root: dir,
        dirtyFiles: [],
      },
      backendRunRecords: [],
      openQuestions: [],
    },
  })) {
    events.push(event);
  }
  await adapter.dispose({ sessionRef });

  const permissionEvent = events.find((event) => event.type === 'permission-request');
  assert.equal(permissionEvent?.requestId, 'approval-1');
  assert.equal(permissionEvent?.toolName, 'run_command');

  const stageResult = events.find((event) => event.type === 'stage-result');
  assert.equal(stageResult?.result.status, 'completed');
  assert.equal(stageResult?.result.finalText, 'done');
});

test('codex app-server adapter keeps retryable app-server errors non-terminal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-codex-retry-'));
  const fakeServerPath = join(dir, 'fake-codex-retry-app-server.mjs');
  await writeFile(fakeServerPath, `
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
const write = (message) => process.stdout.write(JSON.stringify(message) + '\\n');

rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') {
    return;
  }
  if (message.method === 'thread/start') {
    write({ id: message.id, result: { thread: { id: 'thread-1' } } });
    return;
  }
  if (message.method === 'turn/start') {
    write({ id: message.id, result: { turn: { id: 'turn-1' } } });
    write({
      method: 'error',
      params: {
        error: { message: 'stream disconnected' },
        willRetry: true,
      },
    });
    write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'recovered' } });
    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  }
});
`, 'utf8');

  const adapter = new CodexAppServerAgentBackendAdapter({
    command: process.execPath,
    args: [fakeServerPath],
  });
  const sessionRef = await adapter.startSession({
    agentServerSessionId: 'session-1',
    backend: 'codex',
    workspace: dir,
    scope: 'stage',
  });

  const events = [];
  for await (const event of adapter.runTurn({
    sessionRef,
    handoff: {
      runId: 'run-1',
      stageId: 'stage-1',
      stageType: 'implement',
      targetBackend: 'codex',
      stageInstructions: 'run a fake retry turn',
      canonicalContext: [],
      priorStageSummaries: [],
      workspaceFacts: {
        root: dir,
        dirtyFiles: [],
      },
      backendRunRecords: [],
      openQuestions: [],
    },
  })) {
    events.push(event);
  }
  await adapter.dispose({ sessionRef });

  assert.equal(events.some((event) => event.type === 'error'), false);
  assert.ok(events.some((event) => event.type === 'status' && event.message?.includes('will retry')));

  const stageResult = events.find((event) => event.type === 'stage-result');
  assert.equal(stageResult?.result.status, 'completed');
  assert.equal(stageResult?.result.finalText, 'recovered');
});
