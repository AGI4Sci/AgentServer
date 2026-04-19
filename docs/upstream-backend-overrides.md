# Upstream Backend Overrides

最后更新：2026-04-19

本文档记录 AgentServer 为接入官方 backend 而不得不修改 upstream 源码的情况。原则上这里应该尽量为空：adapter、bridge、schema mapping、capability policy 和测试默认都放在 AgentServer 自己的 runtime/docs/tests 中，不落到官方 checkout 里。

## Policy

- 官方 backend 目录默认视为可替换 upstream source，可随官方版本重新 clone、pull 或覆盖。
- 首选接入方式是官方 app-server、SDK、JSON-RPC、stdio RPC、HTTP/WebSocket event stream、本地 runtime API 或 schema-backed bridge。
- 不把 AgentServer adapter 逻辑写进官方源码，除非没有其它稳定入口。
- provider/auth input、结构化状态、工具事件、approval、sandbox metadata、session id、abort/resume、packaging 等原生 runtime 接线问题，仍优先在 AgentServer adapter、bridge、环境变量、配置文件或 capability/profile 降级层解决。
- 如果外围适配需要付出明显不成比例的复杂度，或者外围绕行会明显削弱 backend 原生 agent loop、工具调用、上下文管理、sandbox/approval 或状态透明性，允许对官方源码做小 patch。
- 必须修改官方源码时，改动要小、集中、可重放，并在本文档登记。
- 重新同步官方版本后，先查看本文档，再决定是否需要重放 patch。

## Override Log

当前检查结论：

- `server/backend/codex`：无 AgentServer adapter 必需 patch。
- `server/backend/gemini`：有一个小 auth-env alias patch，见 Gemini 小节；仍存在 upstream clean build debt。
- `server/backend/claude_code`：有一个 AgentServer bridge patch，见 Claude Code 小节。
- AgentServer adapter 代码均放在 `server/runtime/adapters/`、`server/runtime/agent-backend-*.ts`、`scripts/`、`tests/` 和 `docs/` 等 AgentServer 侧路径中。

允许考虑 upstream patch 的典型情况：

- 官方 runtime 不暴露必要 provider/auth input，导致无法通过环境变量、配置文件、SDK option、app-server request 参数或 bridge 注入完成接线。
- 官方 protocol 缺少必要状态、审批、工具事件、sandbox metadata、abort/resume 或 session id，且无法从现有事件/状态稳定推导。
- 官方 build 或 packaging 问题阻塞 production artifact，且 dev fallback 不能满足目标部署。
- 外围 adapter 为了绕过缺口需要复制大量官方内部逻辑，导致后续官方更新更难复用，或更容易损失原生 agent 能力。

每次 patch 前仍应先确认是否可以通过 AgentServer 侧 adapter wrapper、preflight、env override、profile/capability 降级或 readiness 文档解决。

### Codex

当前状态：无 AgentServer adapter 必需的官方源码 patch。

本地路径：

```text
server/backend/codex
```

说明：

- 当前设计要求 Codex adapter 优先通过 Codex app-server / SDK / structured protocol 接入。
- 任意 OpenAI-compatible provider/model 需要进入 Codex 时，AgentServer 侧通过 Codex custom model provider + responses bridge 注入，不修改 Codex 官方源码，也不绕开 Codex app-server 的 native loop、工具、approval、sandbox、session 和结构化事件。
- AgentServer 侧的 adapter contract、capability、handoff、run/stage ledger 和 public API 文档都位于 AgentServer 自己的源码与 `docs/` 中。
- 若未来为暴露缺失事件、状态查询、approval bridge 或 sandbox metadata 而必须修改 Codex 官方源码，需在下方新增记录。

待记录模板：

```text
backend: codex
local path: server/backend/codex
upstream ref: <commit/tag/date>
modified files:
  - <path>
purpose:
  - <why this patch is needed>
replay after upstream update:
  - <steps/checks>
owner:
  - <optional>
```

### Gemini

当前状态：`server/backend/gemini` 有一个小 auth-env alias patch；Gemini live readiness 仍需要真实 Gemini/Google 凭据值，不能通过 patch 伪造。

本地路径：

```text
server/backend/gemini
```

已修改文件：

```text
server/backend/gemini/packages/cli/src/config/auth.ts
server/backend/gemini/packages/cli/src/config/auth.test.ts
```

目的：

