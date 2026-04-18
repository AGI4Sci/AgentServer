# Backend Runtime

最后更新：2026-04-18

## 定位

Backend Runtime 负责吸收不同 backend 的执行差异，让 AgentServer Core 和上层项目只面对统一接口。

一句话：

```text
AgentServer Core -> Backend Runtime -> concrete backend harness
```

AgentServer Core 不直接理解每个 backend 的原生协议。差异集中在：

- backend catalog
- managed launcher
- runtime supervisor
- session runner
- team worker
- event normalizer
- model contract
- backend capability

换句话说：上层看到的是统一 backend id、统一事件、统一工具原语；具体 backend 的启动方式、原生协议、原生工具名和事件细节由 Backend Runtime adapter 自动适配。对外契约以 [Public API](./public-api.md) 为准。

## Backend Catalog

权威 backend 列表在 [`core/runtime/backend-catalog.ts`](../core/runtime/backend-catalog.ts)。

当前 backend：

- `openteam_agent`
- `claude-code`
- `claude-code-rust`
- `codex`
- `hermes-agent`
- `openclaw`
- `zeroclaw`

每个 backend 声明：

- `id`
- `label`
- `family`
- `executables`
- `capabilities`

上层项目不应该硬编码 launcher 名称，应读取 catalog 或使用 `listSupportedBackends()` / `getBackendCapabilities()`。

## Managed Launchers

standalone AgentServer 使用项目内 launcher：

```text
server/backend/bin/openteam_*
```

生成入口：

```bash
npm run build:backend-binaries
```

运行时查找规则：

```text
OPENTEAM_BACKEND_BIN_DIR || server/backend/bin
```

这避免依赖全局 PATH，也避免本机安装的 `codex`、`openclaw`、`zeroclaw` 与项目内 backend 混淆。

`openteam_agent` 是 direct backend，不需要 managed launcher。它通过 `SessionRunner` 直接接入 AgentServer，并在模型调用层使用项目内 vendored SDK runtime。

## Runtime Supervisor

Runtime Supervisor 提供 backend worker 的常驻管理能力。

主要职责：

- 为 backend 创建或复用 worker
- 维护 persistent session
- 隔离不同 project root 的 supervisor
- 统一转发流式事件
- 提供 health / diagnostics

standalone AgentServer 默认 supervisor 端口为 `8767`，避免与 `openteam-studio-run` 默认端口冲突。health response 会包含 `projectRoot`，client 侧会校验 project root，避免跨项目误连。

## Session Runner

所有 backend 最终都收敛到同一个 session runner contract：

```ts
interface SessionRunner {
  run(input: SessionInput, options: RunSessionOptions): Promise<SessionOutput>;
  runStream(
    input: SessionInput,
    options: RunSessionOptions,
    handlers: { onEvent: (event: SessionStreamEvent) => void },
  ): Promise<SessionOutput>;
}
```

对上层来说，切换 backend 只需要换参数：

```ts
agent: {
  backend: 'codex',
  workspace: '/absolute/path/to/workspace',
}
```

或：

```ts
runtime: {
  backend: 'hermes-agent',
}
```

## Unified Events

所有 backend 事件归一化为同一组 `SessionStreamEvent`。标准事件列表和语义见 [Public API / Shared Event Contract](./public-api.md#shared-event-contract)。

标准事件语义由 [`server/runtime/session-types.ts`](../server/runtime/session-types.ts) 定义。

backend 原生事件可以保存在 `raw` 字段中用于调试，但上层业务不应依赖 `raw`。

## Unified Tool Primitives

AgentServer shared tool bridge 提供一组 canonical tool primitive。完整列表和功能说明见 [Public API / Canonical Tool Primitives](./public-api.md#canonical-tool-primitives)。

这些名称是上层项目应该理解和展示的稳定名称。不同 backend 内部可以使用不同协议或工具表示，但进入 AgentServer run event 后应尽量归一化为：

```text
tool-call:{toolName}
tool-result:{toolName}
```

例如 `codex`、`openclaw`、`hermes-agent` 可以有不同的内部 tool loop；上层项目仍只处理 `tool-call:list_dir`、`tool-result:list_dir` 这类标准事件。

## Tool Smoke

统一工具调用兼容性由两层验证：

```bash
npm test
npm run smoke:agent-server:backends
npm run smoke:agent-server:tool-matrix
```

- fixture parity：验证 event normalization 语义。
- backend live smoke：验证 managed launcher、模型配置、runtime supervisor、真实 `list_dir` 工具调用链路。
- tool matrix smoke：验证所有 supported backend 是否都能调用全部 canonical tool primitives。

如果只验证 OpenTeam Agent backend：

```bash
npm run smoke:openteam-agent
AGENT_SERVER_TOOL_MATRIX_BACKENDS=openteam_agent npm run smoke:agent-server:tool-matrix
```

## 接入新 Backend

新增 backend 的最小步骤：

1. 在 [`core/runtime/backend-catalog.ts`](../core/runtime/backend-catalog.ts) 注册 id、family、executables、capabilities。
2. 如果 backend 需要项目内 launcher，在 [`core/runtime/backend-paths.ts`](../core/runtime/backend-paths.ts) 注册 managed backend 路径。
3. 增加 session client 或 team worker。
4. 接入 [`server/runtime/session-runner-registry.ts`](../server/runtime/session-runner-registry.ts)。
5. 接入 [`server/runtime/team-worker-manager.ts`](../server/runtime/team-worker-manager.ts)。
6. 如有原生事件，更新 [`server/runtime/workers/backend-event-normalizers.ts`](../server/runtime/workers/backend-event-normalizers.ts)。
7. 如果是 managed backend，在 [`scripts/build-openteam-backends.ts`](../scripts/build-openteam-backends.ts) 增加 launcher 构建。
8. 增加 fixture parity。
9. 跑 `npm run build`、`npm test`、`npm run smoke:agent-server:backends`。

## OpenTeam Agent

`openteam_agent` 是 `docs/context-harness.md` 所指的自研/custom backend 的第一阶段实现：

- 模型调用层使用 `server/backend/openteam_agent/node_modules` 下的 vendored AI SDK runtime。
- 工具调用仍走 AgentServer shared tool bridge，因此上层看到的是统一 `tool-call` / `tool-result` 事件。
- 它是 Backend Harness 层实现，不代表 v9 context design 已经进入 AgentServer Core。
- 当前是 direct backend，`managedLauncher=false`，不生成 `openteam_*` launcher。
- 服务运行不依赖外部 SDK checkout 或绝对本机路径。

验证：

```bash
AGENT_SERVER_TOOL_MATRIX_BACKENDS=openteam_agent npm run smoke:agent-server:tool-matrix
```

## Hermes Agent

`hermes-agent` 当前是第一阶段集成：

- 源码位于 `server/backend/hermes_agent`
- launcher 为 `openteam_hermes_agent`
- 已接入 catalog、session runner、fixture parity、live smoke
- 当前通过 AgentServer tool bridge 保证统一工具事件

Hermes 的 memory、skill、自进化策略仍属于 Hermes backend/harness 内部，不上移到 AgentServer Core。

ACP stdio/native event 双向协议属于后续增强，只有在需要 Hermes 原生 memory/skill/subagent/interrupt 细粒度审计时再推进。
