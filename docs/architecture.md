# AgentServer 架构设计

最后更新：2026-04-19

## 第一章：原则与边界

### 1.1 核心定位

AgentServer 是一个通用的 **Long-running Agent Runtime**，并逐步演进为多 agent backend 的统一编排层。

它要解决的问题很简单：让一个 agent 可以长期、稳定、可恢复、可审计地工作。

一句话概括：

```text
AgentServer = long-running agent state
            + external context
            + agent-backend orchestration
            + run gateway
            + audit
```

也就是说，AgentServer 负责：

- 创建和维护长期 agent
- 绑定稳定 workspace
- 管理跨 session 的外部上下文
- 把任务分发给一个或多个具体 backend agent 执行
- 记录 run、turn、event、artifact
- 在出错、上下文过大、session 结束时提供恢复和维护能力

它不应该成为某个上层产品的专用服务。OpenTeam Studio Run 是 AgentServer 的重要消费者，但 AgentServer 本身应该足够通用，让 IDE、CI、research pipeline、数据分析平台、机器人系统或其他项目都能通过少量适配使用。

### 1.2 最终形态与动机

AgentServer 的长期目标不是只做“多个 backend 的 facade”，而是做一个对外统一、对内可组合的 agent orchestration runtime。

动机很直接：不同 agent backend 会长期拥有不同强项。

例如：

- Codex 可能更擅长代码审查、bug 定位、测试失败分析。
- Claude Code 可能更擅长代码实现、大规模编辑、重构。
- Gemini 或其它 backend 可能更擅长长上下文、多模态、宽范围资料整合。
- 自研 `openteam_agent` / v9 可以作为白盒 harness，实验新的上下文和工具策略。

用户不应该感知这些 backend 切换。用户看到的应该仍然是：

```text
一个 AgentServer agent
一个 session
一个 run
一个连续上下文
```

内部则可以是：

```text
request
  -> orchestrator 拆成 stage
  -> Codex diagnose/review
  -> Claude Code implement
  -> Codex review diff
  -> AgentServer verify/audit/summarize
  -> unified result
```

因此最终架构要满足两点：

1. **AgentServer 持有统一上下文和编排权。**
   backend 是可组合的专家执行器，不是 session/context 的唯一真相源。

2. **完整 agent backend 能力可以被复用，且状态必须透明。**
   对 Codex/Claude Code/Gemini 这类完整 agent backend，AgentServer 不应只把它们当普通 model provider，也不应只把它们当 CLI 文本程序调用。正式 agent backend 必须通过结构化 transport 复用其 agent loop、工具事件、thread/session、approval、sandbox 和可查询状态。

3. **官方 backend 代码默认保持可替换。**
   Codex、Claude Code、Gemini 等 upstream checkout 应被视为会频繁更新的外部源码。AgentServer 的 adapter、bridge、schema mapping、capability policy 默认写在 AgentServer 自己的 runtime/docs/tests 中；优先通过外围 adapter 充分复用官方原生 agent 能力，并让后续官方源码更新可以直接同步。

4. **允许有记录的小 upstream patch，但不能把 patch 当常态。**
   当 provider/auth input、结构化状态、工具事件、approval、sandbox metadata、session id、abort/resume、packaging 等问题无法通过 SDK/API/RPC/app-server、环境变量、配置、bridge 或 capability 降级合理解决，且外围适配复杂度明显不成比例时，可以修改官方源码。修改必须小、集中、可重放，并在 `docs/upstream-backend-overrides.md` 记录 backend、upstream 版本、修改文件、修改目的和重放步骤，避免每次同步官方版本后重复摸索。

### 1.3 三层策略边界

为了同时保持通用性和未来演化能力，AgentServer 相关体系分成三层：

```text
Evolution Engine
  可选插件/服务
  读取 AgentServer 数据
  生成 proposal
  通过 AgentServer API 应用已验证变更
        |
        v
AgentServer Core
  通用、稳定、简洁
  管理 Agent / Session / ContextItem / Run / Artifact
  提供 orchestration、run gateway、audit、context refs、policy snapshots
  不内置复杂自进化决策
        |
        v
Backend Harness
  strategic: codex / claude-code / gemini / openteam_agent
  ecosystem entry: openclaw / hermes-agent
  保持自治
  各自管理内部 system prompt、tool policy、permission、compaction、context strategy
```

这三层的原则是：

1. **AgentServer Core 通用、稳定、简洁。**
   它提供长期 agent 状态、外部上下文、run gateway、audit 和维护接口，但不把复杂自进化决策写进核心。

2. **Evolution Engine 是可选插件/服务。**
   它读取 AgentServer 的 run ledger、metrics、evaluation、context usage、policy snapshots，生成 proposal。变更需要通过 AgentServer 的安全接口应用，并保留 audit 和 rollback 信息。

3. **Backend Harness 保持自治。**
   claude-code、codex 等前沿 agent 的内部 harness 不被外部拆解。`openteam_agent` 是当前自研 backend 的薄实现；v9 可以继续作为其内部 harness 实验方向，但这不是 AgentServer 的通用 evolution。

换句话说：

```text
AgentServer Core 提供编排、数据地基和安全变更点
Evolution Engine 负责策略学习和提案
Backend Harness 负责单个 backend 的内部运行机制
```

### 1.4 最小核心模型

AgentServer 顶层核心对象保持精简，但多 backend 编排使 `Stage` 必须成为 `Run` 下的一等审计对象：

```text
Agent
Session
ContextItem
Run
Stage
Artifact
```

含义如下：

| 对象 | 含义 |
|---|---|
| Agent | 一个长期存在的 agent 实例 |
| Session | Agent 的一段连续工作上下文 |
| ContextItem | AgentServer 管理的外部可审计上下文 |
| Run | 一次任务执行记录 |
| Stage | Run 内部的一个可审计执行阶段，绑定 backend、输入、输出、状态和指标 |
| Artifact | Run 产生的文件、日志、报告、diff、截图等产物 |

