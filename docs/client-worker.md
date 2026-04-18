# Client Worker 与 Tool Routing

本文说明 AgentServer 的最终通用模型：backend 大脑放在服务端，workspace 通过参数指定，tool-call 按策略选择 primary/fallback workers 执行，工具产生的数据和结果默认归 workspace。

## 核心模型

```text
backend = 大脑，负责思考和规划
workspace = 数据归属地，负责收纳文件、artifact、结果
worker = 执行者，负责真正跑工具
route = 每个 tool-call 的执行计划：primary worker + fallback workers
```

| 概念 | 作用 | 例子 |
|---|---|---|
| Backend | 大脑，通常在云端/服务器端 | `openteam_agent`、`codex`、`claude-code` |
| Workspace | 数据归属地，工具产物默认写回这里 | Mac 项目目录、GPU 实验目录、server workspace |
| Worker | 执行者，可以有多个 | backend-server、Mac worker、SSH GPU、container |
| Tool Route | 单个工具调用的执行计划 | `web_search` 走 backend，`run_command` 走 GPU |

常见场景：

| 场景 | backend 大脑 | workspace 数据归属 | primary worker |
|---|---|---|---|
| Mac 本地开发 | 云端 backend | Mac workspace | Mac worker |
| SSH GPU 实验 | 云端 backend | GPU workspace | SSH GPU worker |
| GPU 不联网查资料 | 云端 backend | GPU workspace | `web_search` 走 backend-server，结果写回 GPU workspace |
| 服务器本地任务 | 云端 backend | server workspace | server worker |
| 多 worker 协作 | 云端 backend | 一个主 workspace | 每个工具按 routing policy 选择 |

## 配置结构

`workspace` 不再表示执行者，而表示数据归属地。执行者是 `worker`。

```json
{
  "runtime": {
    "workspace": {
      "workspaces": [
        {
          "id": "gpu-exp",
          "root": "/home/ubuntu/experiments/run-001",
          "artifactRoot": "/home/ubuntu/experiments/run-001/artifacts",
          "ownerWorker": "gpu-a100"
        }
      ],
      "workers": [
        {
          "id": "backend-server",
          "kind": "backend-server",
          "capabilities": ["network", "metadata"]
        },
        {
          "id": "gpu-a100",
          "kind": "ssh",
          "host": "gpu.example.com",
          "user": "ubuntu",
          "port": 22,
          "identityFile": "/home/agent/.ssh/id_ed25519",
          "allowedRoots": ["/home/ubuntu/experiments"],
          "capabilities": ["filesystem", "shell", "gpu"]
        },
        {
          "id": "mac-local",
          "kind": "client-worker",
          "endpoint": "http://127.0.0.1:3457",
          "allowedRoots": ["/Applications/workspace"],
          "capabilities": ["filesystem", "shell", "network"]
        }
      ],
      "toolRouting": {
        "default": {
          "primary": "gpu-a100"
        },
        "rules": [
          {
            "tools": ["web_search", "web_fetch"],
            "primary": "backend-server",
            "fallbacks": ["mac-local"]
          }
        ]
      }
    }
  }
}
```

含义：

- 默认工具由 `gpu-a100` 执行。
- `web_search` / `web_fetch` 优先由 `backend-server` 执行，失败时可 fallback 到 `mac-local`。
- `run_command` / `apply_patch` / `read_file` 等有 workspace 副作用的工具仍走 workspace owner worker。
- 所有工具的输出策略默认是 `writeToWorkspace=true`。

## Tool 分类

| 工具 | 类型 | 需要的 worker capability | 默认路由 |
|---|---|---|---|
| `list_dir` | `workspace` | `filesystem` | workspace owner worker |
| `read_file` | `workspace` | `filesystem` | workspace owner worker |
| `write_file` | `workspace` | `filesystem` | workspace owner worker |
| `apply_patch` | `workspace` | `filesystem` | workspace owner worker |
| `run_command` | `compute` | `filesystem` + `shell` | workspace owner worker |
| `web_search` | `network` | `network` | backend-server |
| `web_fetch` | `network` | `network` | backend-server |
| `download_url` | `network` | `network` | policy 决定；若写 workspace，需要后续 workspace 写入步骤 |
| `git_clone` | `network` / `workspace` | `network` + `filesystem` | 通常应在目标 workspace owner worker 执行 |

## Route Plan

SDK 提供纯计划函数，不会执行工具：

```ts
import { planToolRoute } from '@agi4sci/agent-server';

const plan = planToolRoute({
  toolName: 'web_search',
  workspace: {
    id: 'gpu-exp',
    root: '/home/ubuntu/experiments/run-001',
    ownerWorker: 'gpu-a100',
  },
  workers: [
    { id: 'backend-server', kind: 'backend-server', capabilities: ['network', 'metadata'] },
    { id: 'gpu-a100', kind: 'ssh', host: 'gpu.example.com', capabilities: ['filesystem', 'shell', 'gpu'] },
  ],
});

// plan.primaryWorker === 'backend-server'
// plan.outputPolicy.writeToWorkspace === true
```

配置层也提供：

```ts
planConfiguredToolRoute(toolName, workspaceId)
```

可以用 smoke 验证配置解析：

```bash
npm run smoke:tool-routing-config
```

## Routed Executor

`planToolRoute()` 只负责计划。服务端执行层使用 `executeRoutedToolCall()` 把计划落到当前已经实现的 executor 上：

