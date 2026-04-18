# Agent Server

`server/agent_server` 是长期运行 agent 的宿主层。

它复用 `server/runtime/*` 和 `server/backend/*` 的执行能力，对外提供稳定的 agent instance/session 抽象，并负责：

- 固定绑定 `workingDirectory`
- 管理 `memory / persistent / current work`
- 维护 turn/run 审计日志
- 提供 compaction / finalize / recovery / retrieval API
- 支持 autonomy、clarification、恢复与故障自愈

设计基线见 [context_design_v9.md](/Applications/workspace/ailab/research/app/openteam-studio-run/server/agent_server/context_design_v9.md)。

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

- `agent.json`：agent 身份、backend、working directory、active session
- `memory/*`：跨 session 记忆
- `persistent/*`：当前 session 的持久上下文
- `work/current.jsonl`：当前 window work，可包含 `compaction` / `partial_compaction`
- `work/log/turns.jsonl`：完整 turn 审计日志
- `runs/*.json`：单次 backend run 记录
- `sessions/*/artifacts/{runId}/`：当前 active session 下的 run 产物目录
- `artifacts/{runId}/`：agent 尚未建立 active session 时的 staging 产物目录

## 目录职责边界

当前项目里与 agent 相关的目录有两类，但职责应明确区分：

- `server/agent_server/data/agents/*`
  这是长期运行 agent 的唯一 runtime 真相源，承载 identity、queue、sessions、persistent/work/memory、run 审计和 artifacts。
- `agents/roles/*`
  这是静态角色定义层，承载角色配置、技能说明、seed memory 等仓库内容；它不再是长期 session / run / artifact 的真相源。

如果某个长期 agent 看起来“在 `agents/roles/<agentId>` 下面没有 sessions”，这不表示它没有长期上下文；正确的运行时状态应到 `server/agent_server/data/agents/<hostedAgentId>` 下查看。

## 核心 API

### Autonomous Hosted Agent API

如果上层的目标是“实例化后长期运行，由 `agent_server` 自己维护上下文、恢复与续跑”，推荐优先走这一层高阶 API：

- `POST /api/agent-server/autonomous/ensure`
- `POST /api/agent-server/autonomous/run`

它们的语义不是“单次裸 `sendMessage`”，而是“确保存在一个可长期运行、自恢复的 hosted agent，然后再投递任务”。

`autonomous/ensure` 负责：

- 确保 agent 存在，不存在时自动创建
- 在 agent 已存在时按当前声明自动 reconcile `backend / workingDirectory / runtimeTeamId / runtimeAgentId / systemPrompt / autonomy`

`autonomous/run` 会在正式执行前后自动做：

- ensure / reconcile agent
- 检查 recovery 状态与 `runtime.lastError`
- 遇到 persistent budget 问题时优先尝试 `persistent/recovery/apply`
- 仍无法恢复时按策略执行 `persistent/reset`
- 必要时 `revive`
- 再执行真正的 message run；若首次执行仍命中 persistent budget，会自动恢复后重试一次

对 blackboard、coordinator 和长期 executor，推荐统一只走这层高阶 API，而不是手写：

- `getAgent -> createAgent`
- `preview/apply persistent recovery`
- `reset persistent`
- `revive`
- `sendMessage`

这样上层只需要表达“给这个长期 agent 投递任务”，生命周期维护留给 `agent_server`。

同样地，黑板在为任务分配 `artifactsRoot` 时，也应默认指向 `agent_server` 数据目录下的 session artifacts，而不是写到 `agents/roles/*/runs/*`。

### Agent 与消息

- `POST /api/agent-server/agents`
- `GET /api/agent-server/agents`
- `GET /api/agent-server/agents/:id`
- `POST /api/agent-server/agents/:id/messages`
- `GET /api/agent-server/agents/:id/runs`
- `GET /api/agent-server/agents/:id/context`
- `GET /api/agent-server/agents/:id/work/current`
- `POST /api/agent-server/agents/:id/work/current`
- `POST /api/agent-server/agents/:id/revive`

`GET /context` 是推荐的总览接口。它会返回：

- `workBudget / persistentBudget / memoryBudget`
- `workLayout`
- `operationalGuidance`
- 当前 assembled context

其中：

- `GET /work/current` 用于读取当前 session 的 current work 视图
- `POST /work/current` 用于测试/运维场景下替换 current work，并可同步推进 `nextTurnNumber`
- `POST /revive` 用于把短暂进入 `error` 的 agent 恢复到可继续执行的状态，而不是由脚本直接改底层存储

### Compaction / Finalize / Recovery

- `POST /api/agent-server/agents/:id/compact/preview`
- `POST /api/agent-server/agents/:id/compact`
- `POST /api/agent-server/agents/:id/sessions/finalize/preview`
- `POST /api/agent-server/agents/:id/sessions/finalize`
- `GET /api/agent-server/agents/:id/persistent/recovery/preview`
- `POST /api/agent-server/agents/:id/persistent/recovery/apply`
- `GET /api/agent-server/agents/:id/recovery`
- `POST /api/agent-server/agents/:id/recovery/acknowledge`