- 让 Gemini 官方 CLI auth validation 在直接启动官方 CLI/SDK 路径时也识别 AgentServer namespaced auth env。
- `AGENT_SERVER_GEMINI_API_KEY` 可作为 `GEMINI_API_KEY` alias。
- `AGENT_SERVER_GOOGLE_API_KEY` 可作为 `GOOGLE_API_KEY` alias。
- `AGENT_SERVER_GOOGLE_APPLICATION_CREDENTIALS` 可作为 `GOOGLE_APPLICATION_CREDENTIALS` alias。
- placeholder 值不会覆盖已有官方 env，避免 readiness template 被误判为真实凭据。

重放步骤：

- 重新同步 Gemini upstream 后，检查 `packages/cli/src/config/auth.ts` 的 `validateAuthMethod()` 是否仍只读取官方 env。
- 若仍需要 AgentServer namespaced env，重放 `applyAgentServerAuthEnvAliases()`、`applyEnvAlias()`、`isPlaceholderValue()`，并在 `validateAuthMethod()` 调用 `loadEnvironment()` 后立即应用 aliases。
- 重放 `packages/cli/src/config/auth.test.ts` 中 `AGENT_SERVER_GEMINI_API_KEY` 和 `AGENT_SERVER_GOOGLE_API_KEY` 两个验证用例。
- 重放后运行：

```bash
cd server/backend/gemini
npx vitest run packages/cli/src/config/auth.test.ts
```

已知 upstream build debt：

- `npm run prepare:gemini-sdk-dev` 可以完成 AgentServer 开发态 fallback 准备：安装 workspace links、生成 git metadata、复制 policy TOML，并让 adapter 通过 vendored dist/source 进入 SDK shape/auth preflight。
- 官方 clean build 当前仍失败，直接运行底层检查可复现：

```bash
cd server/backend/gemini
npx tsc --build packages/core/tsconfig.json --pretty false
npx tsc --build packages/sdk/tsconfig.json --pretty false
```

当前错误：

```text
packages/core/src/code_assist/oauth2.ts(72,37): error TS4111: Property 'GEMINI_OAUTH_CLIENT_ID' comes from an index signature, so it must be accessed with ['GEMINI_OAUTH_CLIENT_ID'].
packages/core/src/code_assist/oauth2.ts(80,41): error TS4111: Property 'GEMINI_OAUTH_CLIENT_SECRET' comes from an index signature, so it must be accessed with ['GEMINI_OAUTH_CLIENT_SECRET'].
```

建议处理：

- 继续优先等待/同步官方 Gemini 修复，或在确需本地 production package build 时，在官方 checkout 中把对应 `process.env.GEMINI_OAUTH_CLIENT_ID` / `process.env.GEMINI_OAUTH_CLIENT_SECRET` 改成 bracket access。
- 如果未来决定修改官方源码，必须把实际 patch 按下方模板登记；当前 AgentServer runtime 没有依赖这个 patch。

待记录模板同上。

### Claude Code

当前状态：`server/backend/claude_code` 有 AgentServer bridge patch。

本地路径：

```text
server/backend/claude_code
```

已修改文件：

```text
server/backend/claude_code/openteam-runtime.ts
```

目的：

- 让 AgentServer supervisor bridge 直接从 Claude Code runtime 获得结构化 `tool-result` 事件，而不是只能看到 `tool-call` 和最终文本。
- 给 OpenAI-compatible LLM request 增加官方 runtime 内部 hard timeout，避免上游 endpoint 或 curl/fetch 卡住时只能依赖 AgentServer 外层 readiness timeout。
- 通过 `OPENTEAM_CLAUDE_CODE_LLM_TIMEOUT_MS` 或 `LLM_REQUEST_TIMEOUT_MS` 覆盖默认 120 秒 timeout。

重放步骤：

- 重新同步 Claude Code upstream 后，检查 `openteam-runtime.ts` 是否仍存在并仍作为 AgentServer bridge entry 使用。
- 若仍需要本地 bridge，重放以下改动：新增 LLM request timeout helper；curl 调用增加 `--max-time`；fetch 调用接入 `AbortController`；工具执行后输出 `{ type: 'tool-result', toolName, detail, output }` JSONL。
- 重放后运行：

```bash
node --import tsx --test tests/claude-code-bridge-adapter.test.ts
AGENT_SERVER_ADAPTER_READINESS_STEP_TIMEOUT_MS=120000 AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=claude-code npm run check:agent-backend-adapters:ready
```

说明：

- 当前 Claude Code agent-backend adapter 通过 AgentServer supervisor bridge 暴露 normalized events/result/readState，adapter 逻辑不写入 Claude Code checkout。
- 这个 patch 仍不是最终的一等 SDK/RPC；长期目标仍是把 Claude Code 的 SDK/control/event protocol 作为 AgentServer backend adapter 的正式入口。

待记录模板同上。
