# AgentServer

AgentServer 是一个面向长期工作的 **agent orchestration runtime**。

它不是新的模型，也不是某个单一 agent harness。它的目标是把 Codex、Claude Code、Gemini、自研 agent，以及生态兼容 backend 统一到一个可恢复、可审计、状态透明的运行层里。上层项目看到的是一个连续工作的 agent；底层可以按任务类型调用不同 backend。

```text
Any Project
  IDE / CI / Research App / Data Platform / Robot Platform
        |
        | runTask(agent, input, metadata)
        v
AgentServer Core
  Agent / Session / Context / Run / Stage / Artifact
  orchestration / handoff / audit / recovery
        |
        v
Backend Adapters
  strategic: Codex / Claude Code / Gemini / self-hosted-agent
  ecosystem: OpenClaw / Hermes Agent
```

## 项目定位

AgentServer 的最终形态是一个对外统一、对内可组合的 agent 编排层。

不同 backend 会长期拥有不同强项：

- **Codex**：代码审查、bug 定位、测试失败分析、diff 风险验证。
- **Claude Code**：实现、重构、跨文件编辑、工程执行。
- **Gemini**：长上下文、多模态、宽范围资料整合。
- **self-hosted-agent / openteam_agent**：自研白盒 harness，用于 context、tool、orchestration 策略实验。

用户不应该感知 backend 切换。对外仍然是：

```text
一个 AgentServer agent
一个 session
一个 run
一个连续上下文
```

内部可以是：

```text
request
  -> orchestrator 拆成 stage
  -> Codex diagnose/review
  -> Claude Code implement
  -> Codex review diff
  -> AgentServer verify/audit/summarize
  -> unified result
```

核心原则：

- AgentServer Core 持有统一上下文、run/stage 审计和编排权。
- 完整 agent backend 必须尽量复用原生 agent loop、工具、session、approval、sandbox 和状态能力。
- 正式 adapter 优先使用 SDK、app-server、JSON-RPC、stdio RPC、HTTP/WebSocket stream 或本地 runtime API。
- CLI 只能作为 bootstrap、debug、fallback 或 compatibility path，不能成为最终状态的不可见控制平面。
- 官方 backend 源码默认保持可同步更新；优先在 AgentServer runtime 层写 adapter。必须修改 upstream 时，要在 `docs/upstream-backend-overrides.md` 记录。

## Backend 分层

首版主线只默认路由到 strategic backend：

```text
strategic
  Codex
  Claude Code
  Gemini
  self-hosted-agent

ecosystem entry
  OpenClaw
  Hermes Agent
```

OpenClaw 和 Hermes Agent 的定位是生态入口：用于承接已有社区、搜索流量、迁移、demo 和对照实验。它们可以通过同一套 `AgentBackendAdapter` 上层接口显式调用，但不进入默认 strategic routing，也不应把专用逻辑推入 AgentServer Core。

## 主要功能

- **统一任务入口**：通过 SDK `createAgentClient().runTask(...)`、`AgentServerService.runTask(...)` 或 HTTP API 调用 backend。
- **长期 agent 状态**：维护 agent、session、memory、persistent state、current work 和 run history。
- **Run / Stage 编排**：一次 request 对外是一个 run，内部可拆成多个可审计 stage，每个 stage 可选择不同 backend。
- **统一 backend adapter**：上层通过同一接口调用 Codex、Claude Code、Gemini、自研 agent、OpenClaw、Hermes Agent。
- **标准事件流**：归一化 `status`、`text-delta`、`tool-call`、`tool-result`、`permission-request`、`stage-result`、`result`、`error`。
- **可审计上下文**：记录 handoff packet、context refs、workspace facts、metrics、evaluation、metadata 和 artifacts。
- **恢复与维护**：支持 context snapshot、compaction、session finalize、persistent recovery、revive 和 recovery acknowledgement。
- **Live Benchmark 预留**：后续用真实任务、离线 replay、shadow review 和用户反馈，持续评估 backend 在不同任务上的强项。

## Quick Start

```bash
npm install
cp openteam.example.json openteam.json
npm run build
npm run smoke:agent-server
```

验证 strategic adapter 注册：

```bash
npm run smoke:agent-backend-adapters
```

显式验证 OpenClaw / Hermes ecosystem adapter：

```bash
AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS=openclaw,hermes-agent npm run smoke:agent-backend-adapters
```

## 最小调用示例

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const agent = createAgentClient({
  defaultBackend: 'codex',
  defaultWorkspace: '/absolute/path/to/workspace',
});

const text = await agent.runText('List the repository files and summarize the project.');

console.log(text);
```

切换 backend 时通常只改：

```ts
backend: 'codex'
```

或显式调用生态入口：

```ts
backend: 'openclaw'
```

## Documentation

The documentation index is [docs/README.md](./docs/README.md). The engineering task board stays at [PROJECT.md](./PROJECT.md).

Start here:

- [Public API](./docs/public-api.md) - SDK/API contract, backend ids, adapter availability, normalized events
- [Architecture](./docs/architecture.md) - long-running runtime, orchestration, context, run/stage model
- [Adapter Contract](./docs/adapter-contract.md) - backend tier, formal transport, capability contract
- [Backend Runtime](./docs/backend-runtime.md)
- [Agent Backend Readiness](./docs/agent-backend-readiness.md)
- [Live Backend Benchmark](./docs/backend-benchmark.md)
- [Deployment](./docs/deployment.md)
- [Tutorial](./docs/tutorial.md)
- [Project Board](./PROJECT.md)

## Supported Backends

Backend ids and capabilities are documented in [Public API](./docs/public-api.md#choose-a-backend). The code truth source is `core/runtime/backend-catalog.ts`; the structured adapter registry lives in `server/runtime/agent-backend-adapter-registry.ts`.

当前上层统一 adapter 已覆盖：

- `codex`
- `claude-code`
- `gemini`
- `self-hosted-agent` / `openteam_agent`
- `openclaw`
- `hermes-agent`

## Notes

Do not commit `openteam.json`; use `openteam.example.json` as the template. Runtime state under `server/agent_server/data/` is ignored.
