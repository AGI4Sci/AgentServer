# Backend Runtime Guide

这个目录存放 `openteam-studio-run` 自带的 5 个 backend，以及它们在 runtime 层的项目内启动约定。

目标有两个：
- 上层统一：Web/API/supervisor 统一通过 runtime 接口派发任务，不关心 backend 内部差异。
- 底层闭环：backend 尽量优先使用项目内自带的二进制或 launcher，不依赖系统全局安装。

当前额外约束：
- 上层只认 backend id 和统一 runtime 链路，不再在多处分别硬编码 `openteam_*` 名字。
- 缺少目标执行事实时必须先向用户澄清，不允许 coordinator/runtime 自行猜测目标项目、目标页面或目标端口。

## 目录概览

- `codex/`
- `claude_code/`
- `claude_code_rust/`
- `openclaw/`
- `zeroclaw/`
- `bin/`

其中 `bin/` 是项目内固定产物目录，推荐放下面这些名字：

- `openteam_codex`
- `openteam_claude_code`
- `openteam_claude_code_rust`
- `openteam_openclaw`
- `openteam_zeroclaw`

这些名字故意与系统可能安装的 `codex`、`openclaw`、`zeroclaw` 区分开，避免 PATH 冲突。

## 上层 API

日常调试和统一调用，优先使用这些接口：

- `POST /api/runtime/runs`
  - 用途：统一发起一次 backend runtime 任务。
  - 典型请求字段：
    - `teamId`
    - `agentId`
    - `backend`
    - `task`
    - `cwd`
    - 可选：`model` / `modelName` / `modelProvider`

- `GET /api/runtime/diagnostics`
  - 用途：查看 supervisor、session、snapshot、contract、restore 等 runtime 诊断信息。

- `GET /api/team/:teamId/runtime/sessions`
  - 用途：查看某个 team 当前的常驻 session。

- `GET /health`
  - 用途：Web 主进程健康检查。

## 统一事件语义

当前 runtime 对上层已经固定了一组尽量 backend 无关的流式事件语义：

- `status`
- `text-delta`
- `tool-call`
- `tool-result`
- `permission-request`
- `error`
- `result`

所有标准 runtime 事件都应携带：

- `protocolVersion: "v1"`
- 可选 `raw`
  - 仅用于调试和兼容原生协议
  - 上层 UI/API 不应依赖 `raw` 做业务判断

其中和工具执行最相关的是三层：

1. `tool-call`
   - 表示 backend 或共享 fallback 已经真实触发了某个工具
   - 典型字段：`toolName`、`detail`

2. `tool-result`
   - 表示工具已经真实产生了可观察结果
   - 典型字段：`toolName`、`detail`、`output`
   - 约定：
     - `output` 优先表示“工具结果正文”
     - `detail` 可以作为兼容字段或结果摘要

3. `result`
   - 表示整次 runtime run 的最终输出

`error` 用于表达 backend adapter、launcher、协议解析、工具 fallback 等 runtime 层失败。失败 run 仍应尽量发出最终 `result`，但上层可以优先用 `error` 事件展示可观察错误。

这三层语义的目标是：

- 上层 API 和 `agent_server` 只依赖统一事件，不按 backend 写分支
- backend 内部可以继续保留自己的原生协议
- 原生协议差异尽量在 worker / supervisor 层被吸收

当前真实回归结果是：

- `claude-code / claude-code-rust / codex / openclaw / zeroclaw`
- 在同一条 `POST /api/runtime/runs` 请求形状下
- 都已经能返回 `tool-call + tool-result + result`
- parity smoke 中工具名已对齐为 `list_dir`

内部还会用到：

- `GET http://127.0.0.1:<supervisorPort>/health`
  - supervisor 健康检查

- `POST /codex/v1/responses`
  - supervisor 内部提供的 codex responses 兼容层
  - 这是平台内部桥接接口，不建议上层直接依赖

## 唯一真源

上层调用看到的唯一真源应当是：

1. backend id
   - `codex`
   - `claude-code`
   - `claude-code-rust`
   - `openclaw`
   - `zeroclaw`
2. 统一 runtime 入口
   - `POST /api/runtime/runs`
   - team/chat/router -> runtime worker manager
3. Backend catalog
   - `core/runtime/backend-catalog.ts`
   - 统一记录 backend id、label、family、managed executables、capabilities
