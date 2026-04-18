# AgentServer - PROJECT.md

最后更新：2026-04-18

## 使用约定
- 本文档作为 AgentServer 工程任务板使用，只保留正在推进或待推进的任务。
- 每个任务只保留 `目标说明 / 成功标准 / TODO / 异常发现 / Takeaway`。
- 设计原则、架构说明、接口语义写在 `docs/architecture.md`；任务拆解和执行状态写在本文档。
- 文档入口、导航和主题归档统一放在 `docs/` 目录。
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
- `T006`：验证所有 backend 的工具调用兼容性（已完成）：六个 backend 的 `list_dir` fixture parity 已纳入 `npm test`；standalone AgentServer 已补齐 backend launcher 构建入口，并完成 live smoke；最近更新 `2026-04-18`
- `T007`：集成 Hermes Agent backend（已完成）：已拷贝源码并接入 backend catalog、launcher、session runner、fixture parity 和 backend live smoke；最近更新 `2026-04-18`
- `T008`：补充公共 API 薄文档（已完成）：新增 `docs/public-api.md`，说明 `runTask`、HTTP facade、backend 列表和 capability 查询示例；最近更新 `2026-04-18`
- `T009`：拆分 Core context 契约与 harness 策略文档（已完成）：新增 `docs/context-core.md`，并将 `docs/context-harness.md` 明确定位为自研/custom backend harness 策略；最近更新 `2026-04-18`
- `T010`：统一整理项目文档到 `docs/`（已完成）：新增 docs 索引，合并 runtime/backend 文档，任务板保留在根目录，消除过期路径和 backend 数量冲突；最近更新 `2026-04-18`
- `T011`：集成 `openteam_agent` 自研 backend（已完成）：将 AI SDK runtime vendored 到本项目内，实现可独立运行的第 7 个 backend，并接入统一事件和工具桥；最近更新 `2026-04-18`
- `T012`：Agent SDK 化（已完成）：整理包根 public SDK 入口，提供 createAgentClient / runText / runTask / backend capabilities 等薄接口；最近更新 `2026-04-18`
- `T025`：最终 Tool Routing 四元模型（已完成）：以 `backend / workspace / worker / route` 作为唯一模型，替换旧 placement/profile 设计；最近更新 `2026-04-18`

---

### T001

#### 目标说明
- 让项目设计文档面向人类阅读，先讲原则与边界，再讲对外接口与用法，最后举例说明细节。
- 明确三层策略边界：
  - AgentServer Core：通用、稳定、简洁，不内置复杂自进化决策。
  - Evolution Engine：可选插件/服务，读取 AgentServer 数据，生成和应用 proposal。
  - Backend Harness：保持自治，v9 可单独做内部实验。

#### 成功标准
- `docs/architecture.md` 使用三章结构。
- 文档明确 AgentServer 核心对象只有 `Agent / Session / ContextItem / Run / Artifact`。
- 文档明确业务差异通过 `metadata` 适配。
- 文档明确 v9 context design 是 v9 backend 内部 harness 策略。
- 文档不包含具体 TODO/task。

#### TODO
- [x] 重写 `docs/architecture.md` 为三章结构。
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
- [x] 将六个 backend 的 `list_dir` fixture parity 加入 `npm test`。
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
- 当前本机已验证六个 backend 都能通过 AgentServer 发起真实 `list_dir` 工具调用并产出标准 tool-call/tool-result 事件。

---

### T007

#### 目标说明
- 将 `/Applications/workspace/ailab/research/app/hermes-agent` 纳入 AgentServer 的 managed backend 集合。
- 第一阶段先把 Hermes 源码拷贝到 `server/backend/hermes_agent`，并提供通用 backend 接线。
- 保持 AgentServer Core 通用，不把 Hermes 的自进化/记忆策略上移到 core。

#### 成功标准
- `server/backend/hermes_agent` 存在 Hermes 源码，且不包含 `.git`、`venv`、`__pycache__`。
- backend catalog 支持 `hermes-agent`。
- runtime supervisor 支持 `hermes-agent` session runner。
- backend launcher 构建脚本生成 `openteam_hermes_agent`。
- Hermes 的 `list_dir` fixture parity 纳入 `npm test`。
- live smoke 能覆盖 `hermes-agent`。

#### TODO
- [x] 拷贝 Hermes 源码到 `server/backend/hermes_agent`。
- [x] 排除 `.git`、`venv`、`__pycache__` 和 `.pyc`。
- [x] 增加 `hermes-agent` backend catalog entry。
- [x] 增加 launcher 构建入口。
- [x] 增加 session runner 接线。
- [x] 增加 `list_dir` fixture parity。
- [x] 跑 `npm run build` / `npm test`。
- [x] 跑 backend live smoke。
- [ ] 后续深化 ACP stdio/native event 双向协议。

#### 异常发现
- Hermes 是 Python 项目，原生入口偏 CLI/ACP；第一阶段用 AgentServer tool bridge 保证工具调用事件一致，ACP 深集成后续单独推进。
- 原项目包含本地 `venv` 和缓存，直接整目录拷贝会带来大量无关产物，需要显式排除。
- AgentServer 和 openteam-studio-run 默认 runtime-supervisor 端口相同会导致跨项目误连；standalone AgentServer 默认端口调整为 `8767`，并在 supervisor health 中暴露 project root。

#### Takeaway
- Hermes 的自进化、记忆和 skill 策略应该继续留在 Hermes backend/harness 内部；AgentServer 只负责把它作为可选 backend 编排、审计和统一工具事件。

---

### T008

#### 目标说明
- 给 `openteam-studio-run` 或其他项目一个很薄的公开 API 速查，不需要读内部 runtime 代码就能接入 AgentServer。
- 明确普通调用只需要改 `agent.backend` 或 `runtime.backend`。
- 给出 `listSupportedBackends()` 和 capability 查询示例。

#### 成功标准
- 存在公共 API 文档。
- 文档包含 in-process `AgentServerService.runTask` 示例。
- 文档包含 HTTP `POST /api/agent-server/runs` 示例。
- 文档包含 backend 列表和 capability 查询示例。
- README/TUTORIAL 能指向公共 API 文档。

