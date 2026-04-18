import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
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
  await closeServer(server);
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

async function startModelServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) as { messages?: Array<{ content?: string }> } : {};
    const transcript = (body.messages || []).map((message) => message.content || '').join('\n\n');
    const content = transcript.includes('Tool result for list_dir')
      ? 'Agent SDK smoke completed after list_dir.'
      : '<list_dir><path>.</path></list_dir>';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-agent-sdk-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent-sdk-smoke-model',
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
    close: async () => closeServer(server),
  };
}

const workspace = await mkdtemp(join(tmpdir(), 'agent-sdk-smoke-'));
const configDir = await mkdtemp(join(tmpdir(), 'agent-sdk-config-'));
const modelServer = await startModelServer();
const supervisorPort = await getFreePort();
const apiPort = await getFreePort();
process.env.OPENTEAM_CONFIG_PATH = join(configDir, 'openteam.json');

try {
  await writeFile(
    process.env.OPENTEAM_CONFIG_PATH,
    JSON.stringify({
      llm: {
        baseUrl: modelServer.baseUrl,
        apiKey: 'agent-sdk-smoke-key',
        model: 'agent-sdk-smoke-model',
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
  await writeFile(join(workspace, 'README.md'), '# Agent SDK smoke\n', 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"agent-sdk-smoke"}\n', 'utf8');

  const { createAgentClient, listSupportedBackends } = await import('../index.js');
  const { handleAgentServerRoutes } = await import('../server/api/agent-server.js');
  const events: string[] = [];
  const client = createAgentClient({
    defaultBackend: 'openteam_agent',
    defaultWorkspace: workspace,
    defaultSystemPrompt: 'You are an Agent SDK smoke-test agent. Use list_dir exactly once.',
    metadata: { smoke: 'agent-sdk' },
  });
  const text = await client.runText('Call list_dir on "." and then finish.', {
    agentId: 'agent-sdk-smoke',
    name: 'Agent SDK Smoke',
    onEvent: (event) => {
      if (event.type === 'tool-call' || event.type === 'tool-result') {
        events.push(`${event.type}:${event.toolName}`);
      }
    },
    runtime: {
      localDevPolicy: {
        isSourceTask: true,
        maxSteps: 3,
        forceSummaryOnBudgetExhausted: true,
      },
    },
  });

  if (!text.includes('Agent SDK smoke completed')) {
    throw new Error(`unexpected SDK output: ${text}`);
  }
  if (!events.includes('tool-call:list_dir') || !events.includes('tool-result:list_dir')) {
    throw new Error(`missing SDK stream tool events; saw=${events.join(', ') || 'none'}`);
  }
  const agent = await client.getAgent('agent-sdk-smoke');
  if (agent.backend !== 'openteam_agent') {
    throw new Error(`unexpected SDK agent backend: ${agent.backend}`);
  }
  const agents = await client.listAgents();
  if (!agents.some((item) => item.id === 'agent-sdk-smoke')) {
    throw new Error('SDK listAgents() did not include the smoke agent.');
  }
  const runs = await client.listRuns('agent-sdk-smoke');
  if (!runs.length) {
    throw new Error('SDK listRuns() did not return the smoke run.');
  }
  const run = await client.getRun(runs[0].id);
  if (run.agentId !== agent.id) {
    throw new Error(`SDK getRun() returned run for unexpected agent: ${run.agentId}`);
  }
  const backends = client.listBackends().map((backend) => backend.id);
  if (!backends.includes('openteam_agent')) {
    throw new Error(`openteam_agent missing from SDK backend list: ${backends.join(', ')}`);
  }
  const supportedBackends = listSupportedBackends().map((backend) => backend.id);
  if (supportedBackends.join(',') !== backends.join(',')) {
    throw new Error(`listSupportedBackends() differs from client.listBackends(): ${supportedBackends.join(', ')}`);
  }

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
  try {
    const httpEvents: string[] = [];
    const httpClient = createAgentClient({
      baseUrl: `http://127.0.0.1:${apiPort}`,
      defaultBackend: 'openteam_agent',
      defaultWorkspace: workspace,
      defaultSystemPrompt: 'You are an HTTP Agent SDK smoke-test agent. Use list_dir exactly once.',
    });
    const httpText = await httpClient.runText('Call list_dir on "." and then finish over HTTP.', {
      agentId: 'agent-sdk-http-smoke',
      name: 'Agent SDK HTTP Smoke',
      onEvent: (event) => {
        if (event.type === 'tool-call' || event.type === 'tool-result') {
          httpEvents.push(`${event.type}:${event.toolName}`);
        }
      },
      runtime: {
        localDevPolicy: {
          isSourceTask: true,
          maxSteps: 3,
          forceSummaryOnBudgetExhausted: true,
        },
      },
    });
    if (!httpText.includes('Agent SDK smoke completed')) {
      throw new Error(`unexpected HTTP SDK output: ${httpText}`);
    }
    if (!httpEvents.includes('tool-call:list_dir') || !httpEvents.includes('tool-result:list_dir')) {
      throw new Error(`missing HTTP SDK stream tool events; saw=${httpEvents.join(', ') || 'none'}`);
    }
    console.log(`PASSED agent SDK smoke: localEvents=${events.length} httpEvents=${httpEvents.length}`);
  } finally {
    await closeServer(apiServer);
  }
} finally {
  await stopSupervisor(supervisorPort);
  await modelServer.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}
