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
- `T036`：首版完整 agent-backend adapter（推进中）：首版 strategic backend 只支持 Codex、Claude Code、Gemini 和自研 agent；四类 adapter 原型和真实 runTurn live smoke 脚本已代码化。Codex 已通过真实 isolated live readiness；Claude Code / 自研 agent 已通过 smoke LLM plumbing readiness，真实 readiness 仍等待可用 OpenAI-compatible endpoint；Gemini SDK module 与 shape preflight 已通过，真实 readiness 仍等待 Gemini/Google auth input。

## 已完成任务归档摘要
- `T001`-`T035`、`T037`-`T041` 已完成或已被后续任务取代；详细任务正文从本文档移除以节约上下文。
- 关键完成里程碑：通用 runs facade、metadata/audit、context/evaluation 基础字段、proposal store、backend smoke、Hermes/openteam_agent 集成、SDK 化、deployment/workers/tool routing、SSH worker smoke、worker env/proxy 注入、Gemini 源码纳入、agent-backend orchestration 架构、adapter contract、native session/policy 边界、Run/Stage 状态、context lifecycle、canonical handoff、stage boundary verification、orchestrator ledger 文档与代码、multi-stage request opt-in 执行路径、Live Backend Benchmark 设计占位文档。

---

### T036

#### 目标说明
- 将 Codex app-server / SDK、Claude Code、Gemini 和自研 agent 接为首版完整 `agent_backend`，而不是继续只通过普通 provider 抽象调用模型。
- 让代码任务可以在一次 request 内复用 backend 的完整能力：agent loop、官方工具事件、thread/session、approval、sandbox 或等价执行策略。
- 正式路线采用结构化、状态透明的 SDK/API/RPC/app-server/bridge；CLI 只作为 bootstrap、debug、fallback 或 compatibility path。
- 官方 backend 源码默认保持可替换；adapter 修改优先放在 AgentServer runtime 层，确需 patch 官方源码时必须登记重放线索。
- 对所有 backend 集成缺口采用同一原则：优先外围 adapter/bridge/env/config/profile 降级，以保留官方原生能力和源码更新复用；当外围成本明显不成比例或会削弱原生 agent 能力时，允许小范围修改官方源码，并记录文件、目的和重放步骤。
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
- [x] 明确 provider/auth input 例外原则：优先外围 adapter/env/config 适配；若代价明显不成比例，可做小 upstream patch，但必须在 override 文档登记文件、目的和重放步骤。
- [x] 将 upstream patch 例外原则扩展为通用 backend 集成规则：所有原生 runtime 接线问题都先评估外围 adapter 与官方源码 patch 的长期成本，允许在外围绕行代价失衡时做小而可重放的源码修改。
- [x] 新增 strategic agent backend profile registry，区分 current capabilities 与 target capabilities，避免把 CLI bridge 误标成 production-complete backend。
- [x] 新增 agent backend adapter registry/factory，只暴露已实现 adapter，并通过 profile 显式标注 prototype / production-complete 差异。
- [x] 实现 Codex app-server adapter 原型，优先使用 app-server JSON-RPC，而不是只 spawn CLI 文本流。
- [x] 实现 Claude Code agent-backend adapter 原型，当前通过 AgentServer supervisor normalized event stream 暴露 structured event/result/readState，仍标记为 partial bridge。
- [x] 实现 Gemini agent-backend adapter 原型，优先使用 SDK/API/app-server 或 schema bridge，覆盖长上下文、多模态和资料整合场景。
- [x] 实现自研 agent adapter 原型，用于白盒 context/tool/orchestration 策略实验，并作为状态透明 contract 的参考实现。
- [x] 增加 strategic agent-backend adapter contract smoke，验证 Codex、Claude Code、Gemini、自研 agent 均已注册并暴露 structured capabilities。
- [x] 增加 live adapter preflight：检查 adapter 注册、Codex app-server 命令、Claude/self-hosted LLM endpoint、Gemini SDK 可解析性。
- [x] 将 live adapter smoke 升级为真实 `runTurn` 任务：创建临时 workspace，提交 handoff，消费标准事件，要求 `stage-result`。
- [x] live adapter smoke 支持 `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` 按 backend 子集验证，便于逐个补齐本机 runtime。
- [x] Codex adapter 将 app-server backend error 标准化为 failed `stage-result`，避免真实 turn 失败时只表现为 timeout。
- [x] Codex adapter 支持 app-server server-initiated approval request：转成 `permission-request`，无交互式审批决策面时默认安全拒绝，避免静默吞掉或卡死。
- [x] Codex live preflight 增加 auth/status probe：`getAuthStatus` 不请求 token，只记录 `authMethod/requiresOpenaiAuth`，避免把真实 `runTurn` 流错误误判为未登录。
- [x] Codex live preflight 增加 account/model/rate-limit probe：当前机器显示 `chatgpt` Pro、可见模型列表、rate limit 未触顶，且不输出 email/token。
- [x] Codex adapter 支持 `AGENT_SERVER_CODEX_MODEL` / `AGENT_SERVER_CODEX_EFFORT` turn override，并在 failed `stage-result` 中附加脱敏 app-server stderr tail。
- [x] Codex adapter 将 app-server `willRetry: true` error 视为非终止 running 状态，让官方 stream retry / HTTP fallback 自己完成；只有非重试 error 或 failed `turn/completed` 才终止 stage。
- [x] Codex isolated live smoke 已在 `gpt-5.4` 下通过真实 `runTurn`：创建 thread、执行 tool-call/tool-result、消费标准事件并返回 completed `stage-result`。
- [x] Gemini adapter 在 `tsx` 开发态支持 vendored SDK source fallback，并提供 `prepare:gemini-sdk-dev` 重放本地 workspace link / generate / policy asset 准备步骤。
- [x] Gemini live preflight 增加 auth input probe：检查 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`~/.gemini/oauth_creds.json` 是否存在，不输出密钥内容。
- [x] Gemini live preflight 增加 SDK shape probe：验证 `GeminiCliAgent` constructor 与 `session.sendStream(prompt, signal)` 仍符合 adapter contract，提前发现上游 SDK 结构变化。
- [x] 复核 Gemini upstream build 阻塞：`npm run prepare:gemini-sdk-dev` 可完成 dev fallback 准备，但官方 core/sdk build 仍被 `packages/core/src/code_assist/oauth2.ts` 的 TS4111 错误阻塞；已记录在 upstream override 文档中，暂不修改官方源码。
- [x] live adapter preflight 支持临时 smoke LLM endpoint：`AGENT_SERVER_ADAPTER_PREFLIGHT_SMOKE_LLM=1` 可验证 Claude Code bridge / 自研 agent 的 endpoint plumbing，不依赖本机真实 `3888` 服务。
- [x] live adapter preflight 与 adapter runtime 使用同一套 `AGENT_SERVER_ADAPTER_LLM_BASE_URL/API_KEY/MODEL/PROVIDER` 环境变量覆盖语义；可在不修改 `openteam.json` 的情况下验证真实 Claude Code / 自研 agent endpoint。
- [x] 增加 strict readiness preflight：`npm run check:agent-backend-adapters:strict` 会把 warning 也视为未就绪，用于最终判定真实 runtime/凭据是否已补齐。
- [x] 区分 strict readiness 中的阻塞型 warning 与诊断型 advisory warning：Codex rate-limit 辅助接口不可读时保留提示，但不阻止后续 live smoke；真实 auth、endpoint、SDK shape 缺口仍会阻塞。
- [x] 增加一键最终 readiness gate：`npm run check:agent-backend-adapters:ready` 先跑 strict preflight，未就绪时跳过耗时 live smoke；就绪后用 Codex isolated live smoke 覆盖 Codex，再对剩余已选择 backend 跑 live smoke，并尊重 `AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS` 子集选择。
- [x] 将 readiness gate 升级为 backend-by-backend 矩阵：每个 backend 独立 strict preflight，失败只跳过自己的 live smoke，其它 backend 继续执行并汇总 `PASSED/FAILED/SKIPPED`。
- [x] readiness gate 支持 dry-run 计划检查：`AGENT_SERVER_ADAPTER_READINESS_DRY_RUN=1 npm run check:agent-backend-adapters:ready` 只打印将执行的步骤，避免每次调整子集逻辑都真实启动 backend。
- [x] 新增 `docs/agent-backend-readiness.md`，集中记录本机 runtime/凭据配置、子集 readiness、dry-run 和最终完成门禁。
- [x] 新增 `examples/agent-backend-readiness.env.example`，提供真实 endpoint、Gemini auth、Codex model 和 readiness 子集配置模板，不包含密钥。
- [x] readiness gate 支持 `AGENT_SERVER_ADAPTER_READINESS_ENV_FILE` 加载本地未提交 env 文件，便于真实 endpoint/Gemini auth 补齐后复现全量检查；shell 已有变量优先，日志不输出 secret 值。
- [x] live adapter smoke 支持临时 smoke LLM endpoint：`AGENT_SERVER_LIVE_ADAPTER_SMOKE_LLM=1` 会为 supervisor path 注入临时 OpenAI-compatible endpoint 并重启 runtime supervisor，Claude Code bridge / 自研 agent 已可完成真实 `runTurn` plumbing smoke。
- [x] Codex live smoke 支持临时隔离 `CODEX_HOME`：`AGENT_SERVER_LIVE_ADAPTER_ISOLATED_CODEX_HOME=1` 会复制 auth/config 到临时目录但不复制 sqlite 状态库，用于排查官方更新后的本地 state migration 问题。
- [x] 将 live adapter smoke 默认总超时提高到 300 秒，并支持 `AGENT_SERVER_LIVE_ADAPTER_SMOKE_TIMEOUT_MS` 覆盖，避免 Codex/Gemini 等真实模型在已经持续输出事件时被 120 秒总时限误杀。
- [ ] 补齐本机真实 backend runtime/凭据后让 live adapter smoke 全绿：同一简单代码修改任务分别通过 Codex、Claude Code、Gemini、自研 agent 完成，并输出标准事件；最终门禁运行 `npm run check:agent-backend-adapters:ready`。
- [ ] 修复当前真实环境 Claude/self-hosted live 缺口：启动/配置可用 OpenAI-compatible LLM endpoint，供 Claude Code bridge 和自研 agent 使用；可通过 `openteam.json` 或 `AGENT_SERVER_ADAPTER_LLM_BASE_URL/API_KEY/MODEL` 覆盖配置，若只验证 adapter plumbing，可先运行 `npm run check:agent-backend-adapters:smoke-llm`。
- [ ] 修复当前 Gemini auth 缺口：SDK dist/source fallback 和 shape preflight 已可用，但当前机器缺少 `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` / `/Users/zhangyanggao/.gemini/oauth_creds.json`，因此 Gemini live `runTurn` 还不能完成。

