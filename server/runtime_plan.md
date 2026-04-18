# Runtime / Backend 统一层现状说明

## 目标

当前 OpenTeam 已经从“按具体 runtime 写专用链路”收敛到“统一入口 + backend 参数切换”的结构。

上层代码现在应遵守两个原则：

1. 聊天链路不区分 backend
2. backend 只通过统一 runtime 配置或统一 runtime 调试接口指定

也就是说：

- 正常团队聊天继续走 `POST /api/team/:teamId/chat`
- 团队使用哪个 backend，走 `GET/PUT /api/teams/:teamId/runtime`
- 需要直接调试某个 backend，走 `POST /api/runtime/runs`
- 需要统一排查 daemon / session / provider-model 解析状态，走 `GET /api/runtime/diagnostics`

## 当前支持的 backend

统一 backend 目录定义在：

- [core/runtime/backend-catalog.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/core/runtime/backend-catalog.ts)

当前 catalog：

- `claude-code`
- `claude-code-rust`
- `codex`
- `openclaw`
- `zeroclaw`

默认 backend：

- `claude-code`

## 统一接口

### 1. backend 目录接口

- `GET /api/backends`

返回结构：

```json
{
  "ok": true,
  "data": {
    "defaultBackend": "claude-code",
    "backends": [
      { "id": "claude-code", "label": "Claude Code", "family": "claude-code" },
      { "id": "claude-code-rust", "label": "Claude Code Rust", "family": "claude-code" },
      { "id": "codex", "label": "Codex", "family": "codex" },
      { "id": "openclaw", "label": "OpenClaw", "family": "openclaw" },
      { "id": "zeroclaw", "label": "ZeroClaw", "family": "zeroclaw" }
    ]
  }
}
```

### 2. team runtime 配置接口

- `GET /api/teams/:teamId/runtime`
- `PUT /api/teams/:teamId/runtime`
- `POST /api/team/:teamId/runtime/start`
- `POST /api/team/:teamId/runtime/stop`
- `GET /api/team/:teamId/runtime/sessions`

当前主字段：

- `runtime.backend`
- `runtime.mode`
- `runtime.tools`

说明：

- 新代码以 `runtime.backend` 为主
- 仍然兼容读取旧的 `runtime.type`
- 新写入会去掉 `runtime.type`
- 成员模型配置现在推荐使用 `modelProvider + modelName`，旧的 `model` 字符串仍兼容读取
- `POST /api/team/:teamId/runtime/start` 用于预热后台常驻会话
- `POST /api/team/:teamId/runtime/stop` 用于关闭后台常驻会话
- `GET /api/team/:teamId/runtime/sessions` 用于查看当前常驻会话列表

推荐写入 payload：

```json
{
  "backend": "claude-code-rust",
  "mode": "isolated",
  "tools": {
    "deny": ["sessions_send", "sessions_list"]
  }
}
```

返回结构示例：

```json
{
  "ok": true,
  "data": {
    "teamId": "vibe-coding",
    "runtime": {
      "backend": "claude-code-rust",
      "mode": "isolated",
      "tools": {
        "deny": ["sessions_send", "sessions_list"]
      }
    },
    "availableBackends": [
      "claude-code",
      "claude-code-rust",
      "codex",
      "openclaw",
      "zeroclaw"
    ],
    "catalog": [
      { "id": "claude-code", "label": "Claude Code", "family": "claude-code" },
      { "id": "claude-code-rust", "label": "Claude Code Rust", "family": "claude-code" },
      { "id": "codex", "label": "Codex", "family": "codex" },
      { "id": "openclaw", "label": "OpenClaw", "family": "openclaw" },
      { "id": "zeroclaw", "label": "ZeroClaw", "family": "zeroclaw" }
    ]
  }
}
```

`POST /api/team/:teamId/runtime/start` 返回示例：

```json
{
  "ok": true,
  "message": "已预热 6 个 claude-code 常驻会话",
  "runtime": "claude-code",
  "sessions": [
    {
      "runtime": "claude-code",
      "teamId": "vibe-coding",
      "agentId": "pm-01",
      "sessionReady": true,
      "online": true,
      "busy": false,
      "status": "ready",
      "pid": 74811
    }
  ]
}
```