4. 项目内 managed launcher 解析
   - `server/runtime/workers/backend-managed-launchers.ts` 只从 backend catalog 读取 executables，再解析到 `server/backend/bin/openteam_*`

也就是说，上层不要再自己区分“这个 backend 该走哪个 openteam_* 文件名”。具体 launcher / binary 名称属于 runtime 层实现细节，由 managed launcher 映射统一维护。

## Backend Contract

新增或重构 backend 时，优先围绕下面这些最小 contract 做：

- `BackendCatalog`
  - 路径：`core/runtime/backend-catalog.ts`
  - 负责：backend id、展示名、family、managed executables、capabilities

- `BackendCapabilities`
  - 当前最小字段：
    - `persistentSession`
    - `permissionRequest`
    - `interrupt`
    - `toolInputStreaming`
    - `nativeToolUse`
    - `managedLauncher`

- `RuntimeEvent`
  - 路径：`server/runtime/session-types.ts`、`server/runtime/team-worker-types.ts`
  - 负责：对上层稳定的 runtime event 语义
  - 当前协议版本：`v1`

- `BackendAdapter`
  - 路径：`server/runtime/backend-adapter-contract.ts`
  - 负责：描述未来 backend adapter 的最小接入面
  - 当前先作为 contract 骨架存在，不要求一次性重写所有 worker

- `AdapterFixtureTest`
  - 路径：`tests/backend-adapter-fixtures.test.ts`
  - 负责：用 backend 原生事件 fixture 锁定 normalized event 语义
  - 当前覆盖：
    - 五个 backend 的 `list_dir` parity 骨架
    - `claude-code` permission request 归一化
    - `claude-code / claude-code-rust / codex / openclaw / zeroclaw` error 到 `error + failed result` 的收口

- `BackendCatalogContractTest`
  - 路径：`tests/backend-catalog-contract.test.ts`
  - 负责：确保 `BACKEND_IDS`、`BACKEND_CATALOG`、managed launcher 解析和 capability 字段保持一致

新增 backend 的推荐步骤：

1. 在 `core/runtime/backend-catalog.ts` 注册 backend id、executables、capabilities。
2. 实现或包装 backend worker/adapter，使输出归一到标准 runtime events。
3. 在 `server/runtime/workers/__fixtures__/<backend>/` 增加至少一个 `list-dir.native.jsonl` 和 `list-dir.expected.json`。
4. 让 adapter fixture test 通过，并确认关键事件骨架至少包含 `tool-call:list_dir -> tool-result:list_dir -> result`。
5. 再补 permission/error fixture，而不是让上层靠 backend 分支兜底。

## 项目内可执行产物

推荐使用项目内自带产物，而不是系统全局命令。

### 构建

先在仓库根目录执行：

```bash
npm run build:backend-binaries
```

这个脚本会尝试：

- 构建 Rust backend release 产物
- 生成 JS backend 的项目内 launcher
- 把最终入口放到 `server/backend/bin/`

### 产物说明

- `openteam_codex`
  - 目标：优先作为 codex app-server 启动入口
  - worker 会优先用它，而不是系统 `codex`

- `openteam_claude_code_rust`
  - 目标：作为 claude-code-rust 的原生可执行入口

- `openteam_zeroclaw`
  - 目标：作为 zeroclaw gateway 的原生可执行入口

- `openteam_claude_code`
  - 目前是项目内 launcher
  - 会定位到当前项目目录下的 `server/backend/claude_code/openteam-runtime.ts`

- `openteam_openclaw`
  - 目前是项目内 launcher
  - 会定位到当前项目目录下的 `server/backend/openclaw/dist/index.js` 或 `scripts/run-node.mjs`

## 可搬运性

`openteam_claude_code` 和 `openteam_openclaw` launcher 不是写死绝对路径，而是根据自身所在目录反推项目根目录。

这意味着：

- 如果你把整个项目目录复制到新位置
- 并把 `server/backend/bin/` 一起复制过去

那么这些 launcher 仍然可以继续使用，只要新目录下的相对结构保持不变。

Rust 产物本身也适合这样随项目目录一起搬运。

不建议只单独拷走 `bin/` 而不带上 backend 源目录/资源目录，因为 launcher 和某些 runtime 资源仍然依赖项目结构。

### 搬目录后要不要重新编译

通常分三种情况：

