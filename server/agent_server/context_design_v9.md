# 无限长时间自主运行 Agent 的 Context 管理设计 v9

> 前提假设：agent context 有限，任务相关的 context 越干净，能力越强，但信息丢失的风险也越高。

---

## 第一章 设计原则

### 原则一：尽可能简单

**在满足底线约束的前提下，始终选择更简单的方案。**

简单性是所有设计决策的默认倾向。多一个数据结构，就多一个真相源；多一个真相源，就多一个冲突点。复杂性不会凭空消失，只会转移到维护负担和难以排查的 bug 上。

| 设计选择 | 简单方向 |
|---------|---------|
| 两个方案都能解决问题 | 选更简单的 |
| 可以合并的数据结构 | 合并 |
| 可以静态解决的问题 | 不引入动态机制 |
| 可以附着在已有结构上的信息 | 不新建独立结构 |

这条原则是倾向，不是底线——以下三条原则是底线，简单性不能突破它们。

---

### 原则二：信息守恒

**任何离开 context 的信息必须可以找回来。**

| 操作类型 | 实现方式 | 可恢复性 |
|---------|---------|---------|
| 卸载到文件系统 | 保留路径引用 | 完全可逆 |
| 摘要压缩 | 写入 log，再摘要 | 有损但可回溯 |
| 直接截断 | 无 | ❌ 不可接受 |

---

### 原则三：决策透明

**所有对 context 的非追加操作必须留下可审计的记录。**

记录需包含三个要素：

- **什么被动了**：操作类型、涉及的 turn 范围、备份路径
- **为什么动**：触发条件（work_ratio 阈值）
- **谁决定的**：`decision_by: human` 或 `decision_by: agent`

---

### 原则四：人类主权

**信息的永久删除权归人类，agent 只有归档权。**

| 操作 | 执行者 |
|-----|-------|
| 压缩、卸载、摘要 | agent 自主执行 |
| 永久删除任何信息 | 必须人类确认 |

---

### 原则五：压缩时机

**在信息还清晰的时候压缩，而不是在混乱的时候。**

高熵状态（agent 已开始重复提问、自我矛盾、决策停滞）下产出的摘要本身就不可信，必须在此之前处理。

---

### 原则六：检索兜底

**不知道的时候去找，找不到的时候问人，不得凭空推理。**

```
COMPACTION TAG constraints + 当前 work 摘要
    ↓ 否
PARTIAL_COMPACTION TAG 摘要（当前 window 内）
    ↓ 否
log/turns.jsonl 原文（按 turn 范围索引）
    ↓ 否
persistent/（当前 session 历史）
    ↓ 否
memory/（跨 session）
    ↓ 否
向人澄清，不推理
```

触发检索的机制分两层：prefix 种子约束负责通用类别，COMPACTION TAG 的 constraints 字段负责任务特定约束。

检索链从近到远，从当前 window 到当前 session 到跨 session，信息越来越旧、读取成本越来越高。

---

### 分级总览

| 级别 | 原则 | 判断标准 |
|-----|------|---------|
| 🔴 底线约束 | 尽可能简单 | 是所有设计决策的默认倾向 |
| 🔴 底线约束 | 信息守恒 | 违反导致信息永久丢失 |
| 🔴 底线约束 | 决策透明 | 违反导致操作不可审计 |
| 🔴 底线约束 | 人类主权 | 违反导致系统不可信 |
| 🟡 强烈推荐 | 压缩时机 | 违反导致摘要质量系统性下降 |
| 🟢 推荐 | 检索兜底 | 违反影响正确性但不影响可恢复性 |

> **简单性与其他底线约束的优先级**：简单性是设计倾向，信息守恒、决策透明、人类主权是不可突破的底线。当两者冲突时，底线优先。

---

## 第二章 案例展开

### 架构总览

```
context = prefix（固定前缀，只追加，永不压缩）
         + work（工作区，可压缩）
               ├── stable_work（已有阶段性结论，LLM 主动决策时不压缩）
               └── dynamic_work（当前进行中的内容，LLM 主动决策的压缩目标）
```

两层结构，单一真相源，所有 context 管理的复杂度集中在 COMPACTION TAG 的写法上。

work 区在逻辑上分为 stable_work 和 dynamic_work 两段，**不是物理分区**——没有显式标记将某个 turn 标为 stable 或 dynamic，边界由 LLM 在每次安全点动态判定。LLM 是主要判断者，人类可以通过种子约束中的优先提示表提供倾向性指导，但最终边界由 LLM 根据语义状态自主决定。

实现建议补充：为了避免 LLM 随意给出一个脱离上下文的 boundary，服务层可以先暴露一组“合法 stable boundary 候选 turn”（例如 `candidateTurns`），再让 LLM 只在该集合内选择，并回传 `boundarySource`。这样既保留语义主导，又保留工程可验证性与恢复友好性。

实现建议补充：`work_ratio` 应被视为“预算压力信号”，不是局部压缩的唯一触发条件。只要已经到达安全点、且 LLM 判断当前存在可以替换的 dynamic_work island，就可以在低 `work_ratio` 下仍触发 partial compaction；hard/full compaction 则继续由硬阈值兜底。

实现建议补充：服务层可以对外暴露一份统一的 compaction `decision` 快照，明确区分“budget 建议”“语义机会”“最终采用来源（semantic / budget / hard threshold）”。这样 preview、auto 与人工确认流可以共享同一套判定结果，而不是各自解释一次。

实现建议补充：session finalize / memory 提炼也适合暴露同类 `decision` 快照。这样人类在结束 session 前可以看到“当前更推荐 conservative / balanced / aggressive 的哪一种，以及它来自语义判断还是启发式预算判断”，从而让 finalize 与 compaction 共享一致的确认体验。

实现建议补充：persistent 超预算恢复也适合走同样的 `decision` 快照。这样人类在执行 slimming 前可以看到“当前更推荐 conservative / balanced / aggressive 的哪一种，以及它来自语义判断还是启发式预算判断”，从而让三类强操作共享统一的确认界面。

实现建议补充：`GET /context` 可以再提供一层统一的 `operationalGuidance` 汇总，把 compaction / session finalize / persistent recovery 三条强操作链的当前推荐动作与理由聚合成一个轻量视图。这样人类和上层 UI 不必逐个调用 preview，仍能一眼看到“现在最值得做什么”。

澄清：同一个 window 内出现多个 `PARTIAL_COMPACTION TAG` 是正常的。局部压缩的目标是“在安全点把当前某一段低价值 dynamic_work 替换掉”，不是强制把整个 window 维持成唯一一个 partial tag。两个 partial 之间可以保留高信息密度、暂时不该压缩的 raw work。只有在 hard/full compaction 触发时，当前 window 内的 raw work 与多个 partial tags 才统一聚合为新的第一个 `COMPACTION TAG`。

