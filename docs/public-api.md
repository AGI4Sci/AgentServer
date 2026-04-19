# AgentServer Public API

This is the thin integration surface for projects that want to use AgentServer without reading the backend runtime internals.

For in-process SDK usage, set `OPENTEAM_CONFIG_PATH` before importing the package if you need a non-default config file.

## Choose A Backend

Backend ids are stable public inputs for `runTask`.

There are two related backend concepts:

- **currently registered backend ids**: what the runtime catalog can launch today.
- **strategic agent backends**: the first-class long-term orchestration set, currently planned as Codex, Claude Code, Gemini, and the self-hosted agent.
- **ecosystem entry backends**: OpenClaw and Hermes Agent can be explicitly invoked through the same `AgentBackendAdapter` interface for traffic, migration, demos, and comparisons, but they are not default strategic routing targets.

```ts
import {
  BACKEND_CATALOG,
  createAgentClient,
  getBackendCapabilities,
  hasAgentBackendAdapter,
  isProductionCompleteAgentBackend,
  listAvailableAgentBackendAdapters,
  listRegisteredStrategicBackendIds,
  listStrategicAgentBackends,
  listStrategicAgentBackendProfiles,
  listSupportedBackends,
} from '@agi4sci/agent-server';

const agent = createAgentClient();
console.log(agent.listBackends().map((backend) => backend.id));
console.log(listSupportedBackends().map((backend) => backend.id));
// [
//   'openteam_agent',
//   'claude-code',
//   'codex',
//   'hermes-agent',
//   'openclaw',
// ]

for (const backend of BACKEND_CATALOG) {
  console.log(backend.id, backend.label, backend.capabilities);
}

const caps = getBackendCapabilities('codex');
if (caps.interrupt) {
  // Enable UI affordances that depend on interrupt support.
}

console.log(listStrategicAgentBackends());
// [ 'codex', 'claude-code', 'gemini', 'self-hosted-agent' ]

console.log(listRegisteredStrategicBackendIds());
// Runtime-registered strategic ids today, for example:
// [ 'openteam_agent', 'claude-code', 'codex' ]

console.log(listStrategicAgentBackendProfiles().map((profile) => ({
  id: profile.id,
  currentTransport: profile.currentTransport,
  modelRuntimeSupport: profile.modelRuntimeSupport.providerRoutes,
  productionComplete: isProductionCompleteAgentBackend(profile),
})));

console.log(listAvailableAgentBackendAdapters().map((adapter) => adapter.id));
// Structured adapter implementations currently available in AgentServer runtime,
// including strategic adapters and explicit ecosystem entry adapters.

console.log(hasAgentBackendAdapter('codex'));
// true once the Codex app-server adapter prototype is registered.

console.log(hasAgentBackendAdapter('gemini'));
// true once the Gemini CLI SDK adapter prototype is registered.

console.log(hasAgentBackendAdapter('openclaw'));
// true for the OpenClaw ecosystem compatibility adapter.

console.log(hasAgentBackendAdapter('hermes-agent'));
// true for the Hermes Agent ecosystem compatibility adapter.
```

Use capabilities for advanced UI or routing decisions. For ordinary task execution, changing only `agent.backend` is enough.

Strategic backend planning should use tier/capability metadata rather than hard-coded backend-name branching:

```ts
type BackendTier = 'strategic' | 'experimental' | 'compatibility' | 'legacy';

type StrategicBackend = 'codex' | 'claude-code' | 'gemini' | 'self-hosted-agent';
```

The strategic set is the default target for the multi-agent orchestration roadmap. Experimental, compatibility, and legacy backends can still be called explicitly, but should not receive default orchestrator routes for high-value production tasks unless policy explicitly opts in.

Strategic backend profiles intentionally separate `currentCapabilities` from `targetCapabilities`. This prevents a temporary CLI bridge from being treated as a production-complete agent backend before it exposes structured events, readable state, abort/resume, and full status transparency.

Strategic backend profiles also expose `modelRuntimeSupport`. This is the public, machine-readable provider/model boundary: it tells callers which providers are native, which are routed through a native custom-provider hook, which are routed through AgentServer's OpenAI-compatible bridge, which are pending, and which must fail or degrade explicitly instead of being smuggled through a backend path that cannot preserve native agent semantics.

