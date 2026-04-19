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

真实 endpoint 和 auth input 默认从 `openteam.json` 的 `llm` 字段读取；同一份 JSON 也是 AgentServer 运行时配置来源，避免 base URL、model name、API key 分散在多个 env 文件里。临时实验仍可显式指定 env 文件，但 readiness gate 不再自动加载 `.agent-backend-readiness.local.env`：

```bash
AGENT_SERVER_ADAPTER_READINESS_ENV_FILE=/absolute/path/to/readiness.local.env \
npm run init:agent-backend-readiness-env
AGENT_SERVER_ADAPTER_READINESS_ENV_FILE=/absolute/path/to/readiness.local.env \
npm run check:agent-backend-adapters:ready
```

初始化脚本不会覆盖已存在文件。env 文件只支持简单的 `KEY=value` / `export KEY=value` 行。脚本只在显式传入 `AGENT_SERVER_ADAPTER_READINESS_ENV_FILE` 时加载 env 文件；已有 shell 环境变量优先，不会被 env 文件覆盖。日志只输出文件路径和加载数量，不输出密钥值。

## Backend Subsets

用 `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` 只检查一部分 backend：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=codex npm run check:agent-backend-adapters:ready
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code,self-hosted-agent npm run check:agent-backend-adapters:ready
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=gemini npm run check:agent-backend-adapters:ready
```

等价的常用快捷命令：

```bash
npm run check:agent-backend-adapters:ready:codex
npm run check:agent-backend-adapters:ready:llm-backends
npm run check:agent-backend-adapters:ready:gemini
```

Gemini readiness 默认验证 AgentServer adapter 功能链路，而不是要求本机有真实 Google/Gemini 凭据。默认路径会启用 `AGENT_SERVER_GEMINI_FUNCTIONAL_SMOKE=1`，使用本地受控 SDK harness 跑通 `startSession`、`runTurn`、结构化事件、`stage-result` 和 `readState`，不访问外部 Google/Gemini 服务。

需要验证真实 Gemini/Google 服务时，显式加：

```bash
AGENT_SERVER_GEMINI_REQUIRE_REAL_AUTH=1 npm run check:agent-backend-adapters:ready:gemini
```

查看 readiness 会执行哪些步骤但不真正启动 backend：

```bash
AGENT_SERVER_ADAPTER_READINESS_DRY_RUN=1 npm run check:agent-backend-adapters:ready
```

真实 live smoke 默认总超时是 300 秒。慢模型或远端 backend 可以临时覆盖：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_TIMEOUT_MS=600000 npm run check:agent-backend-adapters:ready
```

readiness runner 外层还会给每个 preflight/live step 加硬超时，默认 360 秒，用于防止某个 backend bridge 没有正确返回或没有传播内部 timeout。需要更快失败时：

```bash
AGENT_SERVER_ADAPTER_READINESS_STEP_TIMEOUT_MS=120000 npm run check:agent-backend-adapters:ready
```

## Claude Code / Self-Hosted Endpoint

Claude Code bridge 和自研 agent 当前通过 AgentServer supervisor path 使用 OpenAI-compatible LLM endpoint。推荐只改 `openteam.json` 的 `llm.baseUrl`、`llm.apiKey`、`llm.model`、`llm.provider`；AgentServer 会把这份 JSON 映射到 runtime 需要的 canonical `AGENT_SERVER_MODEL_*` / OpenAI-compatible env。

旧的 `AGENT_SERVER_ADAPTER_LLM_BASE_URL`、`AGENT_SERVER_ADAPTER_LLM_API_KEY`、`AGENT_SERVER_ADAPTER_LLM_MODEL`、`AGENT_SERVER_ADAPTER_LLM_PROVIDER` 仍作为兼容输入读取；新接入和文档示例只使用 `AGENT_SERVER_MODEL_*`，保证 provider/model/baseUrl/authType 的唯一解析入口是 AgentServer model runtime resolver。

只验证 plumbing，不依赖真实 endpoint：

```bash
npm run check:agent-backend-adapters:ready:smoke-llm
```

## Gemini Auth

真实 Gemini/Google 服务验证会检查以下任一 auth input：

- `AGENT_SERVER_GEMINI_API_KEY`
- `AGENT_SERVER_GOOGLE_API_KEY`
- `AGENT_SERVER_GOOGLE_APPLICATION_CREDENTIALS`
- `AGENT_SERVER_GEMINI_CLI_HOME`
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `GOOGLE_APPLICATION_CREDENTIALS`
- `~/.gemini/oauth_creds.json`

如需真实 Gemini/Google 凭据，优先使用 `openteam.json` 或显式的 `OPENTEAM_CONFIG_PATH` 管理本机配置；临时环境变量仍可用于一次性验证。AgentServer adapter 和当前 Gemini upstream auth patch 会在启动 Gemini SDK/CLI 前把 `AGENT_SERVER_GEMINI_*` 映射到官方 `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` / `GEMINI_CLI_HOME`。

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

该命令必须完成 strict preflight、Codex isolated live smoke，以及所有已选 backend 的真实 `runTurn` live smoke。官方 backend checkout 默认保持清洁；确需修改时必须是小 patch，并登记到 `docs/upstream-backend-overrides.md`，方便官方源码更新后重放。

readiness 输出中的 `blockingWarn` 代表会阻止 strict preflight 的 warning；`advisoryWarn` 代表仅供诊断的信息，例如 Codex account/rate-limit 辅助接口暂时不可读。真实 completion 仍要求 `failed=0` 且 `blockingWarn=0`。

完整命令会输出每个 backend 的 `PASSED` / `FAILED` / `SKIPPED` 结果。这样 Codex 已就绪、Gemini 缺凭据、Claude Code endpoint 未启动这类状态可以同时被记录，不会因为一个 backend 的环境缺口遮住其它 backend 的进度。
