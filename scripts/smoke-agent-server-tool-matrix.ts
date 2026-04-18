import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKEND_CATALOG, type BackendType } from '../core/runtime/backend-catalog.js';
import {
  getManagedBackendBinDir,
  resolveManagedBackendExecutableForBackend,
} from '../server/runtime/workers/backend-managed-launchers.js';

type ToolName =
  | 'append_file'
  | 'read_file'
  | 'write_file'
  | 'list_dir'
  | 'grep_search'
  | 'run_command'
  | 'apply_patch'
  | 'web_search'
  | 'web_fetch'
  | 'browser_open'
  | 'browser_activate';

const TOOL_NAMES: ToolName[] = [
  'append_file',
  'read_file',
  'write_file',
  'list_dir',
  'grep_search',
  'run_command',
  'apply_patch',
  'web_search',
  'web_fetch',
  'browser_open',
  'browser_activate',
];

const DEFAULT_TOOLS = process.env.AGENT_SERVER_TOOL_MATRIX_TOOLS?.trim()
  ? process.env.AGENT_SERVER_TOOL_MATRIX_TOOLS.split(',').map((item) => item.trim()).filter(Boolean) as ToolName[]
  : TOOL_NAMES;

const DEFAULT_BACKENDS = process.env.AGENT_SERVER_TOOL_MATRIX_BACKENDS?.trim()
  ? new Set(process.env.AGENT_SERVER_TOOL_MATRIX_BACKENDS.split(',').map((item) => item.trim()).filter(Boolean))
  : null;

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
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    2_000,
    undefined,
  );
}

async function startStaticServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('agent-server-tool-matrix-web-fetch-ok\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static server did not bind to a TCP port.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/matrix.txt`,
    close: async () => closeHttpServer(server),
  };
}

function xmlForTool(tool: ToolName, urls: { localUrl: string }): string {
  if (tool === 'append_file') {
    return '<append_file><path>append-target.txt</path><content>append-ok\\n</content></append_file>';
  }
  if (tool === 'read_file') {
    return '<read_file><path>README.md</path></read_file>';
  }
  if (tool === 'write_file') {
    return '<write_file><path>write-target.txt</path><content>write-ok\\n</content></write_file>';
  }
  if (tool === 'list_dir') {
    return '<list_dir><path>.</path></list_dir>';
  }
  if (tool === 'grep_search') {
    return '<grep_search><path>.</path><pattern>MATRIX_NEEDLE</pattern></grep_search>';
  }
  if (tool === 'run_command') {
    return '<run_command><command>printf matrix-command-ok</command></run_command>';
  }
  if (tool === 'apply_patch') {
    return [
      '<apply_patch><patch>',
      '--- patch-target.txt\n',
      '+++ patch-target.txt\n',
      '@@ -1 +1 @@\n',
      '-before\n',
      '+after\n',
      '</patch></apply_patch>',
    ].join('');
  }
  if (tool === 'web_search') {
    return '<web_search><query>AgentServer tool matrix smoke test</query></web_search>';
  }
  if (tool === 'web_fetch') {
    return `<web_fetch><url>${urls.localUrl}</url></web_fetch>`;
  }
  if (tool === 'browser_open') {
    return `<browser_open><url>${urls.localUrl}</url></browser_open>`;
  }
  if (tool === 'browser_activate') {
    return '<browser_activate><app>Finder</app></browser_activate>';
  }
  throw new Error(`Unknown tool ${tool}`);
}

async function startToolModelServer(urls: { localUrl: string }): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> } : {};
    const transcript = (body.messages || []).map((message) => message.content || '').join('\n\n');
    const toolMatch = transcript.match(/TOOL_MATRIX_TOOL=([a-z_]+)/);
    const tool = toolMatch?.[1] as ToolName | undefined;
    const content = transcript.includes('Tool result for ')
      ? `DONE ${tool || 'unknown'}`
      : tool && TOOL_NAMES.includes(tool)
        ? xmlForTool(tool, urls)
        : 'DONE no-tool-marker';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-tool-matrix-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent-server-tool-matrix-model',
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
    throw new Error('Tool model server did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => closeHttpServer(server),
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function prepareWorkspace(backend: BackendType, tool: ToolName): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), `agent-server-${backend}-${tool}-matrix-`));
  await writeFile(join(workspace, 'README.md'), `# ${backend} ${tool}\nMATRIX_NEEDLE\n`, 'utf8');
  await writeFile(join(workspace, 'package.json'), '{"name":"tool-matrix"}\n', 'utf8');
  await writeFile(join(workspace, 'patch-target.txt'), 'before\n', 'utf8');
  await writeFile(join(workspace, 'append-target.txt'), '', 'utf8');
  return workspace;
}

