# Hermes Agent 核心设计原则

> 前提假设：Hermes Agent 是一个长期运行、跨平台、带工具执行能力的通用 Agent。它的核心风险不是“能不能调用一次模型”，而是：在多轮会话、多工具、多平台、多模型、多进程状态下，仍然保持上下文稳定、能力边界清晰、状态可恢复、扩展不互相污染。

---

## 第一章 设计原则

### 原则一：Agent Loop 是系统中心

**所有入口最终都应收敛到同一个同步工具调用循环。**

Hermes 的核心不是 CLI、网关、浏览器、终端或某个模型 provider，而是 `AIAgent.run_conversation()` 中的会话循环：

```
user message
    -> 构造稳定 system prompt + 当前 messages + tool schemas
    -> 调用模型
    -> 如果模型返回 tool_calls：执行工具，追加 tool result
    -> 如果模型返回 final content：结束本轮
```

CLI、Gateway、Batch Runner、ACP、RL 环境都应该是这个核心循环的不同外壳，而不是各自实现一套 Agent 语义。

| 设计选择 | Hermes 方向 |
|---------|-------------|
| 新增一个入口 | 复用 `AIAgent` |
| 新增一种平台 | 只做输入输出适配 |
| 新增一种模型 API | 在 adapter / normalize 层兼容 |
| 新增一种工具 | 注册到统一 tool registry |

这条原则让系统有一个明确的“心脏”：调试时先看 agent loop，扩展时尽量不改 agent loop。

---

### 原则二：Prompt Prefix 稳定优先

**system prompt 是高价值缓存前缀，除 context compression 外不应在会话中随意重建。**

Hermes 明确区分两类上下文：

```
稳定前缀：
  - agent identity
  - tool-use guidance
  - platform hints
  - skills index
  - context files
  - memory snapshot
  - tool schemas

动态内容：
  - 最新用户消息
  - 临时 plugin context
  - tool results
  - conversation history
```

稳定前缀在会话第一次构造后会缓存。Gateway 继续同一 session 时，会从 SQLite 中读取上一轮存下来的 system prompt，而不是重新从磁盘加载 memory / skills / config。原因很直接：重建 prefix 会破坏 prompt cache，使成本和延迟急剧上升，也会让模型看到“同一会话中突然变化的系统事实”。

因此：

| 内容类型 | 注入位置 |
|---------|---------|
| session 初始身份、工具规则、skills index | system prompt |
| plugin 的临时上下文 | 当前 user message |
| slash skill 的临时内容 | user message |
| memory 的新写入 | 后续新 session 或 compression 后再进入 system prompt |
| context compression summary | conversation history 中的 reference-only message |

核心判断标准：**会影响 prefix cache 的内容，必须足够稳定；不稳定但有用的内容，放到 user turn。**

---

### 原则三：工具能力只有一个真相源

**工具的 schema、handler、toolset、可用性检查必须从 `tools.registry` 派生。**

工具系统的依赖方向是：

```
tools/registry.py
    ↑
tools/*.py  顶层 registry.register()
    ↑
model_tools.py  discover + filter + dispatch
    ↑
run_agent.py / cli.py / gateway / batch_runner
```

每个工具文件在 import 时自注册。`model_tools.py` 只负责发现、过滤、兼容旧接口和分发，不再维护一份平行的大字典。

这解决三个问题：

1. **避免多真相源**：schema 和 handler 不会在不同文件中分叉。
2. **避免不可用工具幻觉**：最终暴露给模型的 schema 只包含 check_fn 通过的工具。
3. **支持动态能力**：MCP、plugins 可以进入同一个 registry，而不绕过 toolset 过滤。

特别重要的细节：schema 描述不能静态引用另一个可能不可用的工具。需要跨工具提示时，应在 `get_tool_definitions()` 中根据实际可用工具动态改写 schema。

---

### 原则四：Toolset 是能力边界，不是 UI 装饰

**模型能做什么，由 toolset 解析后的工具集合决定。**

Hermes 不是把所有工具无条件塞给模型，而是用 toolset 组织能力：

