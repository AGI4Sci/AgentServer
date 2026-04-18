# AgentServer Public API

This is the thin integration surface for projects that want to use AgentServer without reading the backend runtime internals.

## Choose A Backend

Backend ids are stable public inputs for `runTask`.

```ts
import {
  BACKEND_CATALOG,
  getBackendCapabilities,
} from './core/runtime/backend-catalog.js';
import { listSupportedBackends } from './server/runtime/session-runner-registry.js';

console.log(listSupportedBackends());
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

## Run A Task In Process

```ts
import { AgentServerService } from './server/agent_server/service.js';

const service = new AgentServerService();

const result = await service.runTask({
  agent: {
    id: 'repo-helper',
    name: 'Repo Helper',
    backend: 'codex',
    workspace: '/absolute/path/to/workspace',
    systemPrompt: 'You are a careful coding agent.',
    reconcileExisting: true,
    metadata: {
      project: 'my-app',
    },
  },
  input: {
    text: 'List the repository files and summarize the project.',
    metadata: {
      taskId: 'task-123',
    },
  },
  runtime: {
    localDevPolicy: {
      isSourceTask: true,
      maxSteps: 6,
      forceSummaryOnBudgetExhausted: true,
    },
    metadata: {
      endpointId: 'local',
    },
  },
  metadata: {
    requestId: 'request-123',
  },
});

console.log(result.run.status);
console.log(result.run.output);
console.log(result.run.events);
```

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
import { createAgentServerHttpClient } from './server/agent_server/http-client.js';

const client = createAgentServerHttpClient('http://127.0.0.1:8080');

const result = await client.runTask({
  agent: {
    id: 'repo-helper',
    backend: 'hermes-agent',
    workspace: '/absolute/path/to/workspace',
    reconcileExisting: true,
  },
  input: {
    text: 'Use list_dir on "." and summarize the files.',
  },
});

const audit = await client.getRun(result.run.id);
console.log(audit.events);
```

Equivalent raw HTTP endpoint:

```text
POST /api/agent-server/runs
GET  /api/agent-server/runs/:runId
```

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
npm run smoke:agent-server:tool-matrix
```

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