#### TODO
- [x] 新增 `docs/public-api.md`。
- [x] 更新 README backend 列表和公共 API 链接。
- [x] 更新 TUTORIAL backend 列表和公共 API 链接。
- [x] 在设计文档第二章标明通用 run facade 是上层推荐入口。

#### 异常发现
- README/TUTORIAL 的 backend 列表还没包含 `hermes-agent`。
- 设计文档第二章仍把 `/autonomous/run` 写成当前推荐入口，需要和已落地的 `/runs` facade 对齐。

#### Takeaway
- 对外集成面应保持薄而稳定：`runTask` + backend id + metadata + normalized events，backend 深层差异由 capability 和 runtime adapter 吸收。

---

### T009

#### 目标说明
- 把 AgentServer Core 通用 context 能力和自定义 agent backend 内部 harness 策略拆开。
- 避免读者误以为 v9 的 prefix/work、stable/dynamic boundary、COMPACTION TAG 是所有 backend 的公共协议。

#### 成功标准
- 存在一个 Core context 契约文档，说明跨 backend 稳定能力。
- `docs/context-harness.md` 顶部明确自己是 v9/custom backend harness 策略。
- 架构文档指向这两个文档，并继续强调 AgentServer Core / Backend Harness 边界。

#### TODO
- [x] 新增 `docs/context-core.md`。
- [x] 更新 `docs/context-harness.md` 文档定位。
- [x] 更新 `docs/architecture.md` 的 v9/context 说明。

#### 异常发现
- `docs/context-harness.md` 内容很有价值，但混合了 Core 可吸收原则和 v9 内部策略；不拆开会让后续 backend 接入者误判实现义务。

#### Takeaway
- Core 文档应该讲“所有 backend 都能依赖什么”；harness 文档应该讲“自研 backend 可以如何变聪明”。

---

### T010

#### 目标说明
- 将项目文档统一收敛到 `docs/` 目录。
- `PROJECT.md` 保留在根目录作为工程任务板，不移动到 `docs/`。
- 消除根目录和 server 子目录中重复、过期或冲突的说明。
- 保留旧位置跳转，避免读者找不到入口。

#### 成功标准
- `docs/README.md` 成为文档总入口。
- 公共 API、架构、Core context、harness context、backend runtime、agent server runtime、教程、任务板都有明确归属。
- 根目录 README 写清楚项目定位、功能、整体介绍和文档导航。
- 根目录 `PROJECT.md` 保留为工程任务板。
- 旧位置跳转页不再承载重复正文。
- 文档中不再出现过期绝对文档链接和 backend 数量冲突。

#### TODO
- [x] 新增 `docs/README.md` 文档索引。
- [x] 移动公共 API 文档到 `docs/public-api.md`。
- [x] 移动教程到 `docs/tutorial.md`。
- [x] 移动架构文档到 `docs/architecture.md`。
- [x] 保留工程任务板在根目录 `PROJECT.md`。
- [x] 移动 Core/v9 context 文档到 `docs/`。
- [x] 新增 `docs/backend-runtime.md`，替代旧 backend/runtime plan 重复说明。
- [x] 新增 `docs/agent-server-runtime.md`，替代旧 agent_server README 长文。
- [x] 将旧位置 README/plan 改为跳转页。
- [x] 扫描并修正旧文件名、旧路径、backend 数量冲突。

#### 异常发现
- agent server 目录原说明还保留了旧项目绝对链接和旧回归脚本列表。
- runtime plan 是从 OpenTeam 迁移来的旧说明，包含大量不属于 standalone AgentServer 的路径。
- backend 目录原说明的 backend 数量与 Hermes 集成后的六 backend 状态冲突。

#### Takeaway
- 文档需要和代码一样有单一真相源：主题正文放 `docs/`，旧位置只做导航。

---

### T011

#### 目标说明
- 将 `docs/context-harness.md` 中描述的自研/custom agent backend 落成一个薄 backend：`openteam_agent`。
- 模型调用层使用 vendored AI SDK runtime，不依赖外部绝对路径。
- 工具执行和事件输出继续复用 AgentServer 的统一工具原语与标准事件，不把 v9 harness 策略塞进 AgentServer Core。

#### 成功标准
- backend catalog 暴露第 7 个 backend：`openteam_agent`。
- `listSupportedBackends()` / capabilities 能看到 `openteam_agent`。
- `openteam_agent` 通过 `SessionRunner` 接入 `AgentServerService.runTask`。
- 新 backend 的工具调用事件仍归一到 `tool-call` / `tool-result` / `result`。
- smoke tool matrix 能覆盖 `openteam_agent` 的统一工具原语。
- 文档说明 `openteam_agent` 的定位：自研 harness 种子实现，不代表 v9 context design 已全部进入 Core。

#### TODO
- [x] 在任务板登记 T011。
- [x] 抽出可复用的 local-dev 工具循环，让 backend 可替换模型调用层。
- [x] 增加项目内 vendored SDK 加载器和 `openteam_agent` session client。
- [x] 将 `openteam_agent` 接入 backend catalog、runner registry、capabilities 示例和 smoke matrix。
- [x] 更新公开 API / backend runtime 文档，说明第 7 个 backend 与内置 SDK 运行方式。
- [x] 运行 build/test/smoke，确认第 7 个 backend 可通过统一工具桥干活。
- [x] 增加 `npm run smoke:openteam-agent`，单独验证 `openteam_agent` 的公开 `runTask` 入口、隔离 supervisor、vendored SDK 和 `list_dir` 工具事件。

#### 异常发现
- 不能硬编码机器本地 SDK checkout 路径；SDK 运行产物已拷贝到 `server/backend/openteam_agent/node_modules`。
- `openteam_agent` 是 direct backend，不需要 `openteam_*` managed launcher；smoke matrix 需要理解 `managedLauncher=false`。

#### Takeaway
- `openteam_agent` 应是 Backend Harness 层的自研实现：模型 SDK 内置于 backend，工具桥和事件契约复用 AgentServer Core。
- 当前已验证 `openteam_agent` 可以通过 AgentServer 统一工具桥调用全部 11 个 canonical tool primitives。

---

### T012

