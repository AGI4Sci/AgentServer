import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackendDescriptors, type BackendType } from '../core/runtime/backend-catalog.js';
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

async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await closeHttpServer(server);
  if (!address || typeof address === 'string') {
    throw new Error('Could not allocate a free TCP port.');
  }
  return address.port;
}

async function stopSupervisor(port: number): Promise<void> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (!response.ok) {
      return;
    }
    const health = await response.json() as { pid?: number };
    if (health.pid && health.pid !== process.pid) {
      process.kill(health.pid, 'SIGTERM');
    }
  } catch {
    // Best-effort cleanup for detached smoke supervisors.
  }
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
    const content = transcript.includes('Tool result for list_dir')
      ? 'All-backend SDK smoke completed after list_dir.'
      : '<list_dir><path>.</path></list_dir>';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-all-backends-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent-sdk-all-backends-model',
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
    close: async () => closeHttpServer(server),
  };
}

async function prepareWorkspace(backend: BackendType): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `agent-sdk-${backend}-http-stream-`));
  await writeFile(join(workspace, 'README.md'), `# ${backend} SDK HTTP stream smoke\n`, 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"agent-sdk-all-backends"}\n', 'utf8');
  return workspace;
}

const smokeTempDir = await mkdtemp(join(tmpdir(), 'agent-sdk-all-backends-config-'));
const modelServer = await startSmokeModelServer();
const supervisorPort = await getFreePort();
const apiPort = await getFreePort();
const smokeConfigPath = join(smokeTempDir, 'openteam.json');
process.env.OPENTEAM_CONFIG_PATH = smokeConfigPath;

await writeFile(
  smokeConfigPath,
  JSON.stringify({
    llm: {
      baseUrl: modelServer.baseUrl,
      apiKey: 'agent-sdk-all-backends-key',
      model: 'agent-sdk-all-backends-model',
      fallbacks: [],
    },
    runtime: {
      supervisor: {
        port: supervisorPort,
      },
    },
  }, null, 2),
  'utf8',
);

const { createAgentClient, listSupportedBackends } = await import('../index.js');
const { handleAgentServerRoutes } = await import('../server/api/agent-server.js');
const apiServer = createServer(async (req, res) => {
  try {
    const handled = await handleAgentServerRoutes(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
    }
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

await new Promise<void>((resolve, reject) => {
  apiServer.once('error', reject);
  apiServer.listen(apiPort, '127.0.0.1', () => resolve());
});

const client = createAgentClient({
  baseUrl: `http://127.0.0.1:${apiPort}`,
});
const enabledBackends = listBackendDescriptors();
const supportedBackendIds = listSupportedBackends().map((backend) => backend.id).join(',');
const enabledBackendIds = enabledBackends.map((backend) => backend.id).join(',');
if (supportedBackendIds !== enabledBackendIds) {
  throw new Error(`SDK backend list mismatch: supported=${supportedBackendIds} enabled=${enabledBackendIds}`);
}

const results: Array<{
  backend: BackendType;
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
}> = [];

try {
  for (const backend of enabledBackends) {
    const executable = resolveManagedBackendExecutableForBackend(backend.id);
    if (backend.capabilities.managedLauncher && !executable) {
      results.push({
        backend: backend.id,
        status: 'skipped',
        detail: `managed launcher not found in ${getManagedBackendBinDir()}: ${backend.executables.join(', ')}`,
      });
      continue;
    }

    const workspace = await prepareWorkspace(backend.id);
    try {
      const events: string[] = [];
      const result = await client.runTask('Use list_dir on "." once, then finish.', {
        agentId: `agent-sdk-http-stream-${backend.id}`,
        name: `${backend.label} SDK HTTP Stream Smoke`,
        backend: backend.id,
        workspace,
        systemPrompt: 'You are an SDK HTTP streaming smoke-test agent. Use list_dir exactly once.',
        onEvent(event) {
          if (event.type === 'tool-call' || event.type === 'tool-result') {
            events.push(`${event.type}:${event.toolName}`);
          }
        },
        runtime: {
          localDevPolicy: {
            isSourceTask: true,
            maxSteps: 4,
            forceSummaryOnBudgetExhausted: true,
          },
        },
        metadata: {
          smoke: 'agent-sdk-all-backends',
          backend: backend.id,
        },
      });
      if (!result.run.output.success) {
        throw new Error(result.run.output.error);
      }
      if (!events.includes('tool-call:list_dir') || !events.includes('tool-result:list_dir')) {
        throw new Error(`missing list_dir HTTP stream events; saw=${events.join(', ') || 'none'}`);
      }
      results.push({
        backend: backend.id,
        status: 'passed',
        detail: `launcher=${executable ?? 'direct'} run=${result.run.id} events=${events.length}`,
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
    console.log(`${result.status.toUpperCase()} ${result.backend}: ${result.detail.replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  const failed = results.filter((result) => result.status === 'failed');
  const skipped = results.filter((result) => result.status === 'skipped');
  const passed = results.filter((result) => result.status === 'passed');
  console.log(`SUMMARY passed=${passed.length} failed=${failed.length} skipped=${skipped.length}`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} SDK all-backend smoke case(s) failed`);
  }
  if (passed.length !== enabledBackends.length) {
    throw new Error(`Expected all ${enabledBackends.length} enabled backends to pass; passed=${passed.length} skipped=${skipped.length}`);
  }
} finally {
  await closeHttpServer(apiServer);
  await stopSupervisor(supervisorPort);
  await modelServer.close();
  await rm(smokeTempDir, { recursive: true, force: true });
}
