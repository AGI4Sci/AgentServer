# AgentServer Public API

This is the thin integration surface for projects that want to use AgentServer without reading the backend runtime internals.

For in-process SDK usage, set `OPENTEAM_CONFIG_PATH` before importing the package if you need a non-default config file.

## Choose A Backend

Backend ids are stable public inputs for `runTask`.

```ts
import {
  BACKEND_CATALOG,
  createAgentClient,
  getBackendCapabilities,
  listSupportedBackends,
} from '@agi4sci/agent-server';

const agent = createAgentClient();
console.log(agent.listBackends().map((backend) => backend.id));
console.log(listSupportedBackends().map((backend) => backend.id));
// [
//   'openteam_agent',
//   'claude-code',
//   'claude-code-rust',
//   'codex',
//   'hermes-agent',
//   'openclaw',
//   'zeroclaw',
// ]

for (const backend of BACKEND_CATALOG) {
  console.log(backend.id, backend.label, backend.capabilities);
}

const caps = getBackendCapabilities('codex');
if (caps.interrupt) {
  // Enable UI affordances that depend on interrupt support.
}
```

Use capabilities for advanced UI or routing decisions. For ordinary task execution, changing only `agent.backend` is enough.

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
backend: 'hermes-agent'
```

with the same task input and event handling code.

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

## Manage Agent Lifecycle

The SDK also exposes the small lifecycle surface most host projects need:

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  defaultBackend: 'openteam_agent',
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
// or 'claude-code-rust'
// or 'codex'
// or 'hermes-agent'
// or 'openclaw'
// or 'zeroclaw'
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
  defaultBackend: 'hermes-agent',
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
type Event =
  | { type: 'status'; status: 'starting' | 'running' | 'waiting_permission' | 'completed' | 'failed'; message?: string }
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolName: string; detail?: string }
  | { type: 'tool-result'; toolName: string; detail?: string; output?: string }
  | { type: 'permission-request'; requestId: string; toolName: string; detail?: string }
  | { type: 'result'; output: { success: true; result: string } | { success: false; error: string } }
  | { type: 'error'; error: string };
```

The event interface is uniform. Backend capabilities describe which advanced behaviors are available or meaningful for a specific backend.

Event meanings:

| Event | Meaning |
|---|---|
| `status` | Backend/runtime lifecycle update, such as starting, running, waiting, completed, or failed. |
| `text-delta` | Assistant text streamed or emitted by the backend. |
| `tool-call` | A real tool invocation started. `toolName` uses the canonical primitive name when routed through the shared tool bridge. |
| `tool-result` | A real tool invocation finished. `output` contains the auditable result text when available. |
| `permission-request` | Backend requested approval before continuing a sensitive action. |
| `result` | Final run output. |
| `error` | Runtime or adapter error that could not be represented as a normal result. |

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
npm run smoke:agent-sdk:all-backends
npm run smoke:agent-server:tool-matrix
```

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
