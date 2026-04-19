import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('readiness dry-run skips Codex isolated smoke when Codex is not selected', async () => {
  const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-readiness.ts'], {
    env: {
      ...process.env,
      AGENT_SERVER_ADAPTER_READINESS_DRY_RUN: '1',
      AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: 'claude-code,self-hosted-agent',
    },
  });

  assert.match(result.stdout, /selectedBackends=claude-code,self-hosted-agent/);
  assert.doesNotMatch(result.stdout, /codex isolated live smoke/);
  assert.match(result.stdout, /PLAN claude-code strict preflight/);
  assert.match(result.stdout, /PLAN claude-code live smoke/);
  assert.match(result.stdout, /PLAN self-hosted-agent strict preflight/);
  assert.match(result.stdout, /PLAN self-hosted-agent live smoke/);
  assert.match(result.stdout, /PLAN_ENV .*AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code/);
  assert.match(result.stdout, /PLAN_ENV .*AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=self-hosted-agent/);
});

test('readiness dry-run plans each selected backend independently', async () => {
  const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-readiness.ts'], {
    env: {
      ...process.env,
      AGENT_SERVER_ADAPTER_READINESS_DRY_RUN: '1',
      AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: 'codex,gemini',
    },
  });

  assert.match(result.stdout, /selectedBackends=codex,gemini/);
  assert.match(result.stdout, /PLAN codex strict preflight/);
  assert.match(result.stdout, /PLAN codex isolated live smoke/);
  assert.match(result.stdout, /PLAN gemini strict preflight/);
  assert.match(result.stdout, /PLAN gemini live smoke/);
  assert.match(result.stdout, /PLAN_ENV .*AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex/);
  assert.match(result.stdout, /PLAN_ENV .*AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini/);
  assert.doesNotMatch(result.stdout, /AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex,gemini/);
});

test('readiness dry-run exposes per-step hard timeout', async () => {
  const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-readiness.ts'], {
    env: {
      ...process.env,
      AGENT_SERVER_ADAPTER_READINESS_DRY_RUN: '1',
      AGENT_SERVER_ADAPTER_READINESS_STEP_TIMEOUT_MS: '12345',
      AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: 'claude-code',
    },
  });

  assert.match(result.stdout, /PLAN_TIMEOUT claude-code strict preflight: 12345ms/);
  assert.match(result.stdout, /PLAN_TIMEOUT claude-code live smoke: 12345ms/);
});

test('Gemini readiness uses functional smoke without real credentials by default', async () => {
  const result = await execFileAsync('npm', ['run', 'check:agent-backend-adapters:ready:gemini'], {
    env: {
      ...process.env,
      AGENT_SERVER_GEMINI_API_KEY: '',
      AGENT_SERVER_GOOGLE_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    },
  });

  assert.match(result.stdout, /functionalSmoke=true/);
  assert.match(result.stdout, /PASSED gemini gemini strict preflight/);
  assert.match(result.stdout, /PASSED gemini gemini live smoke/);
  assert.match(result.stdout, /events=tool-call,tool-result,text-delta,status,stage-result/);
});

test('Gemini readiness can require real auth when explicitly requested', async () => {
  const result = await execFileAsync('npm', ['run', 'check:agent-backend-adapters:ready:gemini'], {
    env: {
      ...process.env,
      AGENT_SERVER_GEMINI_REQUIRE_REAL_AUTH: '1',
      AGENT_SERVER_GEMINI_API_KEY: '',
      AGENT_SERVER_GOOGLE_API_KEY: '',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    },
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout || '',
    stderr: error.stderr || '',
  }));

  assert.match(result.stdout, /FAILED gemini gemini strict preflight/);
  assert.match(result.stdout, /SKIPPED gemini gemini live smoke/);
  assert.doesNotMatch(result.stdout, /functionalSmoke=true/);
});

test('readiness env file loads local settings without printing secret values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-readiness-env-'));
  const envPath = join(dir, 'readiness.local.env');
  try {
    await writeFile(envPath, [
      'AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini',
      'AGENT_SERVER_MODEL_API_KEY=super-secret-test-key',
      'AGENT_SERVER_MODEL_NAME="env-file-model"',
      '',
    ].join('\n'), 'utf8');
    const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-readiness.ts'], {
      env: {
        ...process.env,
        AGENT_SERVER_ADAPTER_READINESS_DRY_RUN: '1',
        AGENT_SERVER_ADAPTER_READINESS_ENV_FILE: envPath,
      },
    });

    assert.match(result.stdout, /selectedBackends=gemini/);
    assert.match(result.stdout, /envFile=.*loaded=3 skippedExisting=0/);
    assert.match(result.stdout, /PLAN gemini strict preflight/);
    assert.doesNotMatch(result.stdout, /super-secret-test-key/);
    assert.doesNotMatch(result.stdout, /env-file-model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readiness env initializer creates a local env file without overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-readiness-init-'));
  const envPath = join(dir, 'readiness.local.env');
  try {
    const created = await execFileAsync('node', ['--import', 'tsx', 'scripts/init-agent-backend-readiness-env.ts'], {
      env: {
        ...process.env,
        AGENT_SERVER_ADAPTER_READINESS_ENV_FILE: envPath,
      },
    });
    assert.match(created.stdout, /created local env file/);
    assert.match(await readFile(envPath, 'utf8'), /AGENT_SERVER_MODEL_BASE_URL=/);

    await writeFile(envPath, 'GEMINI_API_KEY=keep-me\n', 'utf8');
    const skipped = await execFileAsync('node', ['--import', 'tsx', 'scripts/init-agent-backend-readiness-env.ts'], {
      env: {
        ...process.env,
        AGENT_SERVER_ADAPTER_READINESS_ENV_FILE: envPath,
      },
    });
    assert.match(skipped.stdout, /already exists/);
    assert.equal(await readFile(envPath, 'utf8'), 'GEMINI_API_KEY=keep-me\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('adapter preflight reports readiness placeholder values as missing setup', async () => {
  const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-adapters.ts'], {
    env: {
      ...process.env,
      AGENT_SERVER_ADAPTER_PREFLIGHT_STRICT: '1',
      AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: 'gemini',
      GEMINI_API_KEY: 'replace-with-your-gemini-api-key',
    },
  }).catch((error: { stdout?: string; stderr?: string }) => ({
    stdout: error.stdout || '',
    stderr: error.stderr || '',
  }));

  assert.match(result.stdout, /GEMINI_API_KEY=placeholder/);
  assert.match(result.stdout, /blockingWarn=1/);
  assert.doesNotMatch(result.stdout, /replace-with-your-gemini-api-key/);
});

test('adapter preflight maps AgentServer-scoped Gemini auth without leaking secret values', async () => {
  const result = await execFileAsync('node', ['--import', 'tsx', 'scripts/check-agent-backend-adapters.ts'], {
    env: {
      ...process.env,
      AGENT_SERVER_ADAPTER_PREFLIGHT_STRICT: '1',
      AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: 'gemini',
      AGENT_SERVER_GEMINI_API_KEY: 'agent-server-gemini-secret',
      GEMINI_API_KEY: '',
      GOOGLE_API_KEY: '',
      GOOGLE_APPLICATION_CREDENTIALS: '',
    },
  });

  assert.match(result.stdout, /AGENT_SERVER_GEMINI_API_KEY=set/);
  assert.match(result.stdout, /GEMINI_API_KEY=set/);
  assert.match(result.stdout, /blockingWarn=0/);
  assert.doesNotMatch(result.stdout, /agent-server-gemini-secret/);
});