#### 目标说明
- 将当前分散的 `AgentServerService`、HTTP client、backend catalog、事件/工具类型整理成正式 SDK 入口。
- 让其它项目优先从 package root 或 `sdk/` 导入，不需要读 `server/agent_server/*` 内部路径。
- SDK 保持薄层：不重写 runtime，不把 backend harness 策略塞进 SDK。

#### 成功标准
- package root `index.ts` 暴露稳定 public API。
- 存在 `createAgentClient()`，支持 in-process service 和 HTTP baseUrl 两种使用方式。
- SDK client 支持 `runTask()`、`runText()`、`getRun()`、`listBackends()`、`getBackendCapabilities()`。
- in-process SDK 支持 `onEvent` 流式事件回调。
- 文档示例从内部路径迁移到 SDK 入口。
- smoke 覆盖 SDK 入口调用 `openteam_agent`。

#### TODO
- [x] 在任务板登记 T012。
- [x] 新增 `sdk/index.ts` 与根 `index.ts`。
- [x] 更新 `package.json` main/types/exports 指向 SDK 入口。
- [x] 增加 `npm run smoke:agent-sdk`，验证 package root SDK。
- [x] 更新 README / public API / tutorial 中的 SDK 示例。
- [x] 跑 build/test/smoke，确认 SDK 化没有破坏现有服务入口。

#### 异常发现
- 当前已有 SDK 内核，但入口分散在 `server/agent_server/service.ts`、`server/agent_server/http-client.ts`、`core/runtime/backend-catalog.ts`。
- in-process SDK 使用 `openteam.json`，如果要覆盖 `OPENTEAM_CONFIG_PATH`，需要在导入 SDK 前设置环境变量；smoke 已使用动态 import 固化这一点。

#### Takeaway
- Agent SDK 应是“薄、稳定、面向项目”的入口；AgentServer Core 和 Backend Harness 仍保持现有边界。

---

### T013

#### 目标说明
- 继续打磨 Agent SDK，让其它项目可以通过稳定门面管理 agent 生命周期。
- 补齐本地 SDK 与 HTTP SDK 的最小一致能力：创建 agent、查询 agent、列出 agent、列出 runs、查询 run。
- 增加可读示例，减少接入者阅读内部 service/router 的需要。

#### 成功标准
- `createAgentClient()` 支持 `createAgent()`、`getAgent()`、`listAgents()`、`listRuns()`、`getRun()`。
- HTTP client 与 in-process service 在上述生命周期 API 上保持同名同参。
- package root 导出生命周期相关类型。
- `docs/public-api.md` 与 `docs/tutorial.md` 说明 SDK 生命周期用法。
- 存在本地 SDK 和 HTTP SDK 示例文件。
- `npm run smoke:agent-sdk` 覆盖生命周期 API。

#### TODO
- [x] 在任务板登记 T013。
- [x] 给 HTTP client 补 `listAgents()`。
- [x] 给 SDK client 补生命周期方法。
- [x] 从 package root 导出 `AgentManifest` / `CreateAgentRequest`。
- [x] 增加 `examples/sdk-local.ts` 和 `examples/sdk-http.ts`。
- [x] 更新公开 API 和教程文档。
- [x] 扩展 `smoke:agent-sdk`，覆盖 `getAgent()` / `listAgents()` / `listRuns()` / `getRun()`。

#### 异常发现
- `AgentServerService` 和 HTTP 路由已经有生命周期能力，SDK 只是缺一个稳定、易读的门面。
- HTTP SDK 目前仍不支持 `onEvent` 流式回调；流式事件先走 in-process SDK，HTTP 流式可以作为后续独立任务。

#### Takeaway
- 当前 SDK 已从“任务调用包装”推进到“最小 agent 生命周期 SDK”。再往前的主要方向是 HTTP streaming 和更完整的 package 发布体验，而不是继续扩大 Core。

---

### T014

#### 目标说明
- 收敛 SDK 的 package 发布面，避免 `npm pack` 把源码、dist、backend 扩展和临时数据全部打进包。
- 保证 package 消费者仍能使用根 SDK、文档、examples 和内置 `openteam_agent` runtime。
- 修正 `openteam_agent` vendored SDK 查找逻辑，使它作为依赖被宿主项目引用时不依赖宿主项目的 `process.cwd()`。

#### 成功标准
- package `files` 白名单只包含必要发布产物。
- `openteam_agent` runtime 从当前包位置向上查找 vendored SDK，并保留当前仓库 cwd 兼容。
- 文档说明 package local mode 与 standalone service mode 的边界。
- `npm pack --dry-run --json` 包体明显收敛，并包含 `server/backend/openteam_agent`。

#### TODO
- [x] 在任务板登记 T014。
- [x] 增加 package `files` 白名单。
- [x] 修正 `openteam_agent` runtime root 查找逻辑。
- [x] 更新 public API 文档中的 package/standalone 边界说明。
- [x] 重新跑 pack/build/smoke 校验。

#### 异常发现
- 默认 npm pack 会纳入大量源文件和 backend 扩展，dry-run 约 44 MB packed / 188 MB unpacked / 19190 files。
- vendored AI SDK 会被 pack 纳入，但旧查找方式只看宿主 cwd，作为 dependency 使用时容易找不到包内 runtime。

#### Takeaway
- SDK 发布面应该小而明确：package 负责 SDK、本地 `openteam_agent` 和文档示例；完整 native backend 运行环境由 standalone AgentServer 服务承载。

---

### T015

#### 目标说明
- 给 HTTP SDK 补齐流式事件能力，让远程项目接入时也能收到统一 `SessionStreamEvent`。
- 保持协议简单：HTTP 层只转发 AgentServer Core 的标准事件，不引入 backend 特有事件。
- 让 local SDK 和 HTTP SDK 在 `runTask(..., { onEvent })` 用法上保持一致。

#### 成功标准
- 新增 `POST /api/agent-server/runs/stream`。
- streaming endpoint 输出 newline-delimited JSON：事件行为 `{ event }`，最终成功行为 `{ result }`，失败行为 `{ error }`。
- HTTP client 支持 `runTaskStream()`。
- `createAgentClient({ baseUrl })` 在传入 `onEvent` 时自动使用 streaming endpoint。
- 文档说明 HTTP streaming 用法和协议形状。
- `smoke:agent-sdk` 覆盖 local streaming 与 HTTP streaming。

