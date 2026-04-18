import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'agent-server-tool-routing-config-'));
const configPath = join(configDir, 'openteam.json');
process.env.OPENTEAM_CONFIG_PATH = configPath;

try {
  await writeFile(
    configPath,
    JSON.stringify({
      llm: {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'tool-routing-config-key',
        model: 'tool-routing-config-model',
        fallbacks: [],
      },
      runtime: {
        workspace: {
          workspaces: [
            {
              id: 'gpu-exp',
              root: '/home/ubuntu/experiments/run-001',
              artifactRoot: '/home/ubuntu/experiments/run-001/artifacts',
              ownerWorker: 'gpu-a100',
            },
          ],
          workers: [
            {
              id: 'backend-server',
              kind: 'backend-server',
              capabilities: ['network', 'metadata'],
            },
            {
              id: 'gpu-a100',
              kind: 'ssh',
              host: 'gpu.example.com',
              allowedRoots: ['/home/ubuntu/experiments'],
              capabilities: ['filesystem', 'shell', 'gpu'],
            },
            {
              id: 'mac-local',
              kind: 'client-worker',
              endpoint: 'http://127.0.0.1:3457',
              allowedRoots: ['/Applications/workspace'],
              capabilities: ['filesystem', 'shell', 'network'],
            },
          ],
          toolRouting: {
            default: {
              primary: 'gpu-a100',
            },
            rules: [
              {
                tools: ['web_search', 'web_fetch'],
                primary: 'backend-server',
                fallbacks: ['mac-local'],
              },
            ],
          },
        },
      },
    }, null, 2),
    'utf8',
  );

  const {
    getConfiguredWorkspace,
    listConfiguredWorkers,
    planConfiguredToolRoute,
  } = await import('../server/utils/openteam-config.js');
  const workspace = getConfiguredWorkspace('gpu-exp');
  if (!workspace || workspace.ownerWorker !== 'gpu-a100') {
    throw new Error('tool routing config smoke failed: workspace did not normalize as expected');
  }
  const workers = listConfiguredWorkers();
  if (!workers.some((worker) => worker.id === 'backend-server' && worker.kind === 'backend-server')) {
    throw new Error('tool routing config smoke failed: backend-server worker missing');
  }
  const networkRoute = planConfiguredToolRoute('web_search', 'gpu-exp');
  if (networkRoute.primaryWorker !== 'backend-server' || networkRoute.fallbackWorkers[0] !== 'mac-local') {
    throw new Error(`tool routing config smoke failed: unexpected web_search route ${networkRoute.primaryWorker}`);
  }
  const commandRoute = planConfiguredToolRoute('run_command', 'gpu-exp');
  if (commandRoute.primaryWorker !== 'gpu-a100' || commandRoute.executableNow !== true) {
    throw new Error(`tool routing config smoke failed: expected executable gpu ssh route, got ${commandRoute.primaryWorker}`);
  }
  console.log('PASSED tool routing config smoke: network routes can proxy through backend and commands execute on gpu ssh worker');
} finally {
  await rm(configDir, { recursive: true, force: true });
}