两段的压缩策略不同：

| | stable_work | dynamic_work |
|---|---|---|
| LLM 主动决策 | 不压缩，原文保留 | 可压缩，替换为 PARTIAL_COMPACTION TAG |
| 硬兜底触发 | 统一整体压缩，重新评估边界 | 统一整体压缩 |

单次 window 内，stable_work 不降级——即使后续任务方向改变，也等到硬兜底时统一重新评估，不在 LLM 主动决策阶段处理降级。

---

### 执行环境

压缩由 agent 以 by-the-way 模式执行，不依赖外部框架层，完全 self-contained。每个 turn 产生时持续写入 `log/turns.jsonl`，压缩时无需临时 dump，直接从 log 校验完整性后执行。

**局部压缩（LLM 主动决策）：**
```
log/turns.jsonl 持续追加
    → 安全点：LLM 判断 dynamic_work 可压缩
    → prefix + stable_work + dynamic_work + 压缩指令
          → PARTIAL_COMPACTION TAG + 替换代码
    → current.jsonl：stable_work 与高价值 raw islands 保留，被选中的 dynamic_work 段替换为一个 PARTIAL_COMPACTION TAG
```

**整体压缩（硬兜底）：**
```
log/turns.jsonl 持续追加
    → work_ratio >= 强制阈值
    → prefix + work + 压缩指令
          → COMPACTION TAG + 替换代码
    → current.jsonl = 唯一 COMPACTION TAG（旧 work 全部清除）
    → persistent/ 追加写入
```

替换代码采用两步执行（先写入 TAG，再清除旧 work），存在中间状态。崩溃恢复由启动时状态检查覆盖（见案例一种子约束）。

---

### 案例一：Prefix 层的设计

Prefix 是整个架构最稳定的部分，包含三类内容：

```
prefix = system_prompt
       + 工具定义
       + 种子约束
```

**种子约束**是静态写入 system_prompt 的检索触发规则，覆盖通用类别的 unknown unknown：

```
在对以下类型的信息做判断前，必须先检索历史，不得直接推理：
- 任何外部状态（API、文件、环境变量）
- 任何在本 window 中被修改过的值
- 任何你不确定是否还有效的假设

读取 constraints 时，同一 key 存在多条记录，以 turn 编号最大的为准，其余忽略。

使用 constraints 前，按来源类型决定是否验证当前值：

  来源类型              验证策略
  ─────────────────────────────────────────
  外部 API 返回值       每次使用前验证
  文件/数据库状态       每次使用前验证
  环境变量/配置值       每次使用前验证
  工具行为特征          同一 window 内信任，跨 window 验证
  协议/标准定义         永久信任，不验证
  边界模糊              默认验证

启动时状态检查：
- log/turns.jsonl 存在 + 有对应 COMPACTION TAG → 正常状态
- log/turns.jsonl 存在 + 无对应 COMPACTION TAG → 压缩中断，重新执行步骤二到三
- log/turns.jsonl 不存在 + work 区为空 → 异常，向人澄清
- log/turns.jsonl 存在 + 有对应 COMPACTION TAG + current.jsonl 包含 TAG 之外的旧内容
    → 步骤三中断，直接清空 TAG 之前的旧内容，恢复正常状态
- log/turns.jsonl 存在 + 有 PARTIAL_COMPACTION TAG + stable_work 原文在 TAG 之前
    → 正常状态（stable_work 是有意保留的原文）

新 window 启动时：
1. 加载 persistent/ 全量内容
2. 若 constraints.jsonl 或 summary.jsonl 超过各自 token 上限
   → 暂停，通知人类：persistent/ 已超限，请手动触发清理
3. 未超限 → 直接开始任务

检索链：
COMPACTION TAG constraints + 当前 work 摘要
    ↓ 否
PARTIAL_COMPACTION TAG 摘要（当前 window 内）
    ↓ 否
log/turns.jsonl 原文（按 turn 范围索引）
    ↓ 否
persistent/（当前 session 历史）
    ↓ 否
memory/（跨 session）
    ↓ 否
向人澄清，不推理
```

这覆盖了实际任务中大多数 unknown unknown 的来源。代价是无法捕捉任务特定的、运行中才会出现的新类别——这部分由 COMPACTION TAG 的 constraints 字段承接。

Prefix 的特性：只追加，永不修改，cache 命中率最高。修改 prefix 会导致整段 cache 全部失效，代价极高，不推荐。

#### 固定执行 Workspace 前缀

对带工具执行能力的 agent，`workspace` 不是普通上下文，而是决定“工具在哪台机器、哪个目录执行”的全局事实。UI 连接远端 SSH 只说明前端可以访问远端文件，并不自动改变 agent 工具运行位置；如果不把 workspace 写入 prefix / session context，agent 仍会用本地 `process.cwd()` 作为默认执行目录，因此会出现“用户让 agent 查看服务器 GPU，agent 却在本机执行 `nvidia-smi`”这类错误。

因此，每个 agent session 启动时必须先确定一个 **Current Project Workspace**，并作为 prefix 固定前缀注入：

```
CURRENT PROJECT WORKSPACE
- workspaceId: <local | ssh:pjlab_gpu | remote:<sessionId> | tool:<endpointId>>
- transport: <local | ssh | container | robot | tool-endpoint>
- cwd: <PROJECT 根目录；远端时为远端绝对路径>
- allowedRoots: [<cwd>, ...]
- artifactsRoot: <cwd 下的 .openteam/artifacts 或任务指定目录>
- networkMode: <local-egress | offline | remote-direct | remote-via-local-proxy>
- defaultExecutionTarget: <local | remote>
- remoteSessionId: <存在时填写>
```

运行规则：

- 用户没有显式指定机器/目录时，所有 shell、文件、git、GPU、端口、日志、构建、测试操作默认在 `CURRENT PROJECT WORKSPACE` 执行。
- 当 `defaultExecutionTarget=remote` 时，`nvidia-smi`、`pwd`、`ls`、`git status` 等命令必须通过对应 remote workspace/tool endpoint 执行，不能退回本机执行。
- 如果当前任务需要切换 workspace，必须先显式更新 session context 和 blackboard task 的 `executionScope`，再执行工具。
- 任一任务的 `executionScope` 必须从 Current Project Workspace 派生，至少包含 `workspaceId`、`cwd`、`allowedRoots`、`artifactsRoot`；不得在缺失这些字段时默认使用 `process.cwd()`。
- 当远端机器可能无法联网时，prefix 还必须声明 `networkMode` 与可用代理策略。需要联网的 agent 服务优先走本地；只有用户或任务明确允许时，远端才可通过 SSH reverse/proxy 走本地网络。

