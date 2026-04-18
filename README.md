# AgentServer

Standalone AgentServer runtime and backend adapter layer extracted from OpenTeam Studio.

This repository contains:

- `server/agent_server`: the long-lived agent service, store, HTTP client types, and autonomy loop.
- `server/backend`: backend source trees and integration notes for Claude Code, Claude Code Rust, Codex, OpenClaw, and ZeroClaw.
- `server/runtime` and `server/runtime-supervisor`: shared runtime contracts, worker launchers, event normalization, local development tools, and supervisor plumbing.
- `core/runtime`: backend catalog, runtime metadata, and shared coordination types used by AgentServer.

Generated artifacts, dependency folders, runtime state, and local secrets are intentionally excluded.

## Quick Start

```bash
npm install
cp openteam.example.json openteam.json
npm run build
npm run smoke:agent-server
```

For a full walkthrough, see [TUTORIAL.md](./TUTORIAL.md).

## Supported Backends

- `claude-code`
- `claude-code-rust`
- `codex`
- `openclaw`
- `zeroclaw`

Backend metadata is centralized in `core/runtime/backend-catalog.ts`.

## Local Tools

AgentServer can expose these local development tool calls when `localDevPolicy.enabled` is true:

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

## Notes

Do not commit `openteam.json`; use `openteam.example.json` as the template. Runtime state under `server/agent_server/data/` is also ignored.
