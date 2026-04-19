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

test('codex app-server adapter surfaces and auto-approves server-side approval requests', async () => {
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
    if (message.result?.decision !== 'acceptForSession') {
      write({ method: 'error', params: { error: { message: 'expected acceptForSession' } } });
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

test('codex app-server adapter grants requested permissions for the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-codex-auto-approve-'));
  const fakeServerPath = join(dir, 'fake-codex-auto-approve-app-server.mjs');
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
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        reason: 'write smoke file',
        permissions: {
          fileSystem: {
            write: ['/tmp/smoke'],
          },
          network: {
            enabled: true,
          },
        },
      },
    });
    return;
  }
  if (message.id === 'approval-1') {
    if (message.result?.scope !== 'session' || message.result?.permissions?.fileSystem?.write?.[0] !== '/tmp/smoke' || message.result?.permissions?.network?.enabled !== true) {
      write({ method: 'error', params: { error: { message: 'expected session permission grant' } } });
      return;
    }
    write({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 'approval-1' } });
    write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'approved' } });
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
      stageInstructions: 'run an auto approval turn',
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

  const stageResult = events.find((event) => event.type === 'stage-result');
  assert.equal(stageResult?.result.status, 'completed');
  assert.equal(stageResult?.result.finalText, 'approved');
});

test('codex app-server adapter resolves native model through ModelRuntimeConnection', async () => {
  await withModelEnv({
    AGENT_SERVER_MODEL_PROVIDER: 'openai',
    AGENT_SERVER_MODEL_NAME: 'gpt-codex-native',
  }, async () => {
    const events = await runCodexModelSmoke({
      expectedModel: 'gpt-codex-native',
      expectedModelProvider: 'openai',
    });
    const stageResult = events.find((event) => event.type === 'stage-result');
    assert.equal(stageResult?.result.status, 'completed');
  });
});

test('codex app-server adapter does not pass OpenAI-compatible model names into native app-server', async () => {
  await withModelEnv({
    AGENT_SERVER_MODEL_PROVIDER: 'openai-compatible',
    AGENT_SERVER_MODEL_NAME: 'proxy-only-model',
  }, async () => {
    const events = await runCodexModelSmoke({ expectedModel: null });
    const stageResult = events.find((event) => event.type === 'stage-result');
    assert.equal(stageResult?.result.status, 'completed');
  });
});

test('codex app-server adapter maps OpenAI-compatible endpoints through Codex custom provider', async () => {
  await withModelEnv({
    AGENT_SERVER_MODEL_PROVIDER: 'openai-compatible',
    AGENT_SERVER_MODEL_NAME: 'proxy-model',
    AGENT_SERVER_MODEL_BASE_URL: 'http://127.0.0.1:4555/v1',
    AGENT_SERVER_MODEL_API_KEY: 'test-key',
  }, async () => {
    const events = await runCodexModelSmoke({
      expectedModel: 'proxy-model',
      expectedModelProvider: 'openteam_local',
      expectCustomProviderConfig: true,
    });
    const stageResult = events.find((event) => event.type === 'stage-result');
    assert.equal(stageResult?.result.status, 'completed');
  });
});

test('codex app-server adapter keeps explicit Codex model on native route', async () => {
  await withModelEnv({
    AGENT_SERVER_CODEX_MODEL: 'gpt-5.4',
    AGENT_SERVER_MODEL_PROVIDER: 'custom',
    AGENT_SERVER_MODEL_NAME: 'glm-5.1',
    AGENT_SERVER_MODEL_BASE_URL: 'http://127.0.0.1:4555/v1',
    AGENT_SERVER_MODEL_API_KEY: 'test-key',
  }, async () => {
    const events = await runCodexModelSmoke({
      expectedModel: 'gpt-5.4',
      expectedModelProvider: null,
      expectNoCustomProviderConfig: true,
    });
    const stageResult = events.find((event) => event.type === 'stage-result');
    assert.equal(stageResult?.result.status, 'completed');
  });
});

async function runCodexModelSmoke(options: {
  expectedModel: string | null;
  expectedModelProvider?: string | null;
  expectCustomProviderConfig?: boolean;
  expectNoCustomProviderConfig?: boolean;
}) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-server-codex-model-'));
  const fakeServerPath = join(dir, 'fake-codex-model-app-server.mjs');
  await writeFile(fakeServerPath, `
import { createInterface } from 'node:readline';

const expectedModel = ${JSON.stringify(options.expectedModel)};
const expectedModelProvider = ${JSON.stringify(options.expectedModelProvider ?? null)};
const expectCustomProviderConfig = ${JSON.stringify(Boolean(options.expectCustomProviderConfig))};
const expectNoCustomProviderConfig = ${JSON.stringify(Boolean(options.expectNoCustomProviderConfig))};
const argv = process.argv.slice(2).join('\\n');
if (expectCustomProviderConfig && !argv.includes('model_provider="openteam_local"')) {
  console.error('missing custom provider config in argv: ' + argv);
  process.exit(2);
}
if (expectNoCustomProviderConfig && argv.includes('model_provider="openteam_local"')) {
  console.error('unexpected custom provider config in argv: ' + argv);
  process.exit(2);
}
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
    if ((message.params?.model || null) !== expectedModel) {
      write({ id: message.id, error: { message: 'unexpected model ' + JSON.stringify(message.params?.model || null) } });
      return;
    }
    if ((message.params?.modelProvider || null) !== expectedModelProvider) {
      write({ id: message.id, error: { message: 'unexpected modelProvider ' + JSON.stringify(message.params?.modelProvider || null) } });
      return;
    }
    write({ id: message.id, result: { turn: { id: 'turn-1' } } });
    write({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'msg-1', delta: 'model-ok' } });
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
      stageInstructions: 'run a model smoke turn',
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
  return events;
}

async function withModelEnv(values: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const keys = [
    'AGENT_SERVER_MODEL',
    'AGENT_SERVER_MODEL_PROVIDER',
    'AGENT_SERVER_MODEL_NAME',
    'AGENT_SERVER_MODEL_BASE_URL',
    'AGENT_SERVER_MODEL_API_KEY',
    'AGENT_SERVER_CODEX_MODEL',
  ];
  const snapshot = new Map<string, string | undefined>();
  for (const key of keys) {
    snapshot.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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
