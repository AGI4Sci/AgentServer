# AgentServer - PROJECT.md

最后更新：2026-04-19

## 使用约定
- 本文档作为 AgentServer 工程任务板使用，只保留正在推进或待推进的任务。
- 已完成任务的长正文不留在本文档中；需要历史细节时查看 git history。
- 每个任务只保留 `目标说明 / 成功标准 / TODO / 异常发现 / Takeaway`。
- 设计原则、架构说明、接口语义写在 `docs/architecture.md`；任务拆解和执行状态写在本文档。
- 文档入口、导航和主题归档统一放在 `docs/` 目录。
- AgentServer Core 保持通用、稳定、简洁；复杂自进化决策不进入核心。
- Evolution Engine 作为可选插件/服务，读取 AgentServer 数据，生成 proposal，并通过受控 API 应用已验证变更。
- Backend Harness 保持自治；v9 可以做自己的 harness-level evolution，但不作为所有 backend 的公共策略。
- 开发过程中发现新的 TODO，优先追加到本文档。

## 当前状态
- `T035`：Agent Backend Orchestration 最终架构（推进中）：AgentServer 从多 backend facade 升级为多 agent backend 编排层；首版 strategic backend 只支持 Codex、Claude Code、Gemini 和自研 agent。
- `T036`：首版完整 agent-backend adapter（待推进）：将 Codex、Claude Code、Gemini 和自研 agent 作为首版完整 agent backend 接入，而不是把所有历史 backend 平权推进。
- `T037`：统一上下文与 backend handoff 契约（待推进）：由 AgentServer 持有 canonical session context，各 backend 只接收面向任务阶段的 handoff packet。
- `T038`：Live Backend Benchmark 独立模块（待讨论，暂不实现）：记录需要独立设计 backend 评估与路由打分模块，后续单独深入讨论。
- `T039`：Run/Stage 状态机与 Adapter Contract 文档（待推进）：补齐 Stage 一等模型、状态机、adapter contract、metadata 治理和 evolution risk checker。
- `T040`：Native Session Scope 与 Orchestrator Policy 边界（已记录，待落文档/接口）：明确 backend native session 默认 session-scoped 复用但不是真相源，orchestrator 拆为 core kernel 与可插拔 policy。

## 已完成任务归档摘要
- `T001`-`T034` 已完成或已被后续任务取代；详细任务正文从本文档移除以节约上下文。
- 关键完成里程碑：通用 runs facade、metadata/audit、context/evaluation 基础字段、proposal store、backend smoke、Hermes/openteam_agent 集成、SDK 化、deployment/workers/tool routing、SSH worker smoke、worker env/proxy 注入。

---

### T035

#### 目标说明
- 定义 AgentServer 的最终形态：不是多 model provider 网关，而是多 agent backend 的统一编排层。
- 对外仍暴露一个连续 agent/session/run；内部可以按任务阶段调用不同 backend，例如 Codex 负责审查和找 bug，Claude Code 负责实现，Gemini 负责长上下文/多模态/宽范围分析，自研 agent 负责白盒 harness 与策略实验。
- 不考虑旧接口兼容性时，优先让最终状态契合长期需求：AgentServer 拥有上下文、权限、审计、路由、验证和用户体验；backend 只作为可组合的执行专家。
- 首版 strategic backend set 收敛为 `codex / claude-code / gemini / self-hosted-agent`；其它 backend 保留为 experimental / compatibility / legacy，不进入首版默认 orchestrator 路由。

#### 成功标准
- 文档明确区分 `model-provider runtime` 和 `agent-backend runtime`。
- 文档明确 AgentServer 是 orchestrator，不把 orchestration 交给某一个 backend。
- 文档明确每个 backend adapter 都必须输出 normalized result，而不是把 backend 私有事件直接泄漏给上层。
- 文档明确一次用户 request 可以被拆成多个 backend stage，但对外保持一个 run。
- 文档明确 backend 切换默认隐藏在主体验中，只在 debug trace / audit 中可见。
- 文档明确完整 `agent_backend` 在单个 stage 内必须尽量保留 native loop、tools、approval、sandbox、streaming events 和 resumable session。
- 文档明确部分能力或降级路径必须通过 capability 显式声明，不能伪装成完整 agent backend。
- 文档明确首版 strategic backend set 只包含 Codex、Claude Code、Gemini 和自研 agent。

