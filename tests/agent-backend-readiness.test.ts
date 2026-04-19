import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
