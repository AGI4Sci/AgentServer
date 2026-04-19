# AgentServer Adapter Contract

最后更新：2026-04-19

本文档定义 AgentServer 调用 backend 的最小契约。它面向实现者：新增 Codex、Claude Code、Gemini、自研 agent 或其它 backend 时，优先满足这里的接口和语义。

## 1. Backend Tier

首版 orchestrator 默认只在 strategic backend set 中路由生产任务：

```text
strategic
  Codex
  Claude Code
  Gemini
  self-hosted-agent

experimental
  用于研究、对照、白盒实验或未稳定 adapter

compatibility
  历史兼容、fixture parity、迁移期兜底

legacy
  不进入默认路由，仅保留历史数据或手动调用能力
```

Backend tier 只影响默认路由和 benchmark 优先级，不影响 backend 能否被显式调用。用户或上层项目可以手动选择 non-strategic backend，但 orchestrator policy 不应默认把关键写操作分给 non-strategic backend。

## 2. ExecutionBackend

AgentServer 区分两类执行 backend：

```ts
type ExecutionBackendKind = 'model_provider' | 'agent_backend';

type ExecutionBackend = {
  id: string;
  label: string;
  kind: ExecutionBackendKind;
  tier: 'strategic' | 'experimental' | 'compatibility' | 'legacy';
  strengths: BackendStrength[];
  capabilities: AgentBackendCapabilities;
  adapter: ModelProviderAdapter | AgentBackendAdapter;
};
```

`model_provider` 适合轻量问答、兼容路径和普通 LLM provider。它可以返回文本和有限工具事件，但不能伪装成完整 agent backend。

`agent_backend` 必须保留 backend 原生 agent 能力，并通过 adapter 把原生事件映射为 AgentServer normalized events。

## 2.1 Formal Transport Rule

正式 `agent_backend` 的消费方是 AgentServer 和其它 agent，不是人类终端用户。因此生产级 adapter 不能只依赖不可读状态的 CLI transcript。CLI 可以用于 bootstrap、debug、fallback 或 compatibility path，但 CLI-only adapter 只有在外层 bridge 能稳定暴露结构化事件、可查询状态、审批、工具调用、workspace facts、abort/resume 时，才可以声明为完整 agent backend。

可接受的正式 transport 包括：

- 官方 app-server / SDK。
- JSON-RPC / stdio RPC。
- HTTP 或 WebSocket event stream。
- 本地 runtime API。
- 明确 schema 的自研 bridge。

这条规则的目的不是排斥 CLI，而是避免把面向人的交互界面误当成面向 agent 的控制平面。AgentServer 的最终状态应优先使用结构化 SDK/API/RPC，让 backend 状态透明、可审计、可恢复。

## 2.2 Upstream Source Isolation

官方 backend 源码默认是可更新的 upstream checkout，不是 AgentServer adapter 的主要落点。实现 adapter 时优先级如下：

1. 使用官方 app-server、SDK、JSON-RPC、stdio RPC、HTTP/WebSocket stream 或本地 runtime API。
2. 如果官方协议缺少小块机器可读信息，优先在 AgentServer 侧写 bridge / parser / schema mapper。
3. 如果是 provider/auth input、状态读取、工具事件、approval、sandbox、session、abort/resume 或 packaging 等接线问题，先评估外围 adapter/env/config/bridge/profile 降级能否合理解决。
4. 如果外围适配成本明显不成比例，或会严重损失 backend 原生 agent 能力与状态透明性，可以对官方源码做小 patch。
5. 如果必须修改官方源码，改动必须尽量小、集中、可重放，并登记到 [Upstream Backend Overrides](./upstream-backend-overrides.md)。

登记信息至少包括：

- backend 名称与本地路径。
- 对应 upstream commit / tag / 更新日期。
- 修改过的官方文件列表。
- 每个修改的目的，例如暴露 event、补 schema、打开 app-server endpoint、修 launcher path。
- 重新同步官方版本后的重放步骤或检查点。

没有登记的官方源码改动不能被视为 adapter contract 的一部分。adapter 的长期目标是在 AgentServer 自己的 runtime 层吸收差异，让 `server/backend/codex`、`server/backend/gemini` 等目录可以随官方版本更新。

这个取舍不是单纯追求“零 upstream patch”。更高优先级是完整复用 backend 的原生 agent 能力，同时保持源码更新路径清晰：能在外围适配就放外围；外围代价失衡时，允许进入官方源码，但必须把改动变成可审计、可重放的工程事实。

## 3. Backend Strength Policy

首版推荐强项画像：

| Backend | Tier | 主要强项 | 默认避免 |
|---|---|---|---|
| Codex | strategic | 代码审查、bug 定位、测试失败分析、diff 风险验证 | 大规模机械编辑的唯一执行者 |
| Claude Code | strategic | 实现、重构、跨文件编辑、工程执行 | 独立承担最终风险审查 |
| Gemini | strategic | 长上下文、多模态、宽范围资料整合、代码库大范围阅读 | 未声明完整工具/sandbox 能力时执行高风险写操作 |
| self-hosted-agent | strategic | 白盒 harness、context/tool/orchestration 策略实验 | 作为黑盒生产默认能力评分来源 |