这些对象是 AgentServer 的核心领域。其他业务概念都不应该进入核心模型。

`Run` 和 `Stage` 的关系：

```text
Run
  一次用户 request 的对外执行记录
  对外仍表现为一个 agent 在工作

Stage
  Run 内部的执行单元
  一个 Run 可以包含 1..N 个 Stage
  每个 Stage 可以选择不同 backend
  每个 Stage 都必须进入 audit
```

这让 audit 可以回答：

- 这个 run 拆成了哪些 stage？
- 每个 stage 用了哪个 backend？
- Codex 做了什么，Claude Code 做了什么？
- 哪个 stage 改了文件、跑了测试、失败或等待用户？
- 最终输出由哪些 stage 共同产生？

例如 OpenTeam 中的这些概念：

- team
- blackboard
- coordinator
- proposal
- decision
- task materialize
- endpoint routing
- SCP
- remote GPU
- robot

都属于上层项目领域。AgentServer 可以保存它们的 `metadata`，但不应该理解或耦合它们的业务语义。

### 1.5 项目差异通过 metadata 适配

AgentServer 的通用性来自一个原则：

```text
业务字段走 metadata，核心模型保持稳定。
```

OpenTeam 可以把这些字段传给 AgentServer：

```ts
metadata: {
  project: 'openteam-studio-run',
  teamId,
  requestId,
  taskId,
  blackboardId,
  endpointBindings
}
```

另一个项目也可以传完全不同的字段：

```ts
metadata: {
  projectId,
  issueId,
  userId,
  repo,
  ticketUrl
}
```

AgentServer 只做三件事：

1. 保存这些 metadata
2. 把 metadata 关联到 agent、session、run、artifact
3. 在查询 run/audit 时原样回传

AgentServer 不根据这些字段实现业务逻辑。

为了避免 metadata 变成不可治理的杂乱字段，推荐约定：

```text
metadata.project
metadata.source
metadata.<namespace>.*
```

示例：

```ts
metadata: {
  project: 'issue-bot',
  source: 'github-issue',
  'issuebot.issueId': 123,
  'issuebot.repo': 'org/my-repo',
  'openteam.teamId': 'team-1'
}
```

长期可以引入 metadata schema registry，用于声明常见 namespace、可索引字段、敏感字段和展示名称。首版不要求强 schema，但至少应避免不同项目无约定地复用同一个 key。

### 1.6 外部上下文与内部 harness 分离

AgentServer 管理的是 **external auditable context**，也就是外部可审计上下文。

它可以把这些信息组装后传给 backend agent：

- 长期 memory
- 当前 session state
- 最近 work
- retrieval hits
- pending clarification
- recovery issues
- operational guidance

但 AgentServer 不管理 backend agent 的内部 harness。

它不应该：

- 替换 claude-code/codex 的 system prompt 体系
- 接管 claude-code/codex 的内部 compaction
- 重写 backend agent 的 tool policy
- 绕过 backend agent 的 permission model
- 把某个 backend 的 context 策略强行套给其他 backend

推荐边界：

```text
AgentServer 管理 canonical session context 和外部可审计上下文
Agent backend 管理自己的 native thread/session 和内部 harness context
```

这条边界很关键。AgentServer 可以给 agent 提供上下文，但不拆 agent 自己的内部运行机制。

### 1.7 Backend Runtime 吸收 backend 差异

AgentServer 不直接处理每个 backend 的原生协议。

backend 差异应该由 Backend Runtime 吸收：

- backend catalog
- managed launcher
- supervisor
- adapter contract
- runtime event normalization
- error normalization
- backend capability

AgentServer 通过统一 adapter 调用 backend。adapter 分两类：

```text
model-provider runtime
  把 backend 当作模型/provider 调用
  适合轻量问答、兼容路径、普通 LLM provider

agent-backend runtime
  把 backend 当作完整 agent 调用
  适合 Codex app-server、Claude Code、未来完整 agent backend
```

完整 `agent-backend runtime` 有两个硬原则：

1. **能力完整性**：在被调用的 stage 内，backend 的原生 agent 能力应尽量完整保留，接近人类直接使用该 agent 的能力边界。
2. **状态透明性**：正式 agent backend 面向的是 AgentServer 和其它 agent，而不是人类终端用户；因此必须提供结构化事件、可查询状态、可中止 run、可恢复 session 和机器可读的 tool/approval/sandbox/workspace facts。

这意味着 agent-backend adapter 不应把 Codex、Claude Code 这类 backend 降级成 `prompt -> text` 的普通模型调用。adapter 需要保留并桥接 backend 的原生执行面：

- native agent loop
- native tool calls / tool results
- native thread/session
- approval / permission requests
- sandbox 或等价执行边界
- 文件编辑、patch、shell、测试等代码工作流
- streaming native events
- abort / resume / recovery
- readState / status transparency

AgentServer 做的是统一控制平面，而不是低配替代 backend 的执行平面：

| 能力 | 完整 agent backend 内部 | AgentServer 侧责任 |
|---|---|---|
| agent loop | backend 原生执行 | 编排 stage、timeout、cancel、retry/fallback |
| tool 调用 | backend 原生工具或 tool bridge | 标准化事件、审计、权限边界 |
| sandbox | backend 原生 sandbox，或运行在 AgentServer worker/sandbox 内 | 记录 sandbox policy、限制 workspace/worker 范围 |
| approval | backend 原生请求 | 转成 AgentServer approval 事件和 audit |
| native session | backend 原生 thread/session | 绑定 native session ref，但不把它作为真相源 |
| context | backend 内部 context + AgentServer handoff | canonical context、handoff、workspace hard facts |

因此 capability 必须显式声明，不能让轻量 provider 伪装成完整 agent backend。推荐能力字段包括：