三条强操作链都遵循同一模式：

- 先 `preview`
- 返回 `candidates / decision / semanticSuggestion / costDelta`
- 再执行真正的 apply

### Retrieval / Workspace Search / Clarification

- `POST /api/agent-server/agents/:id/retrieve`
- `POST /api/agent-server/agents/:id/workspace-search`
- `GET /api/agent-server/agents/:id/turns`
- `GET /api/agent-server/agents/:id/clarifications`
- `POST /api/agent-server/agents/:id/clarifications/resolve`

`retrieve` 支持：

- `history_first`
- `workspace_first`
- `balanced`

并会返回：

- `recommendedAction`
- `queryKind`
- `evidenceQuality`
- `searchedLayers / skippedLayers`
- `reopenedArchivedRanges`
- `tokenEconomics`

### Autonomy

- `POST /api/agent-server/agents/:id/goals`
- `POST /api/agent-server/agents/:id/autonomy/start`
- `POST /api/agent-server/agents/:id/autonomy/stop`

### Memory / Persistent Admin

- `POST /api/agent-server/agents/:id/memory/summary`
- `POST /api/agent-server/agents/:id/memory/constraints`
- `POST /api/agent-server/agents/:id/persistent/summary`
- `POST /api/agent-server/agents/:id/persistent/constraints`

这些接口主要服务于回归、fixture 注入、恢复和运维脚本。它们的目标是把原本只能通过内部 `.store` 完成的操作提升为正式 `agent_server` API，避免脚本绕过 agent 边界直接改实现层。

## 上层消费建议

推荐上层这样接：

- 对长期 hosted/coordinator/worker agent，优先走 `autonomous/ensure` + `autonomous/run`
- 把 `GET /context` 当唯一总览接口
- 把 `operationalGuidance` 当主 CTA 来源
- 所有强操作先走 preview，再走 apply
- `decision` 用作默认选项
- `semanticSuggestion` 只作解释和辅助排序，不应跳过 preview 直接 apply
- 上层 agent 调用统一走 `agent_server` API；脚本/工具层如果需要批量回归或注入 fixture，也应通过 `/api/agent-server/*`，而不是直接 import `service.ts`、`client.ts` 或内部 `.store`

## HTTP Client

如果是脚本、smoke、回归工具，推荐复用 [http-client.ts](/Applications/workspace/ailab/research/app/openteam-studio-run/server/agent_server/http-client.ts)：

- `createAgentServerHttpClient(baseUrl)`

这个 client 对应 README 里列出的 `/api/agent-server/*` northbound API，目的是让脚本层也只维护一条 agent 使用链路，而不是一部分走 HTTP，一部分走进程内实现。

其中新增的高阶方法是：

- `ensureAutonomousAgent(input)`
- `runAutonomousTask(input)`

## Token Economics 策略对比

[`scripts/t005-token-economics-compare.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-token-economics-compare.ts) 用四种维护策略对比同一 workload 的长期成本：

- `keep_live`
  不主动 `compaction`、不主动 `finalize`；只有 budget 真阻塞时，才允许做最小 clean persistent recovery。它代表最保守、最少主动维护的长期基线。
- `auto_compaction`
  以 `compact(mode=auto)` 为主要维护手段，通过压缩 current work 控制长期成本。
- `aggressive_finalize`
  更积极结束 session，把高价值内容提炼进 memory，再用新的 session seed 继续工作。
- `balanced_recovery`
  以 persistent slimming 为主要维护手段，持续温和瘦身，而不是频繁 compaction 或 aggressive finalize。

这四条 profile 代表四种不同维护哲学：

- `keep_live`：少维护基线
- `auto_compaction`：work 压缩优先
- `aggressive_finalize`：session 提炼优先
- `balanced_recovery`：persistent 瘦身优先

## 回归脚本

常用回归入口：

- [`scripts/t005-agent-server-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-agent-server-regression.ts)
- [`scripts/t005-agent-server-compaction-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-agent-server-compaction-regression.ts)
- [`scripts/t005-agent-server-failure-soak.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-agent-server-failure-soak.ts)
- [`scripts/t005-token-economics-compare.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-token-economics-compare.ts)
- [`scripts/t005-retrieval-economics-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-retrieval-economics-regression.ts)
- [`scripts/t005-retrieval-quality-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-retrieval-quality-regression.ts)
- [`scripts/t005-semantic-quality-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-semantic-quality-regression.ts)
- [`scripts/t005-real-semantic-partial-regression.ts`](/Applications/workspace/ailab/research/app/openteam-studio-run/scripts/t005-real-semantic-partial-regression.ts)

## 当前状态

T004、T005 当前阶段的主干能力已经落地。README 只保留项目定位、核心接口和使用约定；详细过程、实验结论和阶段性报告统一留在 [PROJECT.md](/Applications/workspace/ailab/research/app/openteam-studio-run/PROJECT.md)。
