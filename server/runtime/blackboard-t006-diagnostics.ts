import type { BlackboardTaskStatus, CompletionEvidenceRequirements, TaskFact } from '../../core/runtime/blackboard-types.js';
import { requiresStructuredSourceEvidence } from '../../core/runtime/task-evidence.js';
import { deriveDoneTaskIntegrityGaps } from '../../core/runtime/done-task-integrity.js';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { deriveBlackboardTaskDependencyHandoffs } from '../../core/runtime/blackboard-agent-context.js';
import { extractTaskEvidenceBlock } from '../ws/task-completion-evidence.js';

const PHASE_B_SCOPE_STATUSES = new Set<BlackboardTaskStatus>([
  'pending',
  'running',
  'waiting_user',
  'blocked',
  'failed',
]);

function normalizePathRoot(path: string): string {
  const trimmed = String(path || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

function cwdUnderSomeAllowedRoot(cwd: string, allowedRoots: string[]): boolean {
  const nc = normalizePathRoot(cwd);
  if (!nc) {
    return false;
  }
  for (const ar of allowedRoots) {
    const na = normalizePathRoot(ar);
    if (!na) {
      continue;
    }
    if (nc === na || nc.startsWith(`${na}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * T006 阶段 B（v3 §三 · executionScope）：读快照时检查 TaskFact.executionScope 是否缺关键字段、
 * cwd 是否在 allowedRoots 之下（与 `canAgentServeExecutionScope` 中 servedRoots 正交，此处仅结构健康度）。
 */
export function derivePhaseBExecutionScopeHints(tasks: TaskFact[]): Array<{
  taskId: string;
  requestId: string;
  status: string;
  issues: string[];
}> {
  const out: Array<{ taskId: string; requestId: string; status: string; issues: string[] }> = [];

  for (const task of tasks) {
    if (!PHASE_B_SCOPE_STATUSES.has(task.status)) {
      continue;
    }
    const issues: string[] = [];
    const es = task.executionScope;
    const ws = String(es?.workspaceId || '').trim();
    const cwd = String(es?.cwd || '').trim();
    const art = String(es?.artifactsRoot || '').trim();
    const roots = Array.isArray(es?.allowedRoots) ? es.allowedRoots : [];

    if (!ws) {
      issues.push('executionScope.workspaceId 为空；tick 时 workspaceIds 过滤可能无法匹配');
    }
    if (!cwd) {
      issues.push('executionScope.cwd 为空；claim 时 servedRoots 与 cwd 前缀校验无法生效');
    }
    if (!art) {
      issues.push('executionScope.artifactsRoot 为空；产物目录不明确');
    }
    if (roots.length === 0 && cwd) {
      issues.push('executionScope.allowedRoots 为空但 cwd 已设置；与拆单默认 [cwd] 行为不一致');
    } else if (roots.length > 0 && cwd && !cwdUnderSomeAllowedRoot(cwd, roots)) {
      issues.push('executionScope.cwd 不在 allowedRoots 任一前缀之下；与 claim 路径预期不一致');
    }

    if (issues.length > 0) {
      out.push({
        taskId: task.id,
        requestId: task.requestId,
        status: task.status,
        issues,
      });
    }
  }

  return out;
}

/**
 * 对已为 `done` 且带 `evidenceRequirements` 的任务复算验收（用于发现绕过校验的写入或历史脏数据）。
 */
export function deriveDoneEvidenceIntegrityGaps(args: {
  teamId: string;
  chatSessionId: string;
  tasks: TaskFact[];
}): Array<{ taskId: string; requestId: string; reasons: string[] }> {
  const teamChatStore = getTeamChatStore();
  return deriveDoneTaskIntegrityGaps({
    teamChatStore,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    tasks: args.tasks,
  });
}

const PHASE_E_OPEN_STATUSES = new Set<BlackboardTaskStatus>(['pending', 'running', 'waiting_user', 'blocked']);

const MAX_PHASE_E_OPEN_ROWS = 48;

function summarizeEvidenceRulesForDiagnostics(req: CompletionEvidenceRequirements): string[] {
  const lines: string[] = [];
  if (req.requireRuntimeToolCall) {
    lines.push('requireRuntimeToolCall');
  }
  if (req.requireSummaryArtifact) {
    lines.push('requireSummaryArtifact（summary.md）');
  }
  if (typeof req.minSourceCount === 'number') {
    lines.push(`minSourceCount=${req.minSourceCount}`);
  }
  if (typeof req.maxSourceAgeHours === 'number') {
    lines.push(`maxSourceAgeHours=${req.maxSourceAgeHours}`);
  }
  if (req.requireSourceLinks) {
    lines.push('requireSourceLinks');
  }
  return lines;
}

/**
 * T006 阶段 E：未结案且带 `evidenceRequirements` 的任务 — 暴露与 `task-completion-evidence` / coordinator 提示
 * **同源**的门槛摘要，并标注当前 `result` 是否已含可解析的 `[[TASK_EVIDENCE]]`（联调对照用，不替代运行时验收）。
 */
export function derivePhaseEOpenTaskEvidenceExpectations(tasks: TaskFact[]): Array<{
  taskId: string;
  requestId: string;
  status: string;
  structuredSource: boolean;
  rulesSummary: string[];
  hasTaskEvidenceBlock: boolean;
  /** `[[TASK_EVIDENCE]]` 内结构化 sources 条数；无块或未解析为 null */
  sourceCountInBlock: number | null;
}> {
  const out: Array<{
    taskId: string;
    requestId: string;
    status: string;
    structuredSource: boolean;
    rulesSummary: string[];
    hasTaskEvidenceBlock: boolean;
    sourceCountInBlock: number | null;
  }> = [];

  for (const task of tasks) {
    if (!PHASE_E_OPEN_STATUSES.has(task.status) || !task.evidenceRequirements) {
      continue;
    }
    const req = task.evidenceRequirements;
    let rulesSummary = summarizeEvidenceRulesForDiagnostics(req);
    if (rulesSummary.length === 0) {
      rulesSummary = ['evidenceRequirements 已设置（无 minSourceCount / requireSourceLinks / 工具类门槛字段）'];
    }
    const extracted = extractTaskEvidenceBlock(String(task.result || ''));
    const rawSources = extracted.payload?.sources;
    const sourceCountInBlock = Array.isArray(rawSources)
      ? rawSources.length
      : extracted.hasBlock
        ? 0
        : null;

    out.push({
      taskId: task.id,
      requestId: task.requestId,
      status: task.status,
      structuredSource: requiresStructuredSourceEvidence(req),
      rulesSummary,
      hasTaskEvidenceBlock: extracted.hasBlock,
      sourceCountInBlock,
    });
    if (out.length >= MAX_PHASE_E_OPEN_ROWS) {
      break;
    }
  }

  return out;
}

/**
 * T006 阶段 F（v3 §2.7、§四）：`GET /blackboard` 响应元数据 — 快照生成时刻 + 传输/兜底策略说明（静态文案，便于联调留档）。
 * 与浏览器 WebSocket、UI「兜底轮询」对照，**不替代**事件丢失时的根因分析。
 */
export function derivePhaseFBlackboardSnapshotMeta(): {
  snapshotGeneratedAt: string;
  transportNotes: string[];
} {
  return {
    snapshotGeneratedAt: new Date().toISOString(),
    transportNotes: [
      '主路径：浏览器 WebSocket 收到 team-status、blackboard-*、agent-* 等事件后，防抖触发 GET /api/teams/:teamId/blackboard，拉取当前会话黑板快照（可多次拉取，等价事件驱动的增量补全）。',
      '字段 snapshotGeneratedAt 为本 JSON 在服务端生成时刻；可与浏览器控制台 WS 时间线对照，排查「有推送但黑板未更新」等时序问题。',
      '兜底：页面「黑板 · 兜底轮询」秒数仅作断流或调试备份，0 为关闭；不应依赖轮询掩盖 coordinator 未派发、任务未认领等逻辑问题。',
    ],
  };
}

/**
 * 检测 DAG 依赖边是否跨 `requestId`（联调时常见配置错误）。
 */
export function deriveCrossRequestDependencyHints(tasks: TaskFact[]): Array<{
  taskId: string;
  requestId: string;
  dependencyId: string;
  dependencyRequestId: string;
  hint: string;
}> {
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const hints: Array<{
    taskId: string;
    requestId: string;
    dependencyId: string;
    dependencyRequestId: string;
    hint: string;
  }> = [];

  for (const task of tasks) {
    for (const depId of task.requires || []) {
      const dep = byId.get(depId);
      if (!dep) {
        continue;
      }
      if (dep.requestId !== task.requestId) {
        hints.push({
          taskId: task.id,
          requestId: task.requestId,
          dependencyId: depId,
          dependencyRequestId: dep.requestId,
          hint: `依赖 ${depId} 属于 request「${dep.requestId}」，当前任务属于「${task.requestId}」，可能导致跨 request 的 DAG 无法推进。`,
        });
      }
    }
  }

  return hints;
}

/**
 * T006：显式 supersede 边健康度。replacement/retry/handoff 现在通过 `supersedesTaskId` 建边，
 * 这里直接暴露缺失目标、跨 request 与“目标已结束后仍继续 supersede”等快照级异常。
 */
export function deriveExplicitSupersedeHints(tasks: TaskFact[]): Array<{
  taskId: string;
  requestId: string;
  supersedesTaskId: string;
  issue: string;
}> {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const hints: Array<{
    taskId: string;
    requestId: string;
    supersedesTaskId: string;
    issue: string;
  }> = [];

  for (const task of tasks) {
    const supersedesTaskId = String(task.supersedesTaskId || '').trim();
    if (!supersedesTaskId) {
      continue;
    }
    const target = byId.get(supersedesTaskId);
    if (!target) {
      hints.push({
        taskId: task.id,
        requestId: task.requestId,
        supersedesTaskId,
        issue: `supersedesTaskId 指向的任务「${supersedesTaskId}」不存在于当前黑板快照；需排查 materialize / archive / 请求过滤是否丢边。`,
      });
      continue;
    }
    if (target.requestId !== task.requestId) {
      hints.push({
        taskId: task.id,
        requestId: task.requestId,
        supersedesTaskId,
        issue: `supersede 边跨 request：当前任务属于「${task.requestId}」，目标任务属于「${target.requestId}」；这会让 recovery 与 final gating 难以确定性推进。`,
      });
      continue;
    }
    if (target.status === 'done' && task.status !== 'done') {
      hints.push({
        taskId: task.id,
        requestId: task.requestId,
        supersedesTaskId,
        issue: `目标任务「${supersedesTaskId}」已是 done，但 superseding 任务仍为「${task.status}」；若并非历史回放，请确认是否错误地对已终结任务继续建立 supersede 边。`,
      });
    }
  }

  return hints;
}

export function deriveDependencyHandoffHints(args: {
  teamId: string;
  chatSessionId: string;
  tasks: TaskFact[];
}): Array<{
  taskId: string;
  requestId: string;
  dependencyTaskId: string;
  dependencyStatus: string | null;
  blocking: boolean;
  issue: string;
}> {
  const board = getBlackboardStore();
  const hints: Array<{
    taskId: string;
    requestId: string;
    dependencyTaskId: string;
    dependencyStatus: string | null;
    blocking: boolean;
    issue: string;
  }> = [];

  for (const task of args.tasks) {
    if (!task.requires.length) {
      continue;
    }
    const handoffs = deriveBlackboardTaskDependencyHandoffs(board, args.teamId, args.chatSessionId, task);
    const handoffIds = new Set(handoffs.map((item) => item.taskId));
    for (const dependencyTaskId of task.requires) {
      if (handoffIds.has(dependencyTaskId)) {
        continue;
      }
      const dependency = board.get(args.teamId, args.chatSessionId, dependencyTaskId);
      if (!dependency) {
        hints.push({
          taskId: task.id,
          requestId: task.requestId,
          dependencyTaskId,
          dependencyStatus: null,
          blocking: true,
          issue: `requires 指向的依赖任务「${dependencyTaskId}」不存在于当前黑板快照，无法生成 handoff projection。`,
        });
        continue;
      }
      if (dependency.status === 'running' || dependency.status === 'pending') {
        hints.push({
          taskId: task.id,
          requestId: task.requestId,
          dependencyTaskId,
          dependencyStatus: dependency.status,
          blocking: false,
          issue: `依赖任务「${dependencyTaskId}」当前为 ${dependency.status}，下游任务仍在等待其形成可交接的 done handoff。`,
        });
        continue;
      }
      if (dependency.status !== 'done') {
        hints.push({
          taskId: task.id,
          requestId: task.requestId,
          dependencyTaskId,
          dependencyStatus: dependency.status,
          blocking: true,
          issue: `依赖任务「${dependencyTaskId}」当前为 ${dependency.status}，尚未形成可交接的 done handoff。`,
        });
        continue;
      }
      hints.push({
        taskId: task.id,
        requestId: task.requestId,
        dependencyTaskId,
        dependencyStatus: dependency.status,
        blocking: true,
        issue: `依赖任务「${dependencyTaskId}」虽已 done，但缺少可投影的结果摘要；应优先补齐黑板结果事实，而不是让下游猜路径。`,
      });
    }
  }

  return hints;
}

/**
 * 当前会话任务快照上的 lease 健康度（v3 §2.4），供联调阶段 C 与 UI 可见性。
 * 注：是否执行 `lease_expired_reset` 取决于运行时 sweep，此处仅反映「读快照时」状态。
 */
export function deriveLeaseDiagnostics(
  tasks: TaskFact[],
  nowMs: number = Date.now(),
): {
  runningCount: number;
  expiredLeaseTasks: Array<{
    taskId: string;
    requestId: string;
    owner: string | null;
    leaseUntil: number | null;
    lastHeartbeatAt: number | null;
    msSinceLastHeartbeat: number | null;
    state: 'awaiting_heartbeat' | 'stale';
    hint: string;
  }>;
  runningWithoutLeaseUntil: Array<{ taskId: string; requestId: string; hint: string }>;
  /** 所有仍有效的 running lease 中，距离过期最近的一段毫秒数；无则 null */
  minLeaseRemainingMs: number | null;
} {
  const running = tasks.filter((task) => task.status === 'running');
  const expiredLeaseTasks: Array<{
    taskId: string;
    requestId: string;
    owner: string | null;
    leaseUntil: number | null;
    lastHeartbeatAt: number | null;
    msSinceLastHeartbeat: number | null;
    state: 'awaiting_heartbeat' | 'stale';
    hint: string;
  }> = [];
  const runningWithoutLeaseUntil: Array<{ taskId: string; requestId: string; hint: string }> = [];

  for (const task of running) {
    const lu = task.leaseUntil;
    if (lu == null || !Number.isFinite(lu)) {
      runningWithoutLeaseUntil.push({
        taskId: task.id,
        requestId: task.requestId,
        hint: 'status=running 但缺少有效 leaseUntil，与设计 §2.4 不一致，需排查写入路径。',
      });
      continue;
    }
    if (lu < nowMs) {
      const hb = typeof task.lastHeartbeatAt === 'number' && Number.isFinite(task.lastHeartbeatAt)
        ? task.lastHeartbeatAt
        : null;
      const msSinceLastHeartbeat = hb != null ? Math.max(0, nowMs - hb) : null;
      const state: 'awaiting_heartbeat' | 'stale' =
        msSinceLastHeartbeat != null && msSinceLastHeartbeat <= DEFAULT_BLACKBOARD_LEASE_DURATION_MS
          ? 'awaiting_heartbeat'
          : 'stale';
      expiredLeaseTasks.push({
        taskId: task.id,
        requestId: task.requestId,
        owner: task.owner,
        leaseUntil: lu,
        lastHeartbeatAt: hb,
        msSinceLastHeartbeat,
        state,
        hint:
          state === 'awaiting_heartbeat'
            ? '心跳窗口已超时，但最近仍有心跳：优先等待续期或任务自然完成，不要仅凭 0s 立即判死。'
            : 'leaseUntil 早于当前时间且心跳已陈旧：若长期不恢复 pending，请确认 lease sweep / worker 心跳是否运行。',
      });
    }
  }

  const finiteRemaining = running
    .map((task) => task.leaseUntil)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= nowMs)
    .map((v) => v - nowMs);
  const minLeaseRemainingMs = finiteRemaining.length === 0 ? null : Math.min(...finiteRemaining);

  return {
    runningCount: running.length,
    expiredLeaseTasks,
    runningWithoutLeaseUntil,
    minLeaseRemainingMs,
  };
}

/** 与 BlackboardStore 中分桶逻辑一致（requestId + executionScope.workspaceId） */
const ACTIVE_FOR_BUCKET = new Set<BlackboardTaskStatus>(['pending', 'running', 'waiting_user', 'blocked', 'failed']);

/** 与 `DEFAULT_MAX_ACTIVE_FACTS_PER_BUCKET` 对齐，供 API 诊断展示 */
export const DEFAULT_BLACKBOARD_BUCKET_MAX = 64;

/**
 * 阶段 A：当前拉取会话下，任务上的 teamId / chatSessionId 是否与 API 路径一致；running 是否有 runId。
 */
export function deriveSessionIdentityHints(
  tasks: TaskFact[],
  ctx: { teamId: string; chatSessionId: string },
): Array<{ taskId: string; issue: string }> {
  const issues: Array<{ taskId: string; issue: string }> = [];

  for (const task of tasks) {
    if (task.teamId !== ctx.teamId) {
      issues.push({
        taskId: task.id,
        issue: `task.teamId「${task.teamId}」与当前黑板 teamId「${ctx.teamId}」不一致`,
      });
    }
    if (task.chatSessionId !== ctx.chatSessionId) {
      issues.push({
        taskId: task.id,
        issue: `task.chatSessionId「${task.chatSessionId}」与当前会话「${ctx.chatSessionId}」不一致`,
      });
    }
    if (task.status === 'running' && !String(task.currentRunId || '').trim()) {
      issues.push({
        taskId: task.id,
        issue: 'status=running 但缺少 currentRunId（v3 中 runId 为执行实例身份）',
      });
    }
  }

  return issues;
}

/**
 * 阶段 A · runId（v3「四层身份」）：`currentRunId` 仅应对 **running** 等执行中状态有意义；
 * `waiting_user` 由 store 清空 runId；`pending` 若仍带 runId 多为残留，易与新一轮认领混淆。
 */
export function deriveRunIdLifecycleHints(tasks: TaskFact[]): Array<{ taskId: string; issue: string }> {
  const out: Array<{ taskId: string; issue: string }> = [];
  for (const task of tasks) {
    const rid = String(task.currentRunId || '').trim();
    if (!rid) {
      continue;
    }
    if (task.status === 'waiting_user') {
      out.push({
        taskId: task.id,
        issue: 'status=waiting_user 但仍带 currentRunId；与设计（等待输入时应清空执行实例）不一致',
      });
      continue;
    }
    if (task.status === 'pending') {
      out.push({
        taskId: task.id,
        issue: 'status=pending 仍带 currentRunId；通常为 reset/认领前残留，易与 v3「taskId 稳定、runId 每轮重建」混淆，请核对写入路径',
      });
    }
  }
  return out;
}

/**
 * 阶段 A（v3 §2.1–2.2、§2.6）：Active / Archive 分层与四层身份字段完整性。
 * - duplicateIdsAcrossActiveAndArchive：同一 taskId 不应同时出现在 active 与 archive（数据损坏）。
 * - emptyCoreIdentityFields：id / teamId / chatSessionId / requestId 缺失。
 * - nonDoneInArchive：归档区应为 done；若出现其它状态则异常。
 * - doneCounts：便于联调对照「done 仍在 Active 直至 archive」。
 * - layerFactCounts：各层任务总条数（与 GET blackboard 为每条 task 标注的 `boardLayer` 同源，便于对照 §2.6）。
 */
export function derivePhaseAIdentityAnomalies(state: {
  active: TaskFact[];
  archive: TaskFact[];
}): {
  duplicateIdsAcrossActiveAndArchive: string[];
  emptyCoreIdentityFields: Array<{ taskId: string; field: string }>;
  nonDoneInArchive: Array<{ taskId: string; status: string }>;
  doneCounts: { inActive: number; inArchive: number };
  /** Active / Archive 中 TaskFact 条数（含非 done）；应与 `boardLayer` 分层一致 */
  layerFactCounts: { inActive: number; inArchive: number };
  runIdLifecycleHints: Array<{ taskId: string; issue: string }>;
  /** 与 BlackboardStore.validateTaskFact 及 v3 §2.2 对齐的说明（非运行时检测） */
  doneImmutabilityNote: string;
} {
  const activeIdSet = new Set(state.active.map((t) => t.id));
  const duplicateIdsAcrossActiveAndArchive = state.archive
    .filter((t) => activeIdSet.has(t.id))
    .map((t) => t.id);

  const emptyCoreIdentityFields: Array<{ taskId: string; field: string }> = [];
  const scan = (t: TaskFact) => {
    const tid = String(t.id || '').trim() || '(missing-id)';
    const core: Array<[string, unknown]> = [
      ['id', t.id],
      ['teamId', t.teamId],
      ['chatSessionId', t.chatSessionId],
      ['requestId', t.requestId],
    ];
    for (const [field, val] of core) {
      if (typeof val !== 'string' || !val.trim()) {
        emptyCoreIdentityFields.push({ taskId: tid, field });
      }
    }
  };
  for (const t of state.active) {
    scan(t);
  }
  for (const t of state.archive) {
    scan(t);
  }

  const nonDoneInArchive = state.archive
    .filter((t) => t.status !== 'done')
    .map((t) => ({ taskId: t.id, status: t.status }));

  const allTasks = [...state.active, ...state.archive];
  const runIdLifecycleHints = deriveRunIdLifecycleHints(allTasks);

  return {
    duplicateIdsAcrossActiveAndArchive,
    emptyCoreIdentityFields,
    nonDoneInArchive,
    doneCounts: {
      inActive: state.active.filter((t) => t.status === 'done').length,
      inArchive: state.archive.filter((t) => t.status === 'done').length,
    },
    layerFactCounts: {
      inActive: state.active.length,
      inArchive: state.archive.length,
    },
    runIdLifecycleHints,
    doneImmutabilityNote:
      'BlackboardStore 对已有 done 写入仅允许 revision 递增且 result/goal/requires 等保持不变；修正结论请新建带 supersedesTaskId 的 replacement task，勿覆盖原 done（v3 §2.2）。',
  };
}

/**
 * 阶段 A：校验 GET blackboard 为每条 task 标注的 `boardLayer` 计数与 store 中 `layerFactCounts` 一致。
 * 若不一致（含 duplicate taskId、遗漏标注），联调时可立即发现「快照与分层真相」漂移。
 */
export function deriveBoardLayerPayloadAlignment(args: {
  layerFactCounts: { inActive: number; inArchive: number };
  tasks: Array<{ boardLayer?: 'active' | 'archive' }>;
}): {
  aligned: boolean;
  payloadCounts: { inActive: number; inArchive: number };
  storeCounts: { inActive: number; inArchive: number };
  hint?: string;
} {
  const storeCounts = { ...args.layerFactCounts };
  let inActive = 0;
  let inArchive = 0;
  let unknown = 0;
  for (const t of args.tasks) {
    if (t.boardLayer === 'archive') {
      inArchive += 1;
    } else if (t.boardLayer === 'active') {
      inActive += 1;
    } else {
      unknown += 1;
    }
  }
  const payloadCounts = { inActive, inArchive };
  const aligned =
    unknown === 0
    && inActive === storeCounts.inActive
    && inArchive === storeCounts.inArchive;
  return {
    aligned,
    payloadCounts,
    storeCounts,
    hint: aligned
      ? undefined
      : unknown > 0
        ? `有 ${unknown} 条 task 缺少 boardLayer，与阶段 A 标注约定不一致。`
        : `GET tasks 按 boardLayer 计数为 active ${inActive} / archive ${inArchive}，store 分层为 ${storeCounts.inActive} / ${storeCounts.inArchive}；常见于 active/archive 重复 taskId 或 list 与 getState 不一致。`,
  };
}

/** 与 `BlackboardStore` 默认 `leaseDurationMs` 对齐，用于读快照心跳陈旧度启发（非运行时配置） */
export const DEFAULT_BLACKBOARD_LEASE_DURATION_MS = 5 * 60 * 1000;

const PHASE_C_MAX_ROWS = 32;

/**
 * T006 阶段 C（v3 §2.4、§5.2）：lease 过期履历、Recovery 面（blocked/failed）、running 心跳可见性。
 * 不替代 lease sweep / 运行时心跳，仅辅助联调对照日志与设计语义。
 */
export function derivePhaseCRecoveryAndLeaseHints(
  tasks: TaskFact[],
  nowMs: number = Date.now(),
): {
  leaseExpiredResetHistory: Array<{ taskId: string; requestId: string; runId: string; at: number }>;
  terminalBlockedOrFailed: Array<{
    taskId: string;
    requestId: string;
    status: 'blocked' | 'failed';
    message: string;
  }>;
  runningHeartbeatHints: Array<{ taskId: string; requestId: string; hint: string }>;
  /** 当前 running 任务的租约与心跳读快照（最多 32 条），便于对照 §2.4 续约节奏 */
  runningLeaseDetail: Array<{
    taskId: string;
    requestId: string;
    owner: string | null;
    leaseUntil: number | null;
    lastHeartbeatAt: number | null;
    heartbeatState: 'healthy' | 'awaiting_heartbeat' | 'stale' | 'missing_lease';
    heartbeatWindowMs: number | null;
    leaseRemainingMs: number | null;
    heartbeatOverdueMs: number | null;
    msSinceLastHeartbeat: number | null;
  }>;
} {
  const leaseExpiredResetHistory: Array<{ taskId: string; requestId: string; runId: string; at: number }> = [];
  const terminalBlockedOrFailed: Array<{
    taskId: string;
    requestId: string;
    status: 'blocked' | 'failed';
    message: string;
  }> = [];
  const runningHeartbeatHints: Array<{ taskId: string; requestId: string; hint: string }> = [];

  for (const task of tasks) {
    for (const ev of task.failureHistory || []) {
      if (ev.resetKind === 'lease_expired_reset') {
        leaseExpiredResetHistory.push({
          taskId: task.id,
          requestId: task.requestId,
          runId: ev.runId,
          at: ev.at,
        });
      }
    }

    if (task.status === 'blocked' || task.status === 'failed') {
      const message = String(task.blockedBy?.message || task.result || '').trim().slice(0, 220) || '(no message)';
      terminalBlockedOrFailed.push({
        taskId: task.id,
        requestId: task.requestId,
        status: task.status,
        message,
      });
    }

    if (task.status === 'running') {
      const lu = task.leaseUntil;
      const hb = task.lastHeartbeatAt;
      if (hb == null || !Number.isFinite(hb)) {
        runningHeartbeatHints.push({
          taskId: task.id,
          requestId: task.requestId,
          hint: 'status=running 但缺少 lastHeartbeatAt，无法对照 §2.4 续约节奏',
        });
      } else if (typeof lu === 'number' && Number.isFinite(lu) && lu <= nowMs) {
        const elapsed = nowMs - hb;
        if (elapsed <= DEFAULT_BLACKBOARD_LEASE_DURATION_MS) {
          runningHeartbeatHints.push({
            taskId: task.id,
            requestId: task.requestId,
            hint: `心跳窗口刚超时约 ${Math.round((nowMs - lu) / 1000)}s，但 lastHeartbeatAt 距今仅 ${Math.round(elapsed / 1000)}s：优先等待下一次续期或任务完成。`,
          });
        } else {
          runningHeartbeatHints.push({
            taskId: task.id,
            requestId: task.requestId,
            hint: `lease 与 lastHeartbeatAt 都已陈旧（距上次心跳约 ${Math.round(elapsed / 1000)}s）：更接近真实卡死，应排查 worker 心跳或 reset/sweep。`,
          });
        }
      } else if (
        typeof lu === 'number'
        && Number.isFinite(lu)
        && lu > nowMs
        && nowMs - hb > DEFAULT_BLACKBOARD_LEASE_DURATION_MS * 2
      ) {
        runningHeartbeatHints.push({
          taskId: task.id,
          requestId: task.requestId,
          hint: `lastHeartbeatAt 距今约 ${Math.round((nowMs - hb) / 1000)}s，lease 仍有效时请确认心跳是否持续送达（store 默认租约 ${DEFAULT_BLACKBOARD_LEASE_DURATION_MS / 60000}min）`,
        });
      }
    }
  }

  leaseExpiredResetHistory.sort((a, b) => b.at - a.at);

  const runningLeaseDetail: Array<{
    taskId: string;
    requestId: string;
    owner: string | null;
    leaseUntil: number | null;
    lastHeartbeatAt: number | null;
    heartbeatState: 'healthy' | 'awaiting_heartbeat' | 'stale' | 'missing_lease';
    heartbeatWindowMs: number | null;
    leaseRemainingMs: number | null;
    heartbeatOverdueMs: number | null;
    msSinceLastHeartbeat: number | null;
  }> = [];

  for (const task of tasks) {
    if (task.status !== 'running') {
      continue;
    }
    const lu = task.leaseUntil;
    const hb = task.lastHeartbeatAt;
    const luNum = typeof lu === 'number' && Number.isFinite(lu) ? lu : null;
    const hbNum = typeof hb === 'number' && Number.isFinite(hb) ? hb : null;
    const heartbeatWindowMs =
      luNum != null && hbNum != null && luNum >= hbNum
        ? luNum - hbNum
        : luNum != null && typeof task.claimedAt === 'number' && Number.isFinite(task.claimedAt) && luNum >= task.claimedAt
          ? luNum - task.claimedAt
          : DEFAULT_BLACKBOARD_LEASE_DURATION_MS;
    const heartbeatOverdueMs =
      luNum != null && luNum <= nowMs
        ? nowMs - luNum
        : null;
    const heartbeatState: 'healthy' | 'awaiting_heartbeat' | 'stale' | 'missing_lease' =
      luNum == null
        ? 'missing_lease'
        : luNum > nowMs
          ? 'healthy'
          : hbNum != null && nowMs - hbNum <= DEFAULT_BLACKBOARD_LEASE_DURATION_MS
            ? 'awaiting_heartbeat'
            : 'stale';
    const leaseRemainingMs =
      luNum != null && luNum > nowMs
        ? luNum - nowMs
        : luNum != null && luNum <= nowMs
          ? 0
          : null;
    const msSinceLastHeartbeat = hbNum != null ? nowMs - hbNum : null;
    runningLeaseDetail.push({
      taskId: task.id,
      requestId: task.requestId,
      owner: task.owner,
      leaseUntil: luNum,
      lastHeartbeatAt: hbNum,
      heartbeatState,
      heartbeatWindowMs,
      leaseRemainingMs,
      heartbeatOverdueMs,
      msSinceLastHeartbeat,
    });
  }

  return {
    leaseExpiredResetHistory: leaseExpiredResetHistory.slice(0, PHASE_C_MAX_ROWS),
    terminalBlockedOrFailed: terminalBlockedOrFailed.slice(0, PHASE_C_MAX_ROWS),
    runningHeartbeatHints,
    runningLeaseDetail: runningLeaseDetail.slice(0, PHASE_C_MAX_ROWS),
  };
}

/**
 * 阶段 F：按 (requestId, workspaceId) 分桶统计活跃任务数，接近/达到上限时便于联调（v3 §2.5）。
 */
export function deriveBucketPressure(
  tasks: TaskFact[],
  maxPerBucket: number = DEFAULT_BLACKBOARD_BUCKET_MAX,
): {
  buckets: Array<{
    requestId: string;
    workspaceId: string;
    activeCount: number;
    atOrOverLimit: boolean;
  }>;
  maxObserved: number;
  maxPerBucket: number;
} {
  const counts = new Map<string, { requestId: string; workspaceId: string; n: number }>();

  for (const task of tasks) {
    if (!ACTIVE_FOR_BUCKET.has(task.status)) {
      continue;
    }
    const workspaceId = String(task.executionScope?.workspaceId || '').trim() || '(empty)';
    const requestId = String(task.requestId || '').trim() || '(empty)';
    const key = `${requestId}::${workspaceId}`;
    const prev = counts.get(key) || { requestId, workspaceId, n: 0 };
    prev.n += 1;
    counts.set(key, prev);
  }

  const buckets = [...counts.values()]
    .map((row) => ({
      requestId: row.requestId,
      workspaceId: row.workspaceId,
      activeCount: row.n,
      atOrOverLimit: row.n >= maxPerBucket,
    }))
    .sort((a, b) => b.activeCount - a.activeCount);

  const maxObserved = buckets.length === 0 ? 0 : Math.max(...buckets.map((b) => b.activeCount));

  return { buckets, maxObserved, maxPerBucket };
}
