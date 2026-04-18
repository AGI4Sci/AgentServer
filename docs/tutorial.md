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

## 4. Create An Agent Client

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const agent = createAgentClient({
  defaultWorkspace: '/absolute/path/to/workspace',
  defaultBackend: 'codex',
  defaultSystemPrompt: 'You are a careful research coding agent.',
});

console.log(agent.listBackends().map((backend) => backend.id));
```

The working directory must already exist. AgentServer stores local agent state under `server/agent_server/data/`.

For production deployment, keep code/config/data/workspaces/backend launchers separate. See [Deployment](./deployment.md).

## 5. Create Or Reuse An Agent

For one-shot tasks, `runTask()` can create/reconcile the agent for you from `agentId` and the SDK defaults. If your host project wants explicit lifecycle control, create the agent first:

```ts
const manifest = await agent.createAgent({
  id: 'research-helper',
  name: 'Research Helper',
  backend: 'codex',
  workingDirectory: '/absolute/path/to/workspace',
  systemPrompt: 'You are a careful research coding agent.',
});

console.log(manifest.id);
```

You can later call `agent.getAgent(id)`, `agent.listAgents()`, and `agent.listRuns(id)` for audit and UI state.

## 6. Send A Task

```ts
const run = await agent.runTask('List the files in this workspace and summarize the project.', {
  agentId: 'research-helper',
  runtime: {
    localDevPolicy: {
      isSourceTask: true,
      maxSteps: 12,
      forceSummaryOnBudgetExhausted: true,
    },
  },
  contextPolicy: {
    includeCurrentWork: true,
    includeRecentTurns: true,
    persistRunSummary: true,
  },
});

console.log(run.run.status, run.run.output);
```

Backend adapters absorb native backend differences and emit normalized events. The event contract lives in [Public API / Shared Event Contract](./public-api.md#shared-event-contract), and tool descriptions live in [Public API / Canonical Tool Primitives](./public-api.md#canonical-tool-primitives).

## 7. Run The HTTP Server

```bash
npm run dev:8080
```

Then use the SDK HTTP mode from another process:

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  baseUrl: 'http://127.0.0.1:8080',
  defaultBackend: 'claude-code',
  defaultWorkspace: '/absolute/path/to/workspace',
});

const run = await client.runTask('Inspect the repository README and summarize it.', {
  agentId: 'http-agent',
  onEvent(event) {
    console.log(event.type);
  },
  runtime: {
    localDevPolicy: {
      isSourceTask: true,
      maxSteps: 6,
    },
  },
});
```

When `onEvent` is supplied in HTTP mode, the SDK uses the streaming endpoint and emits the same normalized events as local mode.

## 8. Add A New Backend

Backend integration steps live in [Backend Runtime](./backend-runtime.md#接入新-backend).

## 9. Verify

```bash
npm run build
npm run smoke:agent-sdk
npm run smoke:agent-sdk:all-backends
npm run smoke:agent-sdk:installed
npm run smoke:agent-server
```

The smoke script creates an agent against a temporary workspace and verifies the service, store, and context snapshot path without requiring a live model call.