```ts
import { executeRoutedToolCall } from './server/runtime/tool-executor';

const result = await executeRoutedToolCall({
  toolName: 'web_fetch',
  toolArgs: { url: 'https://example.com' },
  workspace,
  workers,
});
```

当前 executor 状态：

| Worker kind | 当前状态 | 说明 |
|---|---|---|
| `backend-server` | 已实现 | 适合执行 `web_search` / `web_fetch` 等 network 工具 |
| `server` | 已实现 | 适合执行 server 可访问 workspace 的文件和 shell 工具 |
| `ssh` | 已实现 | 通过 `ssh <host> bash -s` 执行 workspace 文件和 shell 工具，适合 GPU workspace |
| `client-worker` | 已实现 | 通过 HTTP `POST /tool-call` 执行用户端 workspace 工具，适合 Mac 本地 workspace |
| `container` | plan-only | 已能进入 route plan，容器执行器下一阶段实现 |
| `remote-service` | plan-only | 已能进入 route plan，外部服务执行器下一阶段实现 |

network 工具有一个额外约定：如果 workspace 可由某个 `server`、`ssh` 或 `client-worker` 写入，执行结果会写入 workspace artifact；如果 workspace 在 container/remote-service 等尚未实现的 worker 侧，结果会标记为 `pending`，由后续 workspace writeback 层补齐。

client-worker HTTP 协议极薄：

```http
POST /tool-call
content-type: application/json
authorization: Bearer <token>
```

请求：

```json
{
  "workerId": "mac-local",
  "workspace": {
    "id": "mac-work",
    "root": "/Applications/workspace/my-project",
    "ownerWorker": "mac-local"
  },
  "cwd": "/Applications/workspace/my-project",
  "toolName": "read_file",
  "args": {
    "path": "README.md"
  }
}
```

响应：

```json
{
  "ok": true,
  "output": "path=/Applications/workspace/my-project/README.md\n..."
}
```

本项目已经提供一个最小 client-worker 服务，可直接在用户端 workspace 所在机器启动：

```bash
AGENT_SERVER_CLIENT_WORKER_ROOTS=/Applications/workspace/my-project \
AGENT_SERVER_CLIENT_WORKER_PORT=3457 \
AGENT_SERVER_CLIENT_WORKER_TOKEN=change-me-client-worker-token \
npm run client-worker
```

环境变量：

| 变量 | 作用 |
|---|---|
| `AGENT_SERVER_CLIENT_WORKER_ROOTS` | 逗号分隔的允许访问目录，默认是启动目录 |
| `AGENT_SERVER_CLIENT_WORKER_ROOT` | 单个允许访问目录，低优先级兼容写法 |
| `AGENT_SERVER_CLIENT_WORKER_HOST` | 监听地址，默认 `127.0.0.1` |
| `AGENT_SERVER_CLIENT_WORKER_PORT` | 监听端口，默认 `3457` |
| `AGENT_SERVER_CLIENT_WORKER_TOKEN` | 可选鉴权 token；设置后 `/capabilities` 和 `/tool-call` 必须携带 token |

健康检查：

```bash
curl http://127.0.0.1:3457/health
```

能力检查：

```bash
curl -H "authorization: Bearer change-me-client-worker-token" \
  http://127.0.0.1:3457/capabilities
```

AgentServer worker 配置中应写入同一个 token：

```json
{
  "id": "mac-local",
  "kind": "client-worker",
  "endpoint": "http://127.0.0.1:3457",
  "authToken": "change-me-client-worker-token",
  "allowedRoots": ["/Applications/workspace/my-project"],
  "capabilities": ["filesystem", "shell", "network"]
}
```

SSH executor 使用系统 `ssh` 命令，默认 binary 是 `ssh`。测试或特殊部署可以用环境变量覆盖：

```bash
AGENT_SERVER_SSH_BIN=/path/to/ssh
```

真实 backend run 里的 shared local-tool fallback 已经接入 routed executor：

- 如果配置中存在包含当前 `cwd` 的 workspace，就使用该 workspace 的 `ownerWorker` / `toolRouting`。
- 如果没有显式 workspace 配置，就自动合成一个本机 `local-dev` workspace，并使用 `server-local` worker 执行文件和 shell 工具。
- 这让普通本地开发继续开箱可用，同时让 Mac / SSH GPU / server workspace 可以逐步迁移到显式 `workspaces + workers + toolRouting` 配置。

可以用 smoke 验证最小执行层：

```bash
npm run smoke:client-worker
npm run smoke:tool-executor
```

## 关键规则

- backend 不等于 worker：backend 是大脑，worker 是执行者。
- workspace 不等于 worker：workspace 是数据归属地，worker 是执行位置。
- 每个 tool-call 都应有 route plan：primary worker、fallback workers、output policy、reason。
- workspace 副作用工具不能随便 fallback 到无法访问同一 workspace 的 worker。
- network 工具可以由 backend-server 或其它 network worker 代跑，但产物默认归 workspace。
- 当前 AgentServer 已实现 route plan、配置解析、SDK helper、server/backend-server/ssh/client-worker executor 和 smoke；真实 `container` / `remote-service` executor 仍是下一阶段。

## 审计原则

AgentServer 应记录控制面数据：

- run id
- backend id
- workspace id
- tool name
- primary worker
- fallback workers
- route reason
- output policy
- 状态和错误类型

AgentServer 不应默认保存 workspace 副作用：

- 大型命令输出
- build 目录
- dependency cache
- 完整文件内容
- client/SSH 侧临时文件
- GPU 训练产物

需要长期保存的内容应显式写入 workspace artifact，而不是作为服务器文件系统垃圾被动留下。
