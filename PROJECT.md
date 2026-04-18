# AgentServer - PROJECT.md

最后更新：2026-04-18

## 使用约定
- 本文档作为 AgentServer 工程任务板使用，只保留正在推进或待推进的任务。
- 每个任务只保留 `目标说明 / 成功标准 / TODO / 异常发现 / Takeaway`。
- 设计原则、架构说明、接口语义写在 `agent-server-architecture.md`；任务拆解和执行状态写在本文档。
- AgentServer Core 保持通用、稳定、简洁；复杂自进化决策不进入核心。
- Evolution Engine 作为可选插件/服务，读取 AgentServer 数据，生成 proposal，并通过受控 API 应用已验证变更。
- Backend Harness 保持自治；v9 可以做自己的 harness-level evolution，但不作为所有 backend 的公共策略。
- 开发过程中发现新的 TODO，优先追加到本文档。

## 当前状态
- `T001`：对齐设计文档与工程任务板（已完成）：设计文档已收敛为三章结构，并明确 AgentServer Core / Evolution Engine / Backend Harness 三层边界；最近更新 `2026-04-18`
- `T002`：实现通用 `POST /api/agent-server/runs` facade（已完成）：已提供通用 runs 入口和 run audit 查询，内部复用现有 `/autonomous/run`；最近更新 `2026-04-18`
- `T003`：补齐 metadata / run audit 基础字段（已完成）：agent/run 已支持项目自定义 metadata，为通用 adapter、audit 和未来 evolution 数据底座做准备；最近更新 `2026-04-18`
- `T004`：Context refs / metrics / evaluation 数据契约（已完成）：run ledger 已具备兼容字段和基础 evaluation hook；最近更新 `2026-04-18`
- `T005`：Evolution proposal store 与受控 apply/rollback（已完成）：已提供 proposal 存储、查询、审批、apply、rollback 生命周期，不把复杂自进化决策写入 AgentServer Core；最近更新 `2026-04-18`
- `T006`：验证所有 backend 的工具调用兼容性（已完成）：五个 backend 的 `list_dir` fixture parity 已纳入 `npm test`；standalone AgentServer 已补齐 backend launcher 构建入口，并完成 live smoke；最近更新 `2026-04-18`

---

### T001

#### 目标说明
- 让项目设计文档面向人类阅读，先讲原则与边界，再讲对外接口与用法，最后举例说明细节。
- 明确三层策略边界：
  - AgentServer Core：通用、稳定、简洁，不内置复杂自进化决策。
  - Evolution Engine：可选插件/服务，读取 AgentServer 数据，生成和应用 proposal。
  - Backend Harness：保持自治，v9 可单独做内部实验。

#### 成功标准
- `agent-server-architecture.md` 使用三章结构。
- 文档明确 AgentServer 核心对象只有 `Agent / Session / ContextItem / Run / Artifact`。
- 文档明确业务差异通过 `metadata` 适配。
- 文档明确 v9 context design 是 v9 backend 内部 harness 策略。
- 文档不包含具体 TODO/task。

#### TODO
- [x] 重写 `agent-server-architecture.md` 为三章结构。
- [x] 增加 AgentServer Core / Evolution Engine / Backend Harness 三层边界。
- [x] 把 TODO/task 移到 `PROJECT.md`。

#### 异常发现
- 旧设计文档更像研究设想，容易把 AgentServer、Evolution Engine、v9 harness 混在一起。

#### Takeaway
- AgentServer 的长期价值来自稳定核心和可适配边界，不来自把所有策略都塞进 core。

---

### T002

#### 目标说明
- 实现通用 `POST /api/agent-server/runs` facade。
- 它应复用现有 `/api/agent-server/autonomous/run` 语义，不重写执行链。
- 目标是给 OpenTeam 或其他项目一个更通用的入口：通过 `agent/input/runtime/contextPolicy/metadata` 表达任务。

#### 成功标准
- 存在 `AgentServerRunRequest` / `AgentServerRunResult` 类型。
- `AgentServerService` 提供通用 run 方法，并内部映射到现有 autonomous run。
- HTTP 路由支持 `POST /api/agent-server/runs`。
- HTTP 路由支持 `GET /api/agent-server/runs/:runId` 查询通用 run audit。
- HTTP client 支持 `runTask(input)` 或等价方法。
- 原有 `/api/agent-server/autonomous/run` 保持兼容。
- `npm run build` 通过。

#### TODO
- [x] 增加通用 run request/result 类型。
- [x] 增加 service facade：将通用 request 映射到 `runAutonomousTask`。
- [x] 增加 HTTP route：`POST /api/agent-server/runs`。
- [x] 增加 HTTP route：`GET /api/agent-server/runs/:runId`。
- [x] 增加 HTTP client 方法。
- [x] 更新 smoke 脚本或增加轻量验证，确认 facade 不破坏现有行为。

#### 异常发现
- 当前 high-level API 已经足够强，但命名仍偏 autonomous/OpenTeam 内部语义；通用项目接入时更容易理解 `/runs`。

#### Takeaway
- 先做薄 facade，不重写 runtime，是最小风险的通用化路径。

---

### T003

#### 目标说明
- 给 Agent 和 Run 增加兼容的 `metadata` 字段。
- 让 OpenTeam 的 `teamId/requestId/taskId/blackboardId` 或其他项目的 `issueId/repo/userId` 能被保存和审计。

