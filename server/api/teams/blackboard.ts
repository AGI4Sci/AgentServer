import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { getBlackboardStore, type BlackboardStore } from '../../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../../core/store/request-state-store.js';
import { compareRequestStateRecords } from '../../../core/store/request-state-store.js';
import { getTeamRuntimeStateStore } from '../../../core/store/team-runtime-state-store.js';
import { getTeamChatStore } from '../../../core/store/team-chat-store.js';
import { error, sendJson, success } from '../../utils/response.js';
import type { DecisionFact, ProposalFact, TaskFact } from '../../../core/runtime/blackboard-types.js';
import type { RequestStateRecord } from '../../../core/store/request-state-store.js';
import { deriveBlackboardTaskDependencyHandoffs } from '../../../core/runtime/blackboard-agent-context.js';
import { normalizeTaskEvidencePayload, requiresStructuredSourceEvidence } from '../../../core/runtime/task-evidence.js';
import { deriveCapabilityCoverageGaps, deriveRosterCapabilityAllowlist } from '../../runtime/blackboard-capability-gaps.js';
import {
  deriveBoardLayerPayloadAlignment,
  deriveBucketPressure,
  deriveCrossRequestDependencyHints,
  deriveDependencyHandoffHints,
  deriveDoneEvidenceIntegrityGaps,
  deriveExplicitSupersedeHints,
  deriveLeaseDiagnostics,
  derivePhaseAIdentityAnomalies,
  derivePhaseBExecutionScopeHints,
  derivePhaseCRecoveryAndLeaseHints,
  derivePhaseEOpenTaskEvidenceExpectations,
  derivePhaseFBlackboardSnapshotMeta,
  deriveSessionIdentityHints,
} from '../../runtime/blackboard-t006-diagnostics.js';
import { deriveOpenTaskProgressSnapshots } from '../../runtime/blackboard-progress-diagnostics.js';
import { probeRequestRuntimeDiagnostics } from '../../runtime/request-runtime-probe.js';
import { getTeamRegistry } from '../../../core/team/registry.js';
import { parseApprovalRequestGoal, parseApprovalResponseResult } from '../../../core/runtime/waiting-user.js';
import {
  resolveBlackboardCoordinatorMode,
  summarizeCoordinatorModeSnapshotForDiagnostics,
} from '../../../core/runtime/blackboard-coordinator.js';
import { deriveRequestClosureMode } from '../../../core/runtime/request-integrity.js';
import { deriveBlackboardFailureTriage } from '../../../core/runtime/request-failure-triage.js';
import { deriveRequestFinalGate } from '../../../core/runtime/request-final-gate.js';
import { deriveRequestAuditSnapshot } from '../../../core/runtime/request-audit.js';
import { deriveProposalLifecycle, isAutoApprovableProposalKind } from '../../../core/runtime/blackboard-proposals.js';
import { triggerBlackboardDispatch } from '../../ws/blackboard-runtime-loop.js';
import { finalizeSynthesizedRequestIfReady } from '../../ws-handler.js';

type BlackboardTaskRole = 'control' | 'substantive';
type BlackboardControlPhase = 'decompose' | 'recovery' | 'synthesize' | null;
type RequestTraceSummaryKind = 'supersede' | 'waiting_user_resume' | 'blocked_recovery' | 'finalization_tick';
type RequestTraceSummaryStatus = 'active' | 'resolved' | 'ready' | 'closed';

type RequestTraceSummaryItem = {
  id: string;
  kind: RequestTraceSummaryKind;
  moduleId: 'M5' | 'M6' | 'M8';
  status: RequestTraceSummaryStatus;
  title: string;
  detail: string;
  taskIds: string[];
  proposalIds: string[];
  decisionIds: string[];
  opIds: string[];
  timestamp: string | null;
};

type CrossRequestDiagnosticItem = {
  requestId: string;
  state: string | null;
  finalPublished: boolean;
  taskCount: number;
  proposalCount: number;
  decisionCount: number;
  gapCount: number;
  activeProtocolModuleIds: Array<'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8'>;
  currentBottleneckModuleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | null;
  waitingUserTaskIds: string[];
  blockedTaskIds: string[];
  readyForFinal: boolean;
  latestOpAt: string | null;
};

const requestReadFinalizationTicks = new Map<string, number>();
const REQUEST_READ_FINALIZATION_TICK_INTERVAL_MS = 2_000;

async function maybeTickRequestFinalizationOnRead(args: {
  teamId: string;
  sessionId: string;
  requestId: string | null;
}): Promise<boolean> {
  const requestId = String(args.requestId || '').trim();
  if (!requestId) {
    return false;
  }
  const requestStore = getRequestStateStore();
  const request = requestStore.getRequestForSession(args.teamId, requestId, args.sessionId);
  if (!request || request.state !== 'ready_for_final' || request.finalPublished) {
    return false;
  }
  const tickKey = `${args.teamId}\n${args.sessionId}\n${requestId}`;
  const now = Date.now();
  const lastTickAt = requestReadFinalizationTicks.get(tickKey) || 0;
  if (now - lastTickAt < REQUEST_READ_FINALIZATION_TICK_INTERVAL_MS) {
    return false;
  }
  requestReadFinalizationTicks.set(tickKey, now);
  try {
    const finalized = finalizeSynthesizedRequestIfReady({
      teamId: args.teamId,
      requestId,
      chatSessionId: args.sessionId,
      coordinatorId: request.coordinatorAgentId || null,
    });
    if (finalized.finalized) {
      return true;
    }

    // Frontend Kanban/explain polling is a safe place to repair a missed finalization wakeup:
    // the dispatch loop is idempotent and will either deliver the pending synthesize task or
    // recover a stale running coordinator task before trying again.
    await triggerBlackboardDispatch({
      teamId: args.teamId,
      requestId,
      chatSessionId: args.sessionId,
    });
    return true;
  } catch (err) {
    console.warn('[API] Failed to tick ready_for_final blackboard request during read:', err);
    return false;
  }
}

function listPersistedBlackboardSessionIdsForRequest(teamId: string, requestId: string): string[] {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return [];
  }
  const teamDir = join(process.cwd(), 'data', 'blackboard', teamId);
  if (!existsSync(teamDir)) {
    return [];
  }
  const sessionIds: string[] = [];
  for (const entry of readdirSync(teamDir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const payload = JSON.parse(readFileSync(join(teamDir, entry), 'utf-8')) as {
        active?: Array<{ requestId?: string }>;
        archive?: Array<{ requestId?: string }>;
      };
      const facts = [...(payload.active || []), ...(payload.archive || [])];
      if (facts.some((fact) => String(fact.requestId || '').trim() === normalizedRequestId)) {
        sessionIds.push(entry.replace(/\.json$/i, ''));
      }
    } catch {
      continue;
    }
  }
  return sessionIds;
}

function findSessionIdForRequest(teamId: string, requestId: string | null): string | null {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return null;
  }
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const chatStore = getTeamChatStore();
  const sessions = chatStore.listSessions(teamId);
  const persistedOnlySessionIds = listPersistedBlackboardSessionIdsForRequest(teamId, normalizedRequestId)
    .filter((sessionId) => !sessions.some((session) => session.sessionId === sessionId));
  const matched = [...sessions.map((session) => session.sessionId), ...persistedOnlySessionIds]
    .map((sessionId) => {
      const sessionSummary = chatStore.getSessionSummary(teamId, sessionId);
      const sessionUpdatedAt = Date.parse(String(sessionSummary?.updatedAt || '')) || 0;
      return {
        sessionId,
        request: requestStore.getRequestForSession(teamId, normalizedRequestId, sessionId),
        facts: board.list(teamId, sessionId, {
          requestId: normalizedRequestId,
          includeArchive: true,
        }),
        sessionUpdatedAt,
      };
    })
    .filter((item) => item.request || item.facts.length > 0)
    .sort((left, right) => {
      if (left.request && right.request) {
        return compareRequestStateRecords(left.request, right.request);
      }
      if (left.request) {
        return -1;
      }
      if (right.request) {
        return 1;
      }
      const factUpdatedDelta =
        Math.max(...right.facts.map((fact) => Number(fact.updatedAt || 0)), 0)
        - Math.max(...left.facts.map((fact) => Number(fact.updatedAt || 0)), 0);
      if (factUpdatedDelta !== 0) {
        return factUpdatedDelta;
      }
      return right.sessionUpdatedAt - left.sessionUpdatedAt;
    });
  return matched[0]?.sessionId || null;
}