这条规则属于 prefix 的种子约束，而不是普通 work 内容：它应该在每个新 window / session 开始时重新从真实 runtime 状态解析并注入。由于远端连接状态会变化，prefix 中的 workspace 值必须带 `checkedAt` 或 session 版本，并在执行前由工具层验证当前 session 仍然可用。

---

### 案例二：Work 层的压缩与 KV Cache 的经济账

#### KV Cache 的价差

KV Cache 命中与未命中的价差约为 10 倍（以 Claude Sonnet 为例，缓存命中 $0.30/MTok，未命中 $3/MTok）。Work 层天然不稳定，每轮都在追加，cache 命中率本来就低于 prefix。如果能把 work 区压缩到原来的 1/N 以下，每一轮后续推理都从更短的 work 区获益，这个收益是持续复利的。

实现建议补充：服务层可以把这件事显式建模成统一的 `tokenEconomics` 快照，而不是只保留近似 token 数。一个实用的第一版模型是：
- `cache_eligible_tokens`：system prompt、memory、persistent、以及当前 window 中保持字节稳定的 stable/raw islands 与 compaction tags
- `uncached_tokens`：当前 window 中仍然活跃、下一轮最可能变化的 dynamic/raw islands
- `effective_per_turn_cost = cache_eligible_tokens * 0.1 + uncached_tokens`

在这个模型下：
- compaction 的收益不只是“压缩了多少 token”，而是“减少了多少未来每轮都要按原价付费的 uncached tokens”
- finalize / persistent slimming 的收益虽然主要发生在 prefix，但仍可以通过 `0.1x` 的缓存价差持续降低每轮成本
- preview / auto / human confirm 三条链都可以共享同一套 `costDelta` 视图，例如 `estimatedSavingsPerFutureTurn`、`estimatedSavingsRatio`、`breakEvenTurns`

实现约束补充：这里的成本优化不应违背前面的语义原则。也就是说，不能为了追求更低 token 成本就主动破坏 stable prefix、合并本应保留的 raw high-value block、或强行重写已有 partial islands。token economics 应作为 `budget + semantic` 之后的第三个决策信号，而不是覆盖语义正确性的唯一目标。

实现建议补充：如果 preview / auto / human confirm 已经显式算出了 `costDelta`、预算状态和关键约束保留情况，这些信号也应继续喂给 semantic analyzer 本身，而不是只展示给人看。否则 LLM 仍只能根据“候选条目数、摘要样本、预算总量”做粗判断，长期 token economics 很难真正进入 compaction / finalize / recovery 的语义决策。

#### 触发条件

压缩分两类触发，职责不同：

**触发 A：LLM 主动决策（每个安全点检查一次）**

```
安全点 = 最近一个 agent turn 不是 tool_result（工具链已结束）
       AND 最近一个 error_retry 已有对应的后续 tool_result（重试已完成）

每次到达安全点，LLM 结合以下输入做判断：
  - 当前 work_ratio（与软阈值对比，作为参考信号）
  - 种子约束中的人类优先提示表（倾向性参考，非硬规则）
  - 当前 work 区语义状态（LLM 自主判断，优先级高于提示表）

LLM 输出二选一：
  a. 不压缩
  b. 划定 stable_work / dynamic_work 边界，压缩 dynamic_work（局部压缩）

LLM 主动决策路径只做局部压缩，不触发整体压缩。
```

**触发 B：硬兜底（不依赖 LLM 判断）**

```
剩余空间 = context_window - prefix_tokens
work_ratio = current_work_tokens / 剩余空间

触发硬兜底 = work_ratio >= 强制阈值
           AND 当前处于安全点
```

硬兜底时不区分 stable/dynamic，对整个 work 区重新全量评估后整体压缩。

**阈值选取**：

| 参数 | 推荐值 | 可调范围 | 说明 |
|-----|-------|---------|------|
| `work_ratio 软阈值` | 0.6 | 0.5 - 0.8 | LLM 主动决策的参考下限，非强制 |
| `work_ratio 强制阈值` | 0.85 | 0.8 - 0.9 | 硬兜底触发线，强制执行 |

软阈值是 LLM 判断的输入信号之一，不是硬性触发条件——LLM 可以在 work_ratio 低于软阈值时主动压缩，也可以在超过软阈值后判断暂不压缩。强制阈值是不依赖 LLM 的最后保障。

**stable_work / dynamic_work 的定义**：

work 区在逻辑上分为两段，不是物理分区，边界由 LLM 在每次安全点判断时划定：

```
stable_work：已得出阶段性结论、后续不会再修改的部分
dynamic_work：当前进行中的内容，结论尚未确定或中间过程价值密度低
```

边界划分粒度为 turn 级别。单次 window 内 stable_work 不降级——即使后续任务方向改变，也等到硬兜底时统一重新评估，不在 LLM 主动决策阶段处理降级。

#### 内容类型表

| type | estimated_ratio | 归档方式 |
|------|----------------|---------|
| `code_output` | 0.05 | 卸载 + 功能摘要 + 精确路径索引 |
| `tool_result` | 0.10 | 卸载 + 摘要 |
| `error_retry` | 0.40 | 只摘要（三段结构：排除路径 + 根因 + 解法）|
| `human_dialogue` | 0.30 | 卸载 + 摘要 + 精确路径索引 |
| `reasoning_chain` | 0.40 | 只摘要（关键步骤）|

> `estimated_ratio` 的定义：压缩后 work 区 token 数 / 压缩前 work 区 token 数。

> `task_log` 已取消作为独立类型。里程碑语义在压缩时从 `tool_result` 和 `human_dialogue` 中提取，写入 summary，不依赖 agent 运行中的实时判断。

> 工具调用轨迹不作为独立类型：调用参数和意图归入 `reasoning_chain`，返回结果归入 `tool_result`。

> `human_dialogue` 和 `code_output` 的 summary 字段需精确记录路径和 turn 范围，格式见案例三。

#### 压缩执行流程

**整体压缩（触发 B 硬兜底）：**

```
步骤零（持续）：每个 turn 产生时追加写入 log/turns.jsonl
步骤一：确认 log/turns.jsonl 中包含本次压缩范围内的所有 turn（完整性校验）
步骤二：一次全量读取，同时完成：
        - 扫描所有 tool_result，提取外部状态事实为 CONSTRAINT
        - 对比已有 COMPACTION TAG 的 constraints，按淘汰规则去重合并
        - 生成各条记录的摘要（human_dialogue/code_output 附路径索引，error_retry 三段结构）
        - 按 type 决定归档方式
        - 继承 persistent/ 中的跨 window constraints，去重合并
步骤三：原子替换——新 work 区 = 唯一 COMPACTION TAG，旧 work 区和所有旧 TAG 清空
步骤四：写入 persistent/
        - constraints.jsonl：追加新提取的约束，去重合并
        - summary.jsonl：追加本次 COMPACTION TAG 的 summary 原文，附 window 编号和时间戳
```