const staticServer = await startStaticServer();
const modelServer = await startToolModelServer({ localUrl: staticServer.url });
const smokeTempDir = await mkdtemp(join(tmpdir(), 'agent-server-tool-matrix-config-'));
const smokeSupervisorPort = await getFreePort();
const smokeConfigPath = join(smokeTempDir, 'openteam.json');
process.env.OPENTEAM_CONFIG_PATH = smokeConfigPath;

await writeFile(
  smokeConfigPath,
  JSON.stringify({
    llm: {
      baseUrl: modelServer.baseUrl,
      apiKey: 'tool-matrix-key',
      model: 'agent-server-tool-matrix-model',
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

const results: Array<{
  backend: string;
  tool: string;
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
}> = [];

try {
  for (const backend of BACKEND_CATALOG) {
    if (DEFAULT_BACKENDS && !DEFAULT_BACKENDS.has(backend.id)) {
      continue;
    }
    const executable = resolveManagedBackendExecutableForBackend(backend.id);
    if (backend.capabilities.managedLauncher && !executable) {
      for (const tool of DEFAULT_TOOLS) {
        results.push({
          backend: backend.id,
          tool,
          status: 'skipped',
          detail: `managed launcher not found in ${getManagedBackendBinDir()}: ${backend.executables.join(', ')}`,
        });
      }
      continue;
    }

    for (const tool of DEFAULT_TOOLS) {
      const workspace = await prepareWorkspace(backend.id, tool);
      try {
        const result = await service.runTask({
          agent: {
            id: `tool-matrix-${backend.id}-${tool}`,
            name: `${backend.label} ${tool} Matrix`,
            backend: backend.id,
            workspace,
            systemPrompt: 'You are a backend tool matrix smoke-test agent. Use exactly the requested tool.',
            reconcileExisting: true,
            metadata: { smoke: 'agent-server-tool-matrix', tool },
          },
          input: {
            text: [
              `TOOL_MATRIX_TOOL=${tool}`,
              `Call exactly the ${tool} tool once, then finish after the tool result.`,
            ].join('\n'),
            metadata: { expectedTool: tool },
          },
          runtime: {
            localDevPolicy: {
              isSourceTask: true,
              maxSteps: 3,
              forceSummaryOnBudgetExhausted: true,
            },
          },
          metadata: { smoke: 'agent-server-tool-matrix', tool },
        });

        const toolEvents = result.run.events.filter((event) => event.type === 'tool-call' || event.type === 'tool-result');
        const sawCall = toolEvents.some((event) => event.type === 'tool-call' && event.toolName === tool);
        const resultEvent = toolEvents.find((event) => event.type === 'tool-result' && event.toolName === tool);
        if (!sawCall || !resultEvent) {
          throw new Error(`missing expected events; saw=${toolEvents.map((event) => `${event.type}:${event.toolName}`).join(', ') || 'none'}`);
        }
        const output = resultEvent.type === 'tool-result' ? (resultEvent.output || resultEvent.detail || '') : '';
        const failedOutput = /(?:^|\n)(?:STATUS:\s*failure|No application knows how to open|execution error|command not found|fetch failed|ENOTFOUND|ECONNREFUSED)/i.test(output);
        if (failedOutput) {
          throw new Error(output.slice(0, 500));
        }
        results.push({
          backend: backend.id,
          tool,
          status: 'passed',
          detail: `run=${result.run.id}`,
        });
      } catch (error) {
        results.push({
          backend: backend.id,
          tool,
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }

  for (const result of results) {
    console.log(`${result.status.toUpperCase()} ${result.backend} ${result.tool}: ${result.detail.replace(/\s+/g, ' ').slice(0, 240)}`);
  }

  const failed = results.filter((result) => result.status === 'failed');
  const skipped = results.filter((result) => result.status === 'skipped');
  const passed = results.filter((result) => result.status === 'passed');
  console.log(`SUMMARY passed=${passed.length} failed=${failed.length} skipped=${skipped.length}`);
  if (failed.length > 0) {
    throw new Error(`${failed.length} backend/tool matrix case(s) failed`);
  }
  if (passed.length === 0) {
    throw new Error(`No backend/tool matrix cases ran because no managed launchers were found in ${getManagedBackendBinDir()}.`);
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  const { getRuntimeSupervisorHealth } = await import('../server/runtime/supervisor-client.js');
  const health = await withTimeout(getRuntimeSupervisorHealth(), 2_000, null);
  if (health?.pid && health.projectRoot === process.cwd()) {
    try {
      process.kill(health.pid, 'SIGTERM');
    } catch {
      // The smoke supervisor may already be gone.
    }
  }
  await modelServer.close();
  await staticServer.close();
  await rm(smokeTempDir, { recursive: true, force: true });
}

process.exit(process.exitCode ?? 0);