#### TODO
- [x] 在 `docs/architecture.md` 增加 Agent Backend Orchestration 章节。
- [ ] 定义 `ExecutionBackend`：`model_provider` 与 `agent_backend` 两类。
- [ ] 定义 `AgentRunStage`：`plan / diagnose / implement / review / verify / summarize` 等阶段。
- [ ] 定义 stage dependency graph：读/审查可并行，写操作需串行或声明 ownership。
- [ ] 明确 orchestrator 首版使用 rule-based policy，LLM planning 后续作为可校验增强。
- [ ] 定义 orchestrator core kernel 与 orchestrator policy 的接口边界。
- [ ] 定义 orchestrator policy 变更的 proposal / risk checker 流程。
- [ ] 定义 backend strength policy：描述每个 backend 擅长和应避免的任务类型。
- [ ] 定义 backend tier：`strategic / experimental / compatibility / legacy`。
- [ ] 定义首版 strategic backend set：Codex、Claude Code、Gemini、自研 agent。
- [ ] 定义 orchestrator 决策输入：任务类型、workspace 状态、成本预算、latency、risk、历史 benchmark score、用户偏好。
- [ ] 定义对外事件语义：一个 run 可以包含多个 internal stages，但 SDK/HTTP 仍输出统一事件流。
- [ ] 定义 audit trace：记录每个 stage 用了哪个 backend、输入摘要、输出摘要、成本、耗时、验证结果。
- [x] 写入完整 agent backend 能力保留原则和显式降级语义。

#### 异常发现
- 当前 `openai-codex` 更接近 model provider：能复用 Codex 后端模型和 OAuth，但不能自动复用 Codex 官方 agent loop、工具注册、上下文管理和沙箱。
- 如果直接把某个官方 SDK 当作主运行时，AgentServer 会失去统一 orchestration、worker routing、审计、verification 和多 backend 组合能力。

#### Takeaway
- AgentServer 的长期价值是成为“统一 agent 指挥中心”：backend 贡献专业能力，但 session/context/policy/verification 归 AgentServer。

---

### T036

#### 目标说明
- 将 Codex app-server / SDK、Claude Code、Gemini 和自研 agent 接为首版完整 `agent_backend`，而不是继续只通过普通 provider 抽象调用模型。
- 让代码任务可以在一次 request 内复用 backend 的完整能力：agent loop、官方工具事件、thread/session、approval、sandbox 或等价执行策略。
- 保留 `openai-codex` direct provider 和其它历史 backend 的定位为轻量/兼容/实验/兜底路径；强任务优先走首版 strategic backend。

#### 成功标准
- 存在 `AgentBackendAdapter` 抽象。
- Codex adapter 能启动或连接 Codex app-server，创建/恢复 thread，提交 turn，监听事件，返回 final result。
- Claude Code adapter 能以完整 agent backend 方式执行任务，而不是只模拟一次模型请求。
- Gemini adapter 能以完整 agent backend 或最接近完整 agent 的方式支持长上下文、多模态和宽范围分析任务，并显式声明能力缺口。
- 自研 agent adapter 能作为白盒 harness 接入，用于验证 context/tool/orchestration 策略。
- adapter 能把 backend 原生事件映射为 AgentServer normalized events。
- adapter 能把 backend 的文件变更、工具调用、审批请求、错误、最终回答转成 normalized result。
- 同一个 AgentServer session 可以绑定不同 backend 的 native session/thread id。
- adapter capability 明确标注 `nativeLoop/nativeTools/nativeSandbox/nativeApproval/nativeSession/fileEditing/streamingEvents/resumableSession` 等能力。

#### TODO
- [ ] 设计 `AgentBackendAdapter` 接口：`startSession / runTurn / abort / readState / dispose`。
- [ ] 新增 `docs/adapter-contract.md`，说明 model-provider adapter 与 agent-backend adapter 的最小接口。
- [ ] 在 `docs/adapter-contract.md` 定义 agent-backend capability declaration 与降级语义。
- [ ] 设计 native session binding 存储：`agentServerSessionId -> backendId -> nativeSessionRef`。
- [ ] 明确 adapter 默认复用 session-scoped native session，但必须支持 stage-scoped 隔离和 native session 重建。
- [ ] 实现 Codex app-server adapter 原型，优先使用 app-server JSON-RPC，而不是只 spawn CLI 文本流。
- [ ] 实现 Claude Code agent-backend adapter 原型，暴露同样的 normalized event/result。
- [ ] 实现 Gemini agent-backend adapter 原型，优先覆盖长上下文、多模态和资料整合场景。
- [ ] 实现自研 agent adapter 原型，用于白盒 context/tool/orchestration 策略实验。
- [ ] 定义 approval bridge：backend 请求审批时转成 AgentServer 审批事件。
- [ ] 定义 sandbox ownership：agent backend 模式下由 backend 自管，或把 backend 进程运行在 AgentServer worker/sandbox 内。
- [ ] 增加 smoke：同一简单代码修改任务分别通过 Codex agent backend 和 Claude Code agent backend 完成，并输出标准事件。
- [ ] 增加 failure-mode 文档：backend 启动失败、native session 丢失、审批超时、工具失败、workspace 权限不足。