function latestIsoTimestamp(values: Array<number | null | undefined>): string | null {
  const latest = values
    .map((value) => Number(value || 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => right - left)[0] || 0;
  return latest > 0 ? new Date(latest).toISOString() : null;
}

function deriveRequestTraceSummary(args: {
  requestId: string;
  requestState: RequestStateRecord | null;
  facts: TaskFact[];
  proposals: ProposalFact[];
  decisions: DecisionFact[];
  ops: ReturnType<BlackboardStore['listOps']>;
  requestAudit: ReturnType<typeof deriveRequestAuditSnapshot>;
}): RequestTraceSummaryItem[] {
  const items: RequestTraceSummaryItem[] = [];
  const factById = new Map(args.facts.map((fact) => [fact.id, fact]));
  const proposalById = new Map(args.proposals.map((proposal) => [proposal.id, proposal]));
  const decisionsByProposalId = (proposalId: string): DecisionFact[] =>
    args.decisions.filter((decision) => decision.proposalId === proposalId);
  const opsFor = (filter: (op: (typeof args.ops)[number]) => boolean) => args.ops.filter(filter);
  const opIdsFor = (filter: (op: (typeof args.ops)[number]) => boolean) => opsFor(filter).map((op) => op.id);
  const opTimesFor = (filter: (op: (typeof args.ops)[number]) => boolean) => opsFor(filter).map((op) => op.timestamp);

  for (const edge of args.requestAudit.supersedeEdges || []) {
    const replacement = factById.get(edge.taskId) || null;
    const original = factById.get(edge.supersedesTaskId) || null;
    const proposal = args.proposals.find((item) =>
      item.payload.taskId === edge.taskId
      || item.payload.supersedesTaskId === edge.supersedesTaskId) || null;
    const proposalDecisions = proposal ? decisionsByProposalId(proposal.id) : [];
    const moduleId: 'M5' | 'M6' = args.requestAudit.historicalWaitingUserTaskIds.includes(edge.supersedesTaskId) ? 'M6' : 'M5';
    items.push({
      id: `supersede:${edge.supersedesTaskId}->${edge.taskId}`,
      kind: 'supersede',
      moduleId,
      status: edge.status === 'done' ? 'resolved' : 'active',
      title: '显式 supersede 接续',
      detail: `task ${edge.taskId} 接续 ${edge.supersedesTaskId}${proposal ? `，来源 proposal ${proposal.id}` : ''}。`,
      taskIds: [edge.supersedesTaskId, edge.taskId],
      proposalIds: proposal ? [proposal.id] : [],
      decisionIds: proposalDecisions.map((decision) => decision.id),
      opIds: opIdsFor((op) =>
        op.taskId === edge.taskId
        || op.taskId === edge.supersedesTaskId
        || (proposal ? op.proposalId === proposal.id : false)),
      timestamp: latestIsoTimestamp([
        original?.updatedAt,
        replacement?.updatedAt,
        proposal?.updatedAt,
        ...proposalDecisions.map((decision) => decision.updatedAt),
        ...opTimesFor((op) =>
          op.taskId === edge.taskId
          || op.taskId === edge.supersedesTaskId
          || (proposal ? op.proposalId === proposal.id : false)),
      ]),
    });
  }

  for (const taskId of [...new Set([...(args.requestAudit.historicalWaitingUserTaskIds || []), ...(args.requestAudit.waitingUserTaskIds || [])])]) {
    const waitingTask = factById.get(taskId) || null;
    const resumeEdges = (args.requestAudit.supersedeEdges || []).filter((edge) => edge.supersedesTaskId === taskId);
    const resumeTaskIds = resumeEdges.map((edge) => edge.taskId);
    const resumeProposals = args.proposals.filter((proposal) =>
      proposal.payload.supersedesTaskId === taskId
      || resumeTaskIds.includes(String(proposal.payload.taskId || '')));
    const resumeDecisions = resumeProposals.flatMap((proposal) => decisionsByProposalId(proposal.id));
    const resolved = waitingTask?.status === 'done' || resumeEdges.some((edge) => edge.status === 'done');
    items.push({
      id: `waiting-user:${taskId}`,
      kind: 'waiting_user_resume',
      moduleId: 'M6',
      status: resolved ? 'resolved' : 'active',
      title: resolved ? 'waiting_user 已恢复接续' : 'waiting_user 仍待输入',
      detail: resumeTaskIds.length > 0
        ? `waiting task ${taskId} 已通过 ${resumeTaskIds.join(', ')} 接续。`
        : `waiting task ${taskId} 尚未看到显式 resume / replacement task。`,
      taskIds: [taskId, ...resumeTaskIds],
      proposalIds: resumeProposals.map((proposal) => proposal.id),
      decisionIds: resumeDecisions.map((decision) => decision.id),
      opIds: opIdsFor((op) =>
        op.taskId === taskId
        || resumeTaskIds.includes(String(op.taskId || ''))
        || resumeProposals.some((proposal) => op.proposalId === proposal.id)),
      timestamp: latestIsoTimestamp([
        waitingTask?.updatedAt,
        ...resumeTaskIds.map((id) => factById.get(id)?.updatedAt),
        ...resumeProposals.map((proposal) => proposal.updatedAt),
        ...resumeDecisions.map((decision) => decision.updatedAt),
        ...opTimesFor((op) =>
          op.taskId === taskId
          || resumeTaskIds.includes(String(op.taskId || ''))
          || resumeProposals.some((proposal) => op.proposalId === proposal.id)),
      ]),
    });
  }

  for (const taskId of [...new Set([...(args.requestAudit.historicalBlockedTaskIds || []), ...(args.requestAudit.blockedTaskIds || [])])]) {
    const blockedTask = factById.get(taskId) || null;
    const recoveryProposals = args.proposals.filter((proposal) =>
      proposal.parentTaskId === taskId && proposal.kind === 'blocked_replan');
    const recoveryDecisions = recoveryProposals.flatMap((proposal) => decisionsByProposalId(proposal.id));
    const replacementTaskIds = recoveryProposals
      .map((proposal) => String(proposal.payload.taskId || '').trim())
      .filter(Boolean);
    const resolved = replacementTaskIds.some((id) => factById.get(id)?.status === 'done')
      || (blockedTask?.status === 'done' && recoveryProposals.length > 0);
    items.push({
      id: `blocked-recovery:${taskId}`,
      kind: 'blocked_recovery',
      moduleId: 'M5',
      status: resolved ? 'resolved' : 'active',
      title: resolved ? 'blocked 邻域已局部恢复' : 'blocked 邻域仍待恢复',
      detail: recoveryProposals.length > 0
        ? `blocked task ${taskId} 已生成 ${recoveryProposals.length} 条 blocked_replan proposal。`
        : `blocked task ${taskId} 尚未看到 blocked_replan proposal。`,
      taskIds: [taskId, ...replacementTaskIds],
      proposalIds: recoveryProposals.map((proposal) => proposal.id),
      decisionIds: recoveryDecisions.map((decision) => decision.id),
      opIds: opIdsFor((op) =>
        op.taskId === taskId
        || replacementTaskIds.includes(String(op.taskId || ''))
        || recoveryProposals.some((proposal) => op.proposalId === proposal.id)),
      timestamp: latestIsoTimestamp([
        blockedTask?.updatedAt,
        ...replacementTaskIds.map((id) => factById.get(id)?.updatedAt),
        ...recoveryProposals.map((proposal) => proposal.updatedAt),
        ...recoveryDecisions.map((decision) => decision.updatedAt),
        ...opTimesFor((op) =>
          op.taskId === taskId
          || replacementTaskIds.includes(String(op.taskId || ''))
          || recoveryProposals.some((proposal) => op.proposalId === proposal.id)),
      ]),
    });
  }

  if (args.requestAudit.readiness.canPublish || args.requestState?.state === 'ready_for_final' || args.requestState?.state === 'closed') {
    const coordinatorTaskId = `coordinator:${args.requestId}`;
    const coordinatorTask = factById.get(coordinatorTaskId) || null;
    const finalOps = opIdsFor((op) =>
      op.taskId === coordinatorTaskId
      || op.op === 'complete'
      || op.op === 'materialize');
    items.push({
      id: `finalization:${args.requestId}`,
      kind: 'finalization_tick',
      moduleId: 'M8',
      status: args.requestState?.finalPublished || args.requestState?.state === 'closed' ? 'closed' : 'ready',
      title: args.requestState?.finalPublished || args.requestState?.state === 'closed'
        ? 'final 已发布'
        : '已进入 finalization tick',
      detail: args.requestAudit.readiness.canPublish
        ? 'request 已满足 final publish 条件，可触发 coordinator synthesize。'
        : 'request 已进入收尾状态，等待或已完成最终发布。',
      taskIds: coordinatorTask ? [coordinatorTask.id] : [],
      proposalIds: [],
      decisionIds: [],
      opIds: finalOps,
      timestamp: latestIsoTimestamp([
        coordinatorTask?.updatedAt,
        ...opTimesFor((op) => op.taskId === coordinatorTaskId || op.op === 'complete' || op.op === 'materialize'),
      ]),
    });
  }

  return items
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((left, right) =>
      Date.parse(left.timestamp || '') - Date.parse(right.timestamp || '')
      || left.id.localeCompare(right.id));
}

function deriveCrossRequestDiagnostics(args: {
  teamId: string;
  sessionId: string;
  currentRequestId: string;
  board: BlackboardStore;
  requestStore: ReturnType<typeof getRequestStateStore>;
}): CrossRequestDiagnosticItem[] {
  const facts = args.board.list(args.teamId, args.sessionId, { includeArchive: true });
  const proposals = args.board.listProposals(args.teamId, args.sessionId);
  const decisions = args.board.listDecisions(args.teamId, args.sessionId);
  const ops = args.board.listOps(args.teamId, args.sessionId);
  const requestIds = [...new Set([
    args.currentRequestId,
    ...args.requestStore.listRequests(args.teamId, args.sessionId).map((request) => request.requestId),
    ...facts.map((fact) => fact.requestId),
    ...proposals.map((proposal) => proposal.requestId),
    ...decisions.map((decision) => decision.requestId),
    ...ops.map((op) => op.requestId),
  ].filter(Boolean))];

  return requestIds
    .map((requestId) => {
      const requestState = args.requestStore.getRequestForSession(args.teamId, requestId, args.sessionId);
      const audit = deriveRequestAuditSnapshot({
        board: args.board,
        teamId: args.teamId,
        chatSessionId: args.sessionId,
        requestId,
        requestState,
      });
      const latestOpAt = latestIsoTimestamp(ops
        .filter((op) => op.requestId === requestId)
        .map((op) => op.timestamp));
      return {
        requestId,
        state: requestState?.state || null,
        finalPublished: requestState?.finalPublished === true,
        taskCount: facts.filter((fact) => fact.requestId === requestId).length,
        proposalCount: proposals.filter((proposal) => proposal.requestId === requestId).length,
        decisionCount: decisions.filter((decision) => decision.requestId === requestId).length,
        gapCount: (audit.gaps || []).length + (audit.protocolInvariantGaps || []).length,
        activeProtocolModuleIds: audit.activeProtocolModuleIds,
        currentBottleneckModuleId: audit.currentBottleneckModuleId,
        waitingUserTaskIds: audit.waitingUserTaskIds,
        blockedTaskIds: audit.blockedTaskIds,
        readyForFinal: audit.readiness.canPublish,
        latestOpAt,
      };
    })
    .sort((left, right) => {
      if (left.requestId === args.currentRequestId) return -1;
      if (right.requestId === args.currentRequestId) return 1;
      return Date.parse(right.latestOpAt || '') - Date.parse(left.latestOpAt || '');
    })
    .slice(0, 12);
}

function isCoordinatorControlTask(task: TaskFact): boolean {
  return task.requiredCapability === 'coordination' && task.id === `coordinator:${task.requestId}`;
}

function inferCoordinatorControlPhase(task: TaskFact): BlackboardControlPhase {
  if (!isCoordinatorControlTask(task)) {
    return null;
  }
  const haystack = `${task.goal || ''} ${task.result || ''} ${task.blockedBy?.message || ''}`.toLowerCase();
  if (/最终综合|synth|final answer|final publish/.test(haystack)) {
    return 'synthesize';
  }
  if (/恢复|recover|recovery|blocked\/failed/.test(haystack)) {
    return 'recovery';
  }
  return 'decompose';
}

function deriveTaskPresentation(task: TaskFact): {
  taskRole: BlackboardTaskRole;
  controlPhase: BlackboardControlPhase;
  displayGroup: 'control' | 'substantive_active' | 'substantive_done';
} {
  const taskRole: BlackboardTaskRole = isCoordinatorControlTask(task) ? 'control' : 'substantive';
  const controlPhase = taskRole === 'control' ? inferCoordinatorControlPhase(task) : null;
  return {
    taskRole,
    controlPhase,
    displayGroup: taskRole === 'control'
      ? 'control'
      : (task.status === 'done' ? 'substantive_done' : 'substantive_active'),
  };
}

export type BlackboardSessionMatchSource =
  | 'request'
  | 'requestedSession'
  | 'activeSession'
  | 'latestBlackboard';

export function resolveBlackboardSessionSelection(args: {
  teamId: string;
  requestedRequestId: string | null;
  requestedSessionId: string | null;
}): {
  sessionId: string | null;
  matchedBy: BlackboardSessionMatchSource | null;
  requestMatchedSessionId: string | null;
  activeSessionId: string | null;
  latestBlackboardSessionId: string | null;
} {
  const requestMatchedSessionId = findSessionIdForRequest(args.teamId, args.requestedRequestId);
  const activeSessionId = getTeamChatStore().getActiveSessionId(args.teamId);
  const latestBlackboardSessionId = findLatestSessionWithBlackboardData(args.teamId);

  if (requestMatchedSessionId) {
    return {
      sessionId: requestMatchedSessionId,
      matchedBy: 'request',
      requestMatchedSessionId,
      activeSessionId,
      latestBlackboardSessionId,
    };
  }
  if (args.requestedSessionId) {
    return {
      sessionId: args.requestedSessionId,
      matchedBy: 'requestedSession',
      requestMatchedSessionId,
      activeSessionId,
      latestBlackboardSessionId,
    };
  }
  if (activeSessionId) {
    return {
      sessionId: activeSessionId,
      matchedBy: 'activeSession',
      requestMatchedSessionId,
      activeSessionId,
      latestBlackboardSessionId,
    };
  }
  return {
    sessionId: latestBlackboardSessionId,
    matchedBy: latestBlackboardSessionId ? 'latestBlackboard' : null,
    requestMatchedSessionId,
    activeSessionId,
    latestBlackboardSessionId,
  };
}

function buildBlackboardRequestExplainData(args: {
  teamId: string;
  sessionId: string;
  requestedSessionId: string | null;
  requestedRequestId: string;
}) {
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const requestState = requestStore.getRequestForSession(args.teamId, args.requestedRequestId, args.sessionId) ?? null;
  const facts = board.list(args.teamId, args.sessionId, {
    requestId: args.requestedRequestId,
    includeArchive: true,
  });
  const proposals = board.listProposals(args.teamId, args.sessionId, {
    requestId: args.requestedRequestId,
  });
  const decisions = board.listDecisions(args.teamId, args.sessionId, {
    requestId: args.requestedRequestId,
  });
  const ops = board.listOps(args.teamId, args.sessionId, {
    requestId: args.requestedRequestId,
  });
  const requestAudit = deriveRequestAuditSnapshot({
    board,
    teamId: args.teamId,
    chatSessionId: args.sessionId,
    requestId: args.requestedRequestId,
    requestState,
  });
  const closureMode = deriveRequestClosureMode({
    requestState,
    tasks: facts,
  });
  const failureTriage = deriveBlackboardFailureTriage({
    requestId: args.requestedRequestId,
    requestState: requestState?.state || null,
    tasks: facts,
  });
  const coordinatorMention = `@${String(requestState?.coordinatorAgentId || 'coordinator').trim() || 'coordinator'}`;
  const lowRiskBacklogProposalIds = proposals
    .filter((proposal) => isAutoApprovableProposalKind(proposal.kind))
    .filter((proposal) => deriveProposalLifecycle(proposal, decisions) !== 'materialized')
    .map((proposal) => proposal.id);
  const protocolActionIntents = (() => {
    const intents: Array<{
      id: string;
      source: 'repair_template' | 'readiness' | 'backlog';
      kind: 'finalize' | 'materialize' | 'decide' | 'recover' | 'user_input' | 'repair';
      moduleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | null;
      invariantCode:
        | 'pending_initial_proposal'
        | 'pending_execution'
        | 'missing_completion_evidence'
        | 'pending_decision'
        | 'approved_not_materialized'
        | 'blocked_neighborhood_unresolved'
        | 'waiting_user_unresolved'
        | 'lease_recovery_active'
        | 'final_gate_not_ready'
        | null;
      actionKind:
        | 'write_initial_proposal'
        | 'continue_execution'
        | 'supply_completion_evidence'
        | 'write_decision'
        | 'materialize_task'
        | 'resolve_blocked_neighborhood'
        | 'collect_user_input'
        | 'finish_lease_recovery'
        | 'satisfy_final_gate'
        | 'auto_resolve_low_risk_backlog'
        | 'finalize_request';
      targetTaskId: string | null;
      targetProposalId: string | null;
      title: string;
      detail: string;
      promptTemplate: string;
      messageTemplate: string;
      executable: boolean;
      executeLabel: string | null;
      executeDisabledReason: string | null;
      priority: number;
    }> = [];
    for (const template of requestAudit.protocolRepairTemplates) {
      const targetProposal = template.targetProposalId
        ? proposals.find((proposal) => proposal.id === template.targetProposalId) || null
        : null;
      const targetWorkspaceId = String(targetProposal?.payload.executionScope?.workspaceId || '').trim();
      const targetFanout = targetWorkspaceId
        ? requestAudit.activeWorkspaceFanout.find((item) => item.workspaceId === targetWorkspaceId) || null
        : null;
      const materializeBlockedByFanout =
        template.actionKind === 'materialize_task'
        && Boolean(targetFanout)
        && targetFanout!.activeTaskCount >= requestAudit.maxWorkspaceFanout;
      const executableMaterialize =
        template.actionKind === 'materialize_task'
        && Boolean(template.targetProposalId)
        && !materializeBlockedByFanout;
      const executableBlockedRecovery =
        template.actionKind === 'resolve_blocked_neighborhood'
        && Boolean(template.targetTaskId)
        && (
          requestAudit.blockedTaskIds.includes(template.targetTaskId || '')
          || requestAudit.historicalRetryableBlockedTaskIds.includes(template.targetTaskId || '')
          || requestAudit.finalGate.autoAdvanceBlockedTaskIds.includes(template.targetTaskId || '')
        );
      const executableWaitingUser =
        template.actionKind === 'collect_user_input'
        && Boolean(template.targetTaskId)
        && requestAudit.waitingUserTaskIds.includes(template.targetTaskId || '');
      const executableTemplate = executableMaterialize || executableBlockedRecovery || executableWaitingUser;
      const targetScope = template.targetProposalId
        ? `目标 proposal=${template.targetProposalId}`
        : template.targetTaskId
          ? `目标 task=${template.targetTaskId}`
          : `目标 request=${args.requestedRequestId}`;
      const promptPrefix = `你是 blackboard coordinator。当前 request=${args.requestedRequestId}，session=${args.sessionId}。`;
      const promptBody = (() => {
        switch (template.actionKind) {
          case 'write_initial_proposal':
            return `请为该 request 写首层 ProposalFact，不要直接创建 TaskFact。${targetScope}。输出应明确 goal、requiredCapability、reason 和后续需要的 decision。`;
          case 'continue_execution':
            return `请沿既有 task lifecycle 继续推进，不要新开旁路恢复链。${targetScope}。若不能直接完成，只能通过 proposal/block 进入后续模块。`;
          case 'supply_completion_evidence':
            return `请先补齐 completion evidence，再决定是否 complete。${targetScope}。不要回滚 done，只补 result/resultRef/evidence 所缺部分。`;
          case 'write_decision':
            return `请为该 proposal 写明确 DecisionFact。${targetScope}。如果批准，说明批准理由；如果拒绝或 amend，给出收敛后的未来路径。`;
          case 'materialize_task':
            return `请把该已批准 proposal materialize 成真实 task。${targetScope}。必须保持 proposal-first / decision-first 主链，不得直接改 DAG。`;
          case 'resolve_blocked_neighborhood':
            return `请只处理 blocked 邻域。${targetScope}。通过 replacement/correction/reset 或 blocked_replan 收口，不要 patch 整个 request。`;
          case 'collect_user_input':
            return `请围绕 waiting_user 邻域收集用户输入并显式恢复。${targetScope}。恢复后要用 replacement/resume task 接续，不要偷偷新开 session。`;
          case 'finish_lease_recovery':
            return `请完成 lease_expired_reset 邻域恢复。${targetScope}。保持同一 taskId 继续 claim/execute，不要发明新的恢复侧链。`;
          case 'satisfy_final_gate':
            return `请先满足 final gate，再进入 synthesize/final。${targetScope}。优先解释为什么当前 request 仍不能 publish，并补齐阻塞项。`;
        }
      })();
      intents.push({
        id: `repair-template:${template.moduleId}:${template.invariantCode}:${template.targetProposalId || template.targetTaskId || args.requestedRequestId}`,
        source: 'repair_template',
        kind: template.moduleId === 'M8'
          ? 'finalize'
          : template.moduleId === 'M6'
            ? 'user_input'
            : template.moduleId === 'M4'
              ? (template.invariantCode === 'pending_decision' ? 'decide' : 'materialize')
              : template.moduleId === 'M5' || template.moduleId === 'M7'
                ? 'recover'
                : 'repair',
        moduleId: template.moduleId,
        invariantCode: template.invariantCode,
        actionKind: template.actionKind,
        targetTaskId: template.targetTaskId || null,
        targetProposalId: template.targetProposalId || null,
        title: template.title,
        detail: template.detail,
        promptTemplate: `${promptPrefix} ${promptBody}`,
        messageTemplate: `${coordinatorMention} ${template.title}。\nrequest=${args.requestedRequestId} · session=${args.sessionId}\n${targetScope}\n${template.detail}\n\n${promptBody}`,
        executable: executableTemplate,
        executeLabel: executableMaterialize
          ? '直接落任务'
          : executableBlockedRecovery
            ? '触发恢复'
            : executableWaitingUser
              ? '唤醒输入闭环'
              : null,
        executeDisabledReason: materializeBlockedByFanout
          ? `workspace ${targetWorkspaceId} active fanout 已达上限 ${requestAudit.maxWorkspaceFanout}，需先等待当前分支完成。`
          : executableTemplate
            ? null
          : '该协议意图仍需要 coordinator 或用户补充上下文。',
        priority: template.moduleId === 'M8' ? 100 : template.moduleId === 'M4' ? 95 : template.moduleId === 'M6' ? 90 : 80,
      });
    }
    if (lowRiskBacklogProposalIds.length > 0) {
      intents.push({
        id: `backlog:auto-resolve-low-risk:${args.requestedRequestId}`,
        source: 'backlog',
        kind: 'materialize',
        moduleId: 'M4',
        invariantCode: 'pending_decision',
        actionKind: 'auto_resolve_low_risk_backlog',
        targetTaskId: null,
        targetProposalId: null,
        title: '一键处理低风险 proposal backlog',
        detail: `当前有 ${lowRiskBacklogProposalIds.length} 条低风险 proposal 尚未完全 materialize，可按统一风险边界自动 approve/materialize。`,
        promptTemplate:
          `你是 blackboard coordinator。当前 request=${args.requestedRequestId}，session=${args.sessionId}。` +
          `请处理低风险 proposal backlog：${lowRiskBacklogProposalIds.join(', ')}。仅允许 need_review / need_qa / need_user_input 自动通过，高风险 proposal 必须保留人工决策。`,
        messageTemplate:
          `${coordinatorMention} 请处理当前 request 的低风险 proposal backlog。\nrequest=${args.requestedRequestId} · session=${args.sessionId}\n` +
          `目标 proposals=${lowRiskBacklogProposalIds.join(', ')}\n只允许自动处理 need_review / need_qa / need_user_input，高风险 proposal 保持待决。`,
        executable: true,
        executeLabel: '一键处理低风险',
        executeDisabledReason: null,
        priority: 105,
      });
    }
    if (requestAudit.readiness.canPublish) {
      intents.push({
        id: `readiness:finalize:${args.requestedRequestId}`,
        source: 'readiness',
        kind: 'finalize',
        moduleId: 'M8',
        invariantCode: null,
        actionKind: 'finalize_request',
        targetTaskId: null,
        targetProposalId: null,
        title: '进入 synthesize / final publish',
        detail: '当前 request 已满足 publish 条件，应优先综合收尾而不是继续扩张 future work。',
        promptTemplate:
          `你是 blackboard coordinator。当前 request=${args.requestedRequestId}，session=${args.sessionId}，已满足 final publish 条件。` +
          `请进入 M8 综合收尾：总结已完成的 substantive tasks，确认 final gate 无阻塞，再输出 final publish，避免继续扩张 proposal/task。`,
        messageTemplate:
          `${coordinatorMention} 请按 M8 综合收尾当前 request。\nrequest=${args.requestedRequestId} · session=${args.sessionId}\n` +
          `当前已满足 final publish 条件，请优先 synthesize / final publish，不要继续扩张 proposal/task。`,
        executable: true,
        executeLabel: '触发收尾',
        executeDisabledReason: null,
        priority: 110,
      });
    }
    return intents
      .sort((left, right) => right.priority - left.priority)
      .map(({ priority: _priority, ...item }) => item);
  })();
  const recommendedActions = (() => {
    const actions: Array<{
      id: string;
      kind: 'finalize' | 'materialize' | 'decide' | 'recover' | 'user_input' | 'repair';
      title: string;
      detail: string;
      priority: number;
    }> = [];
    if (requestAudit.readiness.canPublish) {
      actions.push({
        id: 'finalize-request',
        kind: 'finalize',
        title: '进入 synthesize / final publish',
        detail: '当前 request 已满足 publish 条件，优先收口而不是继续扩张 DAG。',
        priority: 100,
      });
    }
    if (requestAudit.currentBottleneckModuleId) {
      actions.push({
        id: 'follow-protocol-bottleneck',
        kind: requestAudit.currentBottleneckModuleId === 'M8'
          ? 'finalize'
          : requestAudit.currentBottleneckModuleId === 'M6'
            ? 'user_input'
            : requestAudit.currentBottleneckModuleId === 'M4'
              ? 'materialize'
              : requestAudit.currentBottleneckModuleId === 'M5' || requestAudit.currentBottleneckModuleId === 'M7'
                ? 'recover'
                : requestAudit.currentBottleneckModuleId === 'M3'
                  ? 'repair'
                  : 'decide',
        title: `按当前协议瓶颈推进 ${requestAudit.currentBottleneckModuleId}`,
        detail: `当前 request 主要卡在 ${requestAudit.currentBottleneckModuleId}，优先沿这一模块收口，再决定是否继续扩张。`,
        priority: 98,
      });
    }
    for (const gap of requestAudit.protocolInvariantGaps.slice(0, 3)) {
      actions.push({
        id: `protocol-gap:${gap.moduleId}:${gap.code}`,
        kind: gap.moduleId === 'M8'
          ? 'finalize'
          : gap.moduleId === 'M6'
            ? 'user_input'
            : gap.moduleId === 'M4'
              ? (gap.code === 'pending_decision' ? 'decide' : 'materialize')
              : gap.moduleId === 'M5' || gap.moduleId === 'M7'
                ? 'recover'
                : gap.moduleId === 'M3'
                  ? 'repair'
                  : 'decide',
        title: `修补 ${gap.moduleId} 不变量`,
        detail: gap.detail,
        priority: gap.severity === 'critical' ? 97 : gap.severity === 'warning' ? 88 : 70,
      });
    }
    if (requestAudit.approvedButUnmaterializedProposalIds.length > 0) {
      const topFanout = requestAudit.activeWorkspaceFanout[0];
      actions.push({
        id: 'materialize-approved-proposals',
        kind: 'materialize',
        title: '优先 materialize 已批准 proposal',
        detail: topFanout
          ? `仍有 ${requestAudit.approvedButUnmaterializedProposalIds.length} 条已批准 proposal 未落任务；当前最高 fanout workspace 为 ${topFanout.workspaceId}（active=${topFanout.activeTaskCount}）。`
          : `仍有 ${requestAudit.approvedButUnmaterializedProposalIds.length} 条已批准 proposal 未落任务。`,
        priority: 95,
      });
    }
    if (requestAudit.finalGate.pendingDecisionHighRiskProposalIds.length > 0) {
      actions.push({
        id: 'decide-high-risk-proposals',
        kind: 'decide',
        title: '补齐高风险 proposal 的 decision',
        detail: `仍有 ${requestAudit.finalGate.pendingDecisionHighRiskProposalIds.length} 条高风险 proposal 缺少明确决策。`,
        priority: 90,
      });
    }
    if (requestAudit.waitingUserTaskIds.length > 0 || requestAudit.historicalWaitingUserTaskIds.length > requestAudit.waitingUserResumeTaskIds.length) {
      actions.push({
        id: 'collect-user-input',
        kind: 'user_input',
        title: '优先处理 waiting_user 输入闭环',
        detail: '当前 request 仍受用户输入控制任务影响，先补输入或确认恢复任务是否已经显式接续。',
        priority: 85,
      });
    }
    if (requestAudit.historicalRetryableBlockedTaskIds.length > 0 || requestAudit.blockedReplanProposalIds.length > 0) {
      actions.push({
        id: 'recover-blocked-neighborhood',
        kind: 'recover',
        title: '继续局部恢复 blocked 邻域',
        detail: '当前 request 曾发生 retryable blocked / blocked_replan，优先检查 replacement task 是否已完整收口。',
        priority: 80,
      });
    }
    if (requestAudit.gaps.length > 0) {
      actions.push({
        id: 'repair-audit-gaps',
        kind: 'repair',
        title: '修补 request audit gaps',
        detail: `当前 explain 检测到 ${requestAudit.gaps.length} 个审计缺口，应先补齐再继续推进。`,
        priority: 75,
      });
    }
    return actions
      .sort((left, right) => right.priority - left.priority)
      .map(({ priority: _priority, ...item }) => item);
  })();
  const traceSummary = deriveRequestTraceSummary({
    requestId: args.requestedRequestId,
    requestState,
    facts,
    proposals,
    decisions,
    ops,
    requestAudit,
  });
  const crossRequestDiagnostics = deriveCrossRequestDiagnostics({
    teamId: args.teamId,
    sessionId: args.sessionId,
    currentRequestId: args.requestedRequestId,
    board,
    requestStore,
  });

  return {
    teamId: args.teamId,
    chatSessionId: args.sessionId,
    requestId: args.requestedRequestId,
    requestedSessionId: args.requestedSessionId,
    requestState,
    requestAudit,
    protocolActionIntents,
    recommendedActions,
    traceSummary,
    crossRequestDiagnostics,
    requestSummary: {
      state: requestState?.state || null,
      stateReason: requestState?.stateReason || null,
      closureMode,
      failureCategory: failureTriage.failureCategory,
      failureSummary: failureTriage.failureSummary,
      taskIds: facts.map((fact) => fact.id),
      proposalIds: proposals.map((proposal) => proposal.id),
      decisionIds: decisions.map((decision) => decision.id),
      latestOps: ops.slice(0, 20).map((record) => ({
        opId: record.id,
        op: record.op,
        entityType: record.entityType,
        entityId: record.entityId,
        taskId: record.taskId || null,
        proposalId: record.proposalId || null,
        decisionId: record.decisionId || null,
        fromStatus: record.fromStatus ?? null,
        toStatus: record.toStatus ?? null,
        timestamp: new Date(record.timestamp).toISOString(),
      })),
    },
  };
}

function findLatestSessionWithBlackboardData(teamId: string): string | null {
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const sessions = getTeamChatStore().listSessions(teamId);
  const ranked = sessions
    .map((session) => {
      const requestCount = requestStore.listRequests(teamId, session.sessionId).length;
      const taskFacts = board.list(teamId, session.sessionId, { includeArchive: true });
      const latestTaskUpdatedAt = taskFacts.reduce((max, fact) => Math.max(max, Number(fact.updatedAt || 0)), 0);
      const sessionUpdatedAt = Date.parse(String(session.updatedAt || '')) || 0;
      return {
        sessionId: session.sessionId,
        requestCount,
        taskCount: taskFacts.length,
        latestTaskUpdatedAt,
        sessionUpdatedAt,
      };
    })
    .filter((item) => item.requestCount > 0 || item.taskCount > 0)
    .sort((left, right) => {
      const rightScore = Math.max(right.latestTaskUpdatedAt, right.sessionUpdatedAt);
      const leftScore = Math.max(left.latestTaskUpdatedAt, left.sessionUpdatedAt);
      return rightScore - leftScore;
    });
  return ranked[0]?.sessionId || null;
}

function compactText(value: string | null | undefined, max = 220): string | null {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function parseAuditEvidence(value: string | null | undefined): Record<string, unknown> | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function deriveTaskEvidence(teamId: string, chatSessionId: string, task: TaskFact) {
  const presentation = deriveTaskPresentation(task);
  return {
    taskId: task.id,
    requestId: task.requestId,
    taskRole: presentation.taskRole,
    controlPhase: presentation.controlPhase,
    displayGroup: presentation.displayGroup,
    supersedesTaskId: task.supersedesTaskId || null,
    owner: task.owner,
    status: task.status,
    requiredCapability: task.requiredCapability,
    acceptanceCriteria: task.acceptanceCriteria || [],
    evidenceRequirements: task.evidenceRequirements || null,
    requiresTaskEvidence: requiresStructuredSourceEvidence(task.evidenceRequirements),
    taskEvidenceSchema: requiresStructuredSourceEvidence(task.evidenceRequirements)
      ? {
          version: 'task-evidence-v1',
          sources: {
            required: true,
            itemShape: ['title', 'url', 'publishedAt', 'snippet?', 'domain?'],
          },
        }
      : null,
    attempt: task.attempt,
    currentRunId: task.currentRunId,
    resultSummary: compactText(task.result),
    resultRef: task.resultRef || null,
    artifactsRoot: task.executionScope.artifactsRoot || null,
    blockedReason: task.blockedBy?.message || null,
    missingInputs: task.blockedBy?.missingInputs || [],
    dependencyTaskIds: task.requires || [],
    dependencyHandoffs: deriveBlackboardTaskDependencyHandoffs(getBlackboardStore(), teamId, chatSessionId, task),
    supersededByTaskIds: [] as string[],
    createdBy: task.createdBy,
    updatedAt: new Date(task.updatedAt).toISOString(),
  };
}

function deriveRunEvidence(task: TaskFact): Array<{
  runId: string;
  taskId: string;
  requestId: string;
  owner: string | null;
  status: string;
  attempt: number;
  source: 'current' | 'failure_history';
  startedAt: string | null;
  updatedAt: string;
  lastHeartbeatAt: string | null;
  artifactsRoot: string | null;
  resultRef: string | null;
  resultSummary: string | null;
  blockedReason: string | null;
  resetKind?: string;
}> {
  const runs: Array<{
    runId: string;
    taskId: string;
    requestId: string;
    owner: string | null;
    status: string;
    attempt: number;
    source: 'current' | 'failure_history';
    startedAt: string | null;
    updatedAt: string;
    lastHeartbeatAt: string | null;
    artifactsRoot: string | null;
    resultRef: string | null;
    resultSummary: string | null;
    blockedReason: string | null;
    resetKind?: string;
  }> = [];

  if (task.currentRunId) {
    runs.push({
      runId: task.currentRunId,
      taskId: task.id,
      requestId: task.requestId,
      owner: task.owner,
      status: task.status,
      attempt: task.attempt,
      source: 'current',
      startedAt: task.claimedAt ? new Date(task.claimedAt).toISOString() : null,
      updatedAt: new Date(task.updatedAt).toISOString(),
      lastHeartbeatAt: task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).toISOString() : null,
      artifactsRoot: task.executionScope.artifactsRoot || null,
      resultRef: task.resultRef || null,
      resultSummary: compactText(task.result),
      blockedReason: task.blockedBy?.message || null,
    });
  }

  for (const failure of task.failureHistory || []) {
    runs.push({
      runId: failure.runId,
      taskId: task.id,
      requestId: task.requestId,
      owner: task.owner,
      status: 'failed',
      attempt: task.attempt,
      source: 'failure_history',
      startedAt: null,
      updatedAt: new Date(failure.at).toISOString(),
      lastHeartbeatAt: null,
      artifactsRoot: task.executionScope.artifactsRoot || null,
      resultRef: null,
      resultSummary: null,
      blockedReason: failure.blockedBy?.message || null,
      resetKind: failure.resetKind,
    });
  }
  return runs;
}

function deriveRequestEvidence(
  request: RequestStateRecord,
  tasks: TaskFact[],
  dependencyHandoffHints: Array<{ taskId: string; requestId: string; dependencyTaskId: string; dependencyStatus: string | null; blocking: boolean; issue: string }>,
  doneEvidenceGaps?: Array<{ taskId: string; requestId: string; reasons: string[] }>,
  failureTransport?: {
    source?: string | null;
    layer?: string | null;
    health?: string | null;
    status?: string | null;
    ws?: string | null;
  } | null,
  transportError?: string | null,
) {
  const scoped = tasks.filter((task) => task.requestId === request.requestId);
  const scopedProposals = getBlackboardStore().listProposals(request.teamId, request.chatSessionId, { requestId: request.requestId });
  const scopedDecisions = getBlackboardStore().listDecisions(request.teamId, request.chatSessionId, { requestId: request.requestId });
  const finalGate = deriveRequestFinalGate({
    facts: scoped,
    proposals: scopedProposals,
    decisions: scopedDecisions,
  });
  const doneTaskIds = scoped.filter((task) => task.status === 'done').map((task) => task.id);
  const waitingTaskIds = scoped.filter((task) => task.status === 'waiting_user').map((task) => task.id);
  const blockedTaskIds = scoped.filter((task) => task.status === 'blocked' || task.status === 'failed').map((task) => task.id);
  const activeRunIds = scoped.map((task) => task.currentRunId).filter((item): item is string => Boolean(item));
  const scopedDoneEvidenceGaps = (doneEvidenceGaps || []).filter((gap) => gap.requestId === request.requestId);
  const supersedeEdges = scoped
    .filter((task) => String(task.supersedesTaskId || '').trim())
    .map((task) => ({
      taskId: task.id,
      supersedesTaskId: String(task.supersedesTaskId || '').trim(),
      status: task.status,
    }));
  const failureTriage = deriveBlackboardFailureTriage({
    requestId: request.requestId,
    requestState: request.state,
    failureTransport: failureTransport || null,
    transportError,
    dependencyHandoffHints,
    tasks: scoped,
  });
  return {
    requestId: request.requestId,
    state: request.state,
    stateReason: request.stateReason,
    resumable: request.resumable,
    focusTaskIds: request.focusTaskIds,
    doneTaskIds,
    waitingTaskIds,
    blockedTaskIds,
    doneEvidenceGapCount: scopedDoneEvidenceGaps.length,
    doneEvidenceGapTaskIds: scopedDoneEvidenceGaps.map((gap) => gap.taskId),
    doneEvidenceGaps: scopedDoneEvidenceGaps,
    supersededTaskIds: [...new Set(supersedeEdges.map((edge) => edge.supersedesTaskId))],
    supersedingTaskIds: supersedeEdges.map((edge) => edge.taskId),
    supersedeEdges,
    activeRunIds,
    failureCategory: failureTriage.failureCategory,
    failureSummary: failureTriage.failureSummary,
    failureTaskIds: failureTriage.failureTaskIds,
    closureMode: deriveRequestClosureMode({
      requestState: request,
      tasks: scoped,
    }),
    failureTransport: failureTriage.failureTransport,
    finalGate,
    finalPublished: request.finalPublished,
    updatedAt: request.updatedAt,
  };
}

function deriveProposalEvidence(proposal: ProposalFact, decisions: DecisionFact[]) {
  const scopedDecisions = decisions
    .filter((decision) => decision.proposalId === proposal.id)
    .sort((a, b) => b.decidedAt - a.decidedAt || b.updatedAt - a.updatedAt);
  const latestDecision = scopedDecisions[0] || null;
  return {
    proposalId: proposal.id,
    requestId: proposal.requestId,
    parentTaskId: proposal.parentTaskId,
    supersedesTaskId: proposal.payload.supersedesTaskId || null,
    proposerAgentId: proposal.proposerAgentId,
    kind: proposal.kind,
    payload: proposal.payload,
    latestDecision: latestDecision
      ? {
          decisionId: latestDecision.id,
          decision: latestDecision.decision,
          decidedBy: latestDecision.decidedBy,
          decidedAt: new Date(latestDecision.decidedAt).toISOString(),
          note: latestDecision.note || null,
          materializedTaskIds: latestDecision.materializedTaskIds || [],
          materializedAt: latestDecision.materializedAt ? new Date(latestDecision.materializedAt).toISOString() : null,
        }
      : null,
    createdAt: new Date(proposal.createdAt).toISOString(),
    updatedAt: new Date(proposal.updatedAt).toISOString(),
  };
}

function deriveDecisionEvidence(decision: DecisionFact) {
  return {
    decisionId: decision.id,
    requestId: decision.requestId,
    proposalId: decision.proposalId,
    decision: decision.decision,
    decidedBy: decision.decidedBy,
    decidedAt: new Date(decision.decidedAt).toISOString(),
    note: decision.note || null,
    amendedPayload: decision.amendedPayload || null,
    materializedTaskIds: decision.materializedTaskIds || [],
    materializedAt: decision.materializedAt ? new Date(decision.materializedAt).toISOString() : null,
    updatedAt: new Date(decision.updatedAt).toISOString(),
  };
}

function deriveCollaborationRecords(tasks: TaskFact[]) {
  const records: Array<{
    id: string;
    requestId: string;
    taskId: string;
    kind: 'dispatch' | 'result' | 'blocked' | 'waiting_user' | 'retrieval' | 'review' | 'approval';
    actor: string | null;
    title: string;
    summary: string | null;
    resultRef: string | null;
    relatedTaskIds: string[];
    timestamp: string;
  }> = [];

  for (const task of tasks) {
    const approval = parseApprovalRequestGoal(task.goal);
    const approvalResponse = parseApprovalResponseResult(task.result);
    const baseRelatedTaskIds = [...(task.requires || []), ...(task.supersedesTaskId ? [task.supersedesTaskId] : [])];
    records.push({
      id: `${task.id}:dispatch`,
      requestId: task.requestId,
      taskId: task.id,
      kind: approval
        ? 'approval'
        : (task.requiredCapability === 'retrieval' ? 'retrieval' : 'dispatch'),
      actor: task.createdBy || null,
      title: approval
        ? `Approval requested: ${approval.kind}`
        : `Task dispatched to ${task.owner || task.requiredCapability}`,
      summary: compactText(approval ? approval.reason : task.goal),
      resultRef: null,
      relatedTaskIds: baseRelatedTaskIds,
      timestamp: new Date(task.updatedAt).toISOString(),
    });

    if (task.status === 'done') {
      records.push({
        id: `${task.id}:done`,
        requestId: task.requestId,
        taskId: task.id,
        kind: approval
          ? 'approval'
          : (/review|qa/i.test(task.requiredCapability) ? 'review' : (task.requiredCapability === 'retrieval' ? 'retrieval' : 'result')),
        actor: task.owner,
        title: approval
          ? `Approval ${approvalResponse?.status || 'responded'}`
          : `Task completed by ${task.owner || task.requiredCapability}`,
        summary: compactText(
          approval
            ? [
                approval.reason,
                approvalResponse?.decision ? `decision: ${approvalResponse.decision}` : '',
                approvalResponse?.note ? `note: ${approvalResponse.note}` : '',
              ].filter(Boolean).join(' | ')
            : [task.result, task.supersedesTaskId ? `supersedes: ${task.supersedesTaskId}` : ''].filter(Boolean).join(' | '),
        ),
        resultRef: task.resultRef || null,
        relatedTaskIds: baseRelatedTaskIds,
        timestamp: new Date(task.updatedAt).toISOString(),
      });
    } else if (task.status === 'waiting_user') {
      records.push({
        id: `${task.id}:waiting`,
        requestId: task.requestId,
        taskId: task.id,
        kind: approval ? 'approval' : 'waiting_user',
        actor: task.owner,
        title: approval ? 'Waiting for approval response' : 'Waiting for user input',
        summary: compactText([
          approval ? approval.reason : task.goal,
          task.supersedesTaskId ? `supersedes: ${task.supersedesTaskId}` : '',
        ].filter(Boolean).join(' | ')),
        resultRef: null,
        relatedTaskIds: baseRelatedTaskIds,
        timestamp: new Date(task.updatedAt).toISOString(),
      });
    } else if (task.status === 'blocked' || task.status === 'failed') {
      records.push({
        id: `${task.id}:blocked`,
        requestId: task.requestId,
        taskId: task.id,
        kind: 'blocked',
        actor: task.owner,
        title: `Task ${task.status}`,
        summary: compactText([
          task.blockedBy?.message || task.result,
          task.supersedesTaskId ? `supersedes: ${task.supersedesTaskId}` : '',
        ].filter(Boolean).join(' | ')),
        resultRef: null,
        relatedTaskIds: baseRelatedTaskIds,
        timestamp: new Date(task.updatedAt).toISOString(),
      });
    }
  }

  return records
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 200);
}

