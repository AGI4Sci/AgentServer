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

#### 已完成摘要
- Agent-backend adapter contract、profile registry、adapter registry/factory、native session binding、approval/sandbox/failure-mode 语义已落地。
- Codex app-server、Claude Code bridge、Gemini SDK、自研 agent 四类 strategic adapter 原型已实现，并通过 contract smoke。
- Run/Stage/handoff/ledger/multi-stage opt-in 执行路径已落地，backend 原生事件可映射为 AgentServer normalized events/result。
- Readiness/preflight/live smoke 已支持 backend 子集、backend-by-backend 矩阵、strict/advisory warning 区分、Codex isolated `CODEX_HOME`、临时 smoke LLM、可覆盖超时、本地未提交 env 文件。
- Readiness 已提供常用快捷脚本：Codex-only、Gemini-only、Claude/self-hosted、Claude/self-hosted smoke LLM plumbing。
- Codex 已通过真实 isolated live readiness；Claude Code / 自研 agent 已通过 smoke LLM plumbing readiness；Gemini SDK module 与 shape preflight 已通过。
- 官方 backend 源码目录保持干净；必要 upstream patch 原则和 Gemini upstream build debt 已记录在 `docs/upstream-backend-overrides.md`。

#### 剩余 TODO
- [ ] 配置可用 OpenAI-compatible endpoint，供 Claude Code bridge 和自研 agent 跑真实 live readiness。推荐写入 `.agent-backend-readiness.local.env`：`AGENT_SERVER_ADAPTER_LLM_BASE_URL`、`AGENT_SERVER_ADAPTER_LLM_API_KEY`、`AGENT_SERVER_ADAPTER_LLM_MODEL`；配置后运行 `npm run check:agent-backend-adapters:ready:llm-backends`。
- [ ] 配置 Gemini/Google auth input 后跑 Gemini live readiness。可用任一项：`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`~/.gemini/oauth_creds.json`；配置后运行 `npm run check:agent-backend-adapters:ready:gemini`。
- [ ] 补齐上述真实 runtime/凭据后运行 `AGENT_SERVER_ADAPTER_READINESS_ENV_FILE=.agent-backend-readiness.local.env npm run check:agent-backend-adapters:ready`，要求 Codex、Claude Code、Gemini、自研 agent 全部 `PASSED`。

#### 异常发现
- Codex SDK 的高层能力适合做完整 agent backend，但不适合作为现有 model provider 的简单替换。
- 完整 agent backend 的 fallback 语义不同于普通 model provider：执行中途静默切换 backend 可能破坏工具状态和 workspace 状态。
- Claude Code 当前 adapter 仍是 partial bridge：能复用现有 native runtime 和 normalized events，但还没有一等 SDK/RPC 级 abort/resume/full native state。
- 当前机器 live smoke 阻塞项：readiness gate 已按 backend 独立执行并汇总。Codex app-server preflight、auth/account/model 已通过，rate-limit probe 若因 upstream account usage 接口不可读只作为 advisory warning，隔离 `CODEX_HOME` 后不再出现 sqlite migration warning，`gpt-5.4` 已通过真实 isolated live smoke；`gpt-5.2-codex` 在当前 ChatGPT 账号下由官方 app-server 返回 unsupported，不作为 AgentServer adapter 缺口。Claude Code / 自研 agent 在 smoke LLM 模式下已可完成 live `runTurn` plumbing smoke，真实配置仍取决于可用 OpenAI-compatible endpoint，可通过 `openteam.json` 或 `AGENT_SERVER_ADAPTER_LLM_*` 环境变量提供；Gemini SDK dist/source fallback 与 shape preflight 已可用，live smoke 已推进到缺少 Gemini/Google auth input。Gemini 官方 clean build 仍受上游 TS4111 错误阻塞，但当前不改官方源码。

#### Takeaway
- SDK/app-server 是 backend adapter 的实现细节；AgentServer 不能把自己的 orchestration 责任交给任何单一 backend。
