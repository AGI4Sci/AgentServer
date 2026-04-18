import { deriveRequestFinalGate, type RequestFinalGateSnapshot } from './request-final-gate.js';
import { evaluateBlackboardFinalReadiness, type BlackboardFinalReadiness } from './blackboard-synthesis.js';
import type { BlackboardStore } from '../store/blackboard-store.js';
import type { DecisionFact, ProposalFact, TaskFact, BlackboardOpRecord } from './blackboard-types.js';
import type { RequestStateRecord } from '../store/request-state-store.js';
import {
  canMaterializeProposalDecision,
  latestDecisionForProposal,
} from './blackboard-proposals.js';

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.requiredCapability === 'user-input'
    || fact.id.startsWith('coordinator:');
}

function isTerminalSubstantiveFact(fact: Pick<TaskFact, 'status' | 'blockedBy'>): boolean {
  if (fact.status === 'done' || fact.status === 'failed') {
    return true;
  }
  return fact.status === 'blocked' && fact.blockedBy?.retryable === false;
}

export interface RequestAuditSnapshot {
  requestId: string;
  requestState: string | null;
  finalGate: RequestFinalGateSnapshot;
  readiness: BlackboardFinalReadiness;
  protocolModules: Array<{
    moduleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';
    label: string;
    touched: boolean;
    active: boolean;
    reason: string;
  }>;
  activeProtocolModuleIds: Array<'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8'>;
  currentBottleneckModuleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8' | null;
  protocolInvariantGaps: Array<{
    moduleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';
    code:
      | 'pending_initial_proposal'
      | 'pending_execution'
      | 'missing_completion_evidence'
      | 'pending_decision'
      | 'approved_not_materialized'
      | 'blocked_neighborhood_unresolved'
      | 'waiting_user_unresolved'
      | 'lease_recovery_active'
      | 'final_gate_not_ready';
    detail: string;
    severity: 'info' | 'warning' | 'critical';
  }>;
  protocolRepairTemplates: Array<{
    moduleId: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'M8';
    invariantCode:
      | 'pending_initial_proposal'
      | 'pending_execution'
      | 'missing_completion_evidence'
      | 'pending_decision'
      | 'approved_not_materialized'
      | 'blocked_neighborhood_unresolved'
      | 'waiting_user_unresolved'
      | 'lease_recovery_active'
      | 'final_gate_not_ready';
    actionKind:
      | 'write_initial_proposal'
      | 'continue_execution'
      | 'supply_completion_evidence'
      | 'write_decision'
      | 'materialize_task'
      | 'resolve_blocked_neighborhood'
      | 'collect_user_input'
      | 'finish_lease_recovery'
      | 'satisfy_final_gate';
    targetTaskId?: string | null;
    targetProposalId?: string | null;
    title: string;
    detail: string;
  }>;
  substantiveTaskIds: string[];
  terminalTaskIds: string[];
  nonTerminalTaskIds: string[];
  doneTaskIds: string[];
  failedTaskIds: string[];
  blockedTaskIds: string[];
  historicalBlockedTaskIds: string[];
  historicalRetryableBlockedTaskIds: string[];
  waitingUserTaskIds: string[];
  historicalWaitingUserTaskIds: string[];
  waitingUserResumeTaskIds: string[];
  replacementTaskIds: string[];
  supersededTaskIds: string[];
  supersedeEdges: Array<{
    taskId: string;
    supersedesTaskId: string;
    status: TaskFact['status'];
  }>;
  activeWorkspaceFanout: Array<{
    workspaceId: string;
    activeTaskCount: number;
  }>;
  maxWorkspaceFanout: number;
  opCounts: Partial<Record<BlackboardOpRecord['op'], number>>;
  approvedProposalIds: string[];
  materializedProposalIds: string[];
  blockedReplanProposalIds: string[];
  approvedButUnmaterializedProposalIds: string[];
  completeOpTaskIds: string[];
  materializeOpTaskIds: string[];
  resetOpTaskIds: string[];
  leaseExpiredResetTaskIds: string[];
  timeline: Array<{
    op: BlackboardOpRecord['op'];
    entityType: BlackboardOpRecord['entityType'];
    entityId: string;
    taskId: string | null;
    proposalId: string | null;
    decisionId: string | null;
    timestamp: number;
  }>;
  gaps: string[];
}