#### TODO
- [x] 在任务板登记 T015。
- [x] 增加 HTTP streaming route。
- [x] 扩展 HTTP client 的 NDJSON 解析。
- [x] 更新 SDK `runTask()` 的 HTTP `onEvent` 分支。
- [x] 更新 public API / tutorial 文档。
- [x] 扩展 SDK smoke 覆盖 HTTP streaming。

#### 异常发现
- supervisor 内部已经是 NDJSON 事件流，HTTP 层可以保持薄转发，不需要 SSE/WebSocket。
- 旧 SDK 在 HTTP mode 下传入 `onEvent` 会直接报错，现在已改为自动走 `/runs/stream`。

#### Takeaway
- 现在 SDK 的本地和远程接入都能看到同一套标准事件；backend 差异仍停留在 adapter/harness 层。

---

### T016

#### 目标说明
- 将“npm 包安装后能否使用 SDK”的验证固化为正式 smoke。
- 覆盖 package `files` 白名单、runtime dependencies、`openteam_agent` vendored SDK 路径、外部 managed launcher、supervisor 启动链路。
- 防止 SDK 只在仓库根目录可用、作为 dependency 不可用的回归。

#### 成功标准
- 存在 `npm run smoke:agent-sdk:installed`。
- 脚本会临时 `npm pack`、创建空 consumer 项目、安装 tarball、导入 `@agi4sci/agent-server`。
- 安装后的 consumer 能用 `createAgentClient()` 调用全部 backend，并收到 `list_dir` 的 `tool-call` / `tool-result` 事件。
- Native backend 通过 `OPENTEAM_BACKEND_BIN_DIR` 指向外部 managed launcher，不把所有 native backend 源码塞进 npm 包。
- 脚本结束后清理临时目录和 tarball。

#### TODO
- [x] 在任务板登记 T016。
- [x] 新增 `scripts/smoke-agent-sdk-installed.ts`。
- [x] 新增 npm script `smoke:agent-sdk:installed`。
- [x] 补齐顶层 `listSupportedBackends()` helper，与文档概念对齐。
- [x] 给 SDK/openteam smoke 增加临时 supervisor 清理。
- [x] 将 installed package smoke 升级为 all-backends，验证外部 managed launcher 接入。
- [x] 更新教程验证命令。
- [x] 跑 installed package smoke。

#### 异常发现
- 手工 installed-package smoke 曾暴露 `ws` 在 devDependencies 导致 supervisor 启动失败；已将 `ws` 移入 runtime dependencies。
- 完整 native backend 源码体积很大，不适合全部放入 npm package；package local mode 通过外部 managed launcher 支持所有 backend。

#### Takeaway
- SDK 化不只看源码内调用是否通过，还要看发布包作为第三方依赖时是否真的能跑。

---

### T017

#### 目标说明
- 将“所有 backend 都支持 SDK/HTTP streaming 统一接入面”变成强校验。
- 不只验证 `openteam_agent`，而是覆盖 `listSupportedBackends()` 返回的全部 backend。
- 对 native backend 要求 managed launcher 存在；缺 launcher 时失败，避免把“没测到”误当成“已支持”。

#### 成功标准
- 存在 `npm run smoke:agent-sdk:all-backends`。
- 脚本启动临时 HTTP AgentServer route，使用 `createAgentClient({ baseUrl })` 调用每个 backend。
- 每个 backend 都必须通过 `runTask(..., { backend, onEvent })` 收到 `list_dir` 的 `tool-call` / `tool-result` 事件。
- 脚本确认 `listSupportedBackends()` 与 backend catalog 一致。
- 文档把 all-backends SDK smoke 列为统一接口验证项。

#### TODO
- [x] 在任务板登记 T017。
- [x] 新增 `scripts/smoke-agent-sdk-all-backends.ts`。
- [x] 新增 npm script `smoke:agent-sdk:all-backends`。
- [x] 更新 public API / tutorial 文档。
- [x] 运行 all-backends SDK smoke，确认 7 个 backend 都通过。

#### 异常发现
- 之前 SDK smoke 只覆盖 `openteam_agent`；这不足以证明所有 backend 都具备统一 SDK/HTTP 接入能力。
- Native backend 的实际运行依赖 `server/backend/bin` 或 `OPENTEAM_BACKEND_BIN_DIR` 中的 managed launcher，测试必须把这个作为前置条件显式检查。

#### Takeaway
- “所有 backend 支持”应定义为：同一 SDK 方法、同一 backend 参数、同一事件/工具原语契约，在全部 backend 上可验证通过。

---

### T018

#### 目标说明
- 修复 all-backends smoke 并发/连续运行时暴露的 agent store 稳定性问题。
- 避免 agent manifest 写入中的半截 JSON 被 `listAgents()` 读到，导致 loop manager 或 SDK smoke 崩溃。
- 单个损坏 manifest 不应拖垮全局 agent 列表。

#### 成功标准
- `writeJson()` 使用同目录临时文件 + `rename()` 原子替换。
- 空 JSON 文件读取为 `null`。
- `listAgents()` 对单个 agent manifest 解析失败具备隔离能力。
- `npm run smoke:agent-sdk` 在 all-backends smoke 后仍可稳定运行。

#### TODO
- [x] 在任务板登记 T018。
- [x] 将 store JSON 写入改成原子替换。
- [x] 让空 JSON 文件读取为 `null`。
- [x] 让 `listAgents()` 跳过单个损坏 manifest。
- [x] 重新运行 all-backends / SDK smoke 验证。

#### 异常发现
- 连续运行 all-backends smoke 后，`smoke:agent-sdk` 曾在 loop manager 的 `listAgents()` 中读到半截 JSON 并报 `Unexpected end of JSON input`。

#### Takeaway
- all-backends 支持不仅是 backend adapter 能跑，还要求共享 AgentServer Core 的持久化层能承受多 backend 连续写入。

---

### T019

#### 目标说明
- 为云服务部署补齐代码、配置、数据、workspace、backend binaries 分离能力。
- 自动化清理 backend build 中间产物，避免云服务器 build 后长期保留巨大 `target/` / `node_modules` 缓存。
- 明确云端 workspace policy：如果 workspace 留在用户端，云端 AgentServer 不应默认执行本地文件/命令工具。

