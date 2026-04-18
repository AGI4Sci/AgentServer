# AgentServer Docs

最后更新：2026-04-18

这是 AgentServer 的主题文档入口。工程任务板保留在仓库根目录 [`PROJECT.md`](../PROJECT.md)。

## 推荐阅读顺序

日常接入优先读前两篇即可；其它文档按需深入。

1. [Public API](./public-api.md)
   对外接入契约的主要入口。包含 `runTask`、HTTP facade、backend 列表、capability 示例、统一事件和工具原语功能说明。

2. [Architecture](./architecture.md)
   讲 AgentServer Core / Evolution Engine / Backend Harness 的边界，以及为什么 Core 要保持通用、稳定、简洁。

3. [Core Context Contract](./context-core.md)
   讲所有 backend 都能依赖的 external auditable context 契约。

4. [Backend Runtime](./backend-runtime.md)
   讲 backend catalog、managed launcher、runtime supervisor、adapter 如何吸收 backend 差异，以及 smoke 验证。

5. [Agent Server Runtime](./agent-server-runtime.md)
   讲长期 agent 数据目录、session、run、context、maintenance 和恢复接口。

6. [Harness Context Strategy](./context-harness.md)
   讲自研/custom backend 内部可以实验的 context 策略。它不是 AgentServer Core 公共协议。

7. [Deployment](./deployment.md)
   讲云服务部署时如何分离代码、配置、数据、workspace 和 backend launchers，以及如何 prune 构建产物。

8. [Client Worker](./client-worker.md)
   讲 Mac workspace 留在用户端、Ubuntu AgentServer 只做服务控制面时的长期 tool router 设计。

9. [Tutorial](./tutorial.md)
   用代码和 HTTP client 跑一个最小 AgentServer agent。

10. [Project Board](../PROJECT.md)
   工程任务板在根目录，只记录任务状态和 TODO，不承载架构真相。

## 文档职责

| 文档 | 职责 | 不负责 |
|---|---|---|
| `public-api.md` | 外部项目怎么调用 AgentServer；统一事件和工具原语契约 | 内部 runtime 实现细节 |
| `architecture.md` | 总体原则、边界、分层 | 任务 TODO |
| `context-core.md` | Core 通用 context 契约 | v9 内部 harness 策略 |
| `context-harness.md` | 自研 backend 的 harness 实验策略 | 所有 backend 的公共协议 |
| `backend-runtime.md` | backend 接入、launcher、supervisor、adapter、smoke 验证 | 对外 API 契约的重复定义 |
| `agent-server-runtime.md` | agent/session/run/context 数据与 API | backend 原生协议 |
| `deployment.md` | 服务部署、目录分离、workspace policy、构建产物清理 | backend 内部协议 |
| `client-worker.md` | 用户端 workspace worker、hybrid tool router、Mac + Ubuntu 长期形态 | 当前可用 backend 接线 |
| `tutorial.md` | 从零使用示例 | 架构决策记录 |
| `../PROJECT.md` | 工程任务板 | 对外 API 契约 |

## 单一真相源

- 对外 API、backend id、capability、统一事件和工具原语：[`public-api.md`](./public-api.md)
- backend 元数据代码真相源：[`core/runtime/backend-catalog.ts`](../core/runtime/backend-catalog.ts)
- 工程任务与 TODO：[`PROJECT.md`](../PROJECT.md)
