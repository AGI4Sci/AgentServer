# AgentServer - PROJECT.md

最后更新：2026-04-19

## 使用约定
- 本文档作为 AgentServer 工程任务板使用，只保留正在推进或待推进的任务。
- 已完成任务的长正文不留在本文档中；需要历史细节时查看 git history。
- 设计原则、架构说明、接口语义写在 `docs/architecture.md` / `docs/adapter-contract.md`；任务拆解和执行状态写在本文档。
- 文档入口、导航和主题归档统一放在 `docs/` 目录。
- AgentServer Core 保持通用、稳定、简洁；复杂自进化决策不进入核心。
- 开发过程中发现新的 TODO，优先追加到本文档。

## 当前状态
- `T036`：首版完整 agent-backend adapter（推进中）：首版 strategic backend 只支持 Codex、Claude Code、Gemini 和自研 agent；契约已文档化，后续进入 adapter 原型实现。
- `T037`：统一上下文与 backend handoff 契约（推进中）：canonical context / handoff / stage result 已文档化，后续进入 run ledger、renderer 和 stage boundary verification 实现。
- `T038`：Live Backend Benchmark 独立模块（待讨论，暂不实现）：记录需要独立设计 backend 评估与路由打分模块，后续单独深入讨论。

## 已完成任务归档摘要
- `T001`-`T035`、`T039`、`T040` 已完成或已被后续任务取代；详细任务正文从本文档移除以节约上下文。
- 关键完成里程碑：通用 runs facade、metadata/audit、context/evaluation 基础字段、proposal store、backend smoke、Hermes/openteam_agent 集成、SDK 化、deployment/workers/tool routing、SSH worker smoke、worker env/proxy 注入、Gemini 源码纳入、agent-backend orchestration 架构、adapter contract、native session/policy 边界、Run/Stage 状态和 context lifecycle 文档。

---

### T036

#### 目标说明
- 将 Codex app-server / SDK、Claude Code、Gemini 和自研 agent 接为首版完整 `agent_backend`，而不是继续只通过普通 provider 抽象调用模型。
- 让代码任务可以在一次 request 内复用 backend 的完整能力：agent loop、官方工具事件、thread/session、approval、sandbox 或等价执行策略。
- 正式路线采用结构化、状态透明的 SDK/API/RPC/app-server/bridge；CLI 只作为 bootstrap、debug、fallback 或 compatibility path。
- 官方 backend 源码默认保持可替换；adapter 修改优先放在 AgentServer runtime 层，确需 patch 官方源码时必须登记重放线索。
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
- adapter capability 明确标注 `nativeLoop/nativeTools/nativeSandbox/nativeApproval/nativeSession/fileEditing/streamingEvents/structuredEvents/readableState/abortableRun/resumableSession/statusTransparency` 等能力。
- 完整生产 `agent_backend` 必须提供机器可读状态和结构化事件；CLI-only adapter 不能被标记为完整生产 backend，除非有可靠 bridge 暴露同等能力。
- Codex、Claude Code、Gemini 等官方 backend 更新后，AgentServer adapter 不需要重复修改官方源码；若存在必要 upstream patch，能从文档快速重放。

#### TODO
- [x] 设计 `AgentBackendAdapter` 接口：`startSession / runTurn / abort / readState / dispose`。
- [x] 新增 TypeScript `AgentBackendAdapter` contract，供后续 Codex/Claude/Gemini/self-hosted adapter 实现。
- [x] 新增 `docs/adapter-contract.md`，说明 model-provider adapter 与 agent-backend adapter 的最小接口。
- [x] 在 `docs/adapter-contract.md` 定义 agent-backend capability declaration 与降级语义。
- [x] 设计 native session binding 存储：`agentServerSessionId -> backendId -> nativeSessionRef`。
- [x] 明确 adapter 默认复用 session-scoped native session，但必须支持 stage-scoped 隔离和 native session 重建。
- [x] 定义 approval bridge：backend 请求审批时转成 AgentServer 审批事件。
- [x] 定义 sandbox ownership：agent backend 模式下由 backend 自管，或把 backend 进程运行在 AgentServer worker/sandbox 内。
- [x] 增加 failure-mode 文档：backend 启动失败、native session 丢失、审批超时、工具失败、workspace 权限不足。
- [x] 在 backend catalog / SDK 中暴露 backend tier、execution kind 和 strategic backend roadmap。
- [x] 在 run record / stream event 类型中补齐 stage、handoff、stage result 的基础结构。
- [x] 明确正式 agent backend 必须使用结构化、状态透明 transport，CLI-only 只能作为 bootstrap/debug/fallback/compatibility。
- [x] 在 adapter capability 中加入 `structuredEvents/readableState/abortableRun/statusTransparency`。
- [x] 明确 upstream source isolation 原则：官方 backend 源码只读优先，adapter 逻辑默认写在 AgentServer 侧。
- [x] 新增 upstream override 登记文档，记录必要官方源码 patch 和官方更新后的重放步骤。
- [ ] 实现 Codex app-server adapter 原型，优先使用 app-server JSON-RPC，而不是只 spawn CLI 文本流。
- [ ] 实现 Claude Code agent-backend adapter 原型，优先寻找结构化 protocol/bridge，暴露同样的 normalized event/result。
- [ ] 实现 Gemini agent-backend adapter 原型，优先使用 SDK/API/app-server 或 schema bridge，覆盖长上下文、多模态和资料整合场景。
- [ ] 实现自研 agent adapter 原型，用于白盒 context/tool/orchestration 策略实验，并作为状态透明 contract 的参考实现。
- [ ] 增加 smoke：同一简单代码修改任务分别通过 Codex、Claude Code、Gemini、自研 agent 完成，并输出标准事件。

#### 异常发现
- Codex SDK 的高层能力适合做完整 agent backend，但不适合作为现有 model provider 的简单替换。
- 完整 agent backend 的 fallback 语义不同于普通 model provider：执行中途静默切换 backend 可能破坏工具状态和 workspace 状态。
- Gemini 源码已纳入 `server/backend/gemini`，但还没有接入 AgentServer backend catalog / launcher / adapter。

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
- [x] 定义 `CanonicalSessionContext`：goal、plan、decisions、workspace state、artifacts、backend run records、open questions。
- [x] 定义 `BackendHandoffPacket`：给下一 backend 的压缩上下文输入。
- [x] 定义 `BackendStageResult`：filesChanged、diffSummary、toolCalls、testsRun、findings、handoffSummary、nextActions。
- [x] 明确 handoff 由 AgentServer 生成，backend summary 只作为输入之一。
- [x] 将 workspace hard facts：git diff、测试输出、artifact refs 纳入 adapter/stage result contract。
- [x] 增加上下文压缩策略：长 session 优先保留目标、决策、diff/test 事实和未解决风险。
- [x] 在当前单 backend 执行路径的 run ledger 中记录默认 stage、structured handoff 和 stage result。
- [x] 实现基础 handoff prompt renderer：当前覆盖 Codex、Claude Code、自研 agent 和通用 backend 指令。
- [x] 在当前单 stage 边界采集基础 workspace facts：branch、dirty files、git diff stat。
- [ ] 扩展 handoff prompt renderer：补 Gemini 专用模板和普通 model provider 降级模板。
- [ ] 增加完整 stage boundary verification：切换 backend 前读取真实 workspace diff、测试状态和 artifact refs，而不是只相信上一 backend 的自然语言总结。
- [ ] 将单 stage run ledger 扩展为真正的 multi-stage orchestrator ledger。

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