#### 成功标准
- `AGENT_SERVER_DATA_DIR` 可配置 AgentServer 持久化数据目录。
- `AGENT_SERVER_BACKEND_STATE_DIR` 可配置 backend/supervisor state 目录。
- `OPENTEAM_BACKEND_BIN_DIR` 可作为 build 输出目录和运行时 launcher 目录。
- `runtime.workspace.mode="client"` 时拒绝 server-side workspace tools，旧 `executionMode="client"` 保持兼容。
- `runtime.workspace.serverAllowedRoots` 可限制云端 server-side workspace 根目录。
- `AGENT_SERVER_ENABLED_BACKENDS` 控制服务暴露和允许调用的 backend。
- 存在 `npm run prune:backend-artifacts` 自动清理构建中间产物。
- `npm run build:backend-binaries` 默认 build 后 prune，并支持 `AGENT_SERVER_BUILD_BACKENDS` 选择 backend。
- 存在 `npm run check:deployment` 检查部署配置。
- 存在 `docs/deployment.md` 说明部署目录、workspace 策略和 prune 流程。

#### TODO
- [x] 在任务板登记 T019。
- [x] 给 AgentServer 数据目录增加 `AGENT_SERVER_DATA_DIR`。
- [x] 给 backend state 增加 `AGENT_SERVER_BACKEND_STATE_DIR`。
- [x] 给 workspace policy 增加 `mode` / `serverAllowedRoots`，并兼容旧 `executionMode`。
- [x] 在 `runTask()` 中执行 workspace policy 校验。
- [x] 增加 `AGENT_SERVER_ENABLED_BACKENDS`，让云部署只暴露实际启用 backend。
- [x] 新增 `scripts/prune-backend-build-artifacts.ts`。
- [x] 新增 `scripts/check-deployment.ts`。
- [x] 新增 `smoke:workspace-policy`，验证云端 client workspace mode 不会执行 server-side tools。
- [x] 更新 `build-openteam-backends.ts`，支持外部 bin、选择 backend、自动 prune。
- [x] 新增 `docs/deployment.md` 并接入 README/docs index。

#### 异常发现
- 云服务上的工具执行位置默认是云服务器文件系统，不是用户端 workspace。
- 如果用户端 workspace 不同步/挂载到云端，必须走 client-side worker/sync 模式；否则云端应拒绝任务，避免误操作。

#### Takeaway
- AgentServer service 适合做 backend runtime host；用户端 workspace 需要本地 agent、同步层或挂载层来承接，不能靠云服务直接“看见”用户本地文件。

---

### T020

#### 目标说明
- 将 workspace 执行位置正式建模为用户可选择的模式，而不是含糊的 local/remote。
- 支持 `server` / `client` / `hybrid` 三种模式命名。
- 保留旧 `executionMode` 配置兼容，但新文档和新代码以 `mode` 为主。

#### 成功标准
- `runtime.workspace.mode` 支持 `server` / `client` / `hybrid`。
- `AGENT_SERVER_WORKSPACE_MODE` 可覆盖配置。
- `executionMode: "local"` 兼容映射到 `mode: "server"`。
- `executionMode: "client"` 兼容映射到 `mode: "client"`。
- `server` mode 允许 server-side tools，并可用 `serverAllowedRoots` 限制。
- `client` mode 拒绝 server-side workspace tools，并提示需要 client worker/sync/mount。
- `hybrid` mode 明确保留，当前拒绝并提示需要未来 tool router/client worker。
- 后续由 T025 的 `workspaces / workers / toolRouting` 统一承接 worker/tool router 配置契约。
- 部署文档解释三种模式的使用方式。

#### TODO
- [x] 在任务板登记 T020。
- [x] 更新 config type/default/normalize，加入 `runtime.workspace.mode`。
- [x] 支持 `AGENT_SERVER_WORKSPACE_MODE`。
- [x] 更新 `runTask()` workspace mode 校验。
- [x] 更新 `check:deployment` 输出。
- [x] 更新 `smoke:workspace-policy`。
- [x] 在 `smoke:workspace-policy` 中覆盖旧 `executionMode` 兼容。
- [x] 增加早期 worker 配置骨架和部署检查输出；已由 T025 最终模型替换。
- [x] 更新 `docs/deployment.md`。

#### 异常发现
- “local” 容易歧义：对云服务来说 local 是服务器，对用户来说 local 是用户电脑。对外文档应统一使用 `server` / `client`。

#### Takeaway
- workspace mode 是产品级选择：用户必须知道工具在哪里执行，不能让 AgentServer 自动猜。

---

### T021

#### 目标说明
- 推进长期推荐形态：Ubuntu AgentServer 只做服务控制面，Mac client worker 负责真实 workspace 工具执行。
- 避免服务器产生项目构建垃圾、临时 patch 文件、命令副作用和本地 workspace cache。
- 保持 AgentServer Core 通用：tool router 是边界层，不把 Mac/Ubuntu 特例写进 backend 内部。

#### 成功标准
- 定义 client worker/tool router 的最小协议：注册、心跳、capabilities、tool-call、tool-result、cancel。
- workspace primitives 可路由到 client worker：`list_dir`、`read_file`、`write_file`、`run_command`、`apply_patch`。
- server-side backends 看到的仍是统一工具事件，不关心工具实际在 Mac 还是服务器执行。
- `hybrid` mode 下非 workspace 服务能力可留在服务器，workspace 副作用必须走 client worker。
- 断连、超时、权限拒绝、用户取消都有清晰事件和错误。
- audit 只保存必要事件、metadata 和摘要，不保存大文件内容或构建产物。

#### TODO
- [x] 在任务板登记 T021。
- [x] 预留本地 worker endpoint/token/capability 配置；已由 T025 的 `workers` 最终模型替换。
- [x] 在 `docs/deployment.md` 说明 Mac + Ubuntu 长期推荐拓扑。
- [x] 设计 `docs/client-worker.md`，明确 client worker 协议、权限模型和事件流。
- [ ] 新增 server-side tool router 抽象，但先不改变 backend adapter 事件语义。
- [ ] 新增 Mac 本地 worker 最小实现，支持 `list_dir` / `read_file` / `run_command` dry-run smoke。
- [ ] 打通 `client` mode：服务器将 workspace tool-call 转发给本地 worker。
- [ ] 打通 `hybrid` mode：workspace tools 走 client worker，其它服务能力可留 server。
- [ ] 增加端到端 smoke：Ubuntu-like service + local worker + temp workspace。