```
toolset name
    -> includes other toolsets
    -> resolves to concrete tool names
    -> registry filters by availability
    -> model receives final schemas
```

这让同一个 Agent 可以在不同场景下有不同能力边界：

| 场景 | 能力形态 |
|-----|---------|
| 普通 CLI | full Hermes core tools |
| 安全模式 | 无 terminal 的 safe toolset |
| Gateway | 消息平台可用的核心工具 |
| Browser 场景 | browser + 必要 web 工具 |
| Code execution | 只允许当前 session 中真实可用的 sandbox tools |

原则是：**工具暴露必须与运行环境、配置、密钥、平台共同决定，而不是写死在 prompt 里。**

---

### 原则五：平台只是适配层

**CLI 和 Gateway 的差异应停留在交互、持久化和权限体验层，不应复制 Agent 逻辑。**

Hermes 同时支持终端 CLI 和多个消息平台。它们差异很大：

| 维度 | CLI | Gateway |
|-----|-----|---------|
| 输入 | prompt_toolkit REPL | Telegram / Discord / Slack / etc. event |
| 输出 | Rich / spinner / status bar | 平台消息、线程、后台通知 |
| 生命周期 | 单进程交互 | 长期 daemon，多 session cache |
| 权限确认 | 本地 prompt | `/approve` / `/deny` |
| cwd | 当前目录 | `terminal.cwd` 或 home |

但这些差异不应该进入工具调用核心。Gateway 的职责是：

```
platform event
    -> normalize sender/channel/session
    -> load session history
    -> acquire/create AIAgent
    -> run_conversation()
    -> deliver streamed/final output
```

CLI 的职责是：

```
terminal input
    -> slash command dispatch 或 user prompt
    -> run_conversation()
    -> render spinner/tool feed/final response
```

判断标准：如果一段逻辑和“模型下一步怎么思考、怎么调用工具”有关，应靠近 `run_agent.py`；如果只和“用户在哪个平台看到什么”有关，应留在 CLI/Gateway adapter。

---

### 原则六：命令定义集中化

**slash command 的名称、别名、分类、help、gateway 暴露规则必须来自 `COMMAND_REGISTRY`。**

Hermes 的 slash command 不是散落在 CLI 和 Gateway 中各写一遍。`hermes_cli/commands.py` 中的 `CommandDef` 是单一源头：

```
COMMAND_REGISTRY
    -> CLI autocomplete
    -> CLI help
    -> Gateway known commands
    -> Gateway help
    -> Telegram BotCommand menu
    -> Slack subcommand routing
```

新增 alias 只改 `aliases`。新增命令先加 `CommandDef`，再分别补 CLI/Gateway handler。

这条原则避免“CLI 有这个命令、Telegram help 没有、Slack alias 不生效”的漂移。

---

### 原则七：状态必须持久、可搜索、可分叉

**长期 Agent 不能依赖进程内记忆；会话状态必须进入 SQLite，并能被检索。**

Hermes 的会话状态由 `hermes_state.SessionDB` 管理：

```
sessions
messages
messages_fts
```

核心选择：

| 选择 | 原因 |
|-----|-----|
| SQLite | 本地部署简单，适合单机多进程 |
| WAL | Gateway/CLI 并发读写更稳 |
| FTS5 | 支持 `session_search` 召回历史 |
| parent_session_id | compression / branch 后保留链路 |
| system_prompt snapshot | 保持继续会话时 prefix 不变 |
| per-message reasoning/tool_calls | 保留模型轨迹和工具上下文 |

内存里的 `AIAgent` 可以被 Gateway LRU cache 淘汰，但 session 不能丢。恢复能力来自数据库，而不是来自 Python 对象。

---

### 原则八：压缩是恢复机制，不是删除机制

**context compression 的目标是延长会话寿命，同时保留任务可继续性。**

Hermes 的压缩策略是：

```
估算/读取 token 压力
    -> 保护 system/head/tail
    -> 先剪裁旧 tool result 的大输出
    -> 用辅助模型总结中间 turns
    -> summary 标记为 reference-only
    -> 必要时拆出 parent_session_id 链
```