#### 异常发现
- Codex SDK 的高层能力适合做完整 agent backend，但不适合作为现有 model provider 的简单替换。
- 完整 agent backend 的 fallback 语义不同于普通 model provider：执行中途静默切换 backend 可能破坏工具状态和 workspace 状态。
- Claude Code 当前 adapter 仍是 partial bridge：能复用现有 native runtime 和 normalized events，但还没有一等 SDK/RPC 级 abort/resume/full native state。
- 当前机器 live smoke 阻塞项：readiness gate 已按 backend 独立执行并汇总。Codex app-server preflight、auth/account/model 已通过，rate-limit probe 若因 upstream account usage 接口不可读只作为 advisory warning，隔离 `CODEX_HOME` 后不再出现 sqlite migration warning，`gpt-5.4` 已通过真实 isolated live smoke；`gpt-5.2-codex` 在当前 ChatGPT 账号下由官方 app-server 返回 unsupported，不作为 AgentServer adapter 缺口。Claude Code / 自研 agent 在 smoke LLM 模式下已可完成 live `runTurn` plumbing smoke，真实配置仍取决于可用 OpenAI-compatible endpoint，可通过 `openteam.json` 或 `AGENT_SERVER_ADAPTER_LLM_*` 环境变量提供；Gemini SDK dist/source fallback 与 shape preflight 已可用，live smoke 已推进到缺少 Gemini/Google auth input。Gemini 官方 clean build 仍受上游 TS4111 错误阻塞，但当前不改官方源码。

#### Takeaway
- SDK/app-server 是 backend adapter 的实现细节；AgentServer 不能把自己的 orchestration 责任交给任何单一 backend。