`POST /api/team/:teamId/runtime/stop` 返回示例：

```json
{
  "ok": true,
  "message": "已关闭 claude-code 的全部常驻会话",
  "runtime": "claude-code",
  "stopped": [
    {
      "runtime": "claude-code",
      "teamId": "vibe-coding",
      "agentId": "pm-01",
      "status": "ready",
      "pid": 92133
    }
  ]
}
```

`GET /api/team/:teamId/runtime/sessions` 返回示例：

```json
{
  "ok": true,
  "teamId": "vibe-coding",
  "runtime": "claude-code",
  "supported": true,
  "sessions": [
    {
      "runtime": "claude-code",
      "teamId": "vibe-coding",
      "agentId": "pm-01",
      "status": "ready",
      "sessionReady": true,
      "online": true
    }
  ]
}
```

### 3. 统一 runtime 调试接口

- `POST /api/runtime/runs`

用途：

- 不经过 dashboard 聊天链路，直接以统一 payload 调试某个 backend
- 用于 smoke test、联调、后续自动化测试

请求体：

```json
{
  "backend": "codex",
  "teamId": "vibe-coding",
  "agentId": "pm-01",
  "task": "请只回复：链路已打通",
  "context": "请只回复：链路已打通",
  "cwd": "/Applications/workspace/ailab/research/app/openteam-studio-run",
  "modelProvider": "custom",
  "modelName": "glm-5-fp8",
  "timeoutMs": 45000
}
```

模型字段约定：

- 推荐：显式传 `modelProvider + modelName`
- 兼容：也可以继续传单字段 `model`
- 兼容字符串格式：
  - `provider/model`
  - `provider:model`
  - `model`
- 统一解析后：
  - `claude-code` / `claude-code-rust` / `codex` 优先使用 `modelName`
  - `openclaw` 优先使用 `provider/modelName`
  - `zeroclaw` 通过 websocket `connect` 握手把 `modelProvider + modelName` 注入到会话级 agent 配置

返回：

- `backend`
- `input`
- `output`
- `events`

这个接口的目标是提供一个稳定、统一的 backend invocation contract。

### 4. 统一聊天入口

- `POST /api/team/:teamId/chat`

说明：

- 聊天入口不直接暴露 backend 参数
- 它总是先读取 team 当前 runtime 配置
- 再通过统一 session runner 分发到目标 backend

## 核心代码映射

### backend 目录和类型

- [core/runtime/backend-catalog.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/core/runtime/backend-catalog.ts)
- [core/team/types.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/core/team/types.ts)

### 统一 session 协议层

- [server/runtime/session-types.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/session-types.ts)
- [server/runtime/session-runner-registry.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/session-runner-registry.ts)
- [server/runtime/team-worker-manager.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/team-worker-manager.ts)
- [server/runtime/team-worker-types.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/team-worker-types.ts)

当前 `RunSessionOptions` 里的上层主字段：

- `backend`
- `teamId`
- `agentId`
- `requestId`
- `sessionKey`
- `cwd`
- `timeoutMs`
- `model`
- `modelProvider`
- `modelName`

统一模型解析 helper：

- [server/runtime/model-spec.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/model-spec.ts)
- [server/runtime/backend-model-contract.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/backend-model-contract.ts)

supervisor / worker 内部现在也保留显式字段：

- `EnsureWorkerSessionOptions.modelProvider`
- `EnsureWorkerSessionOptions.modelName`
- `WorkerSessionStatus.modelProvider`
- `WorkerSessionStatus.modelName`

统一 backend model contract 当前定义为：

1. `claude-code` / `claude-code-rust` / `codex`
   只消费 `modelName`
2. `openclaw`
   消费 `provider/modelName`
3. `zeroclaw`
   保留完整标识，并在持久 websocket session 的 `connect` 握手里显式注入 `modelProvider + modelName`