function deriveProposalCollaborationRecords(proposals: ProposalFact[], decisions: DecisionFact[]) {
  const records: Array<{
    id: string;
    requestId: string;
    taskId: string;
    kind: 'proposal' | 'decision';
    actor: string | null;
    title: string;
    summary: string | null;
    resultRef: string | null;
    relatedTaskIds: string[];
    timestamp: string;
  }> = [];

  for (const proposal of proposals) {
    records.push({
      id: `${proposal.id}:proposal`,
      requestId: proposal.requestId,
      taskId: proposal.parentTaskId,
      kind: 'proposal',
      actor: proposal.proposerAgentId,
      title: `Proposal submitted: ${proposal.kind}`,
      summary: compactText([
        proposal.payload.goal,
        proposal.payload.reason,
        proposal.payload.supersedesTaskId ? `supersedes: ${proposal.payload.supersedesTaskId}` : '',
      ].filter(Boolean).join(' | ')),
      resultRef: null,
      relatedTaskIds: [
        proposal.parentTaskId,
        ...(proposal.payload.requires || []),
        ...(proposal.payload.supersedesTaskId ? [proposal.payload.supersedesTaskId] : []),
      ],
      timestamp: new Date(proposal.updatedAt).toISOString(),
    });
  }
  for (const decision of decisions) {
    records.push({
      id: `${decision.id}:decision`,
      requestId: decision.requestId,
      taskId: decision.proposalId,
      kind: 'decision',
      actor: decision.decidedBy,
      title: `Decision: ${decision.decision}`,
      summary: compactText(decision.note || ''),
      resultRef: null,
      relatedTaskIds: decision.materializedTaskIds || [],
      timestamp: new Date(decision.updatedAt).toISOString(),
    });
  }
  return records.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function deriveExecutionTrace(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string | null;
}) {
  const history = getTeamChatStore().getHistory(args.teamId, args.chatSessionId);
  const relevantMessages = history.messages
    .filter((message) => !args.requestId || message.requestId === args.requestId)
    .map((message) => ({
      messageId: message.messageId,
      agent: message.agent,
      text: message.text,
      tags: message.tags || [],
      requestId: message.requestId || null,
      timestamp: message.timestamp,
      evidence: parseAuditEvidence(message.auditContent),
    }));

  const events = relevantMessages
    .filter((message) => message.tags.length > 0 || message.evidence)
    .map((message) => {
      const normalizedTaskEvidence = normalizeTaskEvidencePayload(message.evidence);
      return {
        id: message.messageId,
        agent: message.agent,
        timestamp: message.timestamp,
        tags: message.tags,
        eventType: String(message.evidence?.eventType || message.tags[0] || 'message'),
        taskId: typeof message.evidence?.taskId === 'string' ? message.evidence.taskId : null,
        runId: typeof message.evidence?.runId === 'string'
          ? message.evidence.runId
          : (typeof message.evidence?.sessionKey === 'string' ? message.evidence.sessionKey : null),
        summary: compactText(message.text),
        evidence: message.evidence,
        sources: normalizedTaskEvidence?.sources || [],
        evidenceSchema: normalizedTaskEvidence ? 'task-evidence-v1' : null,
      };
    })
    .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));

  return {
    events,
    toolCalls: events.filter((event) => event.eventType === 'runtime-tool-call'),
    permissionRequests: events.filter((event) => event.eventType === 'runtime-permission-request'),
    taskResults: events.filter((event) => event.tags.includes('task-result')),
    taskFailures: events.filter((event) => event.tags.includes('task-failure') || event.tags.includes('error')),
    coordinatorOutputs: events.filter((event) => event.tags.includes('coordinator-output') || event.eventType === 'coordinator-output'),
  };
}

