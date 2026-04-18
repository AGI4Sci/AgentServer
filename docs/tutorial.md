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

Backend ids are public inputs to `runTask`, and ordinary integration code can switch backend by changing the backend id. The canonical list and capability query examples live in [Public API](./public-api.md#choose-a-backend).

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
    isSourceTask: true,
    maxSteps: 12,
    forceSummaryOnBudgetExhausted: true,
  },
  contextPolicy: {
    includeCurrentWork: true,
    includeRecentTurns: true,
    persistRunSummary: true,
  },
});

console.log(run.status, run.summary);
```

Backend adapters absorb native backend differences and emit normalized events. The event contract lives in [Public API / Shared Event Contract](./public-api.md#shared-event-contract), and tool descriptions live in [Public API / Canonical Tool Primitives](./public-api.md#canonical-tool-primitives).

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
  localDevPolicy: {
    isSourceTask: true,
    maxSteps: 6,
  },
});
```

## 7. Add A New Backend

Backend integration steps live in [Backend Runtime](./backend-runtime.md#接入新-backend).

## 8. Verify

```bash
npm run build
npm run smoke:agent-server
```

The smoke script creates an agent against a temporary workspace and verifies the service, store, and context snapshot path without requiring a live model call.