建议上层一律传：

- `modelProvider`
- `modelName`

`model` 现在只作为兼容输入和统一归一化结果保留。

### backend 实现层

- [server/runtime/clients/claude-code-session-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/clients/claude-code-session-client.ts)
- [server/runtime/clients/claude-code-rust-session-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/clients/claude-code-rust-session-client.ts)
- [server/runtime/clients/codex-session-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/clients/codex-session-client.ts)
- [server/runtime/clients/openclaw-session-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/clients/openclaw-session-client.ts)
- [server/runtime/clients/zeroclaw-session-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/clients/zeroclaw-session-client.ts)
- [server/runtime/workers/claude-code-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/claude-code-team-worker.ts)

### 上层分发入口

- [server/ws/agent-delivery.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/ws/agent-delivery.ts)
- [server/ws-handler.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/ws-handler.ts)

`agent-delivery` 现在的职责：

1. 从 team 配置解析当前 backend
2. 组装统一 `SessionInput`
3. 调用 `getSessionRunner(backend).runStream(...)`
4. 把 backend 输出转成统一 `AgentResponse`
5. 交给现有消息持久化和广播逻辑

### HTTP API 层

- [server/api/teams.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/api/teams.ts)
- [server/api/teams/team-crud.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/api/teams/team-crud.ts)
- [server/api/runtime.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/api/runtime.ts)

## 目录约定

### backend 代码和运行时数据

所有可控 backend 的代码和运行时本地数据统一位于：

- `/server/backend/<backend>/`

每个 backend 的 OpenTeam 本地状态统一位于：

- `/server/backend/<backend>/openteam-local/`

相关路径 helper：

- [core/runtime/backend-paths.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/core/runtime/backend-paths.ts)

当前已经把 `openteam-local` 加入 `.gitignore`，并从 Git 索引移除。

## 后台常驻化

### 当前实现边界

第一版后台常驻化已经落地，当前对 `claude-code`、`claude-code-rust`、`codex`、`openclaw`、`zeroclaw` 生效。

现在的关键变化是：

1. 常驻 supervisor 已经从 web/dev 进程中拆出
2. `tsx watch server/index.ts` 重启不会再清空常驻会话内存
3. web API 通过独立 `runtime-supervisor` daemon 读写会话状态

实现方式：

1. 上层仍然走统一 session runner / chat API
2. 所有已接入 backend 都通过 team worker manager 维护会话状态
3. 常驻会话按 `teamId + agentId + backend` 复用
4. 空闲超过 TTL 后自动回收

当前代码入口：

- [server/runtime/team-worker-manager.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/team-worker-manager.ts)
- [server/runtime/workers/claude-code-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/claude-code-team-worker.ts)
- [server/runtime/workers/claude-code-rust-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/claude-code-rust-team-worker.ts)
- [server/runtime/workers/codex-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/codex-team-worker.ts)
- [server/runtime/workers/session-runner-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/session-runner-team-worker.ts)
- [server/runtime/workers/openclaw-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/openclaw-team-worker.ts)
- [server/runtime/workers/zeroclaw-team-worker.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/workers/zeroclaw-team-worker.ts)
- [server/backend/claude_code_rust/src/commands/openteam_session.rs](/Applications/workspace/ailab/research/app/openteam-studio-run/server/backend/claude_code_rust/src/commands/openteam_session.rs)
- [server/runtime-supervisor/index.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime-supervisor/index.ts)
- [server/runtime/supervisor-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/supervisor-client.ts)

补充说明：

1. `runtime-supervisor` 启动时会主动加载项目根目录 `openteam.json`
2. 即使某个 backend 运行失败，也应返回结构化错误，不允许把 daemon 自身带崩
3. `codex` 当前在常驻层里会优先尝试 CLI 原生流；若检测到 `/v1/responses` websocket 不兼容，会回退到 OpenAI-compatible chat completions
4. `openclaw` 现在通过原生 gateway RPC 维持 team 级 gateway 进程和 agent 级持久 websocket session，不再依赖 OpenClaw 的 TUI / Control UI helper
5. `zeroclaw` 现在通过 team 级 gateway 进程和 agent 级持久 websocket session 维持真正常驻会话
6. `zeroclaw` 的 persistent websocket 首帧 `connect` 已支持显式 `model_provider` / `model_name`，会话级 provider/model 不再只能依赖 gateway 全局默认值

