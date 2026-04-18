import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKEND_CATALOG } from '../core/runtime/backend-catalog.js';
import {
  getManagedBackendBinDir,
  resolveManagedBackendExecutableForBackend,
} from '../server/runtime/workers/backend-managed-launchers.js';
const configPath = join(process.cwd(), 'openteam.json');

if (!existsSync(configPath)) {
  await writeFile(
    configPath,
    JSON.stringify({
      llm: {
        baseUrl: 'http://127.0.0.1:3888/v1',
        apiKey: 'smoke-test-key',
        model: 'smoke-test-model',
        fallbacks: [],
      },
    }, null, 2),
    'utf8',
  );
}

const { AgentServerService } = await import('../server/agent_server/service.js');

const service = new AgentServerService();
const results: Array<{ backend: string; status: 'passed' | 'skipped' | 'failed'; detail: string }> = [];

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
