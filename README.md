# AgentServer

AgentServer 是一个面向长期工作的 **distributed agent orchestration runtime**。

它不是新的模型，也不是把几个 CLI 包起来的薄壳。AgentServer 的目标是把 Codex、Claude Code、Gemini、自研 agent，以及生态兼容 backend 统一到一个可恢复、可审计、状态透明的运行层里：上层项目看到的是一个连续工作的 agent，底层可以按任务类型、机器位置、模型 endpoint 和工具能力动态调度不同 backend。

AgentServer 最独特的地方在于：它把 **agent backend 的原生能力** 和 **跨 backend 的统一控制平面** 放在同一个系统里。Codex 仍然可以保留自己的 agent loop、工具、approval、sandbox 和 session；Claude Code 仍然可以专注工程实现；Gemini 仍然可以发挥长上下文能力。AgentServer 负责把它们接成一个透明、可观测、可恢复、可组合的 runtime。

```text
Any Project
  IDE / CI / Research App / Data Platform / Robot Platform
        |
        | runTask(agent, input, metadata)
        v
AgentServer Core
  Agent / Session / Context / Run / Stage / Artifact
  orchestration / handoff / audit / recovery / routing
        |
        v
Backend Adapters
  strategic: Codex / Claude Code / Gemini / self-hosted-agent
  ecosystem: OpenClaw / Hermes Agent
```

## 为什么值得用

普通 agent 集成通常会在两个极端之间摇摆：

- 直接调某个 agent CLI：接入快，但状态不透明，工具调用、sandbox、approval、session、上下文和失败恢复很难被上层可靠管理。
- 自己重写 agent loop：控制力强，但会丢掉 Codex、Claude Code、Gemini 等原生 backend 已经做好的能力。

AgentServer 的定位是第三条路：**复用原生 agent backend 的完整能力，同时提供统一的 SDK/API、事件流、上下文、审计、分布式工具执行和运行时模型选择**。

这让它特别适合：

- 在一个产品里同时使用多个 agent backend，而不是把自己锁死在单一厂商或单一 CLI 上。
- 让 CPU 节点负责联网模型服务，让本地或 GPU 节点负责代码、数据、训练、评测等工具执行。
- 在真实任务中根据 backend 擅长方向分工：Codex 审查和抓 bug，Claude Code 写代码，Gemini 做长上下文理解，自研 agent 做白盒策略实验。
- 给研究平台、CI、IDE、数据平台、机器人平台提供一个长期运行、可恢复、可审计的 agent runtime。

## 独特能力

- **分布式 Agent 拓扑**  
  同一个 run 可以把“大脑”和“手”放在不同机器上：CPU 节点可联网调用模型，本地或 GPU 节点执行 workspace 工具，network tool 可由 backend-server 代理，结果再写回真实 workspace。

- **运行时模型选择**  
  每次 request 都可以传入 `runtime.modelProvider`、`runtime.modelName` 和 `runtime.llmEndpoint`。这意味着同一个 AgentServer 服务可以按任务选择 OpenAI-compatible endpoint、本地模型服务、共享 CPU brain 或 backend 原生模型，而不需要改全局配置。

- **统一但不削弱 backend**  
  AgentServer 不把 Codex、Claude Code、Gemini 降级成纯文本补全。正式 adapter 的目标是保留 backend 原生 agent loop、工具注册、approval、sandbox、session、上下文管理和结构化事件。

- **跨 Backend 编排**  
  一次外部 request 对外仍是一个 run，内部可以拆成可审计 stage：诊断、实现、审查、验证、总结分别由最合适的 backend 执行。

- **状态透明的 SDK/API**  
  上层通过 `runTask(...)`、HTTP API 或 service API 调用，不需要理解每个 backend 的私有协议。事件统一为 `status`、`text-delta`、`tool-call`、`tool-result`、`permission-request`、`stage-result`、`result`、`error`。

- **长期上下文和恢复**  
  AgentServer Core 持有 Agent、Session、ContextItem、Run、Stage、Artifact 等统一对象，支持 handoff packet、context refs、workspace facts、run history、snapshot、compaction、recovery 和 audit。

- **Backend 能力评估预留**  
  Live Benchmark 会作为独立模块持续记录不同 backend 在原子能力和真实应用场景里的表现，用真实任务、replay、shadow review 和用户反馈指导后续 routing 策略。

## 典型拓扑

```text
                         model request
                    +--------------------+
                    | CPU node / model   |
                    | OpenAI-compatible  |
                    +---------^----------+
                              |
                              |
Any Project                   |
  runTask(runtime.llmEndpoint)|            workspace tools
        |                     |        +----------------+
        v                     |        | local machine  |
AgentServer Core -------------+------> | code / files   |
        |                              +----------------+
        |
        | routed tool call
        v
  +----------------+
  | GPU worker     |
  | train / eval   |
  | no public net  |
  +----------------+
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
- **Per-request 模型连接**：每个 request 可独立指定 provider、model name、base URL 和 auth input，优先级高于全局环境变量和配置文件。
- **分布式工具路由**：支持 server、ssh、client-worker 等 worker 类型，把 workspace side-effect、compute、network 工具放到最合适的位置执行。
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

按 request 选择模型服务：

```ts
const result = await agent.runTask('Review this diff and run the relevant checks.', {
  runtime: {
    modelProvider: 'openai-compatible',
    modelName: 'shared-cpu-brain',
    llmEndpoint: {
      provider: 'openai-compatible',
      baseUrl: 'http://cpu-node.internal:18765/v1',
      apiKey: process.env.AGENT_SERVER_MODEL_API_KEY,
      modelName: 'shared-cpu-brain',
    },
  },
});
```

这仍然会走所选 backend 的原生 agent 执行链路；`llmEndpoint` 只是在本次 request 中覆盖模型连接。

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