```ts
type AgentBackendCapabilities = {
  nativeLoop: boolean;
  nativeTools: boolean;
  nativeSandbox: boolean;
  nativeApproval: boolean;
  nativeSession: boolean;
  fileEditing: boolean;
  streamingEvents: boolean;
  resumableSession: boolean;
  structuredEvents: boolean;
  readableState: boolean;
  abortableRun: boolean;
  statusTransparency: 'full' | 'partial' | 'opaque';
};
```

transport 选择原则：

```text
正式 agent_backend:
  必须使用结构化、状态透明的 transport。
  可接受形式包括官方 app-server、SDK、JSON-RPC、stdio RPC、HTTP/WebSocket event stream、本地 runtime API。

CLI transport:
  只允许作为 bootstrap、debug、fallback 或 compatibility path。
  CLI-only adapter 除非能通过可靠 bridge 暴露 structured events、readState、approval、tool calls、workspace facts、abort/resume，否则不能标记为完整生产 agent_backend。
```

降级路径也必须显式：

```text
openai-codex direct provider
  kind: model_provider
  nativeLoop: false
  nativeTools: false
  nativeSandbox: false
  structuredEvents: false
  readableState: false
  statusTransparency: opaque

Codex app-server adapter
  kind: agent_backend
  nativeLoop: true
  nativeTools: true
  nativeSandbox: true
  structuredEvents: true
  readableState: true
  abortableRun: true
  statusTransparency: full
```

如果某个 backend 只能提供部分能力，它仍然可以接入，但 orchestrator 必须按真实 capability 路由，audit 也要记录本次 stage 使用的是完整 agent-backend 路径还是降级路径。

adapter contract 后续应单独沉淀到 `docs/adapter-contract.md`。最小接口需要覆盖：

- session/thread start 或 resume
- run stage / turn
- abort / timeout
- native event 到 normalized event 的映射
- tool/approval/error 的结构化输出
- `BackendStageResult` 和 handoff facts
- capability declaration 与降级语义
- `readState` / status transparency

native session 作用域采用以下原则：

```text
默认：AgentServer session-scoped native session
  同一个 AgentServer session 中，同一个 backend 可以复用自己的 native thread/session。

约束：native session 不是真相源
  AgentServer 的 canonical session context、run ledger、stage result、workspace hard facts 才是可审计真相源。

兜底：必须可重建
  即使 native session 丢失，AgentServer 也应能通过 canonical context + handoff + workspace state 启动新的 native session 继续工作。
```

这比纯 stage-scoped 更能利用 Codex/Claude Code 等 backend 的内部连续性，又不会把跨 backend 上下文完全托付给不可审计的隐式状态。

adapter 需要显式暴露 native session binding，例如：

```text
agentServerSessionId -> backendId -> nativeSessionRef
```

orchestrator 可以在以下场景选择 stage-scoped native session：

- 隐私或权限要求隔离。
- backend native session 状态疑似污染。
- stage 是一次性只读 shadow/review。
- fallback 到另一个 backend，且不应继承旧 backend 的隐式状态。

这样新增 backend 时，主要改 Backend Runtime / adapter，而不是改 AgentServer 核心。

`openai-codex` direct provider 属于轻量/兼容/兜底路径；Codex app-server adapter 属于完整 agent-backend 路径。二者可以共存，但定位不同。

### 1.8 Agent Backend Orchestration

AgentServer orchestrator 负责把一次 request 变成一个或多个 stage。

推荐 stage 类型：

```text
plan
diagnose
implement
review
verify
summarize
```

orchestrator 分为两层：

```text
Orchestrator Core Kernel
  AgentServer Core 的一部分
  负责 stage 状态机、dependency graph 调度、audit、timeout/cancel、handoff 边界

Orchestrator Policy
  可插拔策略层
  负责 stage plan 生成、backend 选择、retry/fallback 策略、成本/风险取舍
```

Core Kernel 必须稳定、可审计、少策略；Policy 可以演进和替换。这样既保证 AgentServer Core 不膨胀，也能让不同项目按场景调整编排策略。

首版 orchestrator policy 应优先使用规则和配置，而不是一开始就依赖 LLM planning。

推荐演进：

```text
v1: rule-based orchestrator
  根据任务标签、backend strength policy、用户配置和风险等级选择 stage

v2: assisted planning
  允许 LLM 生成候选 plan，但必须经过规则校验和预算检查

v3: learned routing
  结合 benchmark score、历史 outcome、成本和用户反馈调整策略
```

这样可以先控制成本、延迟和可解释性。LLM planning 可以作为后续增强，但它本身也是一次 backend 调用，需要记录 token、耗时、上下文来源和失败策略。

Policy 变更属于受控配置变更：

- 小范围 backend strength policy 调整可以是 medium risk。
- retry/fallback、sandbox、worker route、permission 相关策略通常是 high risk。
- 从 rule-based 切换到 assisted planning 必须经过 proposal、policy checker 和人工或 A/B 验证。
- Evolution Engine 可以提出 orchestrator policy proposal，但不能直接替换 Core Kernel。

每个 stage 都应记录：

- 选择了哪个 backend
- 为什么选择它
- 输入 handoff packet 摘要
- 输出 normalized result
- 文件变更、工具调用、审批、测试和 artifact
- 成本、耗时、错误和验证结果

关键原则：

1. **backend 切换默认隐藏在用户主体验中。**
   用户看到一个连续 agent；debug trace / audit 可以展示内部 stage。

2. **不要让某个 backend 接管 orchestration。**
   Codex/Claude Code 可以拥有自己的内部 agent loop，但跨 backend 的任务拆分、handoff、验证和最终汇总归 AgentServer。

3. **写操作要串行或有明确 ownership。**
   多 backend 可以并行读、评审、规划；但同时写同一 workspace 会引入冲突，默认应由 orchestrator 串行安排或分配文件 ownership。

4. **verification 是独立能力。**
   测试、lint、typecheck、diff risk scan、artifact 检查由 AgentServer 统一触发和记录，不完全依赖 backend 自报成功。