#### 异常发现
- Codex SDK 的高层能力适合做完整 agent backend，但不适合作为现有 model provider 的简单替换。
- 完整 agent backend 的 fallback 语义不同于普通 model provider：执行中途静默切换 backend 可能破坏工具状态和 workspace 状态。

#### Takeaway
- SDK/app-server 是 backend adapter 的实现细节；AgentServer 不能把自己的 orchestration 责任交给任何单一 backend。

---

### T037

#### 目标说明
- 建立跨 backend 的统一上下文模型，让多个 agent backend 像同一个 agent 的不同专家角色一样接力工作。
- AgentServer 持有 canonical session context；每次调用 backend 时生成该 backend 和该阶段专用的 handoff packet。
- 不依赖复制完整聊天 transcript 来实现“无缝上下文”，而依赖显式状态、workspace diff、测试结果和结构化 handoff。

#### 成功标准
- 存在 canonical session context schema。
- 每个 backend stage 结束后必须产生 normalized handoff summary。
- handoff summary 包含目标、当前状态、已改文件、关键决策、测试状态、风险、下一步建议。
- 文件系统、git diff、测试输出、artifact、run ledger 是 backend 间共享事实来源。
- backend 私有 thread/session 只作为加速和连续性手段，不是唯一上下文来源。

#### TODO
- [ ] 定义 `CanonicalSessionContext`：goal、plan、decisions、workspace state、artifacts、backend run records、open questions。
- [ ] 定义 `BackendHandoffPacket`：给下一 backend 的压缩上下文输入。
- [ ] 定义 `BackendStageResult`：filesChanged、diffSummary、toolCalls、testsRun、findings、handoffSummary、nextActions。
- [ ] 明确 handoff 由 AgentServer 生成，backend summary 只作为输入之一。
- [ ] 将 workspace hard facts：git diff、测试输出、artifact refs 纳入 adapter/stage result contract。
- [ ] 在 run ledger 中记录每个 stage 的 structured handoff。
- [ ] 实现 handoff prompt renderer：Codex、Claude Code、普通 model provider 各有适配模板。
- [ ] 增加 stage boundary verification：切换 backend 前读取真实 workspace diff 和测试状态，而不是只相信上一 backend 的自然语言总结。
- [ ] 增加上下文压缩策略：长 session 优先保留目标、决策、diff/test 事实和未解决风险。

#### 异常发现
- backend 之间不能共享隐式记忆；Codex thread 内知道的内容，Claude Code 不一定知道。
- 聊天历史不是最可靠的跨 backend 状态；workspace、diff、测试和结构化 handoff 更稳定。

#### Takeaway
- “对外像一个 agent”不是靠单一 backend thread 实现，而是靠 AgentServer 持有统一上下文和显式 handoff。

---

### T038

#### 目标说明
- 记录需要一个独立的 Live Backend Benchmark 模块，但本阶段先不实现。
- 该模块未来用于按原子能力和应用场景给不同 backend 打分，并把分数作为 orchestrator 路由信号之一。
- benchmark 需要后续单独设计，因为真实任务默认只用一个 backend 完成以节约 token；系统仍需通过验证结果、用户反馈、抽样 shadow run 和历史 replay 估计其它 backend 的相对能力。
- 首版 benchmark 设计优先围绕 Codex、Claude Code、Gemini 和自研 agent，不为 experimental / compatibility / legacy backend 扩大首批复杂度。

#### 成功标准
- 任务板中保留 benchmark 独立模块提醒，避免后续架构推进时忘记。
- 明确 benchmark 不属于当前 agent-backend adapter 首批实现范围。
- 明确 benchmark 与 orchestrator 的关系：benchmark 产出能力分数，orchestrator 消费分数，但 orchestrator 不依赖 benchmark 才能启动。
- 明确 benchmark 首版评分对象只覆盖 strategic backend set。
- 后续讨论时再展开 taxonomy、score schema、runner、线上反馈和探索策略。

#### TODO
- [x] 在任务板保留 benchmark 独立模块提醒。
- [ ] 后续单独开 benchmark 设计任务。
- [ ] 讨论 benchmark taxonomy：atomic 能力与 scenario 应用场景。
- [ ] 讨论评分来源：离线基准、真实任务结果、用户反馈、replay、shadow/audit、exploration。
- [ ] 讨论如何在节约 token 的前提下更新未执行 backend 的相对分。
- [ ] 讨论 benchmark score 如何进入 orchestrator 路由策略。