**局部压缩（触发 A LLM 主动决策）：**

```
步骤零（持续）：每个 turn 产生时追加写入 log/turns.jsonl
步骤一：确认 log/turns.jsonl 中包含 dynamic_work 范围内的所有 turn（完整性校验）
步骤二：仅读取 dynamic_work 段，生成摘要，提取 CONSTRAINT
步骤三：原子替换——被选中的 dynamic_work 位置替换为 PARTIAL_COMPACTION TAG，stable_work 与其他高价值 raw work 不动
        （不写入 persistent/，局部压缩的 constraints 等待下次整体压缩时统一合并）
```

> 局部压缩不写 persistent/ 的理由：局部压缩是 window 内的局部优化，constraints 提取不完整；整体压缩时会覆盖处理，避免重复写入。

---

### 案例三：Work 层的标记

#### `[CONSTRAINT]`——压缩时提取

压缩时，agent 扫描本段 work 中所有 `tool_result`，提取其中包含的外部状态事实为 CONSTRAINT，写入 COMPACTION TAG 的 `constraints` 字段。

提取范围：
- 外部 API 的行为特征（返回结构、字段含义、状态码语义）
- 文件/数据库的实际状态（字段变更、schema 变化）
- 环境变量/配置的实际值
- 工具的实际行为（事务提交、缓存策略）

每条 constraint 采用结构化格式，同时标注来源类型（对应种子约束中的验证策略映射表）：

```json
{ "key": "api.api_x.status_pending_data",  "desc": "返回 status=pending 时 data 字段为 null", "turn": 5,  "type": "api_behavior" }
{ "key": "env.api_key",                     "desc": "API_KEY 在 turn_31 轮换",                 "turn": 31, "type": "env_config"   }
{ "key": "db.users.email_verified",         "desc": "prod.db 的 users 表在 turn_67 新增了 email_verified 字段", "turn": 67, "type": "db_state" }
{ "key": "tool.query_db.uncommitted_read",  "desc": "事务未提交时返回旧数据，需手动 commit",   "turn": 89, "type": "tool_behavior" }
```

**key 命名规范**（写入压缩指令，agent 压缩时遵循）：

```
api.{api_name}.{field_or_behavior}     → api.api_x.status_pending_data
db.{table}.{field_or_schema}           → db.users.email_verified
env.{var_name}                         → env.api_key
tool.{tool_name}.{behavior}            → tool.query_db.uncommitted_read
protocol.{name}.{aspect}              → protocol.http.status_codes
```

> key 只描述对象和属性，不包含值。同一属性的不同历史值共享同一 key，通过 turn 编号区分新旧。

**constraints 淘汰规则**（超过 token 上限时按优先级执行）：

| 优先级 | 类型 | 规则 |
|--------|------|------|
| 1 | `protocol` `tool_behavior` | 永不淘汰 |
| 2 | `api_behavior` `db_state` `env_config` | 相同 key 只保留 turn 最大的一条，旧版本优先淘汰 |
| 3 | 以上仍超限 | 按 turn 升序淘汰最旧条目（跨类型兜底） |

同时对比所有已有 COMPACTION TAG 的 constraints：
- 发现相同 key 的：新条目覆盖旧语义，以 turn 编号最大的为准
- 发现矛盾的：显式标记，交由后续检索时处理
- 超过 token 上限的部分：按上述淘汰规则处理

constraints token 上限为人类设定的超参数，推荐 10k token（约可容纳 300 条约束）。

压缩时统一提取的理由：
- 压缩时 agent 本来就要读完整段 work，边际代价极低
- 把写入责任从"agent 自律的实时判断"转移到"结构性强制的压缩流程"
- 单一写入时机，真相源唯一

残余风险：压缩前的窗口期内，新发现的约束未被显式记录。由 prefix 种子约束兜底，最终兜底是向人澄清。窗口期内重复踩坑的代价有上界（多几个 turn 的 error_retry），不违反任何底线约束。

#### `[COMPACTION]`——整体压缩时生成

```
[COMPACTION @turn_47]
  timestamp:   2024-03-15 15:42:03 UTC
  elapsed:     +01:23:18
  decision_by: agent
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_1-47
  files:       [涉及的文件路径列表]
  tools:       [调用过的工具名列表]
  turns:       turn_1 - turn_47
  constraints: [
    { "key": "api.api_x.status_pending_data", "desc": "返回 status=pending 时 data 字段为 null", "turn": 5,  "type": "api_behavior" },
    { "key": "env.api_key",                   "desc": "API_KEY 在 turn_31 轮换",                "turn": 31, "type": "env_config"   }
  ]
  summary:
    [human_dialogue turn_1]  /sessions/abc123/work/log/turns.jsonl @turn_1-47
      用户要求重构 src/api.py，统一封装 HTTP 调用
    [code_output turn_7]     /sessions/abc123/work/log/turns.jsonl @turn_1-47
      HttpClient 类，封装 12 个 HTTP 调用，pending 状态返回 None
    [error_retry turn_5-6]
      排除路径：data 为空数组 → 不是；status 字段不存在 → 不是
      根因：status=pending 时 data 字段为 null
      解法：使用前检查 status，null 时跳过迭代
    完成了 src/api.py 的 HttpClient 封装，统一了 12 个 HTTP 调用。
    完成了 src/auth.py 的 token 刷新逻辑，turn_31 发现 API_KEY 已轮换。
    当前任务进展：基础重构完成，待处理模块为 src/cache.py。
```

**index 字段设计原则**：只保留客观可枚举的信息（files、tools、turns），不预测"关键变量名"等主观字段。index 的职责是"告诉 agent 去哪个归档找"，归档内部的内容通过打开文件确认。

整体压缩后，context 中永远只有一个 COMPACTION TAG，是唯一的真相源。

#### `[PARTIAL_COMPACTION]`——局部压缩时生成

```
[PARTIAL_COMPACTION @turn_23-31]
  timestamp:   2024-03-15 14:55:10 UTC
  elapsed:     +00:36:35
  decision_by: agent
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_23-31
  tools:       [调用过的工具名列表]
  turns:       turn_23 - turn_31
  summary:
    批量查询用户表，确认 email_verified 字段存在，共返回 1823 条记录。
    查询参数：SELECT * FROM users WHERE verified=false，结果已用于下一步过滤逻辑。
```