export async function handleGetTeamBlackboard(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    const requestUrl = new URL(req.url || `/api/teams/${teamId}/blackboard`, 'http://127.0.0.1');
    const requestedRequestId = String(requestUrl.searchParams.get('requestId') || '').trim() || null;
    const requestedSessionId = String(requestUrl.searchParams.get('sessionId') || '').trim() || null;
    const sessionSelection = resolveBlackboardSessionSelection({
      teamId,
      requestedRequestId,
      requestedSessionId,
    });
    let sessionId = sessionSelection.sessionId;

    const board = getBlackboardStore();
    const requestStore = getRequestStateStore();
    const runtimeStore = getTeamRuntimeStateStore();

    if (!sessionId) {
      sessionId = requestedSessionId
        || sessionSelection.activeSessionId
        || sessionSelection.latestBlackboardSessionId
        || 'main';
    }

    await maybeTickRequestFinalizationOnRead({
      teamId,
      sessionId,
      requestId: requestedRequestId,
    });

    let boardState = board.getState(teamId, sessionId);
    let requests = requestStore.listRequests(teamId, sessionId)
      .sort(compareRequestStateRecords);
    let tasks = board.list(teamId, sessionId, { includeArchive: true })
      .sort((a, b) => b.updatedAt - a.updatedAt);

    // 若当前（或 active）会话为空，回退到最近有黑板数据的会话，避免前端 Kanban/DAG 误显示空白。
    if (!requestedRequestId && requests.length === 0 && tasks.length === 0) {
      const fallbackSessionId = findLatestSessionWithBlackboardData(teamId);
      if (fallbackSessionId && fallbackSessionId !== sessionId) {
        sessionId = fallbackSessionId;
        await maybeTickRequestFinalizationOnRead({
          teamId,
          sessionId,
          requestId: null,
        });
        boardState = board.getState(teamId, sessionId);
        requests = requestStore.listRequests(teamId, sessionId).sort(compareRequestStateRecords);
        tasks = board.list(teamId, sessionId, { includeArchive: true }).sort((a, b) => b.updatedAt - a.updatedAt);
      }
    }

    const activeIdSet = new Set(boardState.active.map((t) => t.id));
    const proposals = board.listProposals(teamId, sessionId, requestedRequestId ? { requestId: requestedRequestId } : undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const decisions = board.listDecisions(teamId, sessionId, requestedRequestId ? { requestId: requestedRequestId } : undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const ops = board.listOps(teamId, sessionId, {
      requestId: requestedRequestId || undefined,
      limit: 200,
    }).sort((a, b) => b.timestamp - a.timestamp);
    tasks = tasks.map((task) => ({
      ...task,
      ...deriveTaskPresentation(task as TaskFact),
      boardLayer: activeIdSet.has(task.id) ? ('active' as const) : ('archive' as const),
    }));

    const activeRequestId = requests[0]?.requestId || null;
    const evidenceRequestId = requestedRequestId || activeRequestId;
    const supersededByIndex = new Map<string, string[]>();
    for (const task of tasks) {
      const supersedesTaskId = String(task.supersedesTaskId || '').trim();
      if (!supersedesTaskId) {
        continue;
      }
      const next = supersededByIndex.get(supersedesTaskId) || [];
      next.push(task.id);
      supersededByIndex.set(supersedesTaskId, next);
    }
    const taskEvidence = tasks.map((task) => ({
      ...deriveTaskEvidence(teamId, sessionId, task),
      supersededByTaskIds: supersededByIndex.get(task.id) || [],
    }));
    const runEvidence = tasks.flatMap(deriveRunEvidence)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const doneWithEvidenceGaps = deriveDoneEvidenceIntegrityGaps({
      teamId,
      chatSessionId: sessionId,
      tasks,
    });
    const dependencyHandoffHints = deriveDependencyHandoffHints({
      teamId,
      chatSessionId: sessionId,
      tasks: tasks as TaskFact[],
    });
    const {
      runtimeDiagnostics: probedRuntimeDiagnostics,
      transportError: runtimeTransportError,
      failureTransport: runtimeFailureTransport,
    } = await probeRequestRuntimeDiagnostics({
      teamId,
      requests,
      activeRequestId: evidenceRequestId,
    });
    let runtimeDiagnostics: Record<string, unknown> | { error?: string } | null = probedRuntimeDiagnostics;
    const registry = getTeamRegistry(teamId);

    requests = requests.map((request) => {
      const scopedTasks = tasks.filter((task) => task.requestId === request.requestId);
      const finalGate = deriveRequestFinalGate({
        facts: scopedTasks as TaskFact[],
        proposals: proposals.filter((proposal) => proposal.requestId === request.requestId),
        decisions: decisions.filter((decision) => decision.requestId === request.requestId),
      });
      const failureTriage = deriveBlackboardFailureTriage({
        requestId: request.requestId,
        requestState: request.state,
        failureTransport: request.requestId === evidenceRequestId ? runtimeFailureTransport : null,
        transportError: request.requestId === evidenceRequestId ? runtimeTransportError : null,
        dependencyHandoffHints,
        tasks: scopedTasks as TaskFact[],
      });
      return {
        ...request,
        failureCategory: failureTriage.failureCategory,
        failureSummary: failureTriage.failureSummary,
        failureTaskIds: failureTriage.failureTaskIds,
        closureMode: deriveRequestClosureMode({
          requestState: request,
          tasks: scopedTasks,
        }),
        failureTransport: failureTriage.failureTransport,
        finalGate,
      };
    });
    const requestEvidence = requests.map((request) =>
      deriveRequestEvidence(
        request,
        tasks,
        dependencyHandoffHints,
        doneWithEvidenceGaps,
        request.requestId === evidenceRequestId ? runtimeFailureTransport : null,
        request.requestId === evidenceRequestId ? runtimeTransportError : null,
      ),
    );
    const proposalEvidence = proposals.map((proposal) => deriveProposalEvidence(proposal, decisions));
    const decisionEvidence = decisions.map(deriveDecisionEvidence);
    const collaboration = [
      ...deriveCollaborationRecords(tasks),
      ...deriveProposalCollaborationRecords(proposals, decisions),
    ]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 200);
    const executionTrace = deriveExecutionTrace({
      teamId,
      chatSessionId: sessionId,
      requestId: evidenceRequestId,
    });
    const evidenceIntegrity = {
      doneWithEvidenceGaps,
    };
    const requestScopeHints = {
      crossRequestDependencyHints: deriveCrossRequestDependencyHints(tasks),
      explicitSupersedeHints: deriveExplicitSupersedeHints(tasks),
    };
    const leaseDiagnostics = deriveLeaseDiagnostics(tasks);
    const phaseABase = derivePhaseAIdentityAnomalies(boardState);
    const identityHints = {
      sessionMismatches: deriveSessionIdentityHints(tasks, { teamId, chatSessionId: sessionId }),
      phaseA: {
        ...phaseABase,
        boardLayerPayloadAlignment: deriveBoardLayerPayloadAlignment({
          layerFactCounts: phaseABase.layerFactCounts,
          tasks: tasks as Array<{ boardLayer?: 'active' | 'archive' }>,
        }),
      },
    };
    const bucketPressure = deriveBucketPressure(tasks);
    const phaseB = {
      executionScopeHints: derivePhaseBExecutionScopeHints(tasks as TaskFact[]),
      rosterCapabilityAllowlist: registry ? deriveRosterCapabilityAllowlist(registry) : [],
    };
    const phaseC = derivePhaseCRecoveryAndLeaseHints(tasks as TaskFact[]);
    const coordinatorRequestState = evidenceRequestId
      ? requestStore.getRequestForSession(teamId, evidenceRequestId, sessionId) ?? null
      : null;
    const phaseD = summarizeCoordinatorModeSnapshotForDiagnostics(
      resolveBlackboardCoordinatorMode({
        board,
        teamId,
        chatSessionId: sessionId,
        requestId: evidenceRequestId,
        requestState: coordinatorRequestState,
      }),
    );
    const phaseE = {
      openTaskEvidenceExpectations: derivePhaseEOpenTaskEvidenceExpectations(tasks as TaskFact[]),
    };
    const phaseF = derivePhaseFBlackboardSnapshotMeta();
    const phaseG = deriveOpenTaskProgressSnapshots({
      tasks: tasks as TaskFact[],
      executionEvents: executionTrace.events,
    });
    const phaseH = {
      dependencyHandoffHints,
    };
    const requestAudit = evidenceRequestId
      ? deriveRequestAuditSnapshot({
          board,
          teamId,
          chatSessionId: sessionId,
          requestId: evidenceRequestId,
          requestState: coordinatorRequestState,
        })
      : null;
    if (runtimeDiagnostics && typeof runtimeDiagnostics === 'object') {
      runtimeDiagnostics = {
        ...runtimeDiagnostics,
        evidenceIntegrity,
        requestScopeHints,
        leaseDiagnostics,
        opDiagnostics: {
          recentCount: ops.length,
          latestByOp: ops.slice(0, 20).reduce<Record<string, string>>((acc, item) => {
            if (!acc[item.op]) {
              acc[item.op] = new Date(item.timestamp).toISOString();
            }
            return acc;
          }, {}),
        },
        identityHints,
        bucketPressure,
        phaseB,
        phaseC,
        phaseD,
        phaseE,
        phaseF,
        phaseG,
        phaseH,
        requestAudit,
      };
    } else {
      runtimeDiagnostics = {
        evidenceIntegrity,
        requestScopeHints,
        leaseDiagnostics,
        opDiagnostics: {
          recentCount: ops.length,
          latestByOp: ops.slice(0, 20).reduce<Record<string, string>>((acc, item) => {
            if (!acc[item.op]) {
              acc[item.op] = new Date(item.timestamp).toISOString();
            }
            return acc;
          }, {}),
        },
        identityHints,
        bucketPressure,
        phaseB,
        phaseC,
        phaseD,
        phaseE,
        phaseF,
        phaseG,
        phaseH,
        requestAudit,
      };
    }

    if (registry) {
      const capabilityCoverage = deriveCapabilityCoverageGaps({
        registry,
        tasks,
        requestId: evidenceRequestId,
      });
      runtimeDiagnostics = { ...runtimeDiagnostics, capabilityCoverage };
    }

    sendJson(res, 200, success({
      teamId,
      chatSessionId: sessionId,
      requestedSessionId,
      requestedRequestId,
      sessionResolution: {
        resolvedSessionId: sessionId,
        requestMatchedSessionId: sessionSelection.requestMatchedSessionId,
        activeSessionId: sessionSelection.activeSessionId,
        latestBlackboardSessionId: sessionSelection.latestBlackboardSessionId,
        matchedBy:
          !requestedRequestId && sessionSelection.matchedBy !== 'latestBlackboard' && sessionId === findLatestSessionWithBlackboardData(teamId)
            ? 'latestBlackboard'
            : sessionSelection.matchedBy,
        requestSessionOverride:
          Boolean(requestedRequestId)
          && Boolean(requestedSessionId)
          && requestedSessionId !== sessionSelection.requestMatchedSessionId
          && requestedSessionId !== sessionId,
      },
      activeRequestId,
      evidenceRequestId,
      requests,
      tasks,
      proposals,
      decisions,
      capabilities: boardState.capabilities,
      runtimeState: runtimeStore.getStateForSession(teamId, sessionId),
      runtimeDiagnostics,
      evidence: {
        requests: requestEvidence,
        tasks: taskEvidence,
        proposals: proposalEvidence,
        decisions: decisionEvidence,
        ops: ops.map((record) => ({
          opId: record.id,
          requestId: record.requestId,
          op: record.op,
          entityType: record.entityType,
          entityId: record.entityId,
          actor: record.actor,
          source: record.source,
          reason: record.reason || null,
          taskId: record.taskId || null,
          proposalId: record.proposalId || null,
          decisionId: record.decisionId || null,
          runId: record.runId ?? null,
          beforeRevision: record.beforeRevision ?? null,
          afterRevision: record.afterRevision ?? null,
          fromStatus: record.fromStatus ?? null,
          toStatus: record.toStatus ?? null,
          timestamp: new Date(record.timestamp).toISOString(),
        })),
        runs: runEvidence,
        collaboration,
        executionTrace,
        requestAudit,
      },
    }));
  } catch (err) {
    console.error('[API] Failed to get team blackboard:', err);
    sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
  }
}