### 当前 supervisor 能力

- `runTeamWorker(...)`
- `ensureRuntimeWorkerSession(...)`
- `getRuntimeWorkerSessionStatus(...)`
- `listRuntimeWorkerSessions(...)`
- `listAllRuntimeWorkerSessions(...)`
- `disposeRuntimeWorkerSession(...)`
- `shutdownRuntimeWorkerSessions(...)`

web 进程实际调用的远程能力：

- `ensureSupervisorSession(...)`
- `disposeSupervisorSession(...)`
- `shutdownSupervisorSessions(...)`
- `listSupervisorSessions(...)`
- `runSupervisorWorker(...)`

### daemon 通信接口

独立 supervisor daemon 默认监听：

- `http://127.0.0.1:8766`

当前内部接口：

- `GET /health`
- `GET /diagnostics`
- `POST /sessions/ensure`
- `POST /sessions/dispose`
- `POST /sessions/shutdown`
- `GET /sessions/list`
- `POST /runs`

新增的上层排查接口：

- `GET /api/runtime/diagnostics`

返回重点：

1. supervisor 是否可达
2. 当前 daemon pid / startedAt
3. backend model contract 列表
4. 当前常驻 session 列表
5. 当前 snapshot 文件内容
6. 最近一次 snapshot restore 的结果

### 守护进程使用教程

#### 1. 启动 runtime-supervisor

前台启动：

```bash
cd /Applications/workspace/ailab/research/app/openteam-studio-run
npm run runtime-supervisor
```

后台启动（推荐用 tmux）：

```bash
tmux new-session -d -s runtime-supervisor 'cd /Applications/workspace/ailab/research/app/openteam-studio-run && npm run runtime-supervisor'
```

#### 2. 检查 runtime-supervisor 是否在线

```bash
curl -s http://127.0.0.1:8766/health
```

期望返回：

```json
{
  "ok": true,
  "data": {
    "ok": true,
    "service": "runtime-supervisor",
    "pid": 12345,
    "startedAt": "2026-04-04T01:37:59.116Z"
  }
}
```

如果这里返回连接失败，先确认两件事：

1. 没有旧的 `runtime-supervisor` 进程残留占住端口
2. 当前 shell 所在目录就是项目根目录，便于 daemon 正确加载 `openteam.json`

#### 3. 查看 daemon 诊断信息

```bash
curl -s http://127.0.0.1:8766/diagnostics
```

或者通过 web API：

```bash
curl -s http://localhost:8080/api/runtime/diagnostics
```

适合排查：

1. daemon 是否已经吃到最新代码
2. 当前有哪些 session 常驻
3. snapshot 是否已落盘
4. daemon 重启后是否已自动 restore

#### 4. 启动 web dev server

默认 3456：

```bash
cd /Applications/workspace/ailab/research/app/openteam-studio-run
npm run dev
```

显式 8080：

```bash
cd /Applications/workspace/ailab/research/app/openteam-studio-run
npm run dev:8080
```

如果想让 8080 后台常驻，也推荐用 tmux：

```bash
tmux new-session -d -s openteam-8080 'cd /Applications/workspace/ailab/research/app/openteam-studio-run && npm run dev:8080'
```

#### 5. 关闭 runtime-supervisor

如果是前台启动，直接 `Ctrl+C`。

如果是 tmux 启动：

```bash
tmux kill-session -t runtime-supervisor
```

如果是 detached node 进程启动：

```bash
ps -ef | rg 'runtime-supervisor/index.ts'
kill <pid>
```

#### 6. 关闭 8080 dev server

如果是前台启动，直接 `Ctrl+C`。

如果是 tmux 启动：

```bash
tmux kill-session -t openteam-8080
```