每个 PARTIAL_COMPACTION TAG 都插入在“当次被压缩的 raw dynamic 段”所在的位置，替代该段原文。window 内可以存在多个 PARTIAL_COMPACTION TAG；它们之间允许保留未压缩的高价值 raw work。

PARTIAL_COMPACTION TAG 不包含 constraints 字段——局部压缩的 constraints 提取不完整，等待下次整体压缩时统一扫描合并。

---

### 案例四：残余风险的定位

这套架构对 unknown unknown 的防护分两层：

- **种子约束（prefix）**：覆盖通用类别，开箱即用，无维护成本
- **CONSTRAINT 标记（work）**：覆盖任务特定约束，压缩时结构性提取，按来源类型决定验证策略

两层的残余风险：`[CONSTRAINT]` 的提取仍落在压缩时的 agent 扫描上，真正的 unknown unknown（agent 不知道自己不知道）仍可能漏过。

这个残余风险是可以接受的：已知的 known unknown 由 CONSTRAINT 覆盖，真正的 unknown unknown 由种子约束兜底，最终兜底是"向人澄清"。没有任何机制能完全消除 unknown unknown，但整个检索链把最终风险承接者变成了人类，而不是让模型自己脑补。

---

### 案例五：磁盘文件结构

```
sessions/
    {session_id}/
        work/
            current.jsonl               # 当前 work 区
            log/
                turns.jsonl             # 逐 turn 流式日志，唯一原文真相源
        persistent/
            constraints.jsonl           # 跨 window 持久化的约束（当前 session）
            summary.jsonl               # 跨 window 持久化的任务进展摘要（当前 session）
memory/
    constraints.jsonl                   # 跨 session 持久化的约束
    summary.jsonl                       # 跨 session 持久化的任务进展摘要
```

`compacted/` 目录取消。`log/turns.jsonl` 是唯一的原文真相源，每个 turn 产生时追加写入，COMPACTION TAG 和 PARTIAL_COMPACTION TAG 的 `archived` 字段均引用此文件加 turn 范围索引。

**log/turns.jsonl 的生命周期**：
- 每个 turn 产生时：追加写入，不修改历史记录
- log 超过 turn 数上限时：超出部分归档到冷存储，不影响检索链（检索链不直接读 log，只在回溯原文时按 turn 范围索引访问）
- log 的 turn 数上限为人类配置的超参数

**persistent 层的生命周期**：
- 每次整体压缩步骤四完成后：自动追加，去重合并
- 新 window 启动时：加载全量内容，超限时暂停并通知人类处理
- 合并规则：去重合并，时序优先，总量受各自 token 上限约束

**memory 层的生命周期**：
- session 结束时：由人类显式触发，将 persistent/ 提炼后写入 memory/
- 新 session 启动时：从 memory/ 加载，初始化 persistent/
- 清空 memory：永久删除操作，必须人类确认（原则四）

**session 边界**：
- session 开始：人类启动新任务时显式声明，persistent/ 初始化（或从 memory/ 加载）
- session 结束：人类显式关闭，触发 session 级压缩，当前 persistent/ 归档或清空由人类决定

> session 是任务维度的概念，"任务结束"是语义判断，不由 agent 自动判断，避免误触发。

---

### 案例六：人类介入点的设计

**同步介入点**（任务本身需要的交互）：
- 检索链全部失败时的任务澄清

**显式操作介入点**（context 管理需要的确认）：
- session 结束时触发 session 级压缩，将 persistent/ 写入 memory/
- persistent/ 超限时的人工清理（触发后由人类决定保留哪些历史摘要）
- 清空 memory/（永久删除，必须人类确认）
- 主动触发压缩（decision_by: human）

Agent 自主执行（无需人类）的操作：
- Work 层压缩与卸载（整体压缩和局部压缩）
- COMPACTION TAG 生成（含外部状态事实提取、来源类型标注与合并）
- PARTIAL_COMPACTION TAG 生成（局部压缩时，含阶段性结论摘要）
- persistent 层的读写（每次整体压缩后自动追加）

---

## 第三章 完整 Context 字段刻画

### 总体结构

```
context = PREFIX 区（永不压缩）
        + WORK 区（持续追加，可压缩）
               ├── stable_work（已有阶段性结论，LLM 主动决策时不压缩）
               └── dynamic_work（当前进行中的内容，LLM 主动决策的压缩目标）
```

---

### PREFIX 区（完整字段）

```
# ============ PREFIX BEGIN ============

[SYSTEM PROMPT]
  你是一个自主运行的 agent，负责...

[TOOL DEFINITIONS]
  - read_file(path): 读取文件内容
  - write_file(path, content): 写入文件
  - run_code(code): 执行代码，返回输出
  - query_db(sql): 执行数据库查询

[SEED CONSTRAINTS]
  在对以下类型的信息做判断前，必须先检索历史，不得直接推理：
  - 任何外部状态（API、文件、环境变量）
  - 任何在本 window 中被修改过的值
  - 任何你不确定是否还有效的假设

  读取 constraints 时，同一 key 存在多条记录，以 turn 编号最大的为准，其余忽略。

  使用 constraints 前，按来源类型决定是否验证当前值：

    来源类型              验证策略
    ─────────────────────────────────────────
    外部 API 返回值       每次使用前验证
    文件/数据库状态       每次使用前验证
    环境变量/配置值       每次使用前验证
    工具行为特征          同一 window 内信任，跨 window 验证
    协议/标准定义         永久信任，不验证
    边界模糊              默认验证

  constraints key 命名规范（压缩时遵循）：
    api.{api_name}.{field_or_behavior}
    db.{table}.{field_or_schema}
    env.{var_name}
    tool.{tool_name}.{behavior}
    protocol.{name}.{aspect}
  key 只描述对象和属性，不包含值。

  constraints 淘汰规则（超过 token 上限时按优先级执行）：
    1. [protocol] [tool_behavior]：永不淘汰
    2. [api_behavior] [db_state] [env_config]：相同 key 只保留 turn 最大的一条
    3. 以上仍超限：按 turn 升序淘汰最旧条目（跨类型兜底）

  dynamic_work 压缩判断（局部压缩时执行）：

    LLM 是主要判断者。每次到达安全点，LLM 自主判断当前哪段内容构成 dynamic_work、
    是否已有阶段性结论、中间过程是否还有独立价值。

    判断框架（LLM 遵循）：
      dynamic_work 可压缩，需同时满足：
        1. 这段内容已有明确的阶段性结论
        2. 结论已在 work 区某处得到体现
        3. 中间过程对后续决策没有独立价值
      以下任一条件成立时，不压缩：
        1. 其中穿插了 human_dialogue
        2. 其中包含 error_retry（排除路径本身有价值）
        3. 尚未得出明确的阶段性结论

    人类优先提示表（人类配置，LLM 判断时优先参考，可覆盖）：

      优先视为 dynamic_work（可压缩）：
        （此处由人类填写，例如：）
        - 连续 read_file 后跟 write_file
        - 批量 query_db 最终汇总
        - 多轮 run_code 调试最终跑通

      优先视为 stable_work（不压缩）：
        （此处由人类填写，例如：）
        - 包含重要设计决策的 reasoning_chain
        - 用户明确要求保留的内容

    人类优先提示表未覆盖的情况，LLM 自主判断。
    人类优先提示表的条目是倾向，不是硬规则——LLM 遇到语义冲突时可以不遵循，
    但需要在 PARTIAL_COMPACTION TAG 的 summary 中说明原因。

  启动时状态检查：
  - log/turns.jsonl 存在 + 有对应 COMPACTION TAG → 正常状态
  - log/turns.jsonl 存在 + 无对应 COMPACTION TAG → 压缩中断，重新执行步骤二到三
  - log/turns.jsonl 不存在 + work 区为空 → 异常，向人澄清
  - log/turns.jsonl 存在 + 有对应 COMPACTION TAG + current.jsonl 包含 TAG 之外的旧内容
      → 步骤三中断，直接清空 TAG 之前的旧内容，恢复正常状态
  - log/turns.jsonl 存在 + 有 PARTIAL_COMPACTION TAG + stable_work 原文在 TAG 之前
      → 正常状态（stable_work 是有意保留的原文）

  新 window 启动时：
  1. 加载 persistent/ 全量内容
  2. 若 constraints.jsonl 或 summary.jsonl 超过各自 token 上限
     → 暂停，通知人类：persistent/ 已超限，请手动触发清理
  3. 未超限 → 直接开始任务

  检索链：
  COMPACTION TAG constraints + 当前 work 摘要
      ↓ 否
  PARTIAL_COMPACTION TAG 摘要（当前 window 内）
      ↓ 否
  log/turns.jsonl 原文（按 turn 范围索引）
      ↓ 否
  persistent/（当前 session 历史）
      ↓ 否
  memory/（跨 session）
      ↓ 否
  向人澄清，不推理

# ============ PREFIX END ============
```