Stage 之间应支持 dependency graph，而不是只能线性串行：

```ts
interface AgentRunStage {
  id: string;
  runId: string;
  type: 'plan' | 'diagnose' | 'implement' | 'review' | 'verify' | 'summarize';
  backend?: string;
  dependsOn?: string[];
  mode: 'read' | 'write' | 'verify';
  status: StageStatus;
}
```

默认规则：

- `write` stage 对同一 workspace 串行。
- `read` / `review` stage 可以并行。
- `verify` stage 依赖相关 `write` stage 完成。
- dependency graph 必须进入 audit，便于解释为什么某些 stage 并行或等待。

### 1.9 跨 backend 上下文与 handoff

不同 backend 不能共享隐式记忆。Codex native thread 里知道的东西，Claude Code native session 不一定知道；反过来也一样。

因此 AgentServer 需要维护 canonical session context，并在 stage 边界生成结构化 handoff。

handoff 的生成责任属于 AgentServer，而不是完全交给上一个 backend 自述。推荐流程：

```text
1. backend 返回 native result / events / artifacts
2. adapter 提取 structured facts
3. AgentServer 读取 workspace 硬事实：git diff、文件列表、测试输出、artifact
4. AgentServer 组装 BackendStageResult
5. 必要时再用轻量 summarizer 生成自然语言 handoffSummary
6. 下一 stage 收到 BackendHandoffPacket
```

其中 workspace 硬事实必须优先于自然语言总结。上一个 backend 可以提供 summary，但 adapter contract 要求它同时暴露可机器读取的 facts；AgentServer 负责把这些 facts 和真实 workspace 状态合并。

推荐核心对象：

```ts
interface BackendHandoffPacket {
  goal: string;
  currentState: string;
  relevantContextRefs: ContextRef[];
  workspaceState?: {
    cwd: string;
    gitDiffSummary?: string;
    filesChanged?: string[];
    tests?: string;
  };
  decisions: string[];
  risks: string[];
  nextAction: string;
}

interface BackendStageResult {
  backend: string;
  stage: string;
  status: StageStatus;
  finalResponse?: string;
  filesChanged?: string[];
  diffSummary?: string;
  testsRun?: string[];
  findings?: string[];
  handoffSummary: string;
  hardFacts?: {
    gitDiff?: string;
    testOutputRefs?: string[];
    artifactRefs?: string[];
  };
  nextActions?: string[];
  metadata?: Record<string, unknown>;
}
```

可靠的共享事实源优先级：

```text
workspace files / git diff / test output / artifacts / structured handoff
  >
backend 自己的自然语言总结
  >
完整聊天历史
```

完整聊天历史可以作为辅助，但不应作为跨 backend 连续性的唯一机制。

### 1.10 Live Benchmark 的位置

Live Backend Benchmark 是一个独立模块，当前只沉淀设计，暂不实现 runner 或线上评分系统。详细设计占位见 [`backend-benchmark.md`](./backend-benchmark.md)。

它未来负责回答：

- 哪个 backend 更擅长代码审查？
- 哪个 backend 更擅长实现？
- 哪个 backend 在特定 repo、语言、任务类型上成功率更高？
- 在给定成本/延迟预算下，哪个 backend 最值得被 orchestrator 选择？

Benchmark 与 orchestrator 的关系是：

```text
Live Benchmark
  产出 backend capability score / confidence / cost profile

AgentServer Orchestrator
  消费这些 score 作为路由信号之一
```

Benchmark 不应该阻塞 agent-backend orchestration 的首版实现。首版可以先用手写 backend strength policy；benchmark 后续作为独立模块补上，逐步替代或修正人工策略。

真实任务中通常只运行一个主 backend 以节约 token。未来 benchmark 需要通过离线基准、真实任务反馈、低比例探索、replay、只读 shadow review 等方式更新评分。

### 1.11 v9 的定位

v9 context design 更适合作为自研 v9 agent 的内部 harness 策略。

Context 文档拆分为两层：

```text
docs/context-core.md
  AgentServer Core 通用 context 契约

docs/context-harness.md
  v9/custom backend harness context 策略；当前第一阶段落点是 openteam_agent
```

它和 claude-code、codex、gemini、openclaw、hermes-agent 的内部 harness 是同级关系：

```text
claude-code backend -> Claude Code harness
codex backend       -> Codex harness
gemini backend      -> Gemini harness / SDK
openteam_agent        -> self-developed harness seed, can evolve toward v9 context design
```

v9 的价值在于：

- 白盒可控
- 适合实验新 context 策略
- 适合做前沿 agent 的对比基准
- 适合沉淀自研 agent 能力

但 v9 的 prefix/work 分区、stable/dynamic boundary、COMPACTION TAG、内部 compaction 触发策略，不应该成为 AgentServer 对所有 backend 的公共策略。

AgentServer 对 v9/openteam_agent 的态度应该和其他 backend 一样：它们属于 backend harness，内部策略由 backend 自己负责。

v9 可以有自己的 harness-level evolution，例如调节 stable boundary threshold、compaction trigger、prefix/work layout、retrieval chain 等。但这类实验只属于 v9 backend 内部，不应混同于通用 Evolution Engine。

### 1.12 分层关系

整体分层如下：

```text
Any Project
  OpenTeam / IDE / CI / Research App / Robot Platform
        |
        | call AgentServer API
        | pass project-specific metadata
        v
Evolution Engine (optional)
  observe run ledger
  evaluate outcomes
  generate proposal
  apply approved config changes through AgentServer API
        |
        v
AgentServer
  Agent lifecycle
  Session lifecycle
  Canonical session context
  Orchestrator core kernel
  Orchestrator policy binding
  Context memory/state/work
  Context assembly + refs
  Run gateway
  Audit + artifacts
  Maintenance preview/apply
        |
        | run stages through backend adapters
        v
Backend Runtime
  Backend catalog
  Managed launcher
  Supervisor
  Adapter contract
  Model-provider adapters
  Agent-backend adapters
  Runtime event normalization
        |
        v
Agent Backend
  strategic: codex / claude-code / gemini / openteam_agent
  ecosystem entry: openclaw / hermes-agent
  future backend
  Owns internal harness, system prompt, tool policy, permission model, compaction
```