`BackendStrength` 至少应包含：

```ts
type BackendStrength = {
  taskType:
    | 'plan'
    | 'diagnose'
    | 'implement'
    | 'review'
    | 'verify'
    | 'summarize'
    | 'long_context'
    | 'multimodal'
    | 'research';
  scoreHint: 'preferred' | 'allowed' | 'avoid';
  reason: string;
};
```

Live Benchmark 后续可以把 `scoreHint` 替换或补充为数据驱动分数，但首版 policy 不依赖 benchmark 才能启动。

## 4. Stage Model

一次用户 request 对外仍是一个 `Run`，内部可以拆成多个 `Stage`：

```ts
type AgentRunStageType =
  | 'plan'
  | 'diagnose'
  | 'implement'
  | 'review'
  | 'verify'
  | 'summarize';

type AgentRunStage = {
  id: string;
  runId: string;
  type: AgentRunStageType;
  backendId: string;
  status: StageStatus;
  dependsOn: string[];
  ownership?: StageOwnership;
  input: BackendHandoffPacket;
  result?: BackendStageResult;
  metrics?: StageMetrics;
  audit: StageAudit;
};
```

Stage dependency graph 规则：

- 读、规划、诊断、审查 stage 可以并行，前提是它们不写同一 workspace。
- 写操作默认串行。
- 并行写操作必须声明 `ownership`，例如文件集合、目录集合或独立 worktree。
- `verify` stage 必须读取真实 workspace 状态、git diff 和测试输出，不能只依赖上一 stage 的自然语言总结。
- `summarize` stage 只能汇总已审计事实，不能补写 workspace。

```ts
type StageOwnership = {
  workspaceId: string;
  paths?: string[];
  worktree?: string;
  writeMode: 'none' | 'serial' | 'owned_paths' | 'isolated_worktree';
};
```

## 5. Run And Stage Status

Run 状态：

```ts
type RunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';
```

Stage 状态：

```ts
type StageStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped';
```

Run 和 Stage 的状态关系：

- Run `running` 可以包含多个 `pending/running/completed` stage。
- 任一 stage `waiting_user` 时，Run 应进入 `waiting_user`，直到审批、澄清或用户输入恢复执行。
- Stage `failed/timeout` 后，Run 是否失败由 orchestrator policy 决定。
- 如果 fallback stage 成功，Run 可以 `completed`，但 audit 必须记录失败 stage 和 fallback stage。
- 用户取消时，所有 active stage 必须收到 abort，Run 最终进入 `cancelled`。

## 6. Agent Backend Capabilities

完整 `agent_backend` 在单个 stage 内应尽量接近人类直接使用该 agent 的能力。adapter 必须显式声明能力：

```ts
type AgentBackendCapabilities = {
  nativeLoop: boolean;
  nativeTools: boolean;
  nativeSandbox: boolean;
  nativeApproval: boolean;
  nativeSession: boolean;
  fileEditing: boolean;
  streamingEvents: boolean;
  structuredEvents: boolean;
  readableState: boolean;
  abortableRun: boolean;
  resumableSession: boolean;
  statusTransparency: 'full' | 'partial' | 'opaque';
  multimodalInput?: boolean;
  longContext?: boolean;
};
```

降级路径必须显式。例如：

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

如果某 backend 只有部分能力，它仍可接入，但 orchestrator 必须按真实 capability 路由；audit 也要记录该 stage 是完整 agent-backend 路径还是降级路径。

生产路由默认只信任 `statusTransparency: 'full'` 或策略明确允许的 `partial` backend。`opaque` backend 可以用于兼容、实验或人工指定任务，但不能被标记为首选生产 agent backend。

## 7. AgentBackendAdapter

最小接口：

```ts
type AgentBackendAdapter = {
  backendId: string;
  kind: 'agent_backend';
  capabilities(): Promise<AgentBackendCapabilities>;
  startSession(input: StartBackendSessionInput): Promise<BackendSessionRef>;
  runTurn(input: RunBackendTurnInput): AsyncIterable<NormalizedBackendEvent>;
  abort(input: AbortBackendRunInput): Promise<void>;
  readState(input: ReadBackendStateInput): Promise<BackendReadableState>;
  dispose(input: DisposeBackendSessionInput): Promise<void>;
};
```

`runTurn` 是一轮 stage/turn，不是单次模型 completion。完整 agent backend 可以在这一轮内部进行多步 agent loop、工具调用、审批和 sandbox 执行。

`readState` 是正式路线的关键接口。它必须返回机器可读状态，而不是要求调用方解析终端文本：

```ts
type BackendReadableState = {
  sessionRef: BackendSessionRef;
  status: 'idle' | 'running' | 'waiting_user' | 'failed' | 'disposed';
  activeRunId?: string;
  activeStageId?: string;
  activeToolCall?: {
    id: string;
    name: string;
    inputSummary?: string;
  };
  pendingApproval?: {
    id: string;
    toolName?: string;
    risk?: 'low' | 'medium' | 'high';
    detail?: string;
  };
  workspaceState?: {
    dirtyFiles: string[];
    diffSummary?: string;
  };
  lastStage?: AgentRunStageRecord;
  lastEventAt?: string;
  resumable: boolean;
  metadata?: Record<string, unknown>;
};
```

