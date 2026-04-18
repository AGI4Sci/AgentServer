# Agent Server Runtime

最后更新：2026-04-18

## 定位

`server/agent_server` 是长期运行 agent 的宿主层。

它复用 `server/runtime/*` 和 `server/backend/*` 的执行能力，对外提供稳定的 agent / session / run 抽象，并负责：

- 固定绑定 `workingDirectory`
- 管理 `memory / persistent / current work`
- 维护 turn/run 审计日志
- 提供 compaction / finalize / recovery / retrieval API
- 支持 autonomy、clarification、恢复与故障自愈

Core context 契约见 [Core Context Contract](./context-core.md)。自研 backend 的 harness 策略见 [Harness Context Strategy](./context-harness.md)。

## 数据目录

运行数据落在：

```text
server/agent_server/data/
  agents/
    {agentId}/
      agent.json
      memory/
        summary.jsonl
        constraints.jsonl
      queue.json
      artifacts/
        {runId}/
      sessions/
        {sessionId}/
          session.json
          persistent/
            summary.jsonl
            constraints.jsonl
          work/
            current.jsonl
            log/
              turns.jsonl
          runs/
            {runId}.json
          artifacts/
            {runId}/
```

关键文件：

- `agent.json`：agent 身份、backend、working directory、active session。
- `memory/*`：跨 session 记忆。
- `persistent/*`：当前 session 的稳定上下文。
- `work/current.jsonl`：当前 work window，可包含 compaction / partial compaction 记录。
- `work/log/turns.jsonl`：完整 turn 审计日志。
- `runs/*.json`：单次 backend run 记录。
- `artifacts/{runId}/`：run 产物目录。

## 推荐入口

外部项目优先使用通用 run facade：

```text
POST /api/agent-server/runs
GET  /api/agent-server/runs/:runId
```

Node 内嵌使用：

```ts
import { AgentServerService } from '../server/agent_server/service.js';

const service = new AgentServerService();
const result = await service.runTask({
  agent: {
    id: 'repo-helper',
    backend: 'codex',
    workspace: '/absolute/path/to/workspace',
    reconcileExisting: true,
  },
  input: {
    text: 'Summarize this repository.',
  },
});
```

HTTP client 使用：

```ts
import { createAgentServerHttpClient } from '../server/agent_server/http-client.js';

const client = createAgentServerHttpClient('http://127.0.0.1:8080');
const result = await client.runTask({
  agent: {
    id: 'repo-helper',
    backend: 'hermes-agent',
    workspace: '/absolute/path/to/workspace',
    reconcileExisting: true,
  },
  input: {
    text: 'Use list_dir on "." and summarize the files.',
  },
});
```

更多接入示例见 [Public API](./public-api.md)。

## 兼容入口

这些长期 agent 高阶入口仍保留：

```text
POST /api/agent-server/autonomous/ensure
POST /api/agent-server/autonomous/run
```

它们和 `/runs` 一样不是裸 runtime call，而是包含：

- ensure / reconcile
- recovery check
- persistent budget handling
- context assembly
- backend runtime call
- turn/run audit
- post-run summary / constraints extraction
- optional compaction / recovery

## Context 与 Audit

每次 run 会保存：

- request message
- assembled context snapshot
- normalized events
- backend output
- context refs
- metrics
- evaluation
- metadata

`metadata` 是项目适配面。AgentServer 保存并回传 metadata，但不解释其业务语义。

## Maintenance API

Agent Server Runtime 提供长期状态维护能力：

- context snapshot
- current work replace
- retrieve context
- workspace search
- compaction preview/apply
- session finalize preview/apply
- persistent budget recovery preview/apply
- recovery acknowledgement
- memory / persistent summary append
- memory / persistent constraint append

这些能力属于 AgentServer Core 的可审计维护面。backend harness 可以有自己的内部维护策略，但不应绕过 AgentServer 的 run/audit/store 边界。
