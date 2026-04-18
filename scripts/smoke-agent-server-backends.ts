import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKEND_CATALOG } from '../core/runtime/backend-catalog.js';
import {
  getManagedBackendBinDir,
  resolveManagedBackendExecutableForBackend,
} from '../server/runtime/workers/backend-managed-launchers.js';

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function startSmokeModelServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> } : {};
    const transcript = (body.messages || []).map((message) => message.content || '').join('\n\n');
    const content = transcript.includes('Tool result for list_dir:')
      ? 'The working directory contains README.md and package.json.'
      : '<list_dir><path>.</path></list_dir>';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-smoke-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent-server-smoke-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Smoke model server did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a free TCP port.');
  }
  return address.port;
}

const smokeTempDir = await mkdtemp(join(tmpdir(), 'agent-server-backend-smoke-config-'));
const smokeModelServer = await startSmokeModelServer();
const smokeSupervisorPort = await getFreePort();
const smokeConfigPath = join(smokeTempDir, 'openteam.json');
process.env.OPENTEAM_CONFIG_PATH = smokeConfigPath;

await writeFile(
  smokeConfigPath,
  JSON.stringify({
    llm: {
      baseUrl: smokeModelServer.baseUrl,
      apiKey: 'smoke-test-key',
      model: 'agent-server-smoke-model',
      fallbacks: [],
    },
    runtime: {
      supervisor: {
        port: smokeSupervisorPort,
      },
    },
  }, null, 2),
  'utf8',
);

const { AgentServerService } = await import('../server/agent_server/service.js');

const service = new AgentServerService();
const results: Array<{ backend: string; status: 'passed' | 'skipped' | 'failed'; detail: string }> = [];

try {
for (const backend of BACKEND_CATALOG) {
  const executable = resolveManagedBackendExecutableForBackend(backend.id);
  if (!executable) {
    results.push({
      backend: backend.id,
      status: 'skipped',
      detail: `managed launcher not found in ${getManagedBackendBinDir()}: ${backend.executables.join(', ')}`,
    });
    continue;
  }

  const workspace = await mkdtemp(join(tmpdir(), `agent-server-${backend.id}-tool-smoke-`));
  try {
    await writeFile(join(workspace, 'README.md'), `# ${backend.label} tool smoke\n`, 'utf8');
    await writeFile(join(workspace, 'package.json'), '{"name":"tool-smoke"}\n', 'utf8');

    const result = await service.runTask({
      agent: {
        id: `tool-smoke-${backend.id}`,
        name: `${backend.label} Tool Smoke`,
        backend: backend.id,
        workspace,
        systemPrompt: 'You are a backend tool smoke-test agent. Use tools exactly as requested.',
        reconcileExisting: true,
        metadata: {
          smoke: 'agent-server-backend-tools',
        },
      },
      input: {
        text: 'Use the list_dir tool on "." and then answer with a one-line summary of the files you saw.',
        metadata: {
          expectedTool: 'list_dir',
        },
      },
      runtime: {
        localDevPolicy: {
          isSourceTask: true,
          maxSteps: 4,
          forceSummaryOnBudgetExhausted: true,
        },
      },
      metadata: {
        smoke: 'agent-server-backend-tools',
      },
    });

    const toolEvents = result.run.events.filter((event) => event.type === 'tool-call' || event.type === 'tool-result');
    const sawListDirCall = toolEvents.some((event) => event.type === 'tool-call' && event.toolName === 'list_dir');
    const sawListDirResult = toolEvents.some((event) => event.type === 'tool-result' && event.toolName === 'list_dir');
    if (!sawListDirCall || !sawListDirResult) {
      throw new Error(`missing list_dir tool events; saw=${toolEvents.map((event) => `${event.type}:${event.toolName}`).join(', ') || 'none'}`);
    }

    results.push({
      backend: backend.id,
      status: 'passed',
      detail: `launcher=${executable} run=${result.run.id}`,
    });
  } catch (error) {
    results.push({
      backend: backend.id,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${result.backend}: ${result.detail}`);
}

const failed = results.filter((result) => result.status === 'failed');
if (failed.length > 0) {
  throw new Error(`${failed.length} backend tool smoke(s) failed`);
}

const passed = results.filter((result) => result.status === 'passed');
if (passed.length === 0) {
  console.log(`No backend live smoke ran because no managed launchers were found in ${getManagedBackendBinDir()}.`);
  console.log('Run `npm run build:backend-binaries` first, or set OPENTEAM_BACKEND_BIN_DIR to a compatible launcher directory.');
}
} finally {
  const { getRuntimeSupervisorHealth } = await import('../server/runtime/supervisor-client.js');
  const health = await getRuntimeSupervisorHealth();
  if (health?.pid && health.projectRoot === process.cwd()) {
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // The smoke supervisor may already be gone.
    }
  }
  await smokeModelServer.close();
  await rm(smokeTempDir, { recursive: true, force: true });
}