#### 7. 避免状态漂移

不要同时运行多份 `tsx watch server/index.ts`。

尤其不要同时保留：

- 一份 3456
- 一份 8080
- 以及旧的未清理 watch 进程

如果需要 3456 和 8080 两份 web 入口同时存在，也应确认它们都运行的是当前代码版本；真正的常驻会话状态只应由 `runtime-supervisor` 保存。

### 当前状态暴露

`GET /api/team/:teamId/session-status` 已经融合常驻会话信号：

- `persistent_ready`
- `persistent_busy`

也就是说：

- `configured` 仍来自原有 runtime/config 注入状态
- `sessionReady/online` 会额外叠加后台常驻会话状态

### 当前限制

1. `claude-code-rust` 的常驻模式通过新增 `openteam-session` JSONL 子命令实现
2. `codex` 已接入 supervisor，但当前成功率仍依赖本机 `127.0.0.1:18000` 的 OpenAI-compatible 服务可用
3. `openclaw` 当前依赖自身 gateway agent 运行参数；如果模型/鉴权未配置好，错误会回到 session 状态，但 daemon 不会退出
4. `zeroclaw` 当前依赖自身 provider/api key 配置；如果 provider 不可用，错误会回到 session 状态，但 daemon 不会退出
5. supervisor snapshot 当前保存的是“可恢复 metadata”，不是强一致实时状态日志；例如 `ready -> busy -> ready` 的瞬时变化不保证每一步都立即落盘
6. 当前预热接口默认只做会话常驻，不额外发送 warm-up prompt
7. 当前 live 验证依然依赖外部 LLM 可用性，supervisor 只解决会话稳定性，不解决上游 502 / ECONNREFUSED

### 常驻化环境变量

- `OPENTEAM_RUNTIME_IDLE_TTL_MS`
- `OPENTEAM_RUNTIME_IDLE_SWEEP_MS`

### supervisor snapshot

当前 snapshot 存储在：

- [server/runtime/supervisor-snapshot-store.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/runtime/supervisor-snapshot-store.ts)
- `/server/backend/runtime_supervisor/openteam-local/snapshots/session-snapshots.json`

行为约定：

1. `ensure / dispose / shutdown / run` 后都会刷新 snapshot
2. daemon 运行期间还会按固定周期刷新 snapshot，降低仅靠接口边界落盘导致的状态滞后
3. daemon 启动后会自动读取 snapshot，按 `runtime + teamId + agentId` 尝试恢复会话
4. 某个 session restore 失败时，只会记录到 `restore.errors`，不会阻止 daemon 启动

相关环境变量：

- `OPENTEAM_RUNTIME_SNAPSHOT_FLUSH_MS`

### 已废弃目录

以下目录/概念不再作为当前 runtime 主架构的一部分：

- `server/openclaw`
- `openclaw_gateway` 上层调用链路
- 以 `gateway` 为中心的 dashboard/runtime 切换逻辑
- `server/runtime_docs/*-migration.md` 历史迁移文档

## 前端现状

### Vibe Coding

Vibe Coding 当前已经使用 runtime / backend 语义：

- [teams/vibe-coding/package/js/api/runtime-helpers.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/vibe-coding/package/js/api/runtime-helpers.js)
- [teams/vibe-coding/package/js/api/realtime-helpers.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/vibe-coding/package/js/api/realtime-helpers.js)
- [teams/vibe-coding/package/js/api.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/vibe-coding/package/js/api.js)
- [teams/shared/package/js/shell-layout.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/shared/package/js/shell-layout.js)

它会：

- 读取 `GET /api/teams/:teamId/runtime`
- 使用 `catalog` 渲染 backend 下拉框
- 用 `{ backend: ... }` 调用 `PUT /api/teams/:teamId/runtime`
- 提供 runtime diagnostics 弹窗，直接读取 `GET /api/runtime/diagnostics`
- 支持复制当前 diagnostics / runtime 状态，便于排障

### Template / Research

Template 和 Research 也已经把“状态读取”从 `gateway` 命名迁到了 `runtime` 命名，统一读取：