---

### WORK 区：场景一——从未压缩过（早期状态）

所有 turn 原始保留，无任何 COMPACTION TAG。

```
# ============ WORK BEGIN ============

turn_1 | 2024-03-15 14:18:35 UTC | +00:00:00 | human:
  [human_dialogue]
  帮我重构 src/api.py，把所有 HTTP 调用统一封装

turn_2 | 2024-03-15 14:18:47 UTC | +00:00:12 | agent:
  [reasoning_chain]
  需要先读取 src/api.py 的内容，了解当前结构再决定封装方式

turn_3 | 2024-03-15 14:18:51 UTC | +00:00:16 | agent:
  [tool_result]
  read_file(src/api.py) →
    def get_user(): requests.get(...)
    def post_order(): requests.post(...)
    ...（200行）

turn_4 | 2024-03-15 14:19:10 UTC | +00:00:35 | agent:
  [reasoning_chain]
  当前有 12 个分散的 HTTP 调用，计划统一封装为 HttpClient 类，
  对外暴露 request(method, url) 接口

turn_5 | 2024-03-15 14:20:02 UTC | +00:01:27 | agent:
  [tool_result]
  run_code(test_api.py) →
    ERROR: API_X 返回 status=pending 时 data 字段为 null
    TypeError: cannot iterate over null

turn_6 | 2024-03-15 14:20:18 UTC | +00:01:43 | agent:
  [error_retry]
  失败原因：未处理 status=pending 时 data 字段为 null 的情况
  修复方案：在使用返回值前检查 status 字段，null 时跳过迭代

turn_7 | 2024-03-15 14:22:44 UTC | +00:04:09 | agent:
  [code_output]
  write_file(src/api.py) →
    class HttpClient:
      def request(self, method, url, **kwargs):
        resp = requests.request(method, url, **kwargs)
        if resp.json().get("status") == "pending":
          return None
        return resp.json().get("data")
    ...（150行）

# ============ WORK END ============
```

---

### WORK 区：场景二——触发过一次压缩（中期状态）

turn_1 到 turn_47 已被压缩，由唯一的 COMPACTION TAG 替代，turn_48 起正常追加。

```
# ============ WORK BEGIN ============

[COMPACTION @turn_47]
  timestamp:   2024-03-15 15:42:03 UTC
  elapsed:     +01:23:18
  decision_by: agent
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_1-47
  files:       [src/api.py, src/auth.py, config.json]
  tools:       [read_file, write_file, run_code]
  turns:       turn_1 - turn_47
  constraints: [
    { "key": "api.api_x.status_pending_data", "desc": "返回 status=pending 时 data 字段为 null", "turn": 5,  "type": "api_behavior" },
    { "key": "env.api_key",                   "desc": "API_KEY 在 turn_31 轮换",                "turn": 31, "type": "env_config"   }
  ]
  summary:
    [human_dialogue turn_1]  /sessions/abc123/work/log/turns.jsonl @turn_1-47
      用户要求重构 src/api.py，统一封装 HTTP 调用
    [human_dialogue turn_33] /sessions/abc123/work/log/turns.jsonl @turn_1-47
      用户确认 API_KEY 轮换，要求更新认证逻辑
    [code_output turn_7]     /sessions/abc123/work/log/turns.jsonl @turn_1-47
      HttpClient 类，封装 12 个 HTTP 调用，pending 状态返回 None
    [code_output turn_38]    /sessions/abc123/work/log/turns.jsonl @turn_1-47
      src/auth.py token 刷新逻辑，过期时自动重试一次
    [error_retry turn_5-6]
      排除路径：data 为空数组 → 不是；status 字段不存在 → 不是
      根因：status=pending 时 data 字段为 null
      解法：使用前检查 status，null 时跳过迭代
    完成 HttpClient 封装，完成 auth token 刷新逻辑。
    turn_31 发现 API_KEY 已轮换。待处理：src/db.py。

turn_48 | 2024-03-15 15:42:15 UTC | +01:23:30 | human:
  [human_dialogue]
  cache 模块先不动，先处理 src/db.py

turn_49 | 2024-03-15 15:42:20 UTC | +01:23:35 | agent:
  [reasoning_chain]
  转向 src/db.py，需要先了解当前数据库连接方式

turn_50 | 2024-03-15 15:42:25 UTC | +01:23:40 | agent:
  [tool_result]
  read_file(src/db.py) →
    conn = sqlite3.connect("prod.db")
    ...（80行）

# ============ WORK END ============
```

---

### WORK 区：场景三——触发过两次压缩（后期状态）

