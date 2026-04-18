import { randomUUID } from 'node:crypto';
import { executeRoutedToolCall } from '../server/runtime/tool-executor.js';
import type { ToolRoutingPolicy, WorkerCapability, WorkerProfile, WorkspaceSpec } from '../core/runtime/tool-routing.js';

interface SmokeWorkerConfig {
  id: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  root?: string;
  capabilities?: WorkerCapability[];
  env?: Record<string, string>;
}

function parseWorkers(): SmokeWorkerConfig[] {
  const json = process.env.AGENT_SERVER_SSH_SMOKE_WORKERS?.trim();
  if (json) {
    const parsed = JSON.parse(json) as SmokeWorkerConfig[];
    if (!Array.isArray(parsed)) {
      throw new Error('AGENT_SERVER_SSH_SMOKE_WORKERS must be a JSON array.');
    }
    return parsed;
  }

  const hosts = process.env.AGENT_SERVER_SSH_SMOKE_HOSTS?.split(',')
    .map((item) => item.trim())
    .filter(Boolean) || [];
  return hosts.map((host) => ({
    id: host.replace(/[^a-z0-9_.-]+/gi, '-'),
    host,
  }));
}

function requireWorkerConfig(worker: SmokeWorkerConfig): void {
  if (!worker.id?.trim()) {
    throw new Error('SSH smoke worker is missing id.');
  }
  if (!worker.host?.trim()) {
    throw new Error(`SSH smoke worker ${worker.id} is missing host.`);
  }
}

function workerProfile(config: SmokeWorkerConfig): WorkerProfile {
  return {
    id: config.id,
    kind: 'ssh',
    host: config.host,
    user: config.user,
    port: config.port,
    identityFile: config.identityFile,
    allowedRoots: [config.root || '/tmp'],
    capabilities: config.capabilities || ['filesystem', 'shell'],
    env: config.env,
  };
}

async function runTool(args: {
  workspace: WorkspaceSpec;
  workers: WorkerProfile[];
  toolName: string;
  toolArgs?: Record<string, string>;
  policy?: ToolRoutingPolicy;
}): Promise<void> {
  const result = await executeRoutedToolCall(args);
  const attemptSummary = result.attempts.map((attempt) => `${attempt.workerId}:${attempt.status}`).join(',');
  console.log(`[${args.workspace.id}] ${args.toolName} ok=${result.ok} worker=${result.workerId || '(none)'} attempts=${attemptSummary}`);
  if (result.writeback.status !== 'not-needed') {
    console.log(`[${args.workspace.id}] ${args.toolName} writeback=${result.writeback.status} path=${result.writeback.path || '(none)'}`);
  }
  if (!result.ok) {
    throw new Error(`${args.workspace.id} ${args.toolName} failed:\n${result.output}`);
  }
  const output = result.output.trim();
  if (output) {
    console.log(output.split('\n').slice(0, 12).join('\n'));
  }
}

async function runWorkerSmoke(config: SmokeWorkerConfig): Promise<void> {
  requireWorkerConfig(config);
  const rootBase = config.root || '/tmp';
  const workspaceRoot = `${rootBase.replace(/\/+$/, '')}/agent-server-ssh-smoke-${config.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const workspace: WorkspaceSpec = {
    id: `${config.id}-workspace`,
    root: workspaceRoot,
    artifactRoot: `${workspaceRoot}/artifacts`,
    ownerWorker: config.id,
  };
  const workers: WorkerProfile[] = [
    {
      id: 'backend-server',
      kind: 'backend-server',
      capabilities: ['network', 'metadata'],
    },
    workerProfile(config),
  ];

  console.log(`\n[${config.id}] host=${config.host} root=${workspaceRoot}`);
  await runTool({
    workspace,
    workers,
    toolName: 'run_command',
    toolArgs: {
      command: [
        'printf "hostname="; hostname',
        'printf "user="; whoami',
        'printf "pwd="; pwd',
        'printf "curl=%s\\n" "$(command -v curl || true)"',
        'printf "wget=%s\\n" "$(command -v wget || true)"',
        'printf "python3=%s\\n" "$(command -v python3 || true)"',
        'printf "nvidia_smi=%s\\n" "$(command -v nvidia-smi || true)"',
        'if command -v nvidia-smi >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then timeout 8 nvidia-smi -L || true; fi',
        'if command -v curl >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then timeout 8 curl -L -sS -o /dev/null -w "direct_baidu_http=%{http_code}\\n" https://www.baidu.com || printf "direct_baidu_http=failed\\n"; fi',
      ].join('; '),
    },
  });
  await runTool({
    workspace,
    workers,
    toolName: 'write_file',
    toolArgs: {
      path: 'hello.txt',
      content: `hello from ${config.id}\n`,
    },
  });
  await runTool({
    workspace,
    workers,
    toolName: 'read_file',
    toolArgs: {
      path: 'hello.txt',
    },
  });
  if ((config.capabilities || []).includes('network')) {
    await runTool({
      workspace,
      workers,
      toolName: 'web_fetch',
      toolArgs: {
        url: 'https://www.baidu.com',
      },
      policy: {
        default: {
          primary: config.id,
        },
      },
    });
  }
  await runTool({
    workspace,
    workers,
    toolName: 'web_fetch',
    toolArgs: {
      url: `data:text/plain,network proxy writeback for ${encodeURIComponent(config.id)}`,
    },
  });
}

const workers = parseWorkers();
if (workers.length === 0) {
  console.log('SKIPPED ssh worker smoke: set AGENT_SERVER_SSH_SMOKE_HOSTS or AGENT_SERVER_SSH_SMOKE_WORKERS.');
  process.exit(0);
}

for (const worker of workers) {
  await runWorkerSmoke(worker);
}

console.log(`\nPASSED ssh worker smoke: ${workers.map((worker) => worker.id).join(', ')}`);