Adapter availability and production completeness are separate checks:

- `listStrategicAgentBackendProfiles()` describes roadmap and capability targets.
- `listAvailableAgentBackendAdapters()` lists structured adapter implementations that AgentServer can instantiate.
- `isProductionCompleteAgentBackend(profile)` is stricter; prototype adapters stay false until live smoke validates the full contract.

At the current prototype stage, Codex uses the app-server JSON-RPC route, Claude Code uses the AgentServer schema bridge, Gemini uses the Gemini CLI SDK route, and the self-hosted agent uses the direct harness route. OpenClaw and Hermes Agent are exposed as ecosystem compatibility adapters, not default strategic routing targets.

## Backend Adapter Model

You can think of AgentServer as exposing one stable upper-layer contract:

```text
project code -> AgentServer Core -> Backend Runtime adapter -> native backend harness
```

The project chooses a backend by id. Backend Runtime absorbs native differences such as launcher shape, session protocol, raw event format, and provider-specific tool-call syntax. The upper layer receives normalized events and uses the same canonical tool primitive names.

This means ordinary integration code should not branch on backend internals. Prefer:

```ts
backend: 'codex'
```

and later:

```ts
backend: 'openclaw'
```

with the same task input and event handling code.

Production `agent_backend` adapters are expected to use a structured, status-transparent transport. Official app-server protocols, SDKs, JSON-RPC, stdio RPC, HTTP/WebSocket event streams, local runtime APIs, or schema-backed bridges are acceptable. A plain CLI transcript is only a bootstrap/debug/fallback/compatibility path unless the adapter can also expose structured events, `readState`, approval requests, tool calls, workspace facts, abort/resume, and native session references.

This is the public API consequence of the architecture: applications and other agents should see AgentServer as a transparent control plane, not as a text terminal wrapper around opaque tools. The detailed adapter-side contract is maintained in [Adapter Contract](./adapter-contract.md).

`openteam_agent` is the self-developed/custom backend seed. It vendors its SDK runtime inside `server/backend/openteam_agent`, so AgentServer can run independently without importing an external SDK checkout. It still emits the same normalized AgentServer events and uses the same canonical tool primitive names.

When AgentServer is consumed as an npm package, local in-process SDK mode includes the bundled `openteam_agent` runtime. Full native backend source trees are intended for the standalone repository/service deployment; package consumers can still route to those backends through HTTP mode against a running AgentServer service.

Package consumers can also use native backends from local SDK mode by providing managed launchers through `OPENTEAM_BACKEND_BIN_DIR`. This keeps the npm package small while still allowing all backend ids to use the same SDK surface when the host environment supplies native launchers.

## Run A Task In Process

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const agent = createAgentClient({
  defaultBackend: 'codex',
  defaultWorkspace: '/absolute/path/to/workspace',
  defaultSystemPrompt: 'You are a careful coding agent.',
  metadata: {
    project: 'my-app',
  },
});

const result = await agent.runTask(
  'List the repository files and summarize the project.',
  {
    agentId: 'repo-helper',
    name: 'Repo Helper',
    inputMetadata: { taskId: 'task-123' },
    onEvent(event) {
      console.log(event.type);
    },
    runtime: {
      localDevPolicy: {
        isSourceTask: true,
        maxSteps: 6,
        forceSummaryOnBudgetExhausted: true,
      },
    },
    runtimeMetadata: {
      endpointId: 'local',
    },
    metadata: {
      requestId: 'request-123',
    },
  },
);

console.log(result.run.status);
console.log(result.run.output);
console.log(result.run.events);
```

## Opt In Multi-Stage Orchestration

The default request path remains single-stage unless the caller explicitly opts in. This keeps ordinary runs cheap and predictable while allowing high-value tasks to use multiple strategic backends behind one external request.

```ts
const result = await agent.runTask('Diagnose this failing test, fix it, then verify the change.', {
  agentId: 'repo-helper',
  metadata: {
    orchestrator: {
      mode: 'multi_stage',
      planKind: 'diagnose-implement-verify',
      failureStrategy: 'fallback_backend',
      fallbackBackend: 'codex',
      maxRetries: 1,
    },
  },
});

