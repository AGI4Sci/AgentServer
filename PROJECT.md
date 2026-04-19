# AgentServer - PROJECT.md

最后更新：2026-04-19

## 使用约定
- 本文档作为 AgentServer 工程任务板使用，只保留正在推进或待推进的任务。
- 已完成任务的长正文不留在本文档中；需要历史细节时查看 git history。
- 设计原则、架构说明、接口语义写在 `docs/architecture.md` / `docs/adapter-contract.md`；任务拆解和执行状态写在本文档。
- 文档入口、导航和主题归档统一放在 `docs/` 目录。
- AgentServer Core 保持通用、稳定、简洁；复杂自进化决策不进入核心。
- 代码路径必须尽量保持唯一真相源：引入新链路、或者发现冗余时必须删除、合并或明确降级旧链路，避免两个并行逻辑长期共存造成冗余和误导；实现应优先通用机制，不为单个临时案例堆专用分支。
- 开发过程中发现新的 TODO，优先追加到本文档。

## 当前状态
- 当前没有进行中的工程任务。

## 已完成任务归档摘要
- `T001`-`T045` 已完成或已被后续任务取代；详细任务正文从本文档移除以节约上下文。
- 关键完成里程碑：通用 runs facade、metadata/audit、context/evaluation 基础字段、proposal store、backend smoke、Hermes/openteam_agent 集成、SDK 化、deployment/workers/tool routing、SSH worker smoke、worker env/proxy 注入、Gemini 源码纳入、agent-backend orchestration 架构、adapter contract、native session/policy 边界、Run/Stage 状态、context lifecycle、canonical handoff、stage boundary verification、orchestrator ledger 文档与代码、multi-stage request opt-in 执行路径、Live Backend Benchmark 设计占位文档。
- `T036`：首版 strategic agent-backend adapter 完成。Codex app-server、Claude Code bridge、Gemini SDK、自研 agent adapter 已代码化；readiness、capability/profile/model-runtime 支持矩阵、functional Gemini smoke 和 upstream patch 记录已落地。
- `T042`：统一 model runtime resolver 完成。provider/model/baseUrl/authType 解析收敛到 `ModelRuntimeConnection`；`AGENT_SERVER_MODEL_*` 成为 canonical env；旧 `AGENT_SERVER_ADAPTER_LLM_*` 仅保留兼容输入。
- `T043`：Gemini functional smoke 完成。默认 Gemini readiness 不依赖真实 Google/Gemini 凭据；需要真实服务验证时显式设置 `AGENT_SERVER_GEMINI_REQUIRE_REAL_AUTH=1`。
- `T044`：OpenClaw / Hermes Agent ecosystem adapter 完成。二者可通过统一 `AgentBackendAdapter` 上层接口显式调用，用于流量承接、迁移、demo 和对照；不进入首版 strategic routing / benchmark 默认集合。
- `T045`：Codex provider/model 统一选择链完成。Codex app-server adapter 与 Codex team worker 共用 `server/runtime/codex-model-runtime.ts`；Codex/OpenAI/ChatGPT-native provider 走原生账号路径，带 `baseUrl` 的 OpenAI-compatible provider 走 Codex custom model provider + AgentServer responses bridge，自动确保 runtime supervisor 可用，避免把任意模型名硬塞进 ChatGPT-native 路径，同时保留 Codex 原生 loop、工具、approval、sandbox、session 和结构化事件；SDK all-backends smoke 已覆盖 Codex native `run_command` 工具事件。
- `T046`：废弃 backend 冗余清理完成。`claude-code-rust` / `zeroclaw` 已从 backend catalog、runtime worker/session registry、build/prune scripts、model contract、event normalizer、workspace primitive adapter、测试、文档和生成态 smoke/session 数据中移除。
