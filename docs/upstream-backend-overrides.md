# Upstream Backend Overrides

最后更新：2026-04-19

本文档记录 AgentServer 为接入官方 backend 而不得不修改 upstream 源码的情况。原则上这里应该尽量为空：adapter、bridge、schema mapping、capability policy 和测试默认都放在 AgentServer 自己的 runtime/docs/tests 中，不落到官方 checkout 里。

## Policy

- 官方 backend 目录默认视为可替换 upstream source，可随官方版本重新 clone、pull 或覆盖。
- 首选接入方式是官方 app-server、SDK、JSON-RPC、stdio RPC、HTTP/WebSocket event stream、本地 runtime API 或 schema-backed bridge。
- 不把 AgentServer adapter 逻辑写进官方源码，除非没有其它稳定入口。
- 必须修改官方源码时，改动要小、集中、可重放，并在本文档登记。
- 重新同步官方版本后，先查看本文档，再决定是否需要重放 patch。

## Override Log

### Codex

当前状态：无 AgentServer adapter 必需的官方源码 patch。

本地路径：

```text
server/backend/codex
```

说明：

- 当前设计要求 Codex adapter 优先通过 Codex app-server / SDK / structured protocol 接入。
- AgentServer 侧的 adapter contract、capability、handoff、run/stage ledger 和 public API 文档都位于 AgentServer 自己的源码与 `docs/` 中。
- 若未来为暴露缺失事件、状态查询、approval bridge 或 sandbox metadata 而必须修改 Codex 官方源码，需在下方新增记录。

待记录模板：

```text
backend: codex
local path: server/backend/codex
upstream ref: <commit/tag/date>
modified files:
  - <path>
purpose:
  - <why this patch is needed>
replay after upstream update:
  - <steps/checks>
owner:
  - <optional>
```

### Gemini

当前状态：无 AgentServer adapter 必需的官方源码 patch。

本地路径：

```text
server/backend/gemini
```

待记录模板同上。

### Claude Code

当前状态：无 AgentServer adapter 必需的官方源码 patch。

本地路径：

```text
<pending>
```

待记录模板同上。