整体压缩后，context 中永远只有一个 COMPACTION TAG，旧 TAG 全部清空，constraints 继承合并。

```
# ============ WORK BEGIN ============

[COMPACTION @turn_103]
  timestamp:   2024-03-15 17:08:44 UTC
  elapsed:     +02:50:09
  decision_by: agent
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_1-47
               /sessions/abc123/work/log/turns.jsonl @turn_48-103
  files:       [src/api.py, src/auth.py, config.json, src/db.py, src/cache.py, schema.sql]
  tools:       [read_file, write_file, run_code, query_db]
  turns:       turn_1 - turn_103
  constraints: [
    { "key": "api.api_x.status_pending_data",  "desc": "返回 status=pending 时 data 字段为 null",            "turn": 5,  "type": "api_behavior"  },
    { "key": "env.api_key",                    "desc": "API_KEY 在 turn_31 轮换",                            "turn": 31, "type": "env_config"    },
    { "key": "db.users.email_verified",        "desc": "prod.db 的 users 表在 turn_67 新增了 email_verified 字段", "turn": 67, "type": "db_state" },
    { "key": "tool.query_db.uncommitted_read", "desc": "事务未提交时返回旧数据，需手动 commit",               "turn": 89, "type": "tool_behavior" }
  ]
  summary:
    [human_dialogue turn_1]   /sessions/abc123/work/log/turns.jsonl @turn_1-47
      用户要求重构 src/api.py，统一封装 HTTP 调用
    [human_dialogue turn_48]  /sessions/abc123/work/log/turns.jsonl @turn_48-103
      用户要求转向处理 src/db.py，cache 模块暂缓
    [code_output turn_7]      /sessions/abc123/work/log/turns.jsonl @turn_1-47
      HttpClient 类，封装 12 个 HTTP 调用，pending 状态返回 None
    [code_output turn_38]     /sessions/abc123/work/log/turns.jsonl @turn_1-47
      src/auth.py token 刷新逻辑，过期时自动重试一次
    [code_output turn_78]     /sessions/abc123/work/log/turns.jsonl @turn_48-103
      src/db.py 连接池封装，支持事务管理
    [code_output turn_95]     /sessions/abc123/work/log/turns.jsonl @turn_48-103
      src/cache.py Redis 集成，含 email_verified 字段映射
    [error_retry turn_5-6]
      排除路径：data 为空数组 → 不是；status 字段不存在 → 不是
      根因：status=pending 时 data 字段为 null
      解法：使用前检查 status，null 时跳过迭代
    [error_retry turn_85-89]
      排除路径：查询语法正确 → 不是；连接池配置正确 → 不是
      根因：事务未提交时 query_db 返回旧数据
      解法：每次写操作后手动 commit
    完成 HttpClient 封装、auth token 刷新、db 连接池、cache Redis 集成。
    schema.sql 在 turn_67 新增字段，已同步更新。待处理：集成测试。

turn_104 | 2024-03-15 17:09:01 UTC | +02:50:26 | human:
  [human_dialogue]
  开始写集成测试

# ============ WORK END ============
```

---

### WORK 区：场景四——人工触发压缩

当人类主动要求压缩时，`decision_by` 字段记录为 `human`。

```
# ============ WORK BEGIN ============

[COMPACTION @turn_22]
  timestamp:   2024-03-15 14:55:10 UTC
  elapsed:     +00:36:35
  decision_by: human
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_1-22
  files:       [src/api.py]
  tools:       [read_file, write_file]
  turns:       turn_1 - turn_22
  constraints: []
  summary:
    [human_dialogue turn_1]  /sessions/abc123/work/log/turns.jsonl @turn_1-22
      用户要求重构 src/api.py，统一封装 HTTP 调用
    用户主动触发压缩。已完成 src/api.py 初步分析，尚未开始重构。

turn_23 | 2024-03-15 14:55:22 UTC | +00:36:47 | human:
  [human_dialogue]
  好，继续重构

# ============ WORK END ============
```

---

### WORK 区：场景五——局部压缩（stable_work + dynamic_work）

turn_1 到 turn_15 是已有阶段性结论的 stable_work（HttpClient 封装完成）。turn_16 到 turn_23 是一段批量 query_db 的 dynamic_work，LLM 判断结论已明确、中间过程无独立价值，触发局部压缩，替换为 PARTIAL_COMPACTION TAG。turn_24 起正常追加新的 dynamic_work。

```
# ============ WORK BEGIN ============

turn_1 | 2024-03-15 14:18:35 UTC | +00:00:00 | human:
  [human_dialogue]
  帮我重构 src/api.py，把所有 HTTP 调用统一封装

turn_2 | 2024-03-15 14:18:47 UTC | +00:00:12 | agent:
  [reasoning_chain]
  需要先读取 src/api.py 的内容，了解当前结构再决定封装方式

（... turn_3 到 turn_14 省略，包含 read_file、error_retry、write_file 等 ...）

turn_15 | 2024-03-15 14:22:44 UTC | +00:04:09 | agent:
  [code_output]
  write_file(src/api.py) →
    class HttpClient: ...（150行）

[PARTIAL_COMPACTION @turn_16-23]
  timestamp:   2024-03-15 14:35:10 UTC
  elapsed:     +00:16:35
  decision_by: agent
  archived:    /sessions/abc123/work/log/turns.jsonl @turn_16-23
  tools:       [query_db]
  turns:       turn_16 - turn_23
  summary:
    批量查询 users 表、orders 表、products 表，确认三张表的行数和字段结构。
    users: 1823 条，orders: 4201 条，products: 312 条。
    无异常字段，schema 与预期一致。结果已用于 turn_24 的数据迁移计划。

turn_24 | 2024-03-15 14:35:22 UTC | +00:16:47 | agent:
  [reasoning_chain]
  三张表数据量确认，开始规划数据迁移脚本，优先处理 orders 表的外键约束

turn_25 | 2024-03-15 14:36:01 UTC | +00:17:26 | agent:
  [tool_result]
  query_db(SELECT * FROM orders LIMIT 5) →
    [{"id": 1, "user_id": 42, "product_id": 7, ...}, ...]

# ============ WORK END ============
```

stable_work（turn_1 到 turn_15）原文保留在 context 中，PARTIAL_COMPACTION TAG 插入其后，替代该次被压缩的 dynamic_work 原文。后续如果又出现一段新的低价值 dynamic_work，可以继续生成新的 PARTIAL_COMPACTION TAG，而不用回写旧 tag。等到下次整体压缩时，stable_work + 多个 PARTIAL_COMPACTION TAG + 中间保留的 raw work + 最新 dynamic_work 一起统一处理，输出唯一的 COMPACTION TAG。

