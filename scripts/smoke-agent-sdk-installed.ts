import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { BACKEND_CATALOG } from '../core/runtime/backend-catalog.js';
import { getManagedBackendBinDir } from '../server/runtime/workers/backend-managed-launchers.js';

const execFileAsync = promisify(execFile);

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
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
      ? 'Installed package SDK smoke completed.'
      : '<list_dir><path>.</path></list_dir>';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-installed-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'installed-smoke-model',
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

function buildInstalledSmokeModule(params: {
  workspace: string;
  configPath: string;
  modelBaseUrl: string;
  supervisorPort: number;
  backendBinDir: string;
}): string {
  return `
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

process.env.OPENTEAM_CONFIG_PATH = ${JSON.stringify(params.configPath)};
process.env.OPENTEAM_BACKEND_BIN_DIR = ${JSON.stringify(params.backendBinDir)};

await writeFile(process.env.OPENTEAM_CONFIG_PATH, JSON.stringify({
  llm: {
    baseUrl: ${JSON.stringify(params.modelBaseUrl)},
    apiKey: 'installed-smoke-key',
    model: 'installed-smoke-model',
    fallbacks: [],
  },
  runtime: {
    supervisor: {
      port: ${params.supervisorPort},
    },
  },
}, null, 2), 'utf8');

await writeFile(join(${JSON.stringify(params.workspace)}, 'README.md'), '# Installed Agent SDK smoke\\n', 'utf8');

async function stopSupervisor() {
  try {
    const response = await fetch('http://127.0.0.1:${params.supervisorPort}/health');
    if (!response.ok) {
      return;
    }
    const health = await response.json();
    if (health.pid && health.pid !== process.pid) {
      process.kill(health.pid, 'SIGTERM');
    }
  } catch {
    // Best-effort cleanup for detached smoke supervisors.
  }
}

const { createAgentClient } = await import('@agi4sci/agent-server');
const { listSupportedBackends } = await import('@agi4sci/agent-server');
const client = createAgentClient({
  defaultBackend: 'openteam_agent',
  defaultWorkspace: ${JSON.stringify(params.workspace)},
  defaultSystemPrompt: 'Use list_dir exactly once.',
});
try {
  const results = [];
  for (const backend of listSupportedBackends()) {
    const events = [];
    const text = await client.runText('Call list_dir on "." and finish.', {
      agentId: \`installed-sdk-smoke-\${backend.id}\`,
      backend: backend.id,
      workspace: ${JSON.stringify(params.workspace)},
      onEvent(event) {
        if (event.type === 'tool-call' || event.type === 'tool-result') {
          events.push(\`\${event.type}:\${event.toolName}\`);
        }
      },
      runtime: {
        localDevPolicy: {
          isSourceTask: true,
          maxSteps: 4,
          forceSummaryOnBudgetExhausted: true,
        },
      },
    });

    if (!text.includes('Installed package SDK smoke completed')) {
      throw new Error(\`\${backend.id}: \${text}\`);
    }
    if (!events.includes('tool-call:list_dir') || !events.includes('tool-result:list_dir')) {
      throw new Error(\`\${backend.id}: \${events.join(',')}\`);
    }
    results.push(backend.id);
  }
  console.log(\`PASSED installed package SDK smoke: backends=\${results.length} ids=\${results.join(',')}\`);
} finally {
  await stopSupervisor();
}
`;
}

const tempRoot = await mkdtemp(join(tmpdir(), 'agent-sdk-installed-'));
const packageDir = join(tempRoot, 'package');
const installDir = join(tempRoot, 'consumer');
const workspace = join(tempRoot, 'workspace');
const configDir = join(tempRoot, 'config');
const modelServer = await startModelServer();
const backendBinDir = getManagedBackendBinDir();

for (const backend of BACKEND_CATALOG) {
  if (!backend.capabilities.managedLauncher) {
    continue;
  }
  const hasLauncher = backend.executables.some((name) => existsSync(join(backendBinDir, name)));
  if (!hasLauncher) {
    throw new Error(`Missing managed launcher for ${backend.id} in ${backendBinDir}: ${backend.executables.join(', ')}`);
  }
}

try {
  await Promise.all([
    mkdir(packageDir),
    mkdir(installDir),
    mkdir(workspace),
    mkdir(configDir),
  ]);

  const pack = await execFileAsync('npm', ['pack', '--pack-destination', packageDir, '--json'], {
    cwd: process.cwd(),
  });
  const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
  const packagePath = join(packageDir, packed[0].filename);

  await execFileAsync('npm', ['init', '-y'], { cwd: installDir });
  await execFileAsync('npm', ['install', packagePath], { cwd: installDir });

  const smokePath = join(installDir, 'smoke.mjs');
  await writeFile(smokePath, buildInstalledSmokeModule({
    workspace,
    configPath: join(configDir, 'openteam.json'),
    modelBaseUrl: modelServer.baseUrl,
    supervisorPort: await getFreePort(),
    backendBinDir,
  }), 'utf8');

  const result = await execFileAsync(process.execPath, [smokePath], { cwd: installDir });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await modelServer.close();
  await rm(tempRoot, { recursive: true, force: true });
}
