# AgentServer

AgentServer 是一个可独立运行的 **long-running agent runtime**。

它的目标是把“长期工作的 agent”从具体产品里抽出来，做成一个通用、稳定、可审计的运行层。上层项目只需要告诉它：

- 用哪个 backend agent
- 在哪个 workspace 工作
- 要执行什么任务
- 需要附带哪些项目 metadata

AgentServer 负责维护长期 agent 状态、session、context、run audit、工具事件和恢复能力。

## 项目定位

AgentServer 不是一个新的模型，也不是某个单一 agent harness。它更像一个 **Agent Runtime Gateway**：

```text
Any Project
  OpenTeam / IDE / CI / Research App / Robot Platform
        |
        | runTask(agent, input, metadata)
        v
AgentServer Core
  long-running agent state
  external auditable context
  run gateway
  audit / recovery / maintenance
        |
        v
Backend Runtime
  openteam_agent / claude-code / claude-code-rust / codex / hermes-agent / openclaw / zeroclaw
```

核心原则是：**AgentServer Core 保持通用，backend harness 保持自治。**

AgentServer 只管理跨 backend 都成立的外部上下文和审计数据；每个 backend 自己管理内部 system prompt、tool policy、memory、skill、compaction 和 provider 策略。

## 主要功能

- **统一任务入口**：通过 `AgentServerService.runTask(...)` 或 `POST /api/agent-server/runs` 调用不同 backend。
- **长期 agent 状态**：维护 agent、session、memory、persistent state、current work 和 run history。
- **统一 backend 切换**：上层基本只需切换 `agent.backend` 或 `runtime.backend` 参数。
- **标准事件流**：归一化 `status`、`text-delta`、`tool-call`、`tool-result`、`permission-request`、`result`、`error`。
- **可审计上下文**：记录 `contextRefs`、metrics、evaluation、metadata 和 run events。
- **维护与恢复**：支持 context snapshot、compaction、session finalize、persistent recovery、revive 和 recovery acknowledgement。
- **可选演化层**：Evolution Engine 可以读取 run ledger 并生成 proposal，但复杂自进化决策不进入 Core。

## Quick Start

```bash
npm install
cp openteam.example.json openteam.json
npm run build
npm run smoke:agent-server
```

## Documentation

The documentation index is [docs/README.md](./docs/README.md). The engineering task board stays at [PROJECT.md](./PROJECT.md).

Start here:

- [Public API](./docs/public-api.md) - integration contract, backend ids, normalized events, and tool primitives
- [Architecture](./docs/architecture.md)
- [Backend Runtime](./docs/backend-runtime.md)
- [Agent Server Runtime](./docs/agent-server-runtime.md)
- [Tutorial](./docs/tutorial.md)
- [Project Board](./PROJECT.md)

## Supported Backends

Backend ids and capabilities are documented in [Public API](./docs/public-api.md#choose-a-backend). The code truth source is `core/runtime/backend-catalog.ts`.

## 最小调用示例

```ts
import { createAgentClient } from '@agi4sci/agent-server';

const agent = createAgentClient({
  defaultBackend: 'openteam_agent',
  defaultWorkspace: '/absolute/path/to/workspace',
});

const text = await agent.runText('List the repository files and summarize the project.');

console.log(text);
```

切换 backend 时通常只改：

```ts
backend: 'hermes-agent'
```

更完整的 API 示例见 [docs/public-api.md](./docs/public-api.md)。

`openteam_agent` 是自研/custom backend 的薄实现。它内置 vendored AI SDK runtime，服务运行时不依赖外部 SDK checkout 或绝对本机路径。

## Notes

Do not commit `openteam.json`; use `openteam.example.json` as the template. Runtime state under `server/agent_server/data/` is also ignored.