console.log(result.run.orchestrator?.stageOrder);
console.log(result.run.stages?.map((stage) => ({
  id: stage.id,
  backend: stage.backend,
  type: stage.type,
  status: stage.status,
  executionPath: stage.audit.executionPath,
})));
```

Supported `metadata.orchestrator.planKind` values are `implement-only`, `implement-review`, and `diagnose-implement-verify`. Supported `failureStrategy` values are `fail_run`, `retry_stage`, `fallback_backend`, and `continue_with_warnings`; the last value is currently recorded as policy intent but still fails workspace-writing stages rather than silently continuing.

In multi-stage mode AgentServer builds a canonical handoff packet for each stage. The packet includes prior stage summaries, latest workspace facts, constraints, open questions, and stage-specific instructions. The public run still completes as one request, while `run.stages`, `stage-result` events, and `run.orchestrator` expose the internal backend relay for audit/debug views.

## Manage Agent Lifecycle

The SDK also exposes the small lifecycle surface most host projects need:

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  defaultBackend: 'codex',
  defaultWorkspace: '/absolute/path/to/workspace',
});

const manifest = await client.createAgent({
  id: 'repo-helper',
  name: 'Repo Helper',
  backend: 'openteam_agent',
  workingDirectory: '/absolute/path/to/workspace',
  systemPrompt: 'You are a careful coding agent.',
});

const run = await client.runTask('Inspect README.md and summarize the project.', {
  agentId: manifest.id,
});

console.log(await client.getAgent(manifest.id));
console.log(await client.listAgents());
console.log(await client.listRuns(manifest.id));
console.log(await client.getRun(run.run.id));
```

This keeps application code at the SDK boundary: create an agent, run a task, inspect audit records, and switch backend by changing the backend id.

To switch backend, change only this field:

```ts
backend: 'claude-code'
// or 'openteam_agent'
// or 'codex'
// or 'hermes-agent'
// or 'openclaw'
```

## Run A Task Over HTTP

Start the server:

```bash
npm run dev:8080
```

Call the public run facade:

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  baseUrl: 'http://127.0.0.1:8080',
  defaultBackend: 'codex',
  defaultWorkspace: '/absolute/path/to/workspace',
});

const result = await client.runTask('Use list_dir on "." and summarize the files.', {
  agentId: 'repo-helper',
  onEvent(event) {
    console.log(event.type);
  },
});

const audit = await client.getRun(result.run.id);
console.log(audit.events);
```

Equivalent raw HTTP endpoint:

```text
GET  /api/agent-server/agents
POST /api/agent-server/agents
GET  /api/agent-server/agents/:agentId
GET  /api/agent-server/agents/:agentId/runs
POST /api/agent-server/runs
POST /api/agent-server/runs/stream
GET  /api/agent-server/runs/:runId
```

`POST /api/agent-server/runs/stream` returns newline-delimited JSON. Event lines have `{ "event": ... }`; the final successful line has `{ "result": ... }`. The SDK handles this automatically when `onEvent` is supplied in HTTP mode.

Runnable SDK examples live in:

- `examples/sdk-local.ts`
- `examples/sdk-http.ts`

## Shared Event Contract

All backends are normalized into the same run event shape:

```ts
type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

type StageStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped';

type BackendStageResult = {
  status: StageStatus;
  finalText?: string;
  filesChanged?: string[];
  diffSummary?: string;
  testsRun?: Array<{ command: string; status: 'passed' | 'failed' | 'skipped' }>;
  handoffSummary?: string;
  risks?: string[];
};

