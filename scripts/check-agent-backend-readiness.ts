import { spawn } from 'node:child_process';

type Step = {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  skipAfterFailure?: boolean;
};

const STRATEGIC_BACKENDS = ['codex', 'claude-code', 'gemini', 'self-hosted-agent'] as const;
type StrategicBackend = typeof STRATEGIC_BACKENDS[number];

const baseEnv = {
  ...process.env,
  AGENT_SERVER_CODEX_MODEL: process.env.AGENT_SERVER_CODEX_MODEL || 'gpt-5.4',
};
const selectedBackends = parseSelectedBackends(process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS);
const liveSmokeBackends = selectedBackends.filter((backend) => backend !== 'codex');
const DRY_RUN = process.env.AGENT_SERVER_ADAPTER_READINESS_DRY_RUN === '1';

const steps: Step[] = [
  {
    name: 'strict preflight',
    command: 'npm',
    args: ['run', 'check:agent-backend-adapters:strict'],
    skipAfterFailure: true,
  },
  ...(selectedBackends.includes('codex')
    ? [{
        name: 'Codex isolated live smoke',
        command: 'npm',
        args: ['run', 'smoke:agent-backend-adapters:codex-isolated'],
      }]
    : []),
  ...(liveSmokeBackends.length > 0
    ? [{
        name: selectedBackends.includes('codex')
          ? `remaining selected backend live smoke (${liveSmokeBackends.join(',')})`
          : `selected strategic backend live smoke (${liveSmokeBackends.join(',')})`,
        command: 'npm',
        args: ['run', 'smoke:agent-backend-adapters'],
        env: {
          AGENT_SERVER_LIVE_ADAPTER_SMOKE: '1',
          AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: liveSmokeBackends.join(','),
        },
      }]
    : []),
];

const results: Array<{ name: string; status: 'passed' | 'failed' | 'skipped'; code?: number }> = [];
let shouldSkipRemaining = false;

console.log(`[agent-backend-readiness] selectedBackends=${selectedBackends.join(',')}`);

if (DRY_RUN) {
  console.log('[agent-backend-readiness] dryRun=true');
  for (const step of steps) {
    console.log(`PLAN ${step.name}: ${step.command} ${step.args.join(' ')}`);
    if (step.env?.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS) {
      console.log(`PLAN_ENV ${step.name}: AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=${step.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS}`);
    }
  }
  process.exit(0);
}

for (const step of steps) {
  if (shouldSkipRemaining) {
    results.push({ name: step.name, status: 'skipped' });
    continue;
  }
  console.log(`\n[agent-backend-readiness] ${step.name}`);
  const code = await run(step.command, step.args, {
    ...baseEnv,
    ...(step.env || {}),
  });
  if (code === 0) {
    results.push({ name: step.name, status: 'passed', code });
    continue;
  }
  results.push({ name: step.name, status: 'failed', code });
  if (step.skipAfterFailure) {
    shouldSkipRemaining = true;
  }
}

console.log('\n[agent-backend-readiness] summary');
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${result.name}${result.code === undefined ? '' : ` code=${result.code}`}`);
}

const failed = results.filter((result) => result.status === 'failed');
if (failed.length > 0) {
  console.error([
    '',
    '[agent-backend-readiness] not ready',
    'Fix the failed step above, then rerun npm run check:agent-backend-adapters:ready.',
    'Common remaining setup: provide an OpenAI-compatible endpoint for Claude/self-hosted adapters and one Gemini/Google auth source.',
  ].join('\n'));
  process.exitCode = 1;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(`[agent-backend-readiness] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

function parseSelectedBackends(value: string | undefined): StrategicBackend[] {
  if (!value) {
    return [...STRATEGIC_BACKENDS];
  }
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    return [...STRATEGIC_BACKENDS];
  }
  const invalid = parsed.filter((item) => !STRATEGIC_BACKENDS.includes(item as StrategicBackend));
  if (invalid.length > 0) {
    throw new Error(`Unknown strategic backend(s) in AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: ${invalid.join(', ')}`);
  }
  return [...new Set(parsed)] as StrategicBackend[];
}