export function deriveRequestAuditSnapshot(args: {
  board: Pick<BlackboardStore, 'list' | 'listProposals' | 'listDecisions' | 'listOps'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  requestState?: RequestStateRecord | null;
}): RequestAuditSnapshot {
  const facts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
  });
  const proposals = args.board.listProposals(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  });
  const decisions = args.board.listDecisions(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  });
  const ops = args.board.listOps(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  });

  const finalGate = deriveRequestFinalGate({
    facts: facts.filter((fact) => fact.status !== 'done'),
    proposals,
    decisions,
  });
  const readiness = evaluateBlackboardFinalReadiness({
    board: args.board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState: args.requestState,
  });

  const substantiveFacts = facts.filter((fact) => !isCoordinatorControlFact(fact));
  const terminalFacts = substantiveFacts.filter((fact) => isTerminalSubstantiveFact(fact));
  const nonTerminalFacts = substantiveFacts.filter((fact) => !isTerminalSubstantiveFact(fact));
  const doneFacts = substantiveFacts.filter((fact) => fact.status === 'done');
  const failedFacts = substantiveFacts.filter((fact) => fact.status === 'failed');
  const blockedFacts = substantiveFacts.filter((fact) => fact.status === 'blocked');
  const historicalBlockedTaskIds = [...new Set(ops
    .filter((item) => item.taskId && item.toStatus === 'blocked')
    .map((item) => String(item.taskId)))];
  const historicalRetryableBlockedTaskIds = [...new Set(ops
    .filter((item) =>
      item.taskId
      && item.toStatus === 'blocked'
      && proposals.some((proposal) => proposal.parentTaskId === item.taskId && proposal.kind === 'blocked_replan'))
    .map((item) => String(item.taskId)))];
  const waitingUserFacts = facts.filter((fact) => fact.status === 'waiting_user');
  const historicalWaitingUserTaskIds = [...new Set(ops
    .filter((item) => item.taskId && item.toStatus === 'waiting_user')
    .map((item) => String(item.taskId)))];
  const replacementFacts = substantiveFacts.filter((fact) => typeof fact.supersedesTaskId === 'string' && fact.supersedesTaskId.trim().length > 0);
  const activeWorkspaceFanout = Object.entries(nonTerminalFacts.reduce<Record<string, number>>((acc, fact) => {
    const workspaceId = String(fact.executionScope.workspaceId || '').trim() || 'unknown';
    acc[workspaceId] = (acc[workspaceId] || 0) + 1;
    return acc;
  }, {}))
    .map(([workspaceId, activeTaskCount]) => ({ workspaceId, activeTaskCount }))
    .sort((left, right) =>
      right.activeTaskCount - left.activeTaskCount
      || left.workspaceId.localeCompare(right.workspaceId));
  const maxWorkspaceFanout = activeWorkspaceFanout[0]?.activeTaskCount || 0;
  const waitingUserResumeTaskIds = replacementFacts
    .filter((fact) => {
      if (historicalWaitingUserTaskIds.length === 0) {
        return false;
      }
      const materializingProposal = proposals.find((proposal) =>
        proposal.payload.taskId === fact.id
        || proposal.payload.supersedesTaskId === fact.supersedesTaskId);
      if (materializingProposal?.kind === 'blocked_replan') {
        return false;
      }
      return true;
    })
    .map((fact) => fact.id);
  const supersedeEdges = replacementFacts.map((fact) => ({
    taskId: fact.id,
    supersedesTaskId: String(fact.supersedesTaskId || ''),
    status: fact.status,
  }));
  const materializableDecisions = decisions.filter((decision) => canMaterializeProposalDecision(decision));
  const approvedProposalIds = materializableDecisions.map((decision) => decision.proposalId);
  const materializedProposalIds = materializableDecisions
    .filter((decision) => (decision.materializedTaskIds || []).length > 0)
    .map((decision) => decision.proposalId);
  const blockedReplanProposalIds = proposals
    .filter((proposal) => proposal.kind === 'blocked_replan')
    .map((proposal) => proposal.id);
  const opCounts = ops.reduce<Partial<Record<BlackboardOpRecord['op'], number>>>((acc, item) => {
    acc[item.op] = (acc[item.op] || 0) + 1;
    return acc;
  }, {});
  const completeOpTaskIds = ops
    .filter((item) => item.op === 'complete' && item.taskId)
    .map((item) => String(item.taskId));
  const materializeOpTaskIds = ops
    .filter((item) => item.op === 'materialize' && item.taskId)
    .map((item) => String(item.taskId));
  const resetOpTaskIds = ops
    .filter((item) => item.op === 'reset' && item.taskId)
    .map((item) => String(item.taskId));
  const leaseExpiredResetTaskIds = substantiveFacts
    .filter((fact) => fact.failureHistory.some((item) => item.resetKind === 'lease_expired_reset'))
    .map((fact) => fact.id);
  const timeline = ops
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((item) => ({
      op: item.op,
      entityType: item.entityType,
      entityId: item.entityId,
      taskId: item.taskId || null,
      proposalId: item.proposalId || null,
      decisionId: item.decisionId || null,
      timestamp: item.timestamp,
    }));

  const hasCoordinatorSeed = facts.some((fact) => isCoordinatorControlFact(fact));
  const hasExecutionSignals = nonTerminalFacts.some((fact) => fact.status === 'pending' || fact.status === 'running')
    || ops.some((item) => item.op === 'claim' || item.op === 'heartbeat');
  const hasCompletionSignals = doneFacts.length > 0 || completeOpTaskIds.length > 0;
  const hasProposalExpansionSignals = proposals.length > 0;
  const hasRecoverySignals =
    blockedFacts.length > 0
    || failedFacts.length > 0
    || historicalBlockedTaskIds.length > 0
    || replacementFacts.length > 0
    || resetOpTaskIds.length > 0;
  const hasWaitingUserSignals = waitingUserFacts.length > 0 || historicalWaitingUserTaskIds.length > 0;
  const hasLeaseRecoverySignals = leaseExpiredResetTaskIds.length > 0;
  const hasFinalizeSignals = readiness.canPublish || args.requestState?.state === 'ready_for_final' || args.requestState?.state === 'closed';

  const protocolModules: RequestAuditSnapshot['protocolModules'] = [
    {
      moduleId: 'M1',
      label: '首层拆解',
      touched: hasCoordinatorSeed || proposals.some((proposal) => proposal.parentTaskId.startsWith('coordinator:')),
      active: proposals.length > 0 && substantiveFacts.length === 0,
      reason: proposals.length > 0
        ? 'request 已形成首层 proposal / control seed'
        : '尚未看到明确首层 proposal',
    },
    {
      moduleId: 'M2',
      label: '执行主循环',
      touched: hasExecutionSignals || substantiveFacts.length > 0,
      active: nonTerminalFacts.some((fact) => fact.status === 'pending' || fact.status === 'running'),
      reason: nonTerminalFacts.some((fact) => fact.status === 'pending' || fact.status === 'running')
        ? '仍有 substantive task 在 pending/running'
        : '当前没有进行中的 substantive task',
    },
    {
      moduleId: 'M3',
      label: '完成提交流',
      touched: hasCompletionSignals,
      active: doneFacts.length > 0 && !readiness.canPublish,
      reason: doneFacts.length > 0
        ? '已有 done task，等待 join / final gating 收口'
        : '尚未形成 substantive done task',
    },
    {
      moduleId: 'M4',
      label: 'proposal-first 扩展',
      touched: hasProposalExpansionSignals,
      active: approvedProposalIds.length > materializedProposalIds.length || finalGate.pendingDecisionHighRiskProposalIds.length > 0,
      reason: finalGate.pendingDecisionHighRiskProposalIds.length > 0
        ? '仍有高风险 proposal 缺 decision'
        : approvedProposalIds.length > materializedProposalIds.length
          ? '仍有 approved proposal 尚未 materialize'
          : proposals.length > 0
            ? 'proposal 扩展已发生并已落任务'
            : '尚未发生 proposal 扩展',
    },
    {
      moduleId: 'M5',
      label: '阻塞与局部恢复',
      touched: hasRecoverySignals,
      active: blockedFacts.length > 0 || finalGate.autoAdvanceBlockedTaskIds.length > 0,
      reason: blockedFacts.length > 0
        ? '仍有 blocked substantive task'
        : finalGate.autoAdvanceBlockedTaskIds.length > 0
          ? 'blocked 邻域仍有待推进的 proposal-driven next step'
          : hasRecoverySignals
            ? '曾发生 recovery / replacement / reset'
            : '尚未触发局部恢复',
    },
    {
      moduleId: 'M6',
      label: '等待用户输入',
      touched: hasWaitingUserSignals,
      active: waitingUserFacts.length > 0,
      reason: waitingUserFacts.length > 0
        ? '当前仍有 waiting_user task'
        : historicalWaitingUserTaskIds.length > 0
          ? '曾进入 waiting_user 并已恢复'
          : '尚未进入 waiting_user',
    },
    {
      moduleId: 'M7',
      label: '租约失效与重试',
      touched: hasLeaseRecoverySignals,
      active: leaseExpiredResetTaskIds.some((taskId) => nonTerminalFacts.some((fact) => fact.id === taskId)),
      reason: hasLeaseRecoverySignals
        ? '曾发生 lease_expired_reset / reclaim'
        : '尚未触发 lease recovery',
    },
    {
      moduleId: 'M8',
      label: '综合收尾',
      touched: hasFinalizeSignals,
      active: readiness.canPublish,
      reason: readiness.canPublish
        ? '已满足 final publish 条件'
        : args.requestState?.state === 'closed'
          ? 'request 已收口关闭'
          : '尚未进入 final publish 阶段',
    },
  ];
  const activeProtocolModuleIds = protocolModules.filter((item) => item.active).map((item) => item.moduleId);
  const currentBottleneckModuleId =
    waitingUserFacts.length > 0 ? 'M6'
    : finalGate.pendingDecisionHighRiskProposalIds.length > 0 || approvedProposalIds.length > materializedProposalIds.length ? 'M4'
    : blockedFacts.length > 0 || finalGate.autoAdvanceBlockedTaskIds.length > 0 ? 'M5'
    : leaseExpiredResetTaskIds.some((taskId) => nonTerminalFacts.some((fact) => fact.id === taskId)) ? 'M7'
    : nonTerminalFacts.some((fact) => fact.status === 'pending' || fact.status === 'running') ? 'M2'
    : doneFacts.length > 0 && !readiness.canPublish ? 'M3'
    : readiness.canPublish ? 'M8'
    : proposals.length > 0 ? 'M1'
    : null;

  const gaps: string[] = [];

  for (const proposal of proposals) {
    const latestDecision = latestDecisionForProposal(decisions, proposal.id);
    if (!latestDecision && finalGate.pendingDecisionHighRiskProposalIds.includes(proposal.id)) {
      gaps.push(`high-risk proposal ${proposal.id} is missing a decision`);
      continue;
    }
    if (canMaterializeProposalDecision(latestDecision) && (latestDecision?.materializedTaskIds || []).length === 0) {
      gaps.push(`approved proposal ${proposal.id} is missing materialization`);
    }
  }

  for (const fact of doneFacts) {
    const isSupersededClosure = /Superseded by /.test(String(fact.result || ''));
    const hasCompletionAudit =
      completeOpTaskIds.includes(fact.id)
      || materializeOpTaskIds.includes(fact.id);
    if (!hasCompletionAudit && !isSupersededClosure) {
      gaps.push(`done task ${fact.id} is missing complete/materialize audit ops`);
    }
  }

  const protocolInvariantGaps: RequestAuditSnapshot['protocolInvariantGaps'] = [];
  if (proposals.length === 0 && substantiveFacts.length === 0) {
    protocolInvariantGaps.push({
      moduleId: 'M1',
      code: 'pending_initial_proposal',
      detail: '尚未形成首层 proposal，request 还没有进入可执行主链。',
      severity: 'warning',
    });
  }
  if (nonTerminalFacts.some((fact) => fact.status === 'pending' || fact.status === 'running')) {
    protocolInvariantGaps.push({
      moduleId: 'M2',
      code: 'pending_execution',
      detail: `仍有 ${nonTerminalFacts.filter((fact) => fact.status === 'pending' || fact.status === 'running').length} 个 substantive task 在执行主循环中。`,
      severity: 'info',
    });
  }
  for (const proposalId of finalGate.pendingDecisionHighRiskProposalIds) {
    protocolInvariantGaps.push({
      moduleId: 'M4',
      code: 'pending_decision',
      detail: `高风险 proposal ${proposalId} 仍缺少明确 decision。`,
      severity: 'critical',
    });
  }
  for (const proposalId of finalGate.approvedUnmaterializedProposalIds) {
    protocolInvariantGaps.push({
      moduleId: 'M4',
      code: 'approved_not_materialized',
      detail: `approved proposal ${proposalId} 尚未 materialize 为真实 task。`,
      severity: 'critical',
    });
  }
  if (finalGate.autoAdvanceBlockedTaskIds.length > 0 || blockedFacts.length > 0) {
    protocolInvariantGaps.push({
      moduleId: 'M5',
      code: 'blocked_neighborhood_unresolved',
      detail: `仍有 ${Math.max(finalGate.autoAdvanceBlockedTaskIds.length, blockedFacts.length)} 个 blocked 邻域未收口。`,
      severity: 'warning',
    });
  }
  if (waitingUserFacts.length > 0) {
    protocolInvariantGaps.push({
      moduleId: 'M6',
      code: 'waiting_user_unresolved',
      detail: `仍有 ${waitingUserFacts.length} 个 waiting_user task 等待输入或恢复接续。`,
      severity: 'critical',
    });
  }
  if (leaseExpiredResetTaskIds.some((taskId) => nonTerminalFacts.some((fact) => fact.id === taskId))) {
    protocolInvariantGaps.push({
      moduleId: 'M7',
      code: 'lease_recovery_active',
      detail: 'lease recovery 邻域仍在进行中，尚未完成 reclaim 后收口。',
      severity: 'warning',
    });
  }
  const missingCompletionEvidenceTaskIds = doneFacts
    .filter((fact) => {
      const isSupersededClosure = /Superseded by /.test(String(fact.result || ''));
      const hasCompletionAudit = completeOpTaskIds.includes(fact.id) || materializeOpTaskIds.includes(fact.id);
      return !hasCompletionAudit && !isSupersededClosure;
    })
    .map((fact) => fact.id);
  for (const taskId of missingCompletionEvidenceTaskIds) {
    protocolInvariantGaps.push({
      moduleId: 'M3',
      code: 'missing_completion_evidence',
      detail: `done task ${taskId} 缺少 complete/materialize 审计证据。`,
      severity: 'critical',
    });
  }
  if (!readiness.canPublish && doneFacts.length > 0) {
    protocolInvariantGaps.push({
      moduleId: 'M8',
      code: 'final_gate_not_ready',
      detail: finalGate.blockingReason || 'final gate 尚未满足。',
      severity: 'warning',
    });
  }
  const protocolRepairTemplates: RequestAuditSnapshot['protocolRepairTemplates'] = protocolInvariantGaps.map((gap) => {
    switch (gap.code) {
      case 'pending_initial_proposal':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'write_initial_proposal',
          targetTaskId: null,
          targetProposalId: null,
          title: '先形成首层 proposal',
          detail: '补齐 request 的首层 proposal，再进入后续 decide / materialize 主链。',
        };
      case 'pending_execution':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'continue_execution',
          targetTaskId: nonTerminalFacts.find((fact) => fact.status === 'pending' || fact.status === 'running')?.id || null,
          targetProposalId: null,
          title: '继续推进执行主循环',
          detail: '当前仍有 substantive task 在 pending/running，优先推进 claim / execute / complete。',
        };
      case 'missing_completion_evidence':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'supply_completion_evidence',
          targetTaskId: doneFacts.find((fact) => !completeOpTaskIds.includes(fact.id) && !materializeOpTaskIds.includes(fact.id))?.id || null,
          targetProposalId: null,
          title: '补齐完成证据',
          detail: '先补足 result / resultRef / evidence，再把 done 收口为可审计完成。',
        };
      case 'pending_decision':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'write_decision',
          targetTaskId: null,
          targetProposalId: finalGate.pendingDecisionHighRiskProposalIds[0] || null,
          title: '补齐 proposal 决策',
          detail: '为高风险 proposal 写入明确 decision，避免 request 卡在半状态。',
        };
      case 'approved_not_materialized':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'materialize_task',
          targetTaskId: null,
          targetProposalId: finalGate.approvedUnmaterializedProposalIds[0] || null,
          title: '把已批准 proposal 落成任务',
          detail: '沿显式主链 materialize approved proposal，不要通过旁路直接改 board state。',
        };
      case 'blocked_neighborhood_unresolved':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'resolve_blocked_neighborhood',
          targetTaskId: blockedFacts[0]?.id || finalGate.autoAdvanceBlockedTaskIds[0] || null,
          targetProposalId: proposals.find((proposal) =>
            finalGate.autoAdvanceBlockedTaskIds.includes(proposal.parentTaskId))?.id || null,
          title: '收口 blocked 邻域',
          detail: '在局部邻域内继续 proposal / decision / replacement，而不是重做整个 request。',
        };
      case 'waiting_user_unresolved':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'collect_user_input',
          targetTaskId: waitingUserFacts[0]?.id || null,
          targetProposalId: null,
          title: '完成 waiting_user 输入闭环',
          detail: '先补用户输入，或显式创建恢复接续任务，不要隐式跳过 waiting_user。',
        };
      case 'lease_recovery_active':
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'finish_lease_recovery',
          targetTaskId: leaseExpiredResetTaskIds[0] || null,
          targetProposalId: null,
          title: '完成 lease recovery 收口',
          detail: '沿 reset / reclaim 后的原 task 邻域继续推进，直到恢复链闭合。',
        };
      case 'final_gate_not_ready':
      default:
        return {
          moduleId: gap.moduleId,
          invariantCode: gap.code,
          actionKind: 'satisfy_final_gate',
          targetTaskId: null,
          targetProposalId: null,
          title: '补齐 final gate 条件',
          detail: '先清掉 pending/running/waiting_user 或未 materialize proposal，再进入 synthesize / final。',
        };
    }
  });

  return {
    requestId: args.requestId,
    requestState: args.requestState?.state || null,
    finalGate,
    readiness,
    protocolModules,
    activeProtocolModuleIds,
    currentBottleneckModuleId,
    protocolInvariantGaps,
    protocolRepairTemplates,
    substantiveTaskIds: substantiveFacts.map((fact) => fact.id),
    terminalTaskIds: terminalFacts.map((fact) => fact.id),
    nonTerminalTaskIds: nonTerminalFacts.map((fact) => fact.id),
    doneTaskIds: doneFacts.map((fact) => fact.id),
    failedTaskIds: failedFacts.map((fact) => fact.id),
    blockedTaskIds: blockedFacts.map((fact) => fact.id),
    historicalBlockedTaskIds,
    historicalRetryableBlockedTaskIds,
    waitingUserTaskIds: waitingUserFacts.map((fact) => fact.id),
    historicalWaitingUserTaskIds,
    waitingUserResumeTaskIds,
    replacementTaskIds: replacementFacts.map((fact) => fact.id),
    supersededTaskIds: replacementFacts.map((fact) => String(fact.supersedesTaskId || '')),
    supersedeEdges,
    activeWorkspaceFanout,
    maxWorkspaceFanout,
    opCounts,
    approvedProposalIds,
    materializedProposalIds,
    blockedReplanProposalIds,
    approvedButUnmaterializedProposalIds: finalGate.approvedUnmaterializedProposalIds,
    completeOpTaskIds,
    materializeOpTaskIds,
    resetOpTaskIds,
    leaseExpiredResetTaskIds,
    timeline,
    gaps,
  };
}
