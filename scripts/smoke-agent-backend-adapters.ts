import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StrategicAgentBackend } from '../core/runtime/backend-catalog.js';
import {
  createAgentBackendAdapter,
  listAvailableAgentBackendAdapters,
} from '../server/runtime/agent-backend-adapter-registry.js';
import type { AgentBackendEvent } from '../server/runtime/agent-backend-adapter-contract.js';
import { startSmokeModelServer, type SmokeModelServer } from './lib/smoke-model-server.js';

const LIVE_MODE = process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE === '1';
const LIVE_TIMEOUT_MS = Number(process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_TIMEOUT_MS || 120_000);
const STRATEGIC_BACKENDS: StrategicAgentBackend[] = [
  'codex',
  'claude-code',
  'gemini',
  'self-hosted-agent',
];
const SELECTED_BACKENDS = parseSelectedBackends(process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS);

type SmokeResult = {
  backend: StrategicAgentBackend;
  status: 'passed' | 'skipped' | 'failed';
  detail: string;
};

const available = listAvailableAgentBackendAdapters();
const availableIds = new Set(available.map((item) => item.id));
const results: SmokeResult[] = [];
let smokeModelServer: SmokeModelServer | undefined;
let isolatedCodexHome: string | undefined;

if (LIVE_MODE && process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_LLM === '1') {
  smokeModelServer = await startSmokeModelServer();
  process.env.AGENT_SERVER_ADAPTER_LLM_BASE_URL = smokeModelServer.baseUrl;
  process.env.AGENT_SERVER_ADAPTER_LLM_API_KEY = 'agent-server-smoke-key';
  process.env.AGENT_SERVER_ADAPTER_LLM_MODEL = 'agent-server-smoke-model';
  if (SELECTED_BACKENDS.includes('claude-code') || SELECTED_BACKENDS.includes('self-hosted-agent')) {
    const { restartRuntimeSupervisor } = await import('../server/runtime/supervisor-client.js');
    await restartRuntimeSupervisor();
  }
}
if (LIVE_MODE && SELECTED_BACKENDS.includes('codex') && process.env.AGENT_SERVER_LIVE_ADAPTER_ISOLATED_CODEX_HOME === '1') {
  isolatedCodexHome = await mkdtemp(join(tmpdir(), 'agent-server-codex-home-'));
  await copyIfExists(join(homedir(), '.codex', 'auth.json'), join(isolatedCodexHome, 'auth.json'));
  await copyIfExists(join(homedir(), '.codex', 'config.toml'), join(isolatedCodexHome, 'config.toml'));
  await copyIfExists(join(homedir(), '.codex', 'installation_id'), join(isolatedCodexHome, 'installation_id'));
  process.env.CODEX_HOME = isolatedCodexHome;
}