summary 的语义非常关键：它是“前一窗口交接给后一窗口的参考资料”，不是新的用户指令。文案中明确要求模型不要执行 summary 中提到的旧请求，只响应 summary 之后的新消息。

压缩的原则：

| 原则 | 说明 |
|-----|-----|
| 保护头部 | system prompt 和早期关键上下文不轻易丢 |
| 保护尾部 | 最近工作状态最可能影响下一步 |
| 先便宜后昂贵 | 先本地 pruning，再 LLM summarization |
| 摘要有结构 | resolved / pending / active task / remaining work |
| 可链式恢复 | parent session 保留历史关系 |

---

### 原则九：执行环境必须显式

**工具在哪执行，是 Agent 行为的一部分，不是实现细节。**

Hermes 的 terminal 工具支持 local、docker、ssh、modal、singularity、daytona 等后端。执行环境由配置和 env 共同决定，Gateway 还会把 config.yaml 中的 terminal 设置桥接成 `TERMINAL_*` 环境变量。

必须显式处理的事实包括：

| 事实 | 影响 |
|-----|-----|
| backend | 命令在本机、容器、云沙箱还是远端执行 |
| cwd | 文件、git、测试、构建的默认位置 |
| lifetime | 前台超时、后台进程、环境清理 |
| approval | 危险命令是否需要确认 |
| persistence | 文件系统是否跨 sandbox 重建保留 |
| subprocess HOME | profile/container 下工具配置写到哪里 |

原则是：**不要让模型或用户误以为“能访问 UI 上的文件”就等于“工具在同一台机器执行”。** 终端、文件、browser、gateway 的运行边界必须清楚。

---

### 原则十：危险动作需要可中断、可确认、可回收

**工具执行不是纯函数；对外部世界有副作用的工具必须有护栏。**

Hermes 对工具执行做了几类保护：

| 风险 | 机制 |
|-----|-----|
| 危险 shell 命令 | `tools.approval` + CLI/Gateway approval callback |
| 长时间命令 | foreground timeout + background process registry |
| 用户中断 | thread-scoped interrupt signal |
| 并行工具冲突 | 只并行 read-only 或路径独立工具 |
| 模型乱造工具名 | auto-repair + invalid-tool retry |
| 模型输出坏 JSON | retry / tool error recovery |
| 大工具输出撑爆 context | tool result pruning / persistent storage |

这条原则背后的判断是：Agent 的工具层必须假设模型会偶尔犯错、网络会断、用户会中断、平台会重试。系统应尽量把错误变成可恢复状态，而不是崩溃或沉默失败。

---

### 原则十一：Profile 隔离是路径设计的底线

**所有 Hermes 状态路径必须经过 `get_hermes_home()`；所有展示路径用 `display_hermes_home()`。**

Hermes 支持 profiles：每个 profile 有独立的 config、env、skills、sessions、gateway 状态、memory 等。路径规则是：

```
真实读写路径：get_hermes_home()
用户展示路径：display_hermes_home()
profile 列表根：Path.home() / ".hermes" / "profiles"
```

禁止在读写状态时硬编码：

```
Path.home() / ".hermes"
"~/.hermes"
```

原因不是代码风格，而是隔离性：一旦某个工具或配置写回默认 `~/.hermes`，profile 就会互相污染，Gateway 也可能拿错 token、session 或 memory。

---

### 原则十二：自进化是受控学习闭环

**Hermes 的“自进化”不是在线改写核心代码，而是把运行经验沉淀为可审计、可复用、可召回的外部知识。**

Hermes 不把“进化”理解为模型权重更新，也不让 agent 在运行中随意改变 system prompt。它采用更工程化的闭环：

```
执行任务
    -> 观察用户偏好、环境事实、工具习惯、失败修复路径
    -> 判断哪些信息值得长期保存
    -> 写入 memory / skill / session history
    -> 后续会话通过 memory / skills / session_search 召回
    -> 发现过期或错误时 patch skill / update memory
```