- `GET /api/team/:teamId/session-status`

相关文件：

- [teams/shared/package/js/team-template-runtime-config.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/shared/package/js/team-template-runtime-config.js)
- [teams/research/package/js/api.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/research/package/js/api.js)
- [teams/shared/package/js/team-runtime-app.js](/Applications/workspace/ailab/research/app/openteam-studio-run/teams/shared/package/js/team-runtime-app.js)

## 已完成事项

1. 删除了旧 `openclaw_gateway` 上层可选入口
2. 删除了旧 `server/openclaw/client.ts` gateway 客户端链路
3. 把通用 `AgentResponse` 抽离到 runtime-neutral 文件
4. 五类 backend 统一接入 `SessionRunner`
5. backend 运行时本地数据统一放到 `server/backend/*/openteam-local`
6. `openteam-local` 已经从 Git 管理中忽略
7. team runtime 配置主字段改为 `backend`
8. 增加了统一 backend catalog API
9. 增加了统一 runtime direct-run API
10. 前端上层命名已基本从 `gateway` 收敛到 `runtime`
11. 历史 runtime migration 文档已删除，统一以本文件作为当前实现说明
12. `claude-code` 第一版后台常驻化已落地
13. 增加了 `POST /api/team/:teamId/runtime/start` 预热接口
14. `session-status` 已融合常驻会话状态
15. 增加了 `POST /api/team/:teamId/runtime/stop` 关闭接口
16. 增加了 `GET /api/team/:teamId/runtime/sessions` 会话观测接口
17. `claude-code-rust` 已新增 `openteam-session` 机器协议，并接入 supervisor
18. 常驻 supervisor 已拆成独立 daemon，web 层改为通过 client 远程调用 daemon
19. `codex` 已接入独立 daemon supervisor，`CodexSessionClient` 改为统一走 `runSupervisorWorker(...)`
20. `runtime-supervisor` 启动时会加载项目 `openteam.json`，避免独立进程缺失 LLM 运行参数
21. `codex` 在 websocket 不兼容时会自动回退到 chat completions；fallback 失败会返回错误，不再导致 daemon 退出
22. `runtime-supervisor` 已增加 `unhandledRejection` / `uncaughtException` 保护日志，降低单 backend 漏网异常导致 daemon 退出的风险
23. `openclaw` 已接入独立 daemon supervisor，并改成原生 gateway RPC 持久会话，不再依赖 OpenClaw UI/TUI helper
24. `zeroclaw` 已接入独立 daemon supervisor，并改成 gateway websocket 持久会话
25. `openclaw` / `zeroclaw` 的上游失败都只会写入 session 错误状态，不会把 worker 或 daemon 带崩
26. runtime 层已新增统一 `provider + modelName` 解析，不再把 `custom/...` 等格式写死在某个 backend 里
27. `POST /api/runtime/runs` 已支持显式传 `modelProvider` / `modelName`
28. supervisor worker 边界已统一保留 `modelProvider` / `modelName`，不再在进入 worker 前退化成单个 `model` 字符串
29. `zeroclaw` websocket `connect` 握手已接入 `model_provider` / `model_name`，会话级 agent 初始化会按这两个字段覆盖默认 provider/model
30. `server/backend/zeroclaw/Cargo.toml` 中失效的 workspace member 与失效 benchmark 声明已清理，Rust 侧验证链恢复可用
31. 已新增统一 backend model contract registry，`provider + modelName` 的消费方式不再散落在 API 层临时判断
32. 已新增 supervisor snapshot 落盘与 daemon 启动自动 restore
33. 已新增 `GET /diagnostics` 与 `GET /api/runtime/diagnostics`，统一暴露 daemon 健康、session、snapshot、restore、contract 信息
34. 已新增 supervisor 周期性 snapshot 刷新，减小常驻 session 状态与 snapshot 文件的时间差
35. Vibe Coding dashboard 已新增 runtime diagnostics 弹窗，shared shell 顶栏可直接查看 daemon/session/restore/provider-model 信息