#### 异常发现
- 真实任务每次都让所有 backend 完整执行会浪费 token，并且多个 backend 同时写 workspace 会带来冲突。
- 单 backend 线上任务只能直接评价“被选中的 backend”；不能直接知道其它 backend 在同一任务上会不会更好。
- LLM judge 可以辅助评分，但不能替代测试、lint、diff 检查、用户接受率和后续返工率。

#### Takeaway
- benchmark 应作为独立模块记录和推进；当前架构先为它预留数据与路由接口，具体算法和实现后续再深入讨论。

---

### T039

#### 目标说明
- 吸收架构评审中指出的落地摩擦点，补齐 Run/Stage、adapter、metadata、错误处理和 evolution risk 的明确契约。
- 这些内容是从设计走向实现时的基础约束，应先文档化，再进入代码实现。

#### 成功标准
- `Stage` 明确作为 `Run` 的一等子对象进入核心模型。
- 架构文档包含 Run/Stage 状态机。
- 架构文档说明 `work` context 的 session-scoped 滑动窗口生命周期。
- 架构文档说明 metadata namespace / schema registry 方向。
- 架构文档说明 Evolution proposal risk 需要 AgentServer policy checker 兜底。
- 后续存在单独 adapter contract 文档任务。

#### TODO
- [x] 更新 `docs/architecture.md`，把 Stage 纳入核心模型。
- [x] 更新 `docs/architecture.md`，补 Run/Stage 状态机与 stage 失败策略。
- [x] 更新 `docs/architecture.md`，补 `work` context 生命周期。
- [x] 更新 `docs/architecture.md`，补 metadata namespace 治理建议。
- [x] 更新 `docs/architecture.md`，补 Evolution risk policy checker。
- [ ] 新增 `docs/adapter-contract.md`。
- [ ] 在 `docs/context-core.md` 同步 `work` 生命周期和 context 淘汰策略。
- [ ] 在公共 API 或 runtime 文档中同步 Run/Stage 状态字段。

#### 异常发现
- 如果 Stage 不进入核心模型，多 backend orchestration 的审计会变成自然语言描述，无法稳定回答每个 backend 在 run 中做了什么。
- 如果没有状态机和失败策略，backend 超时、等待用户、部分写入后 fallback 等场景会在实现时变成隐式行为。

#### Takeaway
- 多 agent backend 编排的关键不是多调用几个 backend，而是把 stage、状态、handoff、adapter 和风险边界变成可审计契约。

---

### T040

#### 目标说明
- 回答多 backend 编排中的两个边界问题：
  - backend native session 是 stage-scoped 还是 AgentServer session-scoped。
  - orchestrator 是 AgentServer Core 的一部分，还是可替换策略层。
- 为 adapter contract 和 orchestrator policy 设计提供明确前提。

#### 成功标准
- 架构文档明确 native session 默认 `AgentServer session-scoped`，同一 backend 在同一 AgentServer session 中可以复用 native thread/session。
- 架构文档明确 native session 不是真相源；canonical context、run ledger、stage result、workspace hard facts 才是可审计真相源。
- 架构文档明确 adapter 必须支持 native session 丢失后的重建。
- 架构文档明确 orchestrator 分为 Core Kernel 与 Policy 两层。
- 架构文档明确 Evolution Engine 可以提 orchestrator policy proposal，但不能直接替换 Core Kernel。

#### TODO
- [x] 更新 `docs/architecture.md`，明确 native session scope。
- [x] 更新 `docs/architecture.md`，明确 native session 不是真相源且必须可重建。
- [x] 更新 `docs/architecture.md`，明确 stage-scoped native session 的适用场景。
- [x] 更新 `docs/architecture.md`，明确 orchestrator core kernel / policy 分层。
- [x] 更新 `docs/architecture.md`，明确 orchestrator policy 变更走 proposal / policy checker。
- [ ] 后续在 `docs/adapter-contract.md` 同步 native session binding 接口。
- [ ] 后续在 policy 文档或配置 schema 中定义 orchestrator policy 类型和风险等级。

#### 异常发现
- 如果 native session 完全 stage-scoped，会牺牲 Codex/Claude Code 等 backend 的内部连续性。
- 如果 native session 完全作为 session 真相源，又会削弱 canonical context 和 handoff 的权威性。
- 如果 orchestrator policy 直接写死在 Core，后续演进会让 Core 快速膨胀；如果完全外置，又会削弱状态机和 audit 的一致性。

#### Takeaway
- 推荐折中：native session 默认 session-scoped 复用但不可作为真相源；orchestrator core kernel 留在 Core，policy 可插拔且受 proposal/risk checker 约束。