职责边界：

| 层 | 负责 | 不负责 |
|---|---|---|
| 上层项目 | 业务语义、UI、endpoint routing、产品审批策略 | 长期 agent session/memory 真相源、backend 原生协议、backend 专长路由细节 |
| Evolution Engine | 读取 run ledger/metrics/evaluation/context usage，生成 proposal，做 A/B 和审批流，调用 AgentServer API 应用配置 | 直接操作 backend harness、绕过 AgentServer 改状态、无审计自动改高风险策略 |
| AgentServer Core | Agent/Session/ContextItem/Run/Artifact、canonical context、orchestrator core kernel、外部上下文、run gateway、audit、recovery、maintenance、policy snapshots | OpenTeam blackboard 算法、endpoint 物理路由、backend 内部 harness、复杂自进化决策、benchmark 算法实现 |
| Orchestrator Policy | stage plan、backend 选择、retry/fallback、成本/风险取舍；可配置、可替换、可被 proposal 调整 | run ledger 真相源、状态机内核、绕过 policy checker 的高风险变更 |
| Backend Runtime | backend catalog、launcher、supervisor、adapter、统一事件、错误归一化 | 长期 memory、跨 backend 编排、项目知识策略 |
| Agent Backend | 模型交互、内部 harness、tool policy、permission model、native thread/session、内部 context/compaction | 跨项目长期状态、跨 backend orchestration、业务 audit |
| Live Benchmark | backend 能力评估、score、confidence、cost profile | 用户主请求执行链、直接修改 workspace、替代 orchestrator |

## 第二章：对外接口与用法

### 2.1 推荐使用方式

对上层项目来说，AgentServer 的推荐用法是：

```text
1. ensure/create 一个长期 agent
2. 向这个 agent 投递 run
3. 查询 run/audit/artifact
4. 需要时做 recovery、compact、finalize
```

当前仓库已经有通用 run facade：

```text
POST /api/agent-server/runs
GET  /api/agent-server/runs/:runId
```

上层项目优先使用这个薄接口。它通过 `agent.backend` 或 `runtime.backend` 选择 backend，通过 `metadata` 传项目自定义字段。

仓库也保留兼容的长期 agent 高阶入口：

```text
POST /api/agent-server/autonomous/ensure
POST /api/agent-server/autonomous/run
```

这些 API 的语义都不是“裸 runtime run”，而是长期 agent run：

```text
ensure/reconcile
recovery check
persistent budget handling
context assembly
backend runtime call
turn/run audit
post-run summary/constraints extraction
optional compaction/recovery
```

底层语义保持一致：AgentServer 负责长期状态、上下文、恢复和审计。

最小接入示例、backend capability、统一事件和工具原语说明统一放在 [`docs/public-api.md`](./public-api.md)。本章只描述架构边界，不重复维护完整 API 契约。

### 2.2 Agent API

Agent 表示一个长期 agent 实例。

常用接口：

```text
POST /api/agent-server/agents
GET  /api/agent-server/agents
GET  /api/agent-server/agents/:agentId
POST /api/agent-server/agents/:agentId/revive
```

推荐最小字段：

```ts
interface Agent {
  id: string;
  name: string;
  backend: string;
  workspace: string;
  status: 'active' | 'paused' | 'waiting_user' | 'error';
  systemPrompt?: string;
  runtimeAgentId?: string;
  runtimeTeamId?: string;
  persistentKey?: string;
  metadata?: Record<string, unknown>;
}
```

说明：

