# Deployment

AgentServer should be deployed as a small runtime host, not as a copy of every project that wants to use agents.

## Recommended Layout

Keep code, config, state, workspaces, and backend launchers separate:

```text
/opt/agent-server/app/          AgentServer code or release artifact
/opt/agent-server/config/       openteam.json and secrets
/opt/agent-server/data/         AgentServer durable state
/opt/agent-server/backend-state/ runtime supervisor/backend scratch state
/opt/agent-server/bin/          openteam_* backend launchers
/opt/agent-server/workspaces/   optional server-side workspaces
```

Runtime environment:

```bash
export OPENTEAM_CONFIG_PATH=/opt/agent-server/config/openteam.json
export AGENT_SERVER_DATA_DIR=/opt/agent-server/data
export AGENT_SERVER_BACKEND_STATE_DIR=/opt/agent-server/backend-state
export OPENTEAM_BACKEND_BIN_DIR=/opt/agent-server/bin
export AGENT_SERVER_ENABLED_BACKENDS=openteam_agent,codex,claude-code,hermes-agent,openclaw
export PORT=8080
```

## Workspace Policy

Cloud AgentServer cannot directly operate on a user's laptop files or SSH GPU files unless a worker/executor is registered for that machine. The long-term model is:

```text
backend = service-side brain
workspace = data/result home
worker = execution machine
route = primary/fallback worker plan for each tool-call
```

Choose execution ownership explicitly:

| Scenario | Workspace | Worker |
|---|---|---|
| Server-local work | server workspace | server worker |
| Mac local work | Mac workspace | client-worker |
| SSH GPU work | GPU workspace | ssh worker |
| GPU without network | GPU workspace | network tools route to backend-server, file/shell tools route to GPU worker |

Example route configuration:

```jsonc
{
  "runtime": {
    "workspace": {
      "workspaces": [
        {
          "id": "gpu-exp",
          "root": "/home/ubuntu/experiments/run-001",
          "artifactRoot": "/home/ubuntu/experiments/run-001/artifacts",
          "ownerWorker": "gpu-a100"
        }
      ],
      "workers": [
        {
          "id": "backend-server",
          "kind": "backend-server",
          "capabilities": ["network", "metadata"]
        },
        {
          "id": "gpu-a100",
          "kind": "ssh",
          "host": "gpu.example.com",
          "user": "ubuntu",
          "port": 22,
          "identityFile": "/opt/agent-server/ssh/id_ed25519",
          "allowedRoots": ["/home/ubuntu/experiments"],
          "capabilities": ["filesystem", "shell", "gpu"]
        }
      ],
      "toolRouting": {
        "default": {
          "primary": "gpu-a100"
        },
        "rules": [
          {
            "tools": ["web_search", "web_fetch"],
            "primary": "backend-server"
          }
        ]
      }
    }
  }
}
```

Current AgentServer versions implement route planning, configuration parsing, SDK helpers, and routed executors for `backend-server`, `server`, `ssh`, and `client-worker`. Real `container` and `remote-service` executors are the next phase. If a GPU machine cannot access the internet, route `web_search` / `web_fetch` to `backend-server`; AgentServer can write the network result back into an SSH-owned workspace artifact through the SSH worker. If a Mac workspace should stay local, run a client-worker next to that workspace and set its `endpoint`.

SSH execution uses the system `ssh` command. In production, configure key-based auth and batch mode-friendly hosts; for custom packaging, override the binary with `AGENT_SERVER_SSH_BIN`.

The client-worker executor calls HTTP `POST /tool-call` on the configured endpoint. The request includes `workspace`, `cwd`, `toolName`, and `args`; the response should be JSON with `{ "ok": boolean, "output": string }`.

Run the bundled minimal client-worker on the machine that owns the workspace:

```bash
AGENT_SERVER_CLIENT_WORKER_ROOTS=/Applications/workspace/my-project \
AGENT_SERVER_CLIENT_WORKER_PORT=3457 \
AGENT_SERVER_CLIENT_WORKER_TOKEN=change-me-client-worker-token \
npm run client-worker
```

Then configure the AgentServer worker:

```jsonc
{
  "id": "mac-local",
  "kind": "client-worker",
  "endpoint": "http://127.0.0.1:3457",
  "authToken": "change-me-client-worker-token",
  "allowedRoots": ["/Applications/workspace/my-project"],
  "capabilities": ["filesystem", "shell", "network"]
}
```

When `AGENT_SERVER_CLIENT_WORKER_TOKEN` is set, `/capabilities` and `/tool-call` require `Authorization: Bearer <token>` or `x-agent-server-token: <token>`. Keep this token local/secret; do not expose the bundled client-worker on the public internet without TLS and stronger auth.

`executionMode: "local" | "client"` is still accepted for backward compatibility. New deployments should use `mode: "server" | "client" | "hybrid"`.

You can override the config at runtime:

```bash
export AGENT_SERVER_WORKSPACE_MODE=server
```

## Build And Prune

Build backend launchers into an external bin directory:

```bash
export OPENTEAM_BACKEND_BIN_DIR=/opt/agent-server/bin
npm run build
npm run build:backend-binaries
```

`build:backend-binaries` prunes backend build artifacts by default after copying launchers. To keep build caches:

```bash
AGENT_SERVER_PRUNE_AFTER_BUILD=0 npm run build:backend-binaries
```

To build only selected backend launchers:

```bash
AGENT_SERVER_BUILD_BACKENDS=codex,claude_code,hermes_agent,openclaw npm run build:backend-binaries
```

Manual prune:

```bash
npm run prune:backend-artifacts
```

The prune script removes large regenerable artifacts such as:

```text
server/backend/codex/codex-rs/target
server/backend/zeroclaw/target
server/backend/claude_code_rust/target
server/backend/hermes_agent/web/node_modules
```

## Deployment Check

Before starting the service:

```bash
npm run check:deployment
npm run smoke:deployment-workers
```

This checks:

- `OPENTEAM_CONFIG_PATH`
- `AGENT_SERVER_DATA_DIR` writability
- `OPENTEAM_BACKEND_BIN_DIR` launchers for enabled backends
- `openteam_agent` vendored SDK runtime
- configured `serverAllowedRoots`
- configured workspaces
- configured workers
- worker `allowedRoots` for `server` / `ssh` / `client-worker`
- SSH worker `host` and optional `identityFile`
- client-worker `endpoint` and `authToken`
- workspace root alignment with owner worker `allowedRoots`
- configured tool routing summary

To check only selected backends:

```bash
AGENT_SERVER_ENABLED_BACKENDS=openteam_agent,codex,claude-code,hermes-agent,openclaw npm run check:deployment
```

`AGENT_SERVER_ENABLED_BACKENDS` also controls which backends are listed by the SDK helpers and accepted by `runTask()`. Disabled backends fail fast instead of being advertised as available.

## Start

```bash
npm start
```

For production, run it under `systemd`, `pm2`, Docker, or another process supervisor.
