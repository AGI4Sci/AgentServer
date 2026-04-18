# AgentServer Core Context Contract

最后更新：2026-04-18

## 定位

本文档描述 AgentServer Core 可以承诺的通用 context 能力。

它面向所有当前和未来 backend。当前 backend 列表以 [Public API](./public-api.md#choose-a-backend) 和 [`core/runtime/backend-catalog.ts`](../core/runtime/backend-catalog.ts) 为准。

AgentServer Core 只管理 **external auditable context**，也就是外部可审计上下文。backend 自己的 system prompt、内部 compaction、tool policy、memory engine、skill runtime、agent loop 和 provider strategy 都属于 backend harness。

一句话：

```text
AgentServer Core 负责给 backend 提供可审计的外部上下文；
Backend Harness 负责如何在内部使用、压缩、重排、演化这些上下文。
```

## Core 原则

### 1. 简洁稳定

Core 只保留跨项目、跨 backend 都成立的概念。

Context 相关的核心对象是：

```text
Agent
Session
ContextItem
Run
Artifact
```

不要把某个 backend 的内部 prompt layout、compaction tag 格式、memory plugin 协议放进 Core。

### 2. 信息可追溯

任何进入 run 的 context 都应该能在 audit 中解释来源。

Core 应至少记录：

- 本次启用了哪些 context layer
- 本次使用的 context policy
- backend id
- agent id
- session id
- workspace
- run events
- output
- metrics / evaluation / metadata

### 3. 项目差异走 metadata

OpenTeam、IDE、CI、research pipeline、robot platform 等项目的业务字段不进入 Core schema。

推荐：

```ts
metadata: {
  project: 'openteam-studio-run',
  teamId,
  requestId,
  taskId,
  endpointId,
}
```

Core 只保存、关联、回传这些 metadata，不解释其业务语义。

### 4. Backend Harness 自治

Core 不应该强制 backend 使用同一种：

- prefix/work 物理布局
- stable/dynamic boundary
- COMPACTION TAG 格式
- 内部 memory 策略
- skill 策略
- provider 策略
- 自进化策略

这些能力可以由自定义 backend harness 实现，例如 v9 harness。Core 只通过统一 run gateway 和 normalized events 与它交互。

## Core Context Layers

AgentServer Core 可以向 backend 注入这些外部 context layer：

```text
memory       跨 session 长期记忆
persistent   当前 session 稳定状态
currentWork  当前 session 最近工作窗口
recentTurns  最近对话 turn
runtime      backend/workspace/session 状态
policy       本次 context policy
guidance     recovery/maintenance/clarification 等操作提示
```

这些 layer 是逻辑层，不要求 backend 内部采用相同布局。

## Context Policy

上层项目可以用 `contextPolicy` 控制本次 run 注入哪些外部上下文。

```ts
contextPolicy: {
  includeCurrentWork?: boolean;
  includeRecentTurns?: boolean;
  includePersistent?: boolean;
  includeMemory?: boolean;
  persistRunSummary?: boolean;
  persistExtractedConstraints?: boolean;
}
```

默认策略偏保守：

- include current work
- include recent turns
- include persistent
- include memory
- persist run summary
- persist extracted constraints

上层项目可以在 coordinator、handoff、review、high-risk run 中收窄 context，例如关闭 current work 或 memory。

## Context Refs

每次 run 应记录 `contextRefs`，让后续 audit 和 Evolution Engine 能知道本次上下文来自哪里。

示例：

```ts
contextRefs: [
  {
    scope: 'policy',
    kind: 'context-policy',
    label: 'message-context-policy',
    metadata: { includeMemory: true }
  },
  {
    scope: 'runtime',
    kind: 'backend',
    label: 'codex',
    metadata: { agentId, sessionId, workingDirectory }
  },
  {
    scope: 'memory',
    kind: 'summary-layer',
    label: 'cross-session memory summary',
    metadata: { count: 3 }
  }
]
```

Core 的目标不是记录每个 token 的来源，而是提供足够稳定的审计边界。

## Retrieval Chain

Core 可以给 backend 提供一个通用检索顺序：

```text
current-window compaction constraints/summary
current-window partial compaction summary
current work raw turns
current-session persistent
cross-session memory
workspace search
ask human instead of guessing
```

这个顺序是 Core 的外部 context 建议，不是 backend 内部推理策略。

自定义 backend 可以在 harness 内实现更复杂的 retrieval planner，但不要要求其他 backend 共享同一套内部策略。

## Maintenance

Core 可以提供这些可审计维护能力：

- context snapshot
- compaction preview/apply
- session finalize preview/apply
- persistent budget recovery preview/apply
- recovery issue acknowledgement
- run summary persistence
- extracted constraint persistence

这些能力属于 AgentServer 的长期状态维护面。它们应该留下 audit、preview、recovery 信息。

但 Core 不应该要求所有 backend 使用同一种内部 compaction 格式。

## 与 v9 Harness 的关系

`context-harness.md` 是自研/custom backend harness 的策略文档。

它可以实验：

- prefix/work layout
- stable_work / dynamic_work
- COMPACTION TAG
- PARTIAL_COMPACTION TAG
- LLM semantic boundary decision
- harness-level evolution

这些策略可以启发 Core，但不能直接变成所有 backend 的公共约束。

推荐关系：

```text
context-core.md
  AgentServer Core 通用契约
  对所有 backend 稳定

context-harness.md
  v9/custom backend harness 策略
  对自研 backend 可实验
```
