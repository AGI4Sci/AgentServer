# Building Agents With AgentServer

This repository contains the AgentServer service layer and the backend runtime adapters extracted from OpenTeam Studio. It is intended to be embedded by another Node service or run as a small HTTP server.

## 1. Install

```bash
npm install
```

Use Node.js 20 or newer.

## 2. Configure

Copy the example config and fill in your own model endpoint.

```bash
cp openteam.example.json openteam.json
```

At minimum, set:

- `llm.baseUrl`: OpenAI-compatible API base URL.
- `llm.apiKey`: API key for that endpoint.
- `llm.model`: default model name.

`openteam.json` is intentionally ignored by git because it usually contains secrets.

## 3. Pick A Backend

AgentServer currently knows these backend ids:

- `claude-code`
- `claude-code-rust`
- `codex`
- `openclaw`
- `zeroclaw`

The canonical metadata lives in `core/runtime/backend-catalog.ts`. Each backend declares its executable names and capabilities so launch code and docs do not drift apart.

## 4. Create An Agent In Code

```ts
import { AgentServerService } from './server/agent_server/service.js';

const service = new AgentServerService();

const agent = await service.createAgent({
  name: 'research-helper',
  backend: 'codex',
  workingDirectory: '/absolute/path/to/workspace',
  systemPrompt: 'You are a careful research coding agent.',
});

console.log(agent.id);
```

The working directory must already exist. AgentServer stores local agent state under `server/agent_server/data/`.

## 5. Send A Task

```ts
const run = await service.sendMessage(agent.id, {
  message: 'List the files in this workspace and summarize the project.',
  localDevPolicy: {
    enabled: true,
    mode: 'workspace-write',
    maxSteps: 12,
    allowNetwork: false,
    requireApproval: false,
  },
  contextPolicy: {
    includeFiles: true,
    includeRecentTurns: true,
    persistRunSummary: true,
  },
});

console.log(run.status, run.summary);
```

Supported local development tool call types are:

- `list_dir`
- `read_file`
- `write_file`
- `append_file`
- `grep_search`
- `run_command`
- `apply_patch`
- `web_fetch`
- `web_search`
- `browser_activate`
- `browser_open`

`web_search` depends on the configured external search endpoint in the implementation and may fail if that endpoint is unreachable from the host.

## 6. Run The HTTP Server

```bash
npm run dev:8080
```

Then use `server/agent_server/http-client.ts` from another process:

```ts
import { createAgentServerHttpClient } from './server/agent_server/http-client.js';

const client = createAgentServerHttpClient('http://127.0.0.1:8080');

const agent = await client.createAgent({
  name: 'http-agent',
  backend: 'claude-code',
  workingDirectory: '/absolute/path/to/workspace',
});

const run = await client.sendMessage(agent.id, {
  message: 'Inspect the repository README and summarize it.',
  localDevPolicy: { enabled: true, mode: 'read-only' },
});
```

## 7. Add A New Backend

1. Add its id and capabilities in `core/runtime/backend-catalog.ts`.
2. Add or adapt a worker under `server/runtime/workers/`.
3. Normalize native events into the shared event contract in `server/runtime/workers/backend-event-normalizers.ts`.
4. Add fixtures that prove tool-call, tool-result, permission, error, and result behavior.
5. Run `npm run build` and a smoke task through `AgentServerService` or the HTTP client.

## 8. Verify

```bash
npm run build
npm run smoke:agent-server
```

The smoke script creates an agent against a temporary workspace and verifies the service, store, and context snapshot path without requiring a live model call.