1. 同一台机器、同一个操作系统和架构，只是把整个项目目录换了位置
   - 通常不需要重新编译
   - `openteam_claude_code` 和 `openteam_openclaw` 会按相对路径自定位
   - Rust 二进制一般也可以直接继续使用

2. 换了机器，但操作系统、CPU 架构、运行时依赖都兼容
   - 往往仍然可以直接试用已有 Rust 二进制
   - 但如果本机系统库、Node/Bun 环境、权限模型不同，建议至少重新跑一次 `npm run build:backend-binaries`

3. 换了操作系统或 CPU 架构
   - 需要重新编译
   - 例如 `macOS arm64 -> Linux x86_64` 这类情况，旧二进制通常不能直接运行

一句话建议：

- 只是“换文件夹”通常不用重编译
- 换机器可以先试，但推荐重新执行一次 `npm run build:backend-binaries`
- 换系统或架构时应视为必须重编译

## worker 启动优先级

当前 runtime worker 的推荐优先级是：

1. 显式环境变量指定的可执行文件
2. `server/backend/bin/openteam_*`
3. backend 自带的本地构建产物
4. 开发态 fallback，例如 `cargo run`、`node --import tsx`、`bun`

这样做的目的是：

- 避免系统 PATH 冲突
- 降低首次冷启动时间
- 让部署与调试行为更稳定

当前实现里，`codex / claude-code / claude-code-rust / openclaw / zeroclaw` 已统一走 managed launcher 映射，不再由各 worker 在多处重复维护不同的 `openteam_*` 名字。

## 常驻服务建议

如果目标是“上层派发任务尽可能快”，真正最有价值的是：

1. 预编译产物
2. supervisor 常驻
3. session 预热

只做“编成二进制”会减少冷启动，但常驻和预热带来的收益通常更大。

因此推荐路线是：

- 先用 `openteam_*` 统一项目内启动入口
- 再让 supervisor / ensureSession / prewarm 优先拉起这些入口做常驻服务
- 最后补启动后预热，把首次工具链握手提前完成

## 环境变量

常用环境变量包括：

- `OPENTEAM_BACKEND_BIN_DIR`
  - 覆盖项目内 backend 产物目录

- `CODEX_EXECUTABLE`
- `OPENTEAM_CLAUDE_CODE_EXECUTABLE`
- `OPENTEAM_CLAUDE_CODE_RUST_EXECUTABLE`
- `ZEROCLAW_EXECUTABLE`

- `LLM_BASE_URL`
- `OPENAI_BASE_URL`
- `LLM_MODEL_NAME`
- `OPENAI_MODEL`
- `OPENAI_API_KEY`
- `OPENTEAM_LOCAL_DEV_TOOL_MAX_STEPS`
  - 控制共享 local tool fallback 的最大工具循环步数
  - 当前默认值为 `20`

这些变量主要用于：

- 指定显式 backend 可执行文件
- 指定默认上游模型地址与模型名

## 注意事项

- `codex` 当前仍需要 supervisor 内的 `/codex/v1/responses` 适配层桥接到默认 `chat/completions`。
- `codex / openclaw / claude-code-rust / zeroclaw` 的 tool-required 路径已经接入共享 `local tool fallback`；当 backend 原生工具链或桥接层不兼容时，runtime 会优先尝试统一兜底，而不是直接让上层分叉到另一条 API。
- `WorkerEvent -> runtime-supervisor -> SessionStreamEvent` 的公共传输链现在会完整保留 `tool-result`；如果出现“五个 backend 都只有 tool-call、没有 tool-result”的情况，优先检查公共转发层，而不应先怀疑每个 backend 都各自坏掉。
- 真实 smoke 里 `/codex/v1/responses` 仍可能间歇返回 `502 Bad Gateway / responseStreamDisconnected`；当前做法是允许 tool-required 任务落到共享 fallback 或由 coordinator 重派，但这不代表 adapter 本身已经完全稳定。
- `claude_code` 和 `openclaw` 当前更适合先走“项目内固定 launcher + 常驻服务”路线，而不是强行一步做到单文件 native binary。
- `apply_patch` 还不是所有 backend 上都稳定成熟的一等能力；当前“能改文件”与“结构化 patch primitive 稳定可用”不能完全等同。
- T001 当前明确要求：如果用户没有提供完整的 `targetProjectPath / targetUrl / targetPort`，系统必须先发澄清消息，再继续派发；不得从 `PROJECT.md`、team 旧事实或控制面默认值里静默补全。