这让 Hermes 可以越来越贴合用户和环境，但不会把一次性噪声永久写入核心行为。

| 学到的东西 | 存放位置 | 例子 |
|-----------|---------|------|
| 用户长期偏好 | memory / USER.md | 用户喜欢简洁回答、默认使用某个工作区 |
| 稳定环境事实 | memory | 某 profile 的部署方式、常用服务地址 |
| 可复用工作流 | skill | 某类项目的测试/发布/排障步骤 |
| 当前任务轨迹 | SessionDB | 本轮做过什么、失败过什么、工具结果是什么 |
| 历史使用模式 | insights | 常用模型、工具调用、平台和成本趋势 |
| 压缩前重要信息 | memory provider `on_pre_compress()` | 长会话中即将离开窗口的洞察 |

自进化有三条边界：

1. **不污染 prefix**：新经验不能随意改当前 session 的 system prompt，避免破坏 prompt cache 和会话一致性。
2. **不混淆层级**：偏好进 memory，流程进 skill，过程进 session，一次性输出不进长期记忆。
3. **可修正**：skill 发现过期就 patch；memory 发现错误就更新；session 原文仍可通过 FTS 追溯。

因此，Hermes 的自进化更像“外部认知层”的增长：它让 agent 的行为越来越本地化、熟悉用户、熟悉项目，但核心 loop、tool boundary 和平台边界仍保持稳定。

---

### 原则十三：扩展点要收敛，不要穿透核心

**plugins、MCP、skills、memory providers 都应作为受控扩展点进入系统。**

Hermes 有多种扩展方式：

| 扩展类型 | 进入方式 |
|---------|---------|
| built-in tool | `tools/*.py` 自注册 |
| MCP tool | `tools.mcp_tool.discover_mcp_tools()` 注册 |
| plugin tool | plugin discovery 后进入 registry/toolset |
| skill | skills index + `skill_view/skill_manage` |
| memory provider | `MemoryManager` prefetch / save hooks |
| platform | gateway adapter |
| slash command | `COMMAND_REGISTRY` + handler |

扩展原则是：可以增强系统，但不要绕过核心边界。比如 plugin 的 `pre_llm_call` 可以给当前 user message 注入临时 context，但不能随意改 system prompt；MCP 工具可以注册到 registry，但不能 shadow built-in tool；skills 可以被注入为用户消息，但不破坏 prompt cache。

---

## 第二章 核心架构展开

### 1. 运行时主链路

```
CLI / Gateway / Batch / ACP / RL
    -> 构造或恢复 AIAgent
    -> 加载 session history
    -> AIAgent.run_conversation()
        -> 获取/复用 system prompt
        -> 获取 tool schemas
        -> preflight context compression
        -> 模型调用
        -> tool call validation
        -> tool execution
        -> incremental persistence
        -> final response
```

重要边界：

| 模块 | 责任 |
|-----|-----|
| `run_agent.py` | 会话循环、模型调用、工具执行编排、压缩触发、持久化协调 |
| `model_tools.py` | 工具发现、toolset 过滤、schema 动态修正、dispatch |
| `tools/registry.py` | 工具注册和可用性真相源 |
| `agent/prompt_builder.py` | system prompt 组装 |
| `agent/context_compressor.py` | 长上下文压缩 |
| `hermes_state.py` | SQLite session store |
| `cli.py` | 终端交互外壳 |
| `gateway/run.py` | 消息平台 daemon 外壳 |

---

### 2. 工具执行链路

```
模型返回 tool_calls
    -> 校验工具名是否在 valid_tool_names
    -> 修复常见工具名错误
    -> 校验/修复 JSON arguments
    -> agent-level tools 特殊处理
    -> registry.dispatch()
    -> handler 返回 JSON string
    -> tool result 追加到 messages
    -> 继续下一次模型调用
```

有些工具不直接由 `model_tools.handle_function_call()` 执行，而是在 agent loop 中拦截，因为它们需要 agent 级状态：

```
todo
memory
session_search
delegate_task
```

并行工具执行是保守启用的：只有 read-only 或路径独立工具适合并行；`clarify` 这种交互工具永不并行。