## 当前仍保留的兼容层

为了让旧 team 配置平滑过渡，当前仍保留两处兼容读取：

1. `team.runtime.type`
2. 个别 backend 内部实现仍保留“transport/gateway”术语，用来描述其私有传输层，而不是上层 API 契约

这些兼容层只用于读取旧状态，不应该再作为新代码写入目标。

## 当前验证结果

本轮代码状态下，已确认：

1. `npm run build` 可以通过
2. `GET /api/backends` 返回统一 backend catalog
3. `GET /api/teams/vibe-coding/runtime` 返回 `runtime.backend + availableBackends + catalog`
4. `PUT /api/teams/vibe-coding/runtime` 可以用 `{ "backend": "claude-code-rust" }` 更新 team runtime
5. `POST /api/runtime/runs` 已能统一调起五类 backend
6. `POST /api/team/vibe-coding/runtime/start` 已能预热 `claude-code` 常驻会话
7. `GET /api/team/vibe-coding/session-status` 在预热后可显示 `6/6 sessionReady`、`6/6 online`
8. `GET /api/team/vibe-coding/runtime/sessions` 可返回 6 个 `claude-code` 常驻会话及其 pid/status
9. `POST /api/team/vibe-coding/runtime/stop` 已能关闭全部常驻会话，关闭后 `runtime/sessions` 返回空数组
10. 单进程 smoke test 已验证 `claude-code-rust` 的 `start -> list -> stop` 闭环
11. `ClaudeCodeRustSessionClient` 通过常驻会话发起真实请求时，已经能走到上游模型调用；当前失败点是外部 `502 Bad Gateway`
12. daemon-backed smoke test 已验证 `claude-code` 的 `start -> list -> stop` 闭环
13. `GET http://127.0.0.1:8766/health` 已能返回独立 daemon 健康状态
14. 发现机器上曾同时存在两组 `tsx watch server/index.ts`，其中旧 `8080` 进程造成了“配置态与内存态不一致”的假象
15. 重启旧 `8080` 进程后，`GET /api/team/vibe-coding/runtime/sessions` 已能正确返回 daemon 中的会话状态
16. daemon-backed smoke test 已验证 `codex` 的 `start -> list -> shutdown` 闭环
17. `CodexSessionClient` 已改为统一走 daemon；在本机 `127.0.0.1:18000` 不可达时，会返回结构化错误并保留 daemon 存活
18. daemon-backed smoke test 已验证 `openclaw` 与 `zeroclaw` 的 `start -> list -> shutdown` 闭环
19. `ZeroClawSessionClient` 通过 daemon 成功返回 `zeroclaw daemon验证`
20. `OpenClawTeamWorker` 已完成 team 级 gateway + agent 级持久 websocket session 接线，并通过原生 gateway RPC 调用 `sessions.create / sessions.send / sessions.messages.subscribe / agent.wait`
21. worker-level smoke test 已验证 `openclaw` 的 `ensure -> run -> shutdown` 闭环；当前样例失败会写入 `session.status = error`，daemon 与 worker 仍保持可用
22. worker-level smoke test 已验证 `zeroclaw` 的 `ensure -> run -> shutdown` 闭环；当前 provider/api key 配置错误会写入 `session.status = error`，daemon 与 worker 仍保持可用
23. `parseRuntimeModelSpec()` 已验证能正确解析：
    `custom/glm-5-fp8` -> `provider=custom`, `modelName=glm-5-fp8`
24. `OpenClawTeamWorker.ensureSession()` 已验证会保留完整 provider-qualified model 标识，例如 `custom/glm-5-fp8`
25. `npm run build` 已验证 worker/supervisor 新增的 `modelProvider` / `modelName` 字段接线通过
26. `resolveConfiguredRuntimeModel(...)` 已验证显式输入
    `{ modelProvider: "custom", modelName: "glm-5-fp8" }`
    会稳定归一化成 `custom/glm-5-fp8`
