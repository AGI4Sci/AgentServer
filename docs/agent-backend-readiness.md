# Agent Backend Readiness

最后更新：2026-04-19

本文档是首版 strategic agent backend 的本机就绪检查入口，覆盖 Codex、Claude Code、Gemini 和自研 agent。

## One Command

```bash
npm run check:agent-backend-adapters:ready
```

该命令会：

- 先运行 strict preflight，确认 runtime、endpoint、SDK shape 和凭据输入。
- 如果 strict preflight 失败，停止后续耗时 live smoke。
- 如果 Codex 被选中，用 isolated `CODEX_HOME` 跑 Codex live smoke。
- 对剩余已选 backend 跑真实 `runTurn` live smoke。

可从 [`examples/agent-backend-readiness.env.example`](../examples/agent-backend-readiness.env.example) 复制本机环境变量模板。不要把真实密钥提交到仓库。

## Backend Subsets

用 `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` 只检查一部分 backend：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex npm run check:agent-backend-adapters:ready
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code,self-hosted-agent npm run check:agent-backend-adapters:ready
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini npm run check:agent-backend-adapters:ready
```

查看 readiness 会执行哪些步骤但不真正启动 backend：

```bash
AGENT_SERVER_ADAPTER_READINESS_DRY_RUN=1 npm run check:agent-backend-adapters:ready
```

## Claude Code / Self-Hosted Endpoint

Claude Code bridge 和自研 agent 当前通过 AgentServer supervisor path 使用 OpenAI-compatible LLM endpoint。可以用 `openteam.json` 配置，也可以临时用环境变量覆盖：

```bash
AGENT_SERVER_ADAPTER_LLM_BASE_URL=http://127.0.0.1:3888/v1 \
AGENT_SERVER_ADAPTER_LLM_API_KEY=<key> \
AGENT_SERVER_ADAPTER_LLM_MODEL=<model> \
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code,self-hosted-agent \
npm run check:agent-backend-adapters:ready
```

只验证 plumbing，不依赖真实 endpoint：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code,self-hosted-agent \
AGENT_SERVER_ADAPTER_PREFLIGHT_SMOKE_LLM=1 \
AGENT_SERVER_LIVE_ADAPTER_SMOKE_LLM=1 \
npm run check:agent-backend-adapters:ready
```

## Gemini Auth

Gemini preflight 会检查以下任一 auth input：

- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `~/.gemini/oauth_creds.json`

配置后运行：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini npm run check:agent-backend-adapters:ready
```

如果只想确认 SDK module 和 adapter shape：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini npm run check:agent-backend-adapters
```

## Codex Model

Codex readiness 默认使用 `gpt-5.4`，因为当前 ChatGPT Pro auth path 下 `gpt-5.2-codex` 可能被 upstream app-server 拒绝。需要覆盖时：

```bash
AGENT_SERVER_CODEX_MODEL=gpt-5.4 \
AGENT_SERVER_CODEX_EFFORT=medium \
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex \
npm run check:agent-backend-adapters:ready
```

## Completion Criteria

首版 strategic backend runtime/credential 就绪的完成标准：

```bash
npm run check:agent-backend-adapters:ready
```

该命令必须完成 strict preflight、Codex isolated live smoke，以及所有已选 backend 的真实 `runTurn` live smoke。完成后仍需保留官方 backend checkout 清洁：AgentServer adapter 逻辑应在 AgentServer 侧维护，不写入 `server/backend/codex`、`server/backend/gemini` 或 `server/backend/claude-code`。