---

### 3. Context 与 Memory 的分层

```
system prompt snapshot
    + memory context
    + skills/context files
    + platform/model guidance
conversation messages
    + current user message
    + ephemeral plugin context
    + tool calls/results
external memory providers
    + per-turn prefetch cache
session_search
    + SQLite FTS 历史召回
```

分层原则：

| 信息 | 存放位置 |
|-----|---------|
| 长期偏好、稳定事实 | memory |
| 当前任务过程 | session messages |
| 过去会话检索 | session_search / FTS |
| 可复用工作流 | skill |
| 临时平台上下文 | user message 注入 |
| 大型工具输出 | 压缩、裁剪或持久化引用 |

Memory 不应保存“本轮任务进度”；任务进度属于 session。Skill 不应保存一次性事实；skill 保存可复用过程。

---

### 4. 自进化闭环

Hermes 的自进化由多个小机制组合而成，而不是一个神秘的“大脑模块”：

```
Memory guidance
    -> 提醒模型保存长期有用事实
Skill guidance
    -> 复杂任务后沉淀可复用流程
SessionDB + FTS
    -> 保留历史轨迹，可搜索召回
MemoryManager
    -> 内置记忆 + 至多一个外部 memory provider
InsightsEngine
    -> 从历史 session 统计使用模式
ContextCompressor hooks
    -> 压缩前给 memory provider 提取洞察的机会
```

这个闭环的关键不是“自动保存越多越好”，而是分类保存：

| 阶段 | 机制 | 目标 |
|-----|------|------|
| 观察 | tool results / session messages | 保留真实执行轨迹 |
| 归纳 | LLM 判断 + prompt guidance | 区分长期事实、流程、临时状态 |
| 固化 | memory / skill_manage | 把可复用知识写入外部存储 |
| 召回 | memory prefetch / skills index / session_search | 让未来任务少重复探索 |
| 修正 | skill patch / memory update | 发现经验过期时主动更新 |

这也是为什么 Hermes 强调 skill 和 memory 的边界：如果所有东西都进 memory，长期记忆会噪声化；如果所有经验都只留在 session，未来又无法稳定复用。

---

### 5. 配置与环境加载

Hermes 的配置有三层：

```
HERMES_HOME/config.yaml  -> 普通设置
HERMES_HOME/.env         -> API keys / secrets
环境变量                 -> 运行时覆盖和部署集成
```

CLI 和 Gateway 的加载路径不完全相同，但共同原则是：

1. `HERMES_HOME` 决定状态根目录。
2. `.env` 用于 secrets。
3. `config.yaml` 是用户可编辑的主配置。
4. Gateway 会把部分 config 桥接成 env var，方便底层工具复用。
5. secrets 不应写入 session、日志、prompt 或普通配置展示。

---

### 6. CLI / Gateway 共享与分离

共享：

```
AIAgent
tool registry
command registry
SessionDB
config conventions
skills/memory/toolsets
```

分离：

```
CLI:
  - prompt_toolkit input
  - Rich display
  - local callbacks
  - current cwd

Gateway:
  - platform adapters
  - per-channel sessions
  - long-lived agent cache
  - background process notifications
  - approval commands
```

新平台优先实现 adapter，不改 agent loop。新 UI 优先消费现有 command/session/tool abstractions，不复制业务逻辑。

---

## 第三章 修改代码时的判断规则

### 添加工具

应满足：

1. 新建 `tools/your_tool.py`。
2. 顶层调用 `registry.register()`。
3. handler 返回 JSON string。
4. 加入合适 toolset。
5. schema 不静态引用不可保证存在的其他工具。
6. 读写 Hermes 状态时使用 `get_hermes_home()`。

不要直接在 `run_agent.py` 里写具体工具逻辑，除非它确实需要 agent-level state。

---

### 添加 slash command

应满足：

1. 先加 `COMMAND_REGISTRY`。
2. CLI 需要则加 `HermesCLI.process_command()` handler。
3. Gateway 需要则加 `gateway/run.py` handler。
4. alias 只写在 `CommandDef.aliases`。

