# AgentServer Core Context Contract

最后更新：2026-04-19

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
Stage
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

### `work` / `currentWork` 生命周期

`work` 是 session-scoped 的滑动工作窗口，不是无限增长的完整 transcript。

推荐语义：

```text
memory
  跨 session 长期记忆，生命周期长，写入需要 summary/constraint 抽取。

state / persistent
  当前 session 稳定状态，例如目标、计划、关键决策、用户偏好、未解决问题。

work / currentWork
  当前 session 的近期工作窗口，生命周期随 session 推进而滑动。
```

`work` 默认跟 AgentServer session 绑定，而不是跟单个 run 绑定。一个 session 内多次 run 可以共享近期工作上下文，但 Core 必须有淘汰策略：

- 优先保留当前目标、计划、关键决策、未解决问题。
- 优先保留最近 stage 的 structured result、diff summary、test summary、risks。
- 原始 recent turns 只保留有限窗口。
- 当窗口过大时，先把旧 work 压缩成 summary，再降级到 persistent/state 或 memory candidate。
- 不把 backend native thread 当作 `work` 的唯一来源；native session 丢失后仍可通过 Core context 恢复。

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

## Canonical Session Context

多 backend 编排时，AgentServer 必须持有 canonical session context。它是跨 backend 连续性的主要来源。

```ts
type CanonicalSessionContext = {
  goal: string;
  plan: string[];
  decisions: string[];
  constraints: string[];
  workspaceState: {
    root: string;
    branch?: string;
    dirtyFiles: string[];
    lastKnownDiffSummary?: string;
  };
  artifacts: Array<{ id: string; kind: string; path?: string; uri?: string }>;
  backendRunRecords: Array<{
    runId: string;
    stageId: string;
    backendId: string;
    summary: string;
    filesChanged: string[];
    testsRun: string[];
    risks: string[];
  }>;
  openQuestions: string[];
};
```

Canonical context 不要求一次性全部注入 backend。每个 stage 应由 AgentServer 根据任务类型和 backend 能力渲染成 `BackendHandoffPacket`。

## Backend Handoff

Handoff 是跨 backend 接力的显式协议。它不等于完整聊天历史。

Handoff 必须包含：

- 当前目标和本 stage 的具体任务。
- 关键约束和用户偏好。
- prior stage 的结构化摘要。
- workspace hard facts，例如 git diff、改动文件、测试输出、artifact refs。
- 未解决问题和下一步建议。
- backend capability 或降级提示。

生成原则：

- handoff 由 AgentServer 生成。
- backend 自己提供的 summary 只是输入之一。
- workspace hard facts 优先于自然语言总结。
- 切换 backend 前，AgentServer 应重新读取或确认真实 workspace 状态。

## Context 淘汰策略

长 session 中，Core 应按价值保留上下文：

1. 用户目标、当前 plan、关键决策。
2. 未解决风险、open questions、approval 状态。
3. 最近 stage result、diff/test facts、artifact refs。
4. 最近 turns 的短窗口。
5. 旧 turns 的 summary。
6. 可从 workspace 或 artifact 重新读取的原始材料。

可以淘汰或降级的内容：

- 旧的逐字对话 transcript。
- 已被 diff/test/artifact 覆盖的中间自然语言描述。
- backend 私有 debug trace，除非 audit 或复现需要。
- 可由 workspace search 重新获得的大段文件内容。

淘汰不应破坏 audit。被压缩或淘汰的 context 应留下 summary、refs 或 artifact 指针。

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