#### 成功标准
- `AgentManifest` 支持可选 `metadata`。
- `CreateAgentRequest` / ensure flow 支持传入 metadata。
- `AgentRunRecord` 支持可选 `metadata`。
- 通用 runs facade 会把 request/input/runtime metadata 写入 run metadata。
- 旧数据没有 metadata 时仍可正常读取。

#### TODO
- [x] 扩展类型。
- [x] create/ensure agent 时保存 metadata。
- [x] run record 保存 message/request metadata。
- [x] 通用 runs facade 聚合 metadata。
- [x] build 验证。

#### 异常发现
- 当前 run record 已保存 request context 和 events，但缺少上层项目关联字段；这会影响 OpenTeam evidence 和未来 evolution 数据分析。

#### Takeaway
- `metadata` 是保持 AgentServer 通用性的关键适配面。

---

### T004

#### 目标说明
- 为未来 Evolution Engine 预留数据地基，但不把复杂自进化决策写入 AgentServer Core。

#### 成功标准
- Run ledger 能逐步回答：
  - 注入了哪些 context？
  - 用了哪个 context policy？
  - 成本和耗时是多少？
  - 结果是否成功？
  - 上层项目任务是谁？

#### TODO
- [x] 设计 `contextRefs` 字段。
- [x] 设计 `metrics` 字段。
- [x] 设计 `evaluation` 字段。
- [x] 在 context assembly 返回 text + refs 前，先保留兼容字段。
- [x] evaluation hook 作为可选 observer，不影响 run 成败。

#### 异常发现
- 没有 context refs 和 evaluation，Evolution Engine 只能猜测，无法可靠提案。

#### Takeaway
- Evolution 的第一步不是 auto-apply，而是可审计数据。

---

### T005

#### 目标说明
- 设计 Evolution proposal store 和受控 apply/rollback 接口。
- Evolution Engine 作为外部可选服务生成 proposal，AgentServer Core 只负责保存、审计和受控应用。

#### 成功标准
- proposal 包含 evidence、expectedImpact、risk、rollbackPlan、status。
- 高风险 proposal 不允许默认自动 apply。
- apply/rollback 通过 AgentServer API，不能绕过 store/audit。

#### TODO
- [x] 设计 proposal 类型。
- [x] 设计 proposal 存储路径。
- [x] 设计 approval/apply/rollback API。
- [x] 先支持 proposal lifecycle 的受控 apply/rollback，不在 Core 中直接改复杂策略。
- [x] directive/context policy 变更要求 approval 后才能 apply。

#### 异常发现
- 如果 Evolution Engine 直接改 backend harness 或绕过 AgentServer store，会失去可解释性和可回滚性。

#### Takeaway
- Evolution Engine 是策略层，AgentServer Core 是数据与安全变更层。

---

### T006

#### 目标说明
- 验证 AgentServer / Backend Runtime 是否能让所有 backend 产出一致的工具调用事件。
- 优先验证最小工具骨架：`tool-call:list_dir -> tool-result:list_dir -> result`。
- 区分 fixture parity 与 live smoke：
  - fixture parity 验证 adapter/event normalization 语义。
  - live smoke 验证本机 managed launcher、模型配置、真实 backend 执行链。

#### 成功标准
- `claude-code`、`claude-code-rust`、`codex`、`openclaw`、`zeroclaw` 的 `list_dir` fixture 都纳入 `npm test`。
- 每个 backend 的工具名归一化为 `list_dir`。
- 每个 backend 的标准事件包含 `protocolVersion=v1`。
- 如果本机缺少 launcher，live smoke 明确报告环境阻塞，不误判为代码失败。

#### TODO
- [x] 检查 backend catalog 与本机 managed launcher 可用性。
- [x] 将五个 backend 的 `list_dir` fixture parity 加入 `npm test`。
- [x] 增加 `npm run smoke:agent-server:backends` live smoke 入口，launcher 缺失时跳过并说明原因。
- [x] 补齐 `npm run build:backend-binaries`，生成 `server/backend/bin/openteam_*` managed launchers。
- [x] 修正 live smoke 的 launcher 检测逻辑，使用 runtime 相同的 `OPENTEAM_BACKEND_BIN_DIR || server/backend/bin` 解析规则。
- [x] 在有 launcher 的环境下跑 live tool smoke。

#### 异常发现
- 当前 standalone AgentServer 原本缺少 `server/backend/bin/openteam_*` 生成产物；openteam-studio-run 里可用，是因为它有 `build:backend-binaries` 链路把 wrapper/binary 放进 `server/backend/bin`。
- runtime 查找 launcher 的真实规则是 `OPENTEAM_BACKEND_BIN_DIR || <project>/server/backend/bin`，不是单纯依赖 PATH；此前 live smoke 只查 PATH，报告不够准确。
- 首次构建 `openteam_codex` release binary 成本很高，本机冷编译约 23 分钟；后续增量构建会快很多。

#### Takeaway
- fixture parity 能锁住 AgentServer/Runtime 统一工具事件语义；live smoke 还依赖 managed launcher、模型和 backend 运行环境。standalone AgentServer 必须显式提供 launcher 构建入口，才能复刻 openteam-studio-run 的可用状态。
- 当前本机已验证五个 backend 都能通过 AgentServer 发起真实 `list_dir` 工具调用并产出标准 tool-call/tool-result 事件。