#### 异常发现
- “服务器不记录执行垃圾文件”不等于服务器完全无状态；run audit、proposal、capability、错误事件仍应保留在服务器，方便调试和治理。
- 真正要避免的是 workspace 副作用落到服务器：文件写入、shell 输出产物、构建缓存、临时 patch、中间依赖目录。

#### Takeaway
- 长期方案应是 control plane 在服务器，workspace data plane 在用户端。这样既能托管统一 AgentServer service，又不会把用户项目和执行垃圾搬到云服务器。

### T025

#### 目标说明
- 将旧 `workspace profile / tool placement / route destination` 模型彻底替换为最终四元模型：`backend / workspace / worker / route`。
- backend 固定作为服务端大脑；workspace 只表示数据归属地；worker 才是执行者。
- 每个 tool-call 通过 route plan 指定 primary worker 和 fallback workers。
- 工具产生的数据、artifact、结果默认归 workspace。

#### 成功标准
- 删除旧 `tool-placement.ts` / `tool-router.ts` 实现。
- 新增单一 `core/runtime/tool-routing.ts`。
- 类型模型包含：
  - `WorkspaceSpec`
  - `WorkerProfile`
  - `ToolRoutingPolicy`
  - `ToolRoutePlan`
- `planToolRoute()` 支持 primary/fallback workers。
- workspace 副作用工具要求 worker 可访问同一个 workspace。
- network 工具可由 backend-server / network worker 代跑。
- output policy 默认 `writeToWorkspace=true`。
- 配置层使用 `workspaces / workers / toolRouting`，不再使用 `profiles / toolPlacement / clientWorker`。
- SDK/root exports 使用新 routing helper。
- 中文文档以 `backend / workspace / worker / route` 为唯一解释。

#### TODO
- [x] 在任务板登记 T025。
- [x] 删除旧 `core/runtime/tool-placement.ts`。
- [x] 删除旧 `core/runtime/tool-router.ts`。
- [x] 新增 `core/runtime/tool-routing.ts`。
- [x] 重写 routing unit tests。
- [x] 重写 `server/utils/openteam-config.ts` routing 配置模型。
- [x] 重写 `smoke:tool-routing-config`。
- [x] 更新 package root / SDK 导出。
- [x] 更新 `openteam.example.json`。
- [x] 重写 `docs/client-worker.md`。
- [x] 更新 `docs/public-api.md` 和 `docs/deployment.md`。

#### 异常发现
- 旧模型把 workspace 同时当“数据归属”和“执行者”，解释 Mac / SSH GPU / backend proxy 时会绕。
- 新模型中 `workspace.ownerWorker` 是默认执行者，但单个工具仍可通过 routing policy 选择其它 worker。
- `fallback` 不能破坏 workspace 一致性：有副作用工具的 fallback worker 必须能访问同一个 workspace root。

#### Takeaway
- 最终模型应是：backend 负责想，workspace 负责收纳，worker 负责干活，route 负责决定每个 tool-call 谁先干、谁备选。

---

### T026

#### 目标说明
- 在 T025 route plan 之上新增最小可执行层，让计划不只停留在文档和类型。
- 当前优先实现两个稳定执行器：`backend-server` 负责 network 工具，`server` 负责服务器可访问 workspace 的文件/shell 工具。
- `client-worker` / `ssh` / `container` / `remote-service` 在 T026 先保持 plan-only，进入 route plan 但不假装已经能执行；T027 已继续实现 `ssh` executor。
- network 工具结果在可写 server workspace 中写入 artifact；remote workspace 暂时标记为 pending，等待后续 writeback/remote executor。

#### 成功标准
- 新增 server-side `executeRoutedToolCall()`。
- `write_file` / `read_file` / `run_command` 等 workspace 工具能按 route 在 `server` worker 执行。
- `web_fetch` / `web_search` 等 network 工具能按 route 在 `backend-server` 执行。
- shared local-tool fallback 在真实 backend run 中通过 routed executor 执行工具。
- primary worker 若是 plan-only，可 fallback 到可执行 worker。
- network 结果在 server 可访问 workspace 中写入 artifact。
- 单元测试覆盖 server 执行、plan-only fallback、network artifact writeback。
- 新增 smoke 验证最小 executor。
- 文档说明 route plan 与 routed executor 的边界。

#### TODO
- [x] 在任务板登记 T026。
- [x] 新增 `server/runtime/tool-executor.ts`。
- [x] 复用现有 `local-dev-primitives`，不重复实现工具原语。
- [x] 支持 `backend-server` / `server` 两类已实现 executor。
- [x] 对 `client-worker` / `container` / `remote-service` 输出 plan-only skipped attempt；`ssh` 已在 T027 升级为可执行。
- [x] 支持 primary skipped 后 fallback 到可执行 worker。
- [x] 对 network 工具写入 workspace artifact。
- [x] 将 `local-dev-agent` 的工具执行切换到 routed executor。
- [x] 在没有显式 workspace 配置时自动合成本机 `local-dev` workspace 和 `server-local` worker，保持普通本地开发可用。
- [x] 新增 `tests/tool-executor.test.ts`。
- [x] 新增 `scripts/smoke-tool-executor.ts` 和 `npm run smoke:tool-executor`。
- [x] 更新 `docs/client-worker.md`。

#### 异常发现
- `backend-server` 可以代跑网络工具，但如果 workspace 在 SSH/GPU/用户端机器上，当前还不能直接把网络结果写回那个远端 workspace。
- 因此 network 结果写回需要分两层看：server workspace 可立即写 artifact；remote/client workspace 需要后续 remote executor 或 writeback worker。

#### Takeaway
- 当前系统已经具备“统一计划 + 最小执行”的骨架：本机 server workspace 和 backend 网络代理可以真实运行；跨机器 workspace 下一步应补 executor/writeback，而不是再改核心模型。

---

### T027

