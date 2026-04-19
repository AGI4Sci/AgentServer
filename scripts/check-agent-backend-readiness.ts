import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Step = {
  name: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
};

type BackendPlan = {
  backend: StrategicBackend;
  preflight: Step;
  liveSmoke: Step;
};

type StepResult = {
  backend: StrategicBackend;
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  code?: number;
};

const STRATEGIC_BACKENDS = ['codex', 'claude-code', 'gemini', 'self-hosted-agent'] as const;
type StrategicBackend = typeof STRATEGIC_BACKENDS[number];

const loadedEnvFile = loadReadinessEnvFile(process.env.AGENT_SERVER_ADAPTER_READINESS_ENV_FILE);
const baseEnv = {
  ...process.env,
  AGENT_SERVER_CODEX_MODEL: process.env.AGENT_SERVER_CODEX_MODEL || 'gpt-5.4',
};
const selectedBackends = parseSelectedBackends(process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS);
const DRY_RUN = process.env.AGENT_SERVER_ADAPTER_READINESS_DRY_RUN === '1';

const plans = selectedBackends.map(createBackendPlan);
const results: StepResult[] = [];

console.log(`[agent-backend-readiness] selectedBackends=${selectedBackends.join(',')}`);
if (loadedEnvFile) {
  console.log(`[agent-backend-readiness] envFile=${loadedEnvFile.path} loaded=${loadedEnvFile.loaded} skippedExisting=${loadedEnvFile.skippedExisting}`);
}

if (DRY_RUN) {
  console.log('[agent-backend-readiness] dryRun=true');
  for (const plan of plans) {
    printPlanStep(plan.preflight);
    printPlanStep(plan.liveSmoke);
  }
  process.exit(0);
}

for (const plan of plans) {
  console.log(`\n[agent-backend-readiness] ${plan.preflight.name}`);
  const preflightCode = await runStep(plan.preflight);
  if (preflightCode !== 0) {
    results.push({
      backend: plan.backend,
      name: plan.preflight.name,
      status: 'failed',
      code: preflightCode,
    });
    results.push({
      backend: plan.backend,
      name: plan.liveSmoke.name,
      status: 'skipped',
    });
    continue;
  }
  results.push({
    backend: plan.backend,
    name: plan.preflight.name,
    status: 'passed',
    code: preflightCode,
  });

  console.log(`\n[agent-backend-readiness] ${plan.liveSmoke.name}`);
  const liveSmokeCode = await runStep(plan.liveSmoke);
  results.push({
    backend: plan.backend,
    name: plan.liveSmoke.name,
    status: liveSmokeCode === 0 ? 'passed' : 'failed',
    code: liveSmokeCode,
  });
}

console.log('\n[agent-backend-readiness] summary');
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${result.backend} ${result.name}${result.code === undefined ? '' : ` code=${result.code}`}`);
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

function createBackendPlan(backend: StrategicBackend): BackendPlan {
  return {
    backend,
    preflight: {
      name: `${backend} strict preflight`,
      command: 'npm',
      args: ['run', 'check:agent-backend-adapters:strict'],
      env: {
        AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: backend,
      },
    },
    liveSmoke: backend === 'codex'
      ? {
          name: 'codex isolated live smoke',
          command: 'npm',
          args: ['run', 'smoke:agent-backend-adapters:codex-isolated'],
        }
      : {
          name: `${backend} live smoke`,
          command: 'npm',
          args: ['run', 'smoke:agent-backend-adapters'],
          env: {
            AGENT_SERVER_LIVE_ADAPTER_SMOKE: '1',
            AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: backend,
          },
        },
  };
}

function printPlanStep(step: Step): void {
  console.log(`PLAN ${step.name}: ${step.command} ${step.args.join(' ')}`);
  if (step.env?.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS) {
    console.log(`PLAN_ENV ${step.name}: AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=${step.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS}`);
  }
}

function runStep(step: Step): Promise<number> {
  return run(step.command, step.args, {
    ...baseEnv,
    ...(step.env || {}),
  });
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

function loadReadinessEnvFile(value: string | undefined): { path: string; loaded: number; skippedExisting: number } | undefined {
  const filePath = value?.trim();
  if (!filePath) {
    return undefined;
  }
  const resolvedPath = resolve(filePath);
  const entries = parseEnvFile(readFileSync(resolvedPath, 'utf8'));
  let loaded = 0;
  let skippedExisting = 0;
  for (const [key, parsedValue] of entries) {
    if (process.env[key] !== undefined) {
      skippedExisting += 1;
      continue;
    }
    process.env[key] = parsedValue;
    loaded += 1;
  }
  return { path: resolvedPath, loaded, skippedExisting };
}

function parseEnvFile(contents: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const normalized = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const equalsIndex = normalized.indexOf('=');
    if (equalsIndex <= 0) {
      continue;
    }
    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    entries.push([key, parseEnvValue(normalized.slice(equalsIndex + 1).trim())]);
  }
  return entries;
}

function parseEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const unquoted = value.slice(1, -1);
    return value.startsWith('"')
      ? unquoted.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : unquoted;
  }
  return value.replace(/\s+#.*$/, '').trim();
}