27. `cargo check --manifest-path server/backend/zeroclaw/Cargo.toml --bin zeroclaw` 已通过
28. `ZeroClawTeamWorker.ensureSession(...)` 已验证会保留：
    `model = "custom/glm-5-fp8"`
    `modelProvider = "custom"`
    `modelName = "glm-5-fp8"`
29. `GET http://127.0.0.1:8766/diagnostics` 已返回：
    contract 列表、当前 session 列表、snapshot 内容、restore 状态
30. 带已有 session 重启 `runtime-supervisor` 后，`restore.restoredCount = 1`，会话可从 snapshot 自动恢复
31. `GET http://localhost:8080/api/runtime/diagnostics` 已能透传 daemon 诊断结果
32. `node --check` 已验证 Vibe Coding / shared shell / template / research 新增 diagnostics 前端脚本语法通过

五类 backend 的统一调试接口现状：

1. `claude-code`：统一接口已打通；是否成功拿到回复取决于上游 LLM 可用性
2. `claude-code-rust`：统一接口已打通；是否成功拿到回复取决于上游 LLM 可用性
3. `codex`：统一接口与 daemon 常驻都已打通；若本机 `127.0.0.1:18000` 可用则可继续验证成功回复，否则会返回结构化失败
4. `openclaw`：统一接口与 daemon 常驻都已打通；现在通过原生 gateway RPC 持久会话执行，当前是否成功拿到回复取决于 OpenClaw agent 模型和鉴权配置
5. `zeroclaw`：统一接口与 daemon 常驻都已打通；通过持久 websocket session 执行，当前是否成功拿到回复取决于 provider/api key 配置

后台常驻化现状：

1. `claude-code`：已支持后台常驻与空闲回收
2. `claude-code-rust`：已支持后台常驻、空闲回收与 JSONL 机器协议
3. `codex`：已支持后台常驻、空闲回收、threadId 复用与 websocket 不兼容回退
4. `openclaw`：已支持 team 级 gateway 常驻、agent 级持久 websocket session、空闲回收与失败隔离
5. `zeroclaw`：已支持 team 级 gateway 常驻、agent 级持久 websocket session、空闲回收与失败隔离

## 推荐新增代码约束

后续新增任何 backend 或 runtime 功能时，建议遵守以下规则：

1. 不允许新增新的 team-specific backend API
2. 不允许在聊天入口新增 backend 专用分支
3. backend 差异只能落在 `server/runtime/clients/*`
4. backend 清单只能从 `backend-catalog.ts` 扩展
5. 团队配置只允许写 `runtime.backend`
6. 所有 backend 的本地状态必须写入 `server/backend/<backend>/openteam-local`

## 推荐测试路径

### 配置验证

1. `GET /api/backends`
2. `GET /api/teams/:teamId/runtime`
3. `PUT /api/teams/:teamId/runtime` with `{ "backend": "codex" }`
4. 再次 `GET /api/teams/:teamId/runtime`

### 直接调试验证

1. `POST /api/runtime/runs`
2. 指定 `backend + teamId + agentId + task/context`
3. 验证 `output.success` 和 `events`

### daemon 诊断验证

1. `GET /api/runtime/diagnostics`
2. 检查 `supervisor.healthy`
3. 检查 `supervisor.diagnostics.contracts`
4. 检查 `supervisor.diagnostics.sessions`
5. 检查 `supervisor.diagnostics.restore`

### 聊天链路验证

1. 用 `PUT /api/teams/:teamId/runtime` 选择目标 backend
2. 用 `POST /api/team/:teamId/chat` 发起消息
3. 用 `GET /api/teams/:teamId/chat-history` 验证 final reply 落盘

## 结论

当前 runtime/backend 架构已经从“围绕 OpenClaw Gateway 兼容”切换到“围绕 backend catalog 和统一 session runner”组织。

最重要的判断标准现在是：

- 上层是不是只通过 `backend` 参数切换 runtime
- 聊天入口是不是完全不关心具体 backend
- backend 差异是不是只留在 runtime client 适配层

如果这三个条件持续成立，这套架构就是稳定且可扩展的。