#### 目标说明
- 将最重要的跨机器场景 SSH GPU workspace 从 plan-only 推进到最小可执行。
- 支持 `ssh` worker 执行 workspace 文件工具和 shell 工具。
- 支持 `backend-server` 代跑 network 工具后，通过 SSH worker 把 artifact 写回 SSH-owned workspace。
- 不把 SSH 逻辑塞进 backend harness；它属于 AgentServer worker executor 层。

#### 成功标准
- `ToolRoutePlan.workers[].executableNow` 对带 `host` 的 `ssh` worker 为 `true`。
- `WorkerProfile` 支持 `host` / `user` / `port` / `identityFile`。
- SSH executor 使用系统 `ssh` 命令，通过 `bash -s` 在远端执行脚本。
- SSH executor 支持：
  - `read_file`
  - `write_file`
  - `append_file`
  - `list_dir`
  - `grep_search`
  - `run_command`
  - `apply_patch`
  - `web_fetch`（远端需有 `curl` 或 `wget`）
- network 工具由 `backend-server` 执行时，如果 workspace owner 是可写 SSH worker，结果 artifact 写回 SSH workspace。
- 单元测试不依赖真实 SSH 服务，使用 `AGENT_SERVER_SSH_BIN` fake ssh 验证协议。
- 文档解释 SSH executor 的配置和边界。

#### TODO
- [x] 在任务板登记 T027。
- [x] 扩展 `WorkerProfile` SSH 配置字段。
- [x] 更新 config normalizer，支持 `port` / `user` / `identityFile`。
- [x] 将带 host 的 `ssh` worker 标记为当前可执行。
- [x] 在 `tool-executor` 中实现 SSH primitive script 生成和执行。
- [x] 支持 `AGENT_SERVER_SSH_BIN` 方便测试/部署覆盖。
- [x] 增加 SSH executor 单元测试。
- [x] 增加 backend network result 写回 SSH workspace artifact 的测试。
- [x] 更新 `smoke:tool-executor` 覆盖 SSH route。
- [x] 更新 `docs/client-worker.md` / `docs/deployment.md` / `docs/public-api.md`。

#### 异常发现
- SSH executor 需要远端具备基础 shell 工具：`bash`、`mkdir`、`dirname`、`cat`、`patch`；`grep_search` 优先 `rg`，否则 fallback 到 `grep`。
- 真实 SSH 连接依赖部署环境的 key、known_hosts、网络和权限，单元测试只能验证协议封装，不能替代真实机器 smoke。

#### Takeaway
- 现在“云端 backend 大脑 + SSH GPU workspace 手 + backend 代联网”已经有代码闭环：文件/shell 在 GPU 侧执行，联网任务可由 backend-server 执行，结果可以写回 GPU workspace artifact。

---

### T028

#### 目标说明
- 将 Mac/用户端 workspace 场景从 plan-only 推进到最小可执行。
- 支持 `client-worker` 通过 HTTP endpoint 接收 tool-call 并在用户端 workspace 执行。
- 保持协议极薄，AgentServer 只要求 `POST /tool-call`，不绑定具体客户端实现语言。
- 支持 `backend-server` 代跑 network 工具后，通过 client-worker 把 artifact 写回用户端 workspace。

#### 成功标准
- `ToolRoutePlan.workers[].executableNow` 对带 `endpoint` 的 `client-worker` 为 `true`。
- `client-worker` executor 使用 HTTP `POST /tool-call`。
- 请求包含：
  - `workerId`
  - `workspace`
  - `cwd`
  - `toolName`
  - `args`
- 响应使用 `{ ok: boolean, output: string }`。
- workspace 文件/shell 工具可 route 到 client-worker。
- network 工具由 `backend-server` 执行时，如果 workspace owner 是可写 client-worker，结果 artifact 写回 client workspace。
- 单元测试用本地 fake HTTP worker 覆盖 client-worker 执行和 network writeback。
- `smoke:tool-executor` 覆盖 client-worker route。
- 文档解释 client-worker HTTP 协议。

#### TODO
- [x] 在任务板登记 T028。
- [x] 将带 endpoint 的 `client-worker` 标记为当前可执行。
- [x] 在 `tool-executor` 中实现 HTTP client-worker executor。
- [x] 在 network artifact writeback 中支持 client-worker。
- [x] 新增 client-worker 单元测试。
- [x] 新增 backend network result 写回 client workspace 的测试。
- [x] 更新 `smoke:tool-executor` 覆盖 client-worker。
- [x] 更新 `docs/client-worker.md` / `docs/deployment.md` / `docs/public-api.md`。

#### 异常发现
- AgentServer 端只定义协议和路由，不应该规定用户端 worker 用 Node、Python 还是其它语言实现。
- client-worker 必须自己做本地权限控制，例如 allowed roots、命令白名单、用户确认等；AgentServer 只做 route 和 audit，不替代用户端安全边界。

#### Takeaway
- 现在四种最常用执行位置已经闭环：`backend-server` 代服务端能力，`server` 跑服务器 workspace，`ssh` 跑 GPU workspace，`client-worker` 跑用户端/Mac workspace。

---

### T029

#### 目标说明
- 将 T028 的 client-worker HTTP 协议从“测试用 fake worker”推进到项目内可直接启动的最小服务。
- 让用户端/Mac workspace 所在机器可以运行 `npm run client-worker`，作为 AgentServer 的执行 worker。
- 给 client-worker 加最小 allowed roots 防护，避免服务被误用到非授权目录。

#### 成功标准
- 新增可复用 `client-worker` service 模块。
- 新增 `npm run client-worker` 启动入口。
- 支持环境变量配置：
  - `AGENT_SERVER_CLIENT_WORKER_ROOTS`
  - `AGENT_SERVER_CLIENT_WORKER_ROOT`
  - `AGENT_SERVER_CLIENT_WORKER_HOST`
  - `AGENT_SERVER_CLIENT_WORKER_PORT`
- 支持 `GET /health`。
- 支持 `POST /tool-call`。
- 拒绝 cwd/workspace root 不在 allowed roots 内的请求。
- `tests/tool-executor.test.ts` 和 `smoke:tool-executor` 复用正式 client-worker service 模块。
- 新增 `smoke:client-worker` 验证服务可启动、可执行工具、可拒绝越界目录。
- 文档说明如何启动 bundled client-worker。