- `backend` 指向具体 backend；当前 backend id 列表见 [Public API](./public-api.md#choose-a-backend)
- `workspace` 是 agent 的稳定工作目录
- `metadata` 保存项目自定义字段
- `runtimeAgentId`、`runtimeTeamId`、`persistentKey` 是 runtime 配置，不是业务领域对象
- Agent 级 `waiting_user` 表示该 agent 当前存在至少一个阻塞中的 run/stage 需要用户输入；Run/Stage 级 `waiting_user` 才表示具体阻塞点。

### 2.3 Session API

Session 表示一个 agent 的连续工作上下文。

常用接口：

```text
POST /api/agent-server/agents/:agentId/sessions
GET  /api/agent-server/agents/:agentId/context
POST /api/agent-server/agents/:agentId/sessions/finalize/preview
POST /api/agent-server/agents/:agentId/sessions/finalize
```

Session 是 AgentServer 的真相源。上层项目可以引用 `sessionId`，但不应该自己维护 agent session 内部状态。

### 2.4 Context API

AgentServer 管理三类外部上下文：

```text
memory   跨 session 长期记忆
state    当前 session 稳定状态
work     当前 session 最近工作窗口
```

`work` 是 session-scoped 的滑动工作窗口，不是 run-scoped 的永久记录。一个 session 里可以有很多 run；`work` 只保留最近、仍对当前任务有帮助的 turns、stage summaries、未解决问题和短期 artifacts。完整历史应保存在 run ledger 和 artifacts 中。

推荐生命周期：

```text
memory
  跨 session，长期保留，需要显式压缩/清理

state
  session 级稳定状态，session finalize 时可沉淀为 memory

work
  session 级短期窗口，随 run 增长而滚动淘汰
  淘汰依据 token budget、recency、是否已被 summary/state 吸收、是否仍 pending
```

当前代码中已有的概念可以这样映射：

| 通用层 | 当前实现中的例子 |
|---|---|
| memory | memory summary、memory constraints |
| state | persistent summary、persistent constraints |
| work | recent turns、current work、turn log、compaction tags |

推荐通用结构：

```ts
interface ContextItem {
  id: string;
  agentId: string;
  sessionId?: string;
  scope: 'memory' | 'state' | 'work';
  kind: 'summary' | 'constraint' | 'fact' | 'note' | 'turn' | 'artifact';
  text: string;
  refs?: ContextRef[];
  metadata?: Record<string, unknown>;
}
```

Context assembly 每次 run 前执行。它应该返回：

```ts
interface AssembledContext {
  text: string;
  refs: ContextRef[];
  approxTokens?: number;
  policyId?: string;
}
```

其中：

- `text` 传给 backend runtime
- `refs` 写入 run record，用于审计本次注入了哪些上下文

### 2.5 Run API

Run 是一次任务执行。

当前推荐入口：

```text
POST /api/agent-server/runs
```

`/api/agent-server/autonomous/*` 是长期 agent 的兼容高阶入口；普通外部项目优先使用 `/runs` facade。完整请求/响应示例见 [`docs/public-api.md`](./public-api.md)。

推荐通用请求结构：

```ts
interface RunRequest {
  agent: {
    id?: string;
    name?: string;
    backend?: string;
    workspace?: string;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  };

  input: {
    text: string;
    attachments?: Attachment[];
    metadata?: Record<string, unknown>;
  };

  contextPolicy?: {
    includeMemory?: boolean;
    includeState?: boolean;
    includeWork?: boolean;
    includeRecentTurns?: boolean;
    maxItems?: number;
    metadata?: Record<string, unknown>;
  };

  runtime?: {
    backend?: string;
    model?: string;
    modelProvider?: string;
    modelName?: string;
    llmEndpoint?: {
      provider?: string;
      baseUrl: string;
      apiKey?: string;
      modelName?: string;
      authType?: 'apiKey' | 'bearer' | 'none';
    };
    cwd?: string;
    timeoutMs?: number;
    toolMode?: 'auto' | 'none';
    metadata?: Record<string, unknown>;
  };

  metadata?: Record<string, unknown>;
}
```

`runtime.modelProvider`、`runtime.modelName`、`runtime.llmEndpoint` 是 request-scoped 模型连接输入，优先级高于全局环境变量和配置文件候选。它们属于 AgentServer 对 backend 的统一调用契约，而不是新的并行执行链条：request 仍进入同一个 backend adapter / runtime supervisor / tool router / sandbox path，确保上层可以透明选择“CPU 节点做大脑、本地或 GPU 节点做工具执行”的部署形态，同时不丢失 backend 原生 agent loop、工具注册、approval、sandbox、session 和上下文管理能力。

推荐通用响应结构：

```ts
interface RunResult {
  agentId: string;
  sessionId: string;
  runId: string;
  status: RunStatus;
  output: string;
  stages?: AgentRunStage[];
  events: RuntimeEvent[];
  contextRefs: ContextRef[];
  usage?: Usage;
  artifacts?: ArtifactRef[];
  metadata?: Record<string, unknown>;
}
```

推荐状态机：

```ts
type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

type StageStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  | 'timeout';
```

状态语义：

- `queued/pending`：已创建但尚未开始执行。
- `running`：正在执行。
- `waiting_user`：需要用户输入、审批或澄清。
- `completed`：成功结束。
- `failed`：非超时、非取消的失败。
- `cancelled`：被用户或上层系统取消。
- `timeout`：超过预算或 deadline。

Stage 失败后的默认策略应由 orchestrator policy 决定：

- 可重试的 transient error 可以重试同 backend。
- backend-specific failure 可以切换到同类型 backend retry。
- 写操作已经部分落地时，不能静默 fallback；必须先记录 workspace 状态，并由 policy 决定继续、回滚或等待用户。
- 任一 required stage 失败时，Run 默认失败；optional review/shadow stage 失败不应自动使 Run 失败。

### 2.6 Audit API

AgentServer 的一个核心价值是 audit。

常用接口：

```text
GET /api/agent-server/agents/:agentId/runs
GET /api/agent-server/agents/:agentId/turns
GET /api/agent-server/agents/:agentId/context
```

Run record 应该能回答：

- 谁执行的？
- 在哪个 session 中执行？
- 输入是什么？
- 注入了哪些 context？
- 调用了哪些 backend events？
- 输出是什么？
- 产生了哪些 artifact？
- 是否失败？
- 是否需要用户澄清？
- metadata 中关联了哪个上层项目任务？

### 2.7 Maintenance API

长期 agent 需要维护能力。

AgentServer 应支持：

```text
compact
recover
finalize
revive
clear context
```

强操作遵循：

```text
preview -> apply
```

当前已有接口包括：

```text
POST /api/agent-server/agents/:agentId/compact/preview
POST /api/agent-server/agents/:agentId/compact

GET  /api/agent-server/agents/:agentId/persistent/recovery/preview
POST /api/agent-server/agents/:agentId/persistent/recovery/apply

POST /api/agent-server/agents/:agentId/sessions/finalize/preview
POST /api/agent-server/agents/:agentId/sessions/finalize

POST /api/agent-server/agents/:agentId/revive
```

维护操作需要 preview 的原因：

- 可能丢失上下文
- 需要解释 cost delta
- 需要人工或上层策略确认
- 需要 audit 和 rollback 信息

### 2.8 Backend Runtime API 的位置

Backend Runtime 的入口，例如：

```text
POST /api/runtime/runs
```

属于底层执行接口，适合 runtime/debug/adapter 层使用。

如果上层项目需要长期 memory、session、recovery、context assembly 和 audit，默认不应该绕过 AgentServer 直接调用 runtime。

### 2.9 Evolution Engine 接口位置

Evolution Engine 是 AgentServer 之上的可选策略层，不是 AgentServer Core 的必选组成部分。

AgentServer Core 应该向它提供数据和安全变更点：

```text
read:
  run ledger
  turn log
  runtime events
  contextRefs
  metrics
  evaluation
  artifacts
  policy snapshots

write:
  evolution proposals
  approved context policy changes
  approved context item weight/status changes
  approved directive/config changes
```

重要原则：

- Evolution Engine 可以生成 proposal
- AgentServer 保存 proposal 和审计记录
- 低风险变更可以通过受控 API 应用
- 高风险变更需要 A/B 验证和人工审批
- 任何变更都要有 evidence 和 rollback plan
- Evolution Engine 不直接操作 backend harness

推荐 proposal 结构：

```ts
interface EvolutionProposal {
  id: string;
  type:
    | 'context-weight-change'
    | 'context-merge'
    | 'context-policy-experiment'
    | 'backend-routing-experiment'
    | 'directive-change';
  evidence: unknown[];
  expectedImpact?: string;
  risk: 'low' | 'medium' | 'high';
  rollbackPlan: string;
  status: 'draft' | 'proposed' | 'approved' | 'rejected' | 'applied';
  metadata?: Record<string, unknown>;
}
```

AgentServer Core 只需要支持这些 proposal 的保存、查询、审计和受控应用。具体怎么分析趋势、怎么判断实验结果、怎么生成 proposal，是 Evolution Engine 的职责。

## 第三章：例子与细节

### 3.1 普通项目如何接入

一个普通项目只需要把自己的业务字段放进 metadata。

例如一个 issue bot：

```ts
await agentServer.runs.create({
  agent: {
    id: 'repo-helper',
    backend: 'codex',
    workspace: '/workspace/my-repo',
    metadata: {
      project: 'issue-bot',
      repo: 'org/my-repo'
    }
  },
  input: {
    text: '修复 issue #123 中描述的测试失败',
    metadata: {
      issueId: 123,
      userId: 'alice'
    }
  },
  metadata: {
    source: 'github-issue'
  }
});
```

AgentServer 不需要理解 `issueId`，它只保存并回传这些 metadata。

### 3.2 OpenTeam 如何接入

OpenTeam 可以把 blackboard task 适配成 AgentServer run。

推荐链路：

```text
OpenTeam Blackboard
  proposal -> decision -> materialize task
        |
        | POST /api/agent-server/runs
        | metadata carries teamId/requestId/taskId/blackboardId
        v
AgentServer
  hosted agent lifecycle
  session/context/orchestration/run/audit
        |
        v
Backend Runtime
        |
        v
Agent Backend
```

示例：

```ts
async function runBlackboardTask(task) {
  return await agentServer.runs.create({
    agent: {
      id: task.assigneeAgentId,
      backend: task.backend,
      workspace: task.workspace,
      metadata: {
        teamId: task.teamId,
        roleId: task.roleId
      }
    },
    input: {
      text: task.prompt,
      metadata: {
        requestId: task.requestId,
        taskId: task.id,
        blackboardId: task.blackboardId
      }
    },
    runtime: {
      cwd: task.executionScope?.cwd,
      metadata: {
        endpointBindings: task.toolBindings
      }
    },
    metadata: {
      source: 'openteam-blackboard'
    }
  });
}
```

边界：

- OpenTeam 负责 blackboard 协作算法
- AgentServer 负责长期 agent 宿主、统一上下文、backend stage 编排、run、audit
- Backend Runtime 负责 backend adapter 和原生协议吸收
- Tool Routing / Worker 层负责工具实际执行位置

### 3.3 Remote endpoint 场景

AgentServer 可以保存和注入远程 workspace 相关 metadata。

但这句话：

```text
AgentServer context says remote workspace
```

不等于：

```text
shell/file/git/gpu tools are physically running on remote
```

远程 SSH、GPU、SCP、robot、database、browser 等 endpoint 的物理路由、权限、审批、evidence，应由上层项目的 Tool Execution Router 负责。

AgentServer 不应该内置 OpenTeam 专用 endpoint routing。通用能力应表达为 `backend / workspace / worker / route`：backend 负责想，workspace 负责收纳，worker 负责干活，route 负责决定每个 tool-call 谁先干、谁备选。

正确分工是：

```text
上层项目              提供业务语义、workspace/worker 配置和产品审批策略
AgentServer           保存 run/context/audit，编排 backend stage，应用通用 route
Worker/Tool Router    决定工具实际在哪里执行并写回 workspace/artifact
Backend Runtime       运行具体 backend adapter
Agent Backend         执行自己的内部 harness 或 native agent loop
```

### 3.4 openteam_agent / v9 backend 场景

`openteam_agent` 是当前代码中的自研 backend 种子实现；v9 是它可以继续演进的内部 harness context 策略方向。

Core 通用 context 契约写在 `docs/context-core.md`。v9 的内部 harness context 策略写在 `docs/context-harness.md`。

AgentServer 仍然只通过统一 runtime contract 调用它：

```text
AgentServer -> Backend Runtime -> openteam_agent / v9 backend
```

v9 内部可以实现自己的：

- prefix/work 分区
- stable/dynamic boundary
- COMPACTION TAG
- compaction 触发条件
- retrieval chain
- 自研 context 策略

但这些属于 v9 backend 内部 harness。

AgentServer 不把这些策略强加给 claude-code、codex、gemini、openclaw、hermes-agent。

### 3.5 Codex / Claude Code 作为完整 agent backend

Codex 和 Claude Code 不应只被理解为普通 model provider。它们本身拥有完整 agent backend 能力：

- agent loop
- native thread/session
- 工具注册和工具事件
- 文件编辑/patch 流程
- shell/approval/sandbox 或等价权限模型
- 内部上下文和 compaction

因此长期方向是新增 agent-backend adapter：

```text
AgentServer Orchestrator
  -> Codex app-server adapter
  -> Claude Code adapter
  -> normalized stage result
  -> canonical session context
```

其中：

- Codex app-server adapter 优先复用 Codex app-server / SDK 的完整 agent 能力和结构化状态。
- Claude Code adapter 必须优先寻找结构化 protocol / bridge；CLI 只能作为 bootstrap/fallback，不能作为最终生产边界。
- Gemini adapter 必须优先选择能提供结构化事件、可查询状态和长上下文能力的 SDK/API/app-server；CLI 只能作为过渡。
- `openai-codex` direct provider 可以继续作为轻量/兼容/兜底路径，但不能标记为完整 agent backend。
- 完整 agent-backend stage 内应保留 native loop、native tools、approval、sandbox、streaming events 和 resumable session；AgentServer 只做桥接、审计和外层控制。
- 如果 adapter 无法保留这些能力或无法提供状态透明性，必须在 capability 中显式标记为部分能力或降级路径，不能伪装成完整 agent backend。
- 跨 backend 的 stage 拆分、handoff、验证和最终汇总仍然归 AgentServer。
- 同一个 AgentServer session 中，Codex/Claude Code adapter 可以复用各自的 native session；但这些 native session 是加速和连续性资源，不是 AgentServer 的上下文真相源。

这能满足“对外像一个 agent，内部按 backend 专长协作”的目标。

### 3.6 Live Benchmark 模块占位

Live Backend Benchmark 是后续独立模块，不在当前首版 agent-backend orchestration 中实现。

它要记录的问题是：不同 backend 在不同原子能力和真实应用场景中的表现会变化，路由策略需要长期依据真实数据更新。

但真实任务通常只运行一个主 backend 以节省 token。未来 benchmark 设计需要解决：

- 被选中 backend 如何从真实 run 中得分。
- 未被选中 backend 如何通过 replay、离线基准、只读 shadow review、低比例探索获得相对分。
- 质量、正确性、成本、延迟、工具可靠性、用户接受率、后续返工率如何综合。
- benchmark score 如何作为 orchestrator 的路由信号之一，而不是替代 orchestrator。

当前设计记录在 [`backend-benchmark.md`](./backend-benchmark.md)。后续如果实现，应作为独立任务开启，而不是混入首版 agent-backend orchestration。

### 3.7 Evolution Engine 的正确位置

AgentServer 未来可以支持 evaluation 和 evolution，但复杂自进化决策不应该进入 AgentServer Core。

推荐分层：

```text
Evolution Engine
  读取数据、分析趋势、生成 proposal、做 A/B、走审批

AgentServer Core
  提供 run ledger、context refs、metrics、evaluation、proposal store、apply/rollback audit

Backend Harness
  保持自治；v9 可做自己的内部实验
```

推荐演进路径：

```text
record -> evaluate -> propose -> verify -> approve -> apply
```

Run ledger 应逐步记录：

- contextRefs
- events
- usage
- duration
- tool call count
- artifact refs
- evaluation outcome
- project metadata

Evolution Engine 的第一版更适合作为 proposal/data product：

- 提议降低过期 memory 权重
- 提议合并重复 context
- 提议做 backend A/B
- 提议做 context policy A/B
- 提议改进 directive

高风险变更需要 A/B 验证和人工审批。

风险等级不能只由 Evolution Engine 自评。AgentServer Core 应提供独立的 policy checker，对 proposal 做最低限度的硬规则判定。

示例规则：

```text
context item 文案小修
  low / medium，取决于 scope 和影响范围

context policy 权重变化
  medium，除非只影响单个测试 agent

backend routing / orchestrator policy 变化
  high，必须有 A/B 或人工审批

permission / sandbox / worker route 变化
  high，必须人工审批

自动删除 memory 或 artifact
  high，必须有 rollback plan
```

最终 risk 应取：

```text
max(Evolution Engine 自评, AgentServer policy checker 判定)
```

这样 Evolution Engine 可以提出建议，但不能通过低报风险绕过 AgentServer 的安全边界。

### 3.8 v9 的 harness-level evolution

v9 可以做自己的 harness-level evolution，因为它是自研白盒 backend。

例如 v9 内部可以实验：

- stable boundary threshold
- compaction trigger
- prefix/work layout
- retrieval chain
- 内部 context packing strategy

但这和通用 Evolution Engine 是两件事：

| 类型 | 作用范围 | 位置 |
|---|---|---|
| 通用 Evolution Engine | 所有 backend 的外部 context、policy、routing、directive proposal | AgentServer 之上的可选策略层 |
| v9 harness evolution | v9 自己的内部 context/harness 策略 | v9 backend 内部 |

通用 Evolution Engine 可以观察 v9 的表现，也可以给 v9 选择外部 context policy；但不应把 v9 的内部策略强行变成所有 backend 的公共策略。

### 3.9 不做的事情

AgentServer 不做：

- OpenTeam blackboard 算法
- coordinator proposal/decision/final gating
- endpoint registry
- remote SSH/GPU/robot/SCP 的物理工具路由
- UI evidence panel
- team config 管理
- skills marketplace
- VS Code Remote 风格 UI
- claude-code/codex/gemini/openclaw/hermes-agent 内部 harness 替换
- v9 context design 到所有 backend 的强制套用
- Live Benchmark 首版直接内置到主请求链路
- 复杂自进化决策
- 高风险 evolution 变更的默认自动应用
- 绕过 AgentServer 审计的 evolution apply

### 3.10 总结

AgentServer 的最终形态应是简洁、通用、可编排的长期 agent runtime：

```text
AgentServer is a generic long-running agent orchestration runtime.
Projects adapt to it through metadata and context items.
```

它负责让一个 agent 长期、可恢复、可审计地工作，并在内部组合多个 agent backend 的强项。

OpenTeam 负责让一组 agent 围绕 blackboard 和 endpoints 协作。

Backend Runtime 负责把具体 backend 跑起来、吸收原生协议并统一事件。

Agent backend 自己负责内部 harness、native agent loop 和推理执行。

Evolution Engine 作为可选策略层，读取 AgentServer 数据，生成 proposal，并通过 AgentServer 的受控接口应用经过验证和审批的变更。

Live Backend Benchmark 作为后续独立模块，负责评估 backend 专长和成本画像；它给 orchestrator 提供路由信号，但不替代 AgentServer 的编排职责。
