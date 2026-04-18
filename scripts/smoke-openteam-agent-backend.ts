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
      ? 'OpenTeam Agent smoke completed after list_dir.'
      : '<list_dir><path>.</path></list_dir>';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-openteam-agent-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'openteam-agent-smoke-model',
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

const workspace = await mkdtemp(join(tmpdir(), 'openteam-agent-direct-smoke-'));
const configDir = await mkdtemp(join(tmpdir(), 'openteam-agent-config-'));
const modelServer = await startModelServer();
const supervisorPort = await getFreePort();
process.env.OPENTEAM_CONFIG_PATH = join(configDir, 'openteam.json');

try {
  await writeFile(
    process.env.OPENTEAM_CONFIG_PATH,
    JSON.stringify({
      llm: {
        baseUrl: modelServer.baseUrl,
        apiKey: 'openteam-agent-smoke-key',
        model: 'openteam-agent-smoke-model',
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
  await writeFile(join(workspace, 'README.md'), '# OpenTeam Agent smoke\n', 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"openteam-agent-smoke"}\n', 'utf8');

  const { AgentServerService } = await import('../server/agent_server/service.js');
  const service = new AgentServerService();
  const result = await service.runTask({
    agent: {
      id: 'openteam-agent-direct-smoke',
      name: 'OpenTeam Agent Direct Smoke',
      backend: 'openteam_agent',
      workspace,
      systemPrompt: 'You are a smoke-test agent. Use list_dir exactly once.',
      reconcileExisting: true,
      metadata: { smoke: 'openteam-agent-direct' },
    },
    input: {
      text: 'Call list_dir on "." and then finish.',
      metadata: { expectedTool: 'list_dir' },
    },
    runtime: {
      localDevPolicy: {
        isSourceTask: true,
        maxSteps: 3,
        forceSummaryOnBudgetExhausted: true,
      },
    },
    metadata: { smoke: 'openteam-agent-direct' },
  });

  const toolEvents = result.run.events.filter((event) => event.type === 'tool-call' || event.type === 'tool-result');
  const sawCall = toolEvents.some((event) => event.type === 'tool-call' && event.toolName === 'list_dir');
  const sawResult = toolEvents.some((event) => event.type === 'tool-result' && event.toolName === 'list_dir');
  if (!result.run.output.success) {
    throw new Error(`run failed: ${result.run.output.error}`);
  }
  if (!sawCall || !sawResult) {
    throw new Error(`missing list_dir events; saw=${toolEvents.map((event) => `${event.type}:${event.toolName}`).join(', ') || 'none'}`);
  }
  console.log(`PASSED openteam_agent direct smoke: run=${result.run.id} events=${result.run.events.length}`);
} finally {
  await stopSupervisor(supervisorPort);
  await modelServer.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
}
