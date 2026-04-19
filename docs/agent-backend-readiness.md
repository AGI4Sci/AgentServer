# Agent Backend Readiness

最后更新：2026-04-19

本文档是首版 strategic agent backend 的本机就绪检查入口，覆盖 Codex、Claude Code、Gemini 和自研 agent。

## One Command

```bash
npm run check:agent-backend-adapters:ready
```

该命令会：

- 按 backend 逐个运行 strict preflight，确认 runtime、endpoint、SDK shape 和凭据输入。
- strict preflight 只会被失败项和阻塞型 warning 拦住；Codex rate-limit 接口暂时不可读这类诊断型 warning 会保留输出，但不阻止后续 live smoke。
- 某个 backend 的 strict preflight 失败时，只跳过该 backend 的 live smoke；其它已选 backend 会继续执行。
- Codex 使用 isolated `CODEX_HOME` 跑 live smoke。
- 其它已选 backend 跑真实 `runTurn` live smoke。

可从 [`examples/agent-backend-readiness.env.example`](../examples/agent-backend-readiness.env.example) 复制本机环境变量模板。不要把真实密钥提交到仓库。

推荐把真实 endpoint 和 auth input 放进本地未提交文件，例如 `.agent-backend-readiness.local.env`：

```bash
AGENT_SERVER_ADAPTER_READINESS_ENV_FILE=.agent-backend-readiness.local.env \
npm run check:agent-backend-adapters:ready
```

env 文件只支持简单的 `KEY=value` / `export KEY=value` 行。脚本会先加载该文件，再计算 backend 子集；已有 shell 环境变量优先，不会被 env 文件覆盖。日志只输出文件路径和加载数量，不输出密钥值。

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

真实 live smoke 默认总超时是 300 秒。慢模型或远端 backend 可以临时覆盖：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_TIMEOUT_MS=600000 npm run check:agent-backend-adapters:ready
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

readiness 输出中的 `blockingWarn` 代表会阻止 strict preflight 的 warning；`advisoryWarn` 代表仅供诊断的信息，例如 Codex account/rate-limit 辅助接口暂时不可读。真实 completion 仍要求 `failed=0` 且 `blockingWarn=0`。

完整命令会输出每个 backend 的 `PASSED` / `FAILED` / `SKIPPED` 结果。这样 Codex 已就绪、Gemini 缺凭据、Claude Code endpoint 未启动这类状态可以同时被记录，不会因为一个 backend 的环境缺口遮住其它 backend 的进度。
