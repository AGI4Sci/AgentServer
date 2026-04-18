import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runDeploymentCheck(args: {
  configPath: string;
  dataDir: string;
}): Promise<{ stdout: string; stderr: string }> {
  return await execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'scripts/check-deployment.ts'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENTEAM_CONFIG_PATH: args.configPath,
        AGENT_SERVER_DATA_DIR: args.dataDir,
        AGENT_SERVER_ENABLED_BACKENDS: 'openteam_agent',
      },
      maxBuffer: 1024 * 1024,
    },
  );
}

async function writeConfig(args: {
  path: string;
  serverRoot: string;
  clientRoot: string;
  sshRoot: string;
  identityFile: string;
  includeClientAuthToken: boolean;
}): Promise<void> {
  await writeFile(
    args.path,
    JSON.stringify({
      llm: {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'deployment-worker-smoke-key',
        model: 'deployment-worker-smoke-model',
        fallbacks: [],
      },
      runtime: {
        workspace: {
          mode: 'server',
          serverAllowedRoots: [args.serverRoot],
          workspaces: [
            {
              id: 'server-work',
              root: args.serverRoot,
              ownerWorker: 'server-local',
            },
            {
              id: 'client-work',
              root: args.clientRoot,
              ownerWorker: 'mac-local',
            },
            {
              id: 'gpu-work',
              root: args.sshRoot,
              artifactRoot: join(args.sshRoot, 'artifacts'),
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
              id: 'server-local',
              kind: 'server',
              allowedRoots: [args.serverRoot],
              capabilities: ['filesystem', 'shell', 'network', 'metadata'],
            },
            {
              id: 'gpu-a100',
              kind: 'ssh',
              host: 'gpu.example.com',
              user: 'ubuntu',
              port: 22,
              identityFile: args.identityFile,
              allowedRoots: [args.sshRoot],
              capabilities: ['filesystem', 'shell', 'gpu'],
            },
            {
              id: 'mac-local',
              kind: 'client-worker',
              endpoint: 'http://127.0.0.1:3457',
              ...(args.includeClientAuthToken ? { authToken: 'deployment-worker-smoke-token' } : {}),
              allowedRoots: [args.clientRoot],
              capabilities: ['filesystem', 'shell', 'network'],
            },
          ],
          toolRouting: {
            default: {
              primary: 'server-local',
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
    'utf-8',
  );
}

const root = await mkdtemp(join(tmpdir(), 'agent-server-deployment-workers-'));
const configPath = join(root, 'openteam.json');
const dataDir = join(root, 'data');
const serverRoot = join(root, 'server-workspace');
const clientRoot = join(root, 'client-workspace');
const sshRoot = join(root, 'ssh-workspace');
const identityFile = join(root, 'id_ed25519');

try {
  await mkdir(serverRoot, { recursive: true });
  await mkdir(clientRoot, { recursive: true });
  await mkdir(sshRoot, { recursive: true });
  await writeFile(identityFile, 'fake identity for deployment smoke\n', 'utf-8');

  await writeConfig({
    path: configPath,
    serverRoot,
    clientRoot,
    sshRoot,
    identityFile,
    includeClientAuthToken: true,
  });
  const success = await runDeploymentCheck({ configPath, dataDir });
  if (!success.stdout.includes('[deployment] ok')) {
    throw new Error(`deployment worker smoke expected ok output, got:\n${success.stdout}\n${success.stderr}`);
  }

  await writeConfig({
    path: configPath,
    serverRoot,
    clientRoot,
    sshRoot,
    identityFile,
    includeClientAuthToken: false,
  });
  let failedAsExpected = false;
  try {
    await runDeploymentCheck({ configPath, dataDir });
  } catch (error) {
    const detail = error && typeof error === 'object'
      ? `${(error as { stdout?: string }).stdout || ''}\n${(error as { stderr?: string }).stderr || ''}`
      : String(error);
    if (detail.includes('client-worker authToken is missing')) {
      failedAsExpected = true;
    } else {
      throw new Error(`deployment worker smoke failed for unexpected reason:\n${detail}`);
    }
  }
  if (!failedAsExpected) {
    throw new Error('deployment worker smoke expected missing client-worker authToken to fail');
  }

  console.log('PASSED deployment worker routing smoke: complete worker config passes and missing client authToken fails');
} finally {
  await rm(root, { recursive: true, force: true });
}
