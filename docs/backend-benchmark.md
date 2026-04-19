# Live Backend Benchmark Design Note

最后更新：2026-04-19

Live Backend Benchmark 是 AgentServer 后续的独立模块。本阶段只沉淀设计，不实现 runner、评分存储或线上探索策略。

## 目标

Benchmark 的目标不是让每个真实用户请求都由所有 backend 跑一遍。真实任务默认仍应只选择一个主 backend，以控制 token、延迟和 workspace 冲突。

Benchmark 负责长期回答：

- Codex、Claude Code、Gemini、自研 agent 分别擅长什么任务？
- 某个 backend 在某个 repo、语言、工具链、任务类型上的成功率和风险如何？
- 在成本、延迟、质量、可审计性之间，当前最值得路由给哪个 backend？
- 哪些 backend 只适合 review / diagnose / summarize，不适合直接写 workspace？

首版评分对象只覆盖 strategic backend set：

```text
codex
claude-code
gemini
self-hosted-agent
```

experimental、compatibility、legacy backend 可以被显式调用，但不进入首版 benchmark 复杂度。

## 能力分类

Benchmark 需要同时记录原子能力和应用场景。

原子能力示例：

| 能力 | 含义 |
|---|---|
| `code_review` | 发现 bug、风险、遗漏测试和边界条件 |
| `implementation` | 按需求稳定修改文件并保持风格一致 |
| `debugging` | 复现、定位和解释失败原因 |
| `test_repair` | 根据测试失败修复代码或测试 |
| `large_context_reading` | 阅读大型仓库、长文档、多文件依赖 |
| `tool_reliability` | 工具调用、文件编辑、命令执行是否稳定 |
| `handoff_quality` | 给下一个 backend 的 summary 是否可执行 |
| `state_transparency` | 是否暴露结构化事件、readState、tool/approval 状态 |
| `sandbox_fit` | 是否能在目标 workspace/sandbox 策略下安全运行 |

应用场景示例：

| 场景 | 典型 stage |
|---|---|
| 小型 bugfix | diagnose -> implement -> verify |
| 大规模重构 | plan -> implement -> review |
| PR review | review -> summarize |
| 失败测试修复 | diagnose -> implement -> verify |
| 多文件资料整合 | diagnose / summarize |
| 高风险生产代码修改 | diagnose -> implement -> review -> verify |

## 评分 Schema

Benchmark 分数应该是带置信度和成本画像的事实记录，而不是单一排行榜。

建议最小记录：

```ts
type BackendBenchmarkScore = {
  backend: 'codex' | 'claude-code' | 'gemini' | 'self-hosted-agent';
  capability: string;
  scenario?: string;
  repoFingerprint?: string;
  language?: string;
  score: number;        // 0..1 quality estimate
  confidence: number;   // 0..1 evidence confidence
  sampleCount: number;
  cost: {
    medianInputTokens?: number;
    medianOutputTokens?: number;
    medianLatencyMs?: number;
    failureRate?: number;
  };
  evidence: Array<{
    source: 'offline_benchmark' | 'real_run' | 'user_feedback' | 'replay' | 'shadow_review' | 'exploration';
    runId?: string;
    stageId?: string;
    observedAt: string;
    summary: string;
  }>;
  updatedAt: string;
};
```

分数解释：

- `score` 表示质量估计。
- `confidence` 表示这个质量估计有多可靠。
- `sampleCount` 防止少量成功样本被误读为强结论。
- `cost` 让 orchestrator 能在质量之外考虑 token、延迟和失败率。

## 评分来源

真实任务通常只运行一个主 backend，因此 benchmark 不能依赖“每次请求所有 backend 都完整执行”。

可用信号：

| 来源 | 适用 | 成本 |
|---|---|---|
| Offline benchmark | 固定任务集、回归测试、能力对比 | 可控，但可能脱离真实任务 |
| Real run outcome | 被选中 backend 的真实结果 | 低成本，只有被选中 backend 的直接标签 |
| User feedback | 接受、拒绝、返工、手动修复 | 高价值，但稀疏 |
| Replay | 用历史任务离线重跑其它 backend | 中高成本，可批量调度 |
| Shadow review | 只读 review，不写 workspace | 比完整执行便宜，适合评估 review/debug |
| Exploration | 小比例流量尝试非默认 backend | 有成本和风险，需要强保护 |

被选中 backend 可以从真实 run 中直接得分。未被选中 backend 通过 replay、只读 shadow review、低比例 exploration、以及离线任务集逐步更新相对分。

## 节约 Token 的策略

线上主请求默认只跑一个主 backend。Benchmark 更新采用低频、低风险、异步策略：

1. 对高价值任务保存 canonical handoff、workspace facts、diff/test output 和 stage result。
2. 在后台选择少量任务做 replay 或只读 shadow review。
3. 对未执行 backend 只评估它能安全评估的 stage，例如 review、diagnose、summarize。
4. 对 workspace 写操作使用独立 worktree 或临时 workspace，不污染用户主 run。
5. 把探索比例设为 policy 参数，例如每个 capability 每天最多 N 个 replay。

这让 benchmark 能逐步学习，同时不让真实请求变成多 backend 竞赛。

## 与 Orchestrator 的关系

Benchmark 给 orchestrator 提供路由信号，但不替代 orchestrator。

```text
Live Benchmark
  -> score / confidence / cost profile

Orchestrator Policy
  -> capability requirements
  -> stage dependency graph
  -> backend selection
  -> failure / retry / fallback policy
```

Orchestrator 消费 benchmark 时应遵守：

- benchmark score 只是信号之一，还要看 capability、sandbox、approval、workspace ownership、用户偏好和成本预算。
- 低置信度高分不能直接覆盖安全策略。
- 写 workspace 的 stage 必须优先满足 adapter capability 和 sandbox policy。
- fallback 不能在执行中途静默切换；必须形成新的 stage 或明确的 retry/fallback audit。

## 首版不实现项

本阶段不实现：

- benchmark runner
- score database
- LLM judge
- shadow traffic scheduler
- replay queue
- 自动改写 orchestrator policy

本阶段只要求架构和类型设计预留这些数据入口：run、stage、evaluation、metrics、orchestrator ledger、stage boundary verification。

## 后续实现入口

后续可以单独开启任务，例如：

```text
T0xx: Live Backend Benchmark module
- score schema and store
- offline benchmark runner
- replay/shadow job queue
- scoring aggregation
- orchestrator score provider
```

这个模块应保持独立：它读 AgentServer 的 run/stage/evaluation 数据，产出路由参考分数，但不直接执行用户主请求、不直接修改 workspace、不替代 orchestrator。
