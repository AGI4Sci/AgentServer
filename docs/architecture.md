# AgentServer 架构设计

最后更新：2026-04-18

## 第一章：原则与边界

### 1.1 核心定位

AgentServer 是一个通用的 **Long-running Agent Runtime**。

它要解决的问题很简单：让一个 agent 可以长期、稳定、可恢复、可审计地工作。

一句话概括：

```text
AgentServer = long-running agent state + external context + run gateway + audit
```

也就是说，AgentServer 负责：

- 创建和维护长期 agent
- 绑定稳定 workspace
- 管理跨 session 的外部上下文
- 把任务交给具体 backend agent 执行
- 记录 run、turn、event、artifact
- 在出错、上下文过大、session 结束时提供恢复和维护能力

它不应该成为某个上层产品的专用服务。OpenTeam Studio Run 是 AgentServer 的重要消费者，但 AgentServer 本身应该足够通用，让 IDE、CI、research pipeline、数据分析平台、机器人系统或其他项目都能通过少量适配使用。

### 1.2 三层策略边界

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
  提供 run gateway、audit、context refs、policy snapshots
  不内置复杂自进化决策
        |
        v
Backend Harness
  openteam_agent / claude-code / claude-code-rust / codex / hermes-agent / openclaw / zeroclaw / v9
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
AgentServer Core 提供数据地基和安全变更点
Evolution Engine 负责策略学习和提案
Backend Harness 负责单个 backend 的内部运行机制
```

### 1.3 最小核心模型

AgentServer 顶层只保留五个通用对象：

```text
Agent
Session
ContextItem
Run
Artifact
```

含义如下：

| 对象 | 含义 |
|---|---|
| Agent | 一个长期存在的 agent 实例 |
| Session | Agent 的一段连续工作上下文 |
| ContextItem | AgentServer 管理的外部可审计上下文 |
| Run | 一次任务执行记录 |
| Artifact | Run 产生的文件、日志、报告、diff、截图等产物 |

这五个对象是 AgentServer 的核心领域。其他业务概念都不应该进入核心模型。

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

### 1.4 项目差异通过 metadata 适配

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

### 1.5 外部上下文与内部 harness 分离

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
AgentServer 管理外部可审计上下文
Agent backend 管理内部 harness context
```

这条边界很关键。AgentServer 可以给 agent 提供上下文，但不拆 agent 自己的内部运行机制。

### 1.6 Backend Runtime 吸收 backend 差异

AgentServer 不直接处理每个 backend 的原生协议。

backend 差异应该由 Backend Runtime 吸收：

- backend catalog
- managed launcher
- supervisor
- adapter contract
- runtime event normalization
- error normalization
- backend capability

AgentServer 只需要通过统一入口调用 backend：

```ts
runSessionViaSupervisor(backend, { task, context }, options)
```

这样新增 backend 时，主要改 Backend Runtime，而不是改 AgentServer 核心。

### 1.7 v9 的定位

v9 context design 更适合作为自研 v9 agent 的内部 harness 策略。

Context 文档拆分为两层：

```text
docs/context-core.md
  AgentServer Core 通用 context 契约

docs/context-harness.md
  v9/custom backend harness context 策略；当前第一阶段落点是 openteam_agent
```

它和 claude-code、codex、openclaw、zeroclaw 的内部 harness 是同级关系：

```text
claude-code backend -> Claude Code harness
codex backend       -> Codex harness
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

### 1.8 分层关系

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
  Context memory/state/work
  Context assembly + refs
  Run gateway
  Audit + artifacts
  Maintenance preview/apply
        |
        | runSessionViaSupervisor(...)
        v
Backend Runtime
  Backend catalog
  Managed launcher
  Supervisor
  Adapter contract
  Runtime event normalization
        |
        v
Agent Backend
  openteam_agent / claude-code / claude-code-rust / codex / hermes-agent / openclaw / zeroclaw / v9 / future backend
  Owns internal harness, system prompt, tool policy, permission model, compaction
```

职责边界：

| 层 | 负责 | 不负责 |
|---|---|---|
| 上层项目 | 业务语义、多 agent 协作、任务编排、UI、endpoint routing、审批策略 | 长期 agent session/memory 真相源、backend 原生协议 |
| Evolution Engine | 读取 run ledger/metrics/evaluation/context usage，生成 proposal，做 A/B 和审批流，调用 AgentServer API 应用配置 | 直接操作 backend harness、绕过 AgentServer 改状态、无审计自动改高风险策略 |
| AgentServer Core | Agent/Session/ContextItem/Run/Artifact、外部上下文、run gateway、audit、recovery、maintenance、policy snapshots | OpenTeam blackboard 算法、endpoint 物理路由、backend 内部 harness、复杂自进化决策 |
| Backend Runtime | backend catalog、launcher、supervisor、adapter、统一事件、错误归一化 | 长期 memory、业务任务编排、项目知识策略 |
| Agent Backend | 模型交互、内部 harness、tool policy、permission model、内部 context/compaction | 跨项目长期状态、多 agent 协作、业务 audit |

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
    cwd?: string;
    timeoutMs?: number;
    toolMode?: 'auto' | 'none';
    metadata?: Record<string, unknown>;
  };

  metadata?: Record<string, unknown>;
}
```

推荐通用响应结构：

```ts
interface RunResult {
  agentId: string;
  sessionId: string;
  runId: string;
  status: 'completed' | 'failed' | 'waiting_user';
  output: string;
  events: RuntimeEvent[];
  contextRefs: ContextRef[];
  usage?: Usage;
  artifacts?: ArtifactRef[];
  metadata?: Record<string, unknown>;
}
```

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
  session/context/run/audit
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
- AgentServer 负责长期 agent 宿主、上下文、run、audit
- Backend Runtime 负责 backend 执行
- Tool Router 负责 endpoint 物理执行位置

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

AgentServer 不应该内置 OpenTeam 专用 endpoint routing。

正确分工是：

```text
OpenTeam Tool Router  决定工具实际在哪里执行
AgentServer           保存 run/context/audit 和 endpoint metadata
Backend Runtime       运行具体 backend
Agent Backend         执行自己的内部 harness
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

AgentServer 不把这些策略强加给 claude-code、codex、openclaw、zeroclaw。

### 3.5 Evolution Engine 的正确位置

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

### 3.6 v9 的 harness-level evolution

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

### 3.7 不做的事情

AgentServer 不做：

- OpenTeam blackboard 算法
- coordinator proposal/decision/final gating
- endpoint registry
- remote SSH/GPU/robot/SCP 的物理工具路由
- UI evidence panel
- team config 管理
- skills marketplace
- VS Code Remote 风格 UI
- claude-code/codex/openclaw/zeroclaw 内部 harness 替换
- v9 context design 到所有 backend 的强制套用
- 复杂自进化决策
- 高风险 evolution 变更的默认自动应用
- 绕过 AgentServer 审计的 evolution apply

### 3.8 总结

AgentServer 的最终形态应尽可能简洁、通用：

```text
AgentServer is a generic long-running agent runtime.
Projects adapt to it through metadata and context items.
```

它只负责让一个 agent 长期、可恢复、可审计地工作。

OpenTeam 负责让一组 agent 围绕 blackboard 和 endpoints 协作。

Backend Runtime 负责把具体 agent 跑起来并统一事件。

Agent backend 自己负责内部 harness 和推理执行。

Evolution Engine 作为可选策略层，读取 AgentServer 数据，生成 proposal，并通过 AgentServer 的受控接口应用经过验证和审批的变更。