type Event =
  | { type: 'status'; status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed'; stageId?: string; message?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; stageId?: string; toolName: string; detail?: string }
  | { type: 'tool-result'; stageId?: string; toolName: string; detail?: string; output?: string }
  | { type: 'permission-request'; stageId?: string; requestId: string; toolName: string; detail?: string }
  | { type: 'stage-result'; stageId: string; result: BackendStageResult }
  | { type: 'result'; output: { success: true; result: string } | { success: false; error: string } }
  | { type: 'error'; stageId?: string; error: string };
```

The event interface is uniform. Backend capabilities describe which advanced behaviors are available or meaningful for a specific backend. Public SDK/UI integrations may ignore `stageId` by default and still present a single continuous agent experience; audit/debug views should preserve `stageId`.

Event meanings:

| Event | Meaning |
|---|---|
| `status` | Backend/runtime lifecycle update, such as starting, running, waiting, completed, or failed. |
| `text-delta` | Assistant text streamed or emitted by the backend. |
| `tool-call` | A real tool invocation started. `toolName` uses the canonical primitive name when routed through the shared tool bridge. |
| `tool-result` | A real tool invocation finished. `output` contains the auditable result text when available. |
| `permission-request` | Backend requested approval before continuing a sensitive action. |
| `stage-result` | Internal stage finished and emitted structured handoff/audit facts. |
| `result` | Final run output. |
| `error` | Runtime or adapter error that could not be represented as a normal result. |

Run/Stage ledger status semantics:

- A `Run` represents one external request.
- A `Stage` is an internal audited step inside a run.
- `run.orchestrator` records the rule or policy that planned the stage graph, the ordered stage ids, completed/failed/skipped ids, and compact stage summaries for future handoff.
- A run can be `running` while multiple stages are `pending/running/completed`.
- If a stage waits for approval or clarification, the run enters `waiting_user`.
- Stage failure does not automatically mean run failure; orchestrator policy may retry or fallback, but audit must retain both the failed stage and fallback stage.
- `stage.result.boundaryVerification` records AgentServer-observed workspace facts, test events, artifacts, and changed files at the stage boundary, so later stages do not have to trust only a backend's natural-language summary.
- `stage.audit.executionPath` records whether the stage ran through the formal `agent_backend_adapter` path or the legacy supervisor compatibility path.
- The rule-based orchestrator core supports multi-stage execution waves, stage-to-stage handoff, retry, and fallback decisions. The default service request path remains single-stage, and callers can opt in to multi-stage execution with `metadata.orchestrator.mode = 'multi_stage'`.

The detailed adapter-side contract is maintained in [Adapter Contract](./adapter-contract.md).

## Canonical Tool Primitives

AgentServer's shared local tool bridge currently normalizes tool calls to this canonical primitive set:

| Primitive | Purpose |
|---|---|
| `append_file` | Append text to a file in the workspace, creating parent directories when needed. |
| `read_file` | Read a text file from the workspace. |
| `write_file` | Replace or create a text file in the workspace. |
| `list_dir` | List direct children of a directory. |
| `grep_search` | Search files or directories with `rg`-style text matching. |
| `run_command` | Run a shell command in the workspace. |
| `apply_patch` | Apply a unified diff patch to workspace files. |
| `web_search` | Search the web through configured/fallback search providers. |
| `web_fetch` | Fetch a URL and return status plus response text. |
| `browser_open` | Open a URL in the host browser. |
| `browser_activate` | Bring a host desktop application, usually the browser, to the foreground. |

Different native backends may internally name or route tools differently. AgentServer adapters translate those differences into the same `tool-call` and `tool-result` event shape whenever the run goes through the shared tool bridge.

Path-oriented primitives resolve relative paths against the agent workspace. `web_search` currently tries DuckDuckGo HTML first and falls back to Bing when the first provider is unreachable.

## Worker Routing Smoke

Projects that use remote workspaces should verify their workers before running real tasks:

```bash
npm run smoke:tool-executor
AGENT_SERVER_SSH_SMOKE_HOSTS=pjlab,pjlab_gpu npm run smoke:ssh-workers
```

`smoke:tool-executor` validates the local routed executor with server, backend-server, SSH, and client-worker routes using controlled test workers. `smoke:ssh-workers` talks to real SSH hosts when configured. It confirms that workspace tools execute on the SSH machine while network tools can still be proxied by `backend-server` and written back to the SSH workspace.

Workers may also carry environment variables:

```jsonc
{
  "id": "pjlab-cpu",
  "kind": "ssh",
  "host": "pjlab",
  "allowedRoots": ["/tmp"],
  "capabilities": ["filesystem", "shell", "network"],
  "env": {
    "http_proxy": "http://httpproxy-headless.kubebrain.svc.pjlab.local:3128",
    "https_proxy": "http://httpproxy-headless.kubebrain.svc.pjlab.local:3128",
    "no_proxy": "10.0.0.0/8,100.96.0.0/12,.pjlab.org.cn"
  }
}
```

This keeps proxy/VPN settings attached to the worker that needs them. A CPU SSH worker with `network` capability and proxy `env` can run `web_fetch` directly; a GPU worker without network can keep routing network primitives to `backend-server` or another network-capable worker.

For Mac / cloud backend / SSH GPU layouts, see [Client Worker 与 Tool Routing](./client-worker.md). The short version is: backend is the thinker, workspace owns data/results, workers execute tools, and tool routing chooses primary/fallback workers per tool call.

The SDK exports the route planning helper:

```ts
import { planToolRoute } from '@agi4sci/agent-server';

const plan = planToolRoute({
  toolName: 'web_search',
  workspace: {
    id: 'gpu-exp',
    root: '/home/ubuntu/experiments/run-001',
    ownerWorker: 'gpu-a100',
  },
  workers: [
    { id: 'backend-server', kind: 'backend-server', capabilities: ['network', 'metadata'] },
    { id: 'gpu-a100', kind: 'ssh', host: 'gpu.example.com', capabilities: ['filesystem', 'shell', 'gpu'] },
  ],
});

// plan.primaryWorker === 'backend-server'
```

The server runtime also has a thin routed executor for the worker kinds that are implemented today. It currently executes `backend-server` network tools plus `server`, `ssh`, and `client-worker` workspace tools; `container` and `remote-service` remain explicit plan-only route targets until their executors are added.

The bundled client-worker service exposes `GET /health`, authenticated `GET /capabilities`, and authenticated `POST /tool-call` when `AGENT_SERVER_CLIENT_WORKER_TOKEN` is set. AgentServer sends the configured worker `authToken` as a bearer token.

```bash
npm run smoke:client-worker
npm run smoke:deployment-workers
npm run smoke:tool-routing-config
npm run smoke:tool-executor
```

Example normalized event sequence:

```ts
[
  { type: 'status', status: 'running', message: 'Calling local model ...' },
  { type: 'tool-call', toolName: 'list_dir', detail: '{"path":"."}' },
  { type: 'tool-result', toolName: 'list_dir', output: 'path=/repo\nfile README.md\n...' },
  { type: 'text-delta', text: 'This repository contains ...' },
  { type: 'result', output: { success: true, result: 'This repository contains ...' } },
]
```

The smoke matrix for this contract is:

```bash
npm run check:agent-backend-adapters
npm run check:agent-backend-adapters:ready
npm run check:agent-backend-adapters:smoke-llm
npm run check:agent-backend-adapters:strict
npm run smoke:agent-backend-adapters
npm run smoke:agent-backend-adapters:codex-isolated
npm run smoke:agent-backend-adapters:live-smoke-llm
npm run smoke:agent-sdk:all-backends
npm run smoke:agent-server:tool-matrix
```

`check:agent-backend-adapters` is a preflight for live adapter work. It checks strategic adapter registration, Codex app-server command availability plus a lightweight JSON-RPC initialize/thread-start handshake, the OpenAI-compatible LLM endpoint used by Claude Code/self-hosted bridge paths, and whether the Gemini SDK module is resolvable. It honors `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` for subset checks.
Codex preflight also records non-secret account/model/rate-limit summaries and auth status. Gemini preflight records whether usable auth inputs exist without printing key material, and it verifies the SDK shape expected by the adapter: `GeminiCliAgent` plus `session.sendStream(prompt, signal)`.
`check:agent-backend-adapters:smoke-llm` runs the same preflight with a temporary OpenAI-compatible smoke LLM endpoint. Use it to verify adapter plumbing for Claude Code/self-hosted paths without requiring the real `openteam.json` endpoint to be online.
For production-like Claude Code/self-hosted checks, preflight and runtime share the same environment override semantics through the AgentServer model runtime resolver: set `AGENT_SERVER_MODEL_BASE_URL`, `AGENT_SERVER_MODEL_API_KEY`, `AGENT_SERVER_MODEL_NAME`, and optionally `AGENT_SERVER_MODEL_PROVIDER` / `AGENT_SERVER_MODEL_AUTH_TYPE` to test a real endpoint without editing `openteam.json`. The older `AGENT_SERVER_ADAPTER_LLM_*` names remain compatibility inputs, but new code and docs should use `AGENT_SERVER_MODEL_*`.
`check:agent-backend-adapters:strict` runs the production preflight with strict readiness semantics: warnings, such as missing Gemini auth inputs, also produce a non-zero exit. Use it as the final local gate before declaring all strategic backend runtimes and credentials ready.
`check:agent-backend-adapters:ready` is the one-command readiness gate. It runs strict preflight first and stops there if local runtime or credential setup is missing. Once strict preflight passes, it covers Codex with isolated live smoke when Codex is selected, then runs live smoke for the remaining selected backends. It honors `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` for subset readiness checks, and defaults Codex live smoke to `gpt-5.4` unless `AGENT_SERVER_CODEX_MODEL` is already set.
Gemini readiness uses `AGENT_SERVER_GEMINI_FUNCTIONAL_SMOKE=1` by default so local runs can verify the AgentServer adapter lifecycle and structured event contract without real Google/Gemini credentials. Set `AGENT_SERVER_GEMINI_REQUIRE_REAL_AUTH=1` when you want the Gemini readiness gate to require real Gemini/Google auth and service access.
Set `AGENT_SERVER_ADAPTER_READINESS_DRY_RUN=1` with `check:agent-backend-adapters:ready` to print the planned readiness steps without running preflight or live smoke. This is useful when checking backend subsets or reviewing readiness behavior after script changes.
`prepare:gemini-sdk-dev` prepares the vendored Gemini checkout for local `tsx` development fallback by installing workspace links, generating git metadata, attempting the official core/sdk builds, and copying policy TOML assets into the partial dist tree if the upstream build is blocked. This does not replace the production requirement to build or link a clean `@google/gemini-cli-sdk` package.
`smoke:agent-backend-adapters` verifies that the strategic agent-backend adapter set is registered and exposes structured capabilities for Codex, Claude Code, Gemini, and the self-hosted agent. By default it runs a contract smoke that does not require external model credentials. It can also explicitly verify ecosystem entry adapters with `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=openclaw,hermes-agent`. Set `AGENT_SERVER_LIVE_ADAPTER_SMOKE=1` to also run a real `runTurn` smoke against the installed backend runtimes: it creates a temporary workspace, sends a handoff packet, consumes structured events, and requires a completed `stage-result`. Set `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex,gemini` to verify a subset while bringing local runtimes online.
`smoke:agent-backend-adapters:codex-isolated` runs Codex live smoke with a temporary `CODEX_HOME` containing copied auth/config files but no copied sqlite state. It is useful after upstream Codex updates when local state migrations may be stale.
Codex app-server may emit transient `error` notifications with `willRetry: true` while it retries stream sampling or falls back to HTTP. AgentServer maps those to non-terminal running status events and waits for the final app-server outcome. Use `AGENT_SERVER_CODEX_MODEL` and `AGENT_SERVER_CODEX_EFFORT` to test account-specific model access; on the current ChatGPT Pro auth path, `gpt-5.4` passes isolated live smoke, while `gpt-5.2-codex` can be listed but rejected by the upstream app-server for this account.
`smoke:agent-backend-adapters:live-smoke-llm` runs live `runTurn` smoke with a temporary OpenAI-compatible endpoint injected into bridge-capable adapters. It is useful for Claude Code/self-hosted plumbing checks before the real shared endpoint is available. Codex can use this class of endpoint through its custom provider + responses bridge path; Gemini still needs Gemini/Google-native runtime credentials for full production-like live smoke.
`smoke:agent-sdk:all-backends` verifies the external SDK/HTTP streaming surface for every backend id in `listSupportedBackends()`. It requires managed launcher binaries for native backends under `server/backend/bin` or `OPENTEAM_BACKEND_BIN_DIR`; otherwise it fails rather than silently accepting partial backend coverage.
`smoke:agent-sdk:installed` verifies the npm package install path and also runs every backend by pointing the installed package at the managed launcher directory.

To test only the OpenTeam Agent backend:

```bash
npm run smoke:openteam-agent
AGENT_SERVER_TOOL_MATRIX_BACKENDS=openteam_agent npm run smoke:agent-server:tool-matrix
```

## Compatibility Rule

Project-specific fields should go in `metadata`. AgentServer stores and returns metadata for audit, but does not attach business meaning to it.

```ts
metadata: {
  project: 'openteam-studio-run',
  teamId: 'team-1',
  requestId: 'request-1',
  taskId: 'task-1',
}
```