export async function handleGetTeamBlackboardRequestExplain(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  requestIdParam: string,
): Promise<void> {
  try {
    const requestUrl = new URL(
      req.url || `/api/teams/${teamId}/blackboard/requests/${encodeURIComponent(requestIdParam)}/explain`,
      'http://127.0.0.1',
    );
    const requestedSessionId = requestUrl.searchParams.get('sessionId');
    const requestedRequestId = String(requestIdParam || requestUrl.searchParams.get('requestId') || '').trim();
    if (!requestedRequestId) {
      sendJson(res, 400, error('requestId is required'));
      return;
    }
    const sessionSelection = resolveBlackboardSessionSelection({
      teamId,
      requestedRequestId,
      requestedSessionId,
    });
    const sessionId = sessionSelection.sessionId;
    if (!sessionId) {
      sendJson(res, 404, error(`No blackboard session found for request ${requestedRequestId}`));
      return;
    }

    await maybeTickRequestFinalizationOnRead({
      teamId,
      sessionId,
      requestId: requestedRequestId,
    });

    const payload = buildBlackboardRequestExplainData({
      teamId,
      sessionId,
      requestedSessionId,
      requestedRequestId,
    });

    sendJson(res, 200, success({
      ...payload,
      sessionResolution: {
        resolvedSessionId: sessionId,
        requestMatchedSessionId: sessionSelection.requestMatchedSessionId,
        activeSessionId: sessionSelection.activeSessionId,
        latestBlackboardSessionId: sessionSelection.latestBlackboardSessionId,
        matchedBy: sessionSelection.matchedBy,
      },
    }));
  } catch (err) {
    console.error('[API] Failed to explain request blackboard flow:', err);
    sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
  }
}