不要在 Telegram/Slack/CLI help 中手写另一份命令列表。

---

### 添加持久状态

优先级：

1. 能放入现有 SQLite session schema 的，放 SQLite。
2. profile 级状态放 `get_hermes_home()` 下。
3. 大型 artifact 放 profile 内专门目录，并在 session 中存引用。
4. 用户可编辑配置放 `config.yaml`。
5. secret 放 `.env` 或平台 credential store。

不要写真实 `~/.hermes`，不要把 profile 状态写到项目目录，测试也不要碰用户真实 home。

---

### 修改 prompt / memory / context

先问三个问题：

1. 这个内容是否必须进入 system prompt？
2. 它是否会在同一 session 中变化？
3. 它是否会破坏 prompt cache 或让历史上下文语义漂移？

如果内容是动态的，优先注入 user message 或 tool result。如果必须修改 system prompt，需要理解它会影响 continuing session、Gateway cache、Anthropic prompt caching 和 compression 之后的重建。

---

### 修改自进化机制

先判断你要保存的是哪类经验：

| 经验类型 | 应写入 |
|---------|--------|
| 用户长期偏好 | memory |
| 环境稳定事实 | memory |
| 可复用操作流程 | skill |
| 一次任务的执行轨迹 | session messages |
| 大量历史统计 | insights 查询，不写入 prompt |
| 外部知识库召回 | memory provider prefetch |

不要让 agent 把“刚完成了某任务”这类过程日志写入长期 memory；也不要把只对当前项目有效的流程写成全局 skill，除非 skill frontmatter 或内容明确限定适用条件。

---

### 修改工具执行 / 并发

先判断工具是否：

| 问题 | 如果答案是是 |
|-----|-------------|
| 会询问用户？ | 不并行 |
| 会写文件？ | 只允许路径不冲突时并行 |
| 会改进程/环境状态？ | 默认顺序执行 |
| 只读且无共享状态？ | 可加入并行安全列表 |
| 输出可能很大？ | 设置 result size / pruning 策略 |

工具并发不是性能装饰，它会改变副作用顺序。默认保守。

---

## 第四章 最快理解地图

如果只读 8 个文件，建议顺序如下：

| 顺序 | 文件 | 看什么 |
|-----|------|--------|
| 1 | `run_agent.py` | `AIAgent.run_conversation()` 主循环 |
| 2 | `model_tools.py` | tool discovery/filter/dispatch |
| 3 | `tools/registry.py` | 工具注册模型 |
| 4 | `toolsets.py` | 能力边界如何组合 |
| 5 | `agent/prompt_builder.py` | system prompt 分层 |
| 6 | `agent/context_compressor.py` | 长上下文如何续命 |
| 7 | `hermes_state.py` | session 如何持久和检索 |
| 8 | `hermes_cli/commands.py` | slash command 单一真相源 |

再按需要看：

| 方向 | 文件 |
|-----|------|
| CLI 交互 | `cli.py` |
| Gateway | `gateway/run.py`, `gateway/platforms/base.py` |
| Terminal 后端 | `tools/terminal_tool.py`, `tools/environments/*` |
| 配置 | `hermes_cli/config.py`, `hermes_constants.py` |
| Skills | `agent/skill_commands.py`, `agent/skill_utils.py` |
| Memory | `agent/memory_manager.py`, `agent/memory_provider.py` |
| 自进化/洞察 | `agent/insights.py`, `tools/skills_tool.py` |
| MCP | `tools/mcp_tool.py` |
| Plugins | `hermes_cli/plugins.py` |

---

## 第五章 一句话架构

Hermes Agent 的核心设计是：

**用一个稳定、可缓存的 Agent Loop 统领所有入口；用 registry/toolset 把工具能力变成可裁剪边界；用 SQLite/FTS/profile-safe paths 保证长期状态可恢复、可搜索、可隔离；用 memory/skills/session_search/insights 构成受控自进化闭环；用 CLI/Gateway/Plugins/MCP 作为受控适配层扩展系统，而不让扩展穿透核心循环。**