try {
for (const backend of SELECTED_BACKENDS) {
  if (!availableIds.has(backend)) {
    results.push({
      backend,
      status: 'failed',
      detail: 'adapter is not registered',
    });
    continue;
  }

  try {
    const adapter = createAgentBackendAdapter(backend);
    const capabilities = await adapter.capabilities();
    if (adapter.kind !== 'agent_backend' || adapter.tier !== 'strategic') {
      throw new Error(`unexpected adapter classification kind=${adapter.kind} tier=${adapter.tier}`);
    }
    if (!capabilities.streamingEvents || !capabilities.structuredEvents || !capabilities.readableState) {
      throw new Error(`adapter does not expose required structured capability: ${JSON.stringify(capabilities)}`);
    }

    if (!LIVE_MODE) {
      results.push({
        backend,
        status: 'passed',
        detail: `contract ok; productionComplete=${available.find((item) => item.id === backend)?.productionComplete}`,
      });
      continue;
    }

    const workspace = await mkdtemp(join(tmpdir(), `agent-backend-${backend}-live-smoke-`));
    let sessionRef: Awaited<ReturnType<typeof adapter.startSession>> | undefined;
    let startSessionMs: number | undefined;
    let runTurnMs: number | undefined;
    try {
      await writeFile(join(workspace, 'README.md'), `# ${backend} adapter live smoke\n`, 'utf8');
      await writeFile(join(workspace, 'AGENT_BACKEND_SMOKE.md'), 'initial\n', 'utf8');
      const sessionStartedAt = Date.now();
      sessionRef = await withTimeout(adapter.startSession({
        agentServerSessionId: `live-smoke-${backend}`,
        backend,
        workspace,
        scope: 'stage',
        metadata: {
          smoke: 'agent-backend-adapters',
        },
      }), LIVE_TIMEOUT_MS, `${backend} startSession`);
      startSessionMs = Date.now() - sessionStartedAt;
      const state = await adapter.readState({ sessionRef });
      if (state.status !== 'idle') {
        throw new Error(`expected idle state after startSession, got ${state.status}`);
      }

      const runTurnStartedAt = Date.now();
      const events = await collectRunTurnEvents(
        adapter.runTurn({
          sessionRef,
          handoff: buildLiveSmokeHandoff(backend, workspace),
        }),
        LIVE_TIMEOUT_MS,
        backend,
      );
      runTurnMs = Date.now() - runTurnStartedAt;
      const stageResult = events.find((event) => event.type === 'stage-result');
      if (!stageResult) {
        throw new Error(`live run did not emit stage-result; events=${events.map((event) => event.type).join(',')}`);
      }
      if (stageResult.result.status !== 'completed') {
        throw new Error(`live stage failed with status=${stageResult.result.status}: ${formatStageFailure(stageResult.result)}`);
      }
      const hasStructuredEvent = events.some((event) => (
        event.type === 'text-delta'
        || event.type === 'tool-call'
        || event.type === 'tool-result'
        || event.type === 'permission-request'
        || event.type === 'stage-result'
      ));
      if (!hasStructuredEvent) {
        throw new Error('live run did not emit any structured event');
      }
      const smokeFile = await readFile(join(workspace, 'AGENT_BACKEND_SMOKE.md'), 'utf8').catch(() => '');
      results.push({
        backend,
        status: 'passed',
        detail: [
          `live run ok session=${sessionRef.id}`,
          `startSessionMs=${startSessionMs}`,
          `runTurnMs=${runTurnMs}`,
          `events=${events.map((event) => event.type).join(',')}`,
          smokeFile.includes(backend) ? 'workspace_edit=observed' : 'workspace_edit=not_observed',
        ].join('; '),
      });
    } catch (error) {
      results.push({
        backend,
        status: 'failed',
        detail: [
          error instanceof Error ? error.message : String(error),
          startSessionMs !== undefined ? `startSessionMs=${startSessionMs}` : undefined,
          runTurnMs !== undefined ? `runTurnMs=${runTurnMs}` : undefined,
        ].filter(Boolean).join('; '),
      });
    } finally {
      if (sessionRef) {
        await adapter.dispose({ sessionRef, reason: 'smoke complete' }).catch(() => undefined);
      }
      await rm(workspace, { recursive: true, force: true });
    }
  } catch (error) {
    results.push({
      backend,
      status: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
} finally {
  await smokeModelServer?.close().catch(() => undefined);
  if (isolatedCodexHome) {
    await rm(isolatedCodexHome, { recursive: true, force: true });
  }
}

for (const result of results) {
  const maxDetailLength = result.status === 'failed' ? 2_000 : 240;
  console.log(`${result.status.toUpperCase()} ${result.backend}: ${result.detail.replace(/\s+/g, ' ').slice(0, maxDetailLength)}`);
}

const failed = results.filter((result) => result.status === 'failed');
const passed = results.filter((result) => result.status === 'passed');
console.log(`SUMMARY mode=${LIVE_MODE ? 'live' : 'contract'} backends=${SELECTED_BACKENDS.join(',')} passed=${passed.length} failed=${failed.length}`);
if (failed.length > 0) {
  throw new Error(`${failed.length} strategic agent backend adapter smoke case(s) failed`);
}

function parseSelectedBackends(value: string | undefined): StrategicAgentBackend[] {
  if (!value) {
    return STRATEGIC_BACKENDS;
  }
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    return STRATEGIC_BACKENDS;
  }
  const invalid = parsed.filter((item) => !STRATEGIC_BACKENDS.includes(item as StrategicAgentBackend));
  if (invalid.length > 0) {
    throw new Error(`Unknown strategic backend(s) in AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: ${invalid.join(', ')}`);
  }
  return [...new Set(parsed)] as StrategicAgentBackend[];
}

function buildLiveSmokeHandoff(backend: StrategicAgentBackend, workspace: string) {
  const runId = `live-smoke-${backend}-${Date.now().toString(36)}`;
  const stageId = `${runId}-stage-implement-1`;
  return {
    runId,
    stageId,
    stageType: 'implement' as const,
    goal: 'Verify that this strategic backend can execute one AgentServer handoff turn.',
    userRequest: [
      'This is an AgentServer live adapter smoke test.',
      'Append one short line to AGENT_BACKEND_SMOKE.md mentioning the backend id.',
      'Then report what you changed.',
    ].join(' '),
    canonicalContext: {
      goal: 'Live adapter smoke',
      plan: [`implement:${backend}`],
      decisions: ['Use the real adapter runTurn path, not a lifecycle-only check.'],
      constraints: ['Keep the change inside AGENT_BACKEND_SMOKE.md.'],
      workspaceState: {
        root: workspace,
        dirtyFiles: [],
      },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    stageInstructions: [
      `Stage type: implement`,
      `Backend under test: ${backend}`,
      'Use the native backend loop/tools if available.',
      'Emit normal structured events and finish with a completed stage result.',
    ].join('\n'),
    constraints: ['Only edit AGENT_BACKEND_SMOKE.md.'],
    workspaceFacts: {
      root: workspace,
      dirtyFiles: [],
    },
    priorStageSummaries: [],
    openQuestions: [],
    metadata: {
      smoke: 'agent-backend-adapters',
      mode: 'live-run-turn',
    },
  };
}

async function collectRunTurnEvents(
  iterable: AsyncIterable<AgentBackendEvent>,
  timeoutMs: number,
  backend: StrategicAgentBackend,
): Promise<AgentBackendEvent[]> {
  const iterator = iterable[Symbol.asyncIterator]();
  const events: AgentBackendEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`${backend} runTurn timed out after ${timeoutMs}ms; events=${eventTypes(events)}`);
      }
      const next = await withTimeout(iterator.next(), remaining, `${backend} runTurn next event; events=${eventTypes(events)}`);
      if (next.done) {
        break;
      }
      events.push(next.value);
      if (next.value.type === 'stage-result') {
        break;
      }
    }
  } finally {
    await iterator.return?.().catch(() => undefined);
  }
  return events;
}

function eventTypes(events: AgentBackendEvent[]): string {
  return events.map((event) => event.type).join(',') || '(none)';
}

function formatStageFailure(result: Extract<AgentBackendEvent, { type: 'stage-result' }>['result']): string {
  return [
    result.finalText,
    result.handoffSummary,
    result.risks?.join('; '),
  ].filter(Boolean).join(' | ') || '(no failure detail)';
}

async function copyIfExists(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch {
    // Optional local runtime files may not exist in fresh environments.
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