## 8. Native Session Binding

默认策略：

```text
AgentServer session-scoped native session
```

也就是同一个 AgentServer session 中，同一个 backend 可以复用自己的 native thread/session：

```ts
type NativeSessionBinding = {
  agentServerSessionId: string;
  backendId: string;
  nativeSessionRef: BackendSessionRef;
  scope: 'session' | 'stage';
  createdAt: string;
  lastUsedAt: string;
  resumable: boolean;
};
```

约束：

- native session 是连续性和性能资源，不是真相源。
- canonical context、run ledger、stage result、workspace hard facts 才是 AgentServer 的可审计真相源。
- adapter 必须支持 native session 丢失后的重建。
- orchestrator 可以在隐私隔离、状态污染、shadow review、fallback 等场景使用 stage-scoped native session。

## 9. Handoff Packet

AgentServer 在调用 backend 前生成 `BackendHandoffPacket`。它不是完整聊天 transcript，而是结构化、可审计、面向当前 stage 的输入。

```ts
type BackendHandoffPacket = {
  runId: string;
  stageId: string;
  stageType: AgentRunStageType;
  goal: string;
  userRequest: string;
  canonicalContext: CanonicalSessionContextSnapshot;
  stageInstructions: string;
  constraints: string[];
  workspaceFacts: WorkspaceFacts;
  priorStageSummaries: StageSummary[];
  openQuestions: string[];
  metadata?: Record<string, unknown>;
};
```

Handoff 由 AgentServer 生成。backend 自己的 summary 可以作为输入之一，但不能直接成为唯一 handoff。

## 10. Stage Result

每个 stage 结束后 adapter 必须返回结构化事实：

```ts
type BackendStageResult = {
  status: StageStatus;
  finalText?: string;
  filesChanged: string[];
  diffSummary?: string;
  toolCalls: ToolCallSummary[];
  testsRun: TestRunSummary[];
  findings: Finding[];
  handoffSummary: string;
  nextActions: string[];
  risks: string[];
  artifacts: ArtifactRef[];
  nativeSessionRef?: BackendSessionRef;
};
```

Workspace hard facts 优先级高于自然语言总结。AgentServer 在 stage boundary 必须读取或接收：

- git diff / file change list
- 测试命令和结果
- 工具调用摘要
- artifact refs
- backend 原生错误和退出状态

## 11. Approval Bridge

Backend 原生审批请求必须映射为 AgentServer 统一事件：

```ts
type ApprovalEvent = {
  type: 'permission-request';
  requestId: string;
  stageId: string;
  backendId: string;
  toolName: string;
  detail?: string;
  risk?: 'low' | 'medium' | 'high';
};
```

审批结果再由 adapter 转回 backend 原生协议。Run 在等待审批时进入 `waiting_user`。

如果当前调用路径还没有可用的上层审批决策面，adapter 不能默认授权高风险操作；必须安全拒绝、取消，或把 stage 明确置为 `waiting_user`。审批请求不能被当作普通通知吞掉，也不能只留在 backend 私有状态里。

## 12. Sandbox Ownership

两种模式都允许：

```text
backend-native sandbox
  backend 自己执行 sandbox/approval/tool policy

agentserver-wrapped sandbox
  AgentServer worker/sandbox 先限制 backend 进程和 workspace，再让 backend 内部运行
```

adapter 必须声明实际模式。高风险 workspace 写操作、远程 worker、生产凭据访问等策略由 orchestrator policy 和 AgentServer permission 层控制。

## 13. Failure And Fallback

失败处理由 orchestrator policy 决定，但 adapter 必须报告足够事实：

- startup failure
- native session lost
- approval timeout
- tool failure
- sandbox denied
- workspace permission denied
- backend timeout
- malformed native event
- partial write detected

Fallback 规则：

- 读/审查/总结 stage 可以较安全地 fallback。
- 写 stage fallback 前必须先记录 workspace diff，并由 AgentServer 决定是否继续、回滚或要求用户确认。
- backend 中途失败不能静默切换；audit 必须记录原 backend、失败原因、fallback backend 和 handoff 输入。

## 14. Normalized Events

adapter 可以保留原生事件用于 debug trace，但对上层必须输出 normalized event：

```ts
type NormalizedBackendEvent =
  | { type: 'status'; status: RunStatus | StageStatus; stageId?: string; message?: string }
  | { type: 'text-delta'; stageId?: string; text: string }
  | { type: 'tool-call'; stageId?: string; toolName: string; detail?: string }
  | { type: 'tool-result'; stageId?: string; toolName: string; detail?: string; output?: string }
  | ApprovalEvent
  | { type: 'stage-result'; stageId: string; result: BackendStageResult }
  | { type: 'result'; output: { success: true; result: string } | { success: false; error: string } }
  | { type: 'error'; stageId?: string; error: string };
```

外部 SDK/HTTP 可以默认隐藏 stage 细节，只在 debug trace / audit 中暴露。