#### TODO
- [x] 在任务板登记 T029。
- [x] 新增 `server/runtime/client-worker-service.ts`。
- [x] 新增 `scripts/client-worker.ts`。
- [x] 新增 `npm run client-worker`。
- [x] 新增 `scripts/smoke-client-worker-service.ts`。
- [x] 新增 `npm run smoke:client-worker`。
- [x] 将 tool executor 测试改为复用正式 client-worker service。
- [x] 将 `smoke:tool-executor` 改为复用正式 client-worker service。
- [x] 更新 `docs/client-worker.md` / `docs/deployment.md` / `docs/public-api.md`。

#### 异常发现
- client-worker 的权限边界必须主要留在用户端执行服务里；AgentServer 的 routing 校验是控制面保护，不能替代用户端本地安全。
- 当前最小服务适合本机或受信网络；公网暴露前还需要 token/auth、TLS、审计和用户确认策略。

#### Takeaway
- Mac/用户端 workspace 场景现在已经不是“需要用户自己实现协议”的状态；本项目自带最小 client-worker，可以直接跑起来做端到端验证。

---

### T030

#### 目标说明
- 给 bundled client-worker 增加最小鉴权和能力发现，避免本地工具服务裸奔。
- 让 AgentServer executor 能自动携带 worker 配置里的 token。
- 保持实现简单：本阶段只做 bearer token / header token，不引入复杂账号体系。

#### 成功标准
- `WorkerProfile` 支持 `authToken`。
- config normalizer 支持 `authToken`。
- AgentServer 调用 client-worker 时发送 `Authorization: Bearer <authToken>`。
- client-worker 支持：
  - `GET /health`
  - `GET /capabilities`
  - `POST /tool-call`
- 设置 token 后，`/capabilities` 和 `/tool-call` 要求鉴权。
- 支持两种 token 传递方式：
  - `Authorization: Bearer <token>`
  - `x-agent-server-token: <token>`
- `smoke:client-worker` 覆盖 health、auth、capabilities、tool-call、allowed-root guard。
- 文档说明 `AGENT_SERVER_CLIENT_WORKER_TOKEN` 和 worker `authToken`。

#### TODO
- [x] 在任务板登记 T030。
- [x] 扩展 `WorkerProfile.authToken`。
- [x] 更新 config normalizer。
- [x] 更新 `tool-executor`，调用 client-worker 时发送 bearer token。
- [x] 更新 `client-worker-service`，加入 token 校验和 `/capabilities`。
- [x] 更新 `scripts/client-worker.ts`，支持 `AGENT_SERVER_CLIENT_WORKER_TOKEN`。
- [x] 更新单元测试，让 routed executor 通过 token 调用 client-worker。
- [x] 更新 `smoke:client-worker` 覆盖鉴权。
- [x] 更新 `smoke:tool-executor` 覆盖带 token 的 client-worker route。
- [x] 更新 `openteam.example.json`。
- [x] 更新 `docs/client-worker.md` / `docs/deployment.md` / `docs/public-api.md`。

#### 异常发现
- token 鉴权只适合本机或受信网络的最低限度保护；公网部署仍需要 TLS、token 轮换、审计、审批和更细粒度权限。
- `/health` 保持公开但不返回 allowed roots；`/capabilities` 在启用 token 时需要鉴权，避免泄露本地能力和目录信息。

#### Takeaway
- bundled client-worker 现在具备最小安全边界：可以启动、发现能力、执行工具、限制目录，并能要求 AgentServer 携带 token。

---

### T031

#### 目标说明
- 将 worker routing 的关键安全/可用性约束放进 `check:deployment`，让错误配置在启动前暴露。
- 覆盖真实部署最容易踩坑的地方：client-worker 未配置 token、workspace root 不在 allowedRoots、SSH identityFile 缺失等。

#### 成功标准
- `check:deployment` 检查 `server` / `ssh` / `client-worker` 的 `allowedRoots`。
- `check:deployment` 检查 workspace root 是否落在 owner worker 的 `allowedRoots` 内。
- `check:deployment` 检查 SSH worker：
  - `host`
  - `identityFile` 存在性（如果配置了）
- `check:deployment` 检查 client-worker：
  - `endpoint`
  - endpoint 是 http(s)
  - `authToken`
- 文档说明新增部署检查范围。

#### TODO
- [x] 在任务板登记 T031。
- [x] 更新 `scripts/check-deployment.ts`。
- [x] 更新 `docs/deployment.md`。
- [x] 跑完整验证。

#### 异常发现
- routing 层认为 `ownerWorker` 能访问 workspace，但真实 client-worker/ssh 服务仍会按 `allowedRoots` 拒绝越界路径；部署检查必须提前发现这种配置不一致。

#### Takeaway
- `check:deployment` 现在不仅检查 backend launcher，也检查 worker data-plane 的基本安全边界。

---

### T032

#### 目标说明
- 给严格化后的 `check:deployment` 增加端到端配置 smoke，避免部署检查本身只靠人工相信。
- 用临时配置覆盖完整 worker routing：`server`、`ssh`、`client-worker`、`backend-server`、workspace owner、allowedRoots、identityFile、authToken 和 network fallback。
- 同时验证一个坏配置：client-worker 缺少 `authToken` 必须失败。

#### 成功标准
- 新增 `smoke:deployment-workers`。
- smoke 生成临时 `openteam.json`。
- smoke 生成临时 `AGENT_SERVER_DATA_DIR`。
- 正常配置通过 `check:deployment`。
- 缺少 client-worker `authToken` 的配置必须被 `check:deployment` 拒绝。
- 文档列出该 smoke。

#### TODO
- [x] 在任务板登记 T032。
- [x] 新增 `scripts/smoke-deployment-worker-routing.ts`。
- [x] 新增 `npm run smoke:deployment-workers`。
- [x] 更新 `docs/deployment.md`。
- [x] 更新 `docs/public-api.md`。
- [x] 跑完整验证。

#### 异常发现
- 严格的部署检查需要自己的 smoke，否则后续调整配置 schema 时容易误伤真实部署。

#### Takeaway
- 现在不仅有 worker executor smoke，也有 worker deployment config smoke：执行链和部署链都被覆盖。