---

### 字段说明汇总

**Turn 头部格式：**
```
turn_N | 绝对时间戳 UTC | 相对时间（距 window 开始）| 发起对象（human/agent）:
```

**COMPACTION TAG 字段：**

| 字段 | 含义 |
|-----|-----|
| `timestamp` | 压缩发生的绝对时间（UTC）|
| `elapsed` | 距 window 开始的相对时间 |
| `decision_by` | `agent`（自动触发）或 `human`（人工触发）|
| `archived` | 原文归档引用，格式为 `log/turns.jsonl @turn_N-M`，整体压缩后可能有多段 |
| `files` | 本次压缩覆盖的所有文件路径列表（客观枚举）|
| `tools` | 本次压缩覆盖的所有工具名列表（客观枚举）|
| `turns` | 本次压缩覆盖的 turn 范围 |
| `constraints` | 从 tool_result 中提取的外部状态事实，结构化格式，跨 TAG 合并，字段：key / desc / turn / type |
| `summary` | 语义摘要，human_dialogue 和 code_output 附精确路径索引，error_retry 使用三段结构 |

**PARTIAL_COMPACTION TAG 字段：**

| 字段 | 含义 |
|-----|-----|
| `timestamp` | 局部压缩发生的绝对时间（UTC）|
| `elapsed` | 距 window 开始的相对时间 |
| `decision_by` | 固定为 `agent` |
| `archived` | 原文归档引用，格式为 `log/turns.jsonl @turn_N-M` |
| `tools` | 本次压缩覆盖的工具名列表（客观枚举）|
| `turns` | 被压缩的 dynamic_work turn 范围 |
| `summary` | 阶段性结论摘要，不含 constraints（等待下次整体压缩统一提取）|

**constraints 来源类型标记：**

| type | 含义 | 验证策略 | 淘汰规则 |
|------|------|---------|---------|
| `api_behavior` | 外部 API 返回值特征 | 每次使用前验证 | 相同 key 保留最新 |
| `db_state` | 文件/数据库实际状态 | 每次使用前验证 | 相同 key 保留最新 |
| `env_config` | 环境变量/配置实际值 | 每次使用前验证 | 相同 key 保留最新 |
| `tool_behavior` | 工具实际行为特征 | 同一 window 内信任，跨 window 验证 | 永不淘汰 |
| `protocol` | 协议/标准定义 | 永久信任，不验证 | 永不淘汰 |

**内容类型（type）：**

| type | 含义 |
|-----|-----|
| `human_dialogue` | 人类发出的消息 |
| `reasoning_chain` | agent 的推理过程（含工具调用意图和参数）|
| `tool_result` | 工具返回的数据 |
| `code_output` | 写入文件的代码内容 |
| `error_retry` | 排除路径 + 根因 + 解法（三段结构，保持绑定，不拆分）|

**超参数列表（人类配置）：**

| 超参数 | 推荐值 | 含义 |
|-------|-------|-----|
| `work_ratio 软阈值` | 0.6（可调范围 0.5-0.8）| LLM 主动压缩决策的参考信号，非强制触发 |
| `work_ratio 强制阈值` | 0.85（可调范围 0.8-0.9）| 硬兜底触发线，不依赖 LLM 判断 |
| `constraints_token_limit` | 10k token（约 300 条）| COMPACTION TAG 中 constraints 字段的总 token 上限 |
| `summary_token_limit` | 人类实践确定 | persistent/summary.jsonl 的总 token 上限 |
| `log_turn_limit` | 人类实践确定 | log/turns.jsonl 超出后归档冷存储，不参与热路径 |

---

## 贯穿始终的设计哲学

> **尽可能简单，但不能更简单。底线是：所有压缩可审计，所有遗忘有据可查，所有决策有责任归属。**

两层结构，单一真相源。模型的历史不是被悄悄删除的，而是被显式地归档、标记、索引——它知道自己的历史在哪里被编辑过，也知道去哪里找回来，也知道是谁做的决定。

---

## 实现补充：Workspace Retrieval 与原生命令边界

关于“retrieve 时是否应该直接让 LLM 写 bash，以便更好利用 `grep`、`glob` 等原生命令”，当前实现结论如下：

- 方向上是对的：working directory 检索确实应该尽量利用本机原生命令，例如 `rg --files`、`rg -n` 这类能力，而不是只靠模型在长 context 中做模糊回忆。
- 但不应把“任意 bash”直接交给 LLM。对长期 agent 来说，更稳的做法是：由 `agent_server` 暴露**受控的 native retrieval primitives**，服务层在 agent 绑定的 `working directory` 内执行受限的原生命令，并返回结构化结果。

这样做的原因：

1. 保留统一 API：上层仍是 `retrieve` / `workspace-search`，而不是不同 backend、不同模型各自生成不同 shell。
2. 保留安全边界：LLM 不直接获得任意 shell 注入能力，只能通过服务层提供的受控检索面访问工作目录。
3. 保留可审计性：检索行为仍属于 `agent_server` 语义边界，可以和 clarification、turn log、compaction tag 放在同一套审计链里。
4. 保留跨 backend 一致性：本地模型、第三方模型、不同 backend 切换时，上层接口与返回结构不变。
5. 仍然获得原生命令优势：底层直接调用 `rg`，因此可以充分利用 grep/glob 类工具的速度和准确性。

因此，推荐路线不是：

- `LLM -> 自由生成 bash -> 直接执行`

而是：

- `LLM / API -> agent_server retrieval intent -> 受控 native retrieval primitive -> 结构化结果`

当前落地形态可以概括为：

- `retrieve(includeWorkspaceSearch=true)`：在检索链中把 working directory 原生命令检索作为额外层引入
- `workspace-search`：显式的 working directory 检索 API，内部直接调用 `rg --files / rg -n`

这条路线仍然不是最终形态。后续如果继续演进，更合理的方向是把这些 native retrieval primitives 纳入更强的 retrieval planner，由 planner 决定：

- 先查 compaction / persistent / memory
- 还是先查 working directory
- 是否需要进一步回跳 archived turn range
- 如果仍无证据，再进入 `waiting_user / clarification`

补充的 token economics 原则：

- retrieval planner 不应只把这些成本“暴露给人看”，而应在不违背主检索层级的前提下主动利用这些成本信号。
- 对 `mixed` 查询，更合理的默认顺序是先看当前 window 里的 `compaction / partial summary`，再决定是否真的需要 `workspace search`。
- 如果当前 partial/history 层已经足够回答问题，就应优先跳过 workspace search，尽量保持稳定 prefix 与 KV cache 复用。
- 只有当历史层证据不足，或者调用方显式要求包含 workspace search 时，才为该 query 注入 workspace 结果。
