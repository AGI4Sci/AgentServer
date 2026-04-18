import type {
  DecisionFact,
  ProposalFact,
  ProposalFactKind,
  ProposalFactPayload,
  TaskFact,
} from './blackboard-types.js';

export type ProposalLifecycle =
  | 'pending_decision'
  | 'rejected'
  | 'approved_unmaterialized'
  | 'materialized';

export function isAutoApprovableProposalKind(kind: ProposalFactKind): boolean {
  return kind === 'need_review' || kind === 'need_qa' || kind === 'need_user_input';
}

export function isHighRiskProposalKind(kind: ProposalFactKind): boolean {
  return kind === 'handoff' || kind === 'split' || kind === 'blocked_replan';
}

export function latestDecisionForProposal(decisions: DecisionFact[], proposalId: string): DecisionFact | null {
  return decisions
    .filter((decision) => decision.proposalId === proposalId)
    .sort((left, right) =>
      Number(right.decidedAt || 0) - Number(left.decidedAt || 0)
      || Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
}

export function canMaterializeProposalDecision(decision: Pick<DecisionFact, 'decision'> | null | undefined): boolean {
  return decision?.decision === 'approve' || decision?.decision === 'amend';
}

export function deriveProposalLifecycle(proposal: ProposalFact, decisions: DecisionFact[]): ProposalLifecycle {
  const latestDecision = latestDecisionForProposal(decisions, proposal.id);
  if (!latestDecision) {
    return 'pending_decision';
  }
  if (!canMaterializeProposalDecision(latestDecision)) {
    return 'rejected';
  }
  return (latestDecision.materializedTaskIds || []).length > 0
    ? 'materialized'
    : 'approved_unmaterialized';
}

export function buildAutoDecisionForProposal(proposal: ProposalFact, decidedBy = 'system:auto-rule'): Omit<DecisionFact, 'id' | 'revision' | 'chatSessionId' | 'requestId' | 'teamId' | 'proposalId' | 'updatedAt'> {
  return {
    decision: 'approve',
    decidedBy,
    decidedAt: Date.now(),
    note: `auto-approved:${proposal.kind}`,
  };
}

export function defaultMaterializedTaskId(proposal: ProposalFact): string {
  return `${proposal.requestId}:${proposal.kind}:${proposal.id}`;
}

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination' || fact.id.startsWith('coordinator:');
}

export function buildTaskPatchFromProposalDecision(args: {
  proposal: ProposalFact;
  decision: DecisionFact;
  parentTask: TaskFact;
  taskId?: string;
}): Partial<TaskFact> & Pick<TaskFact, 'id' | 'goal' | 'requiredCapability' | 'createdBy'> {
  const payload: ProposalFactPayload = args.decision.amendedPayload || args.proposal.payload;
  const baseRequires = Array.isArray(payload.requires) && payload.requires.length > 0
    ? payload.requires
    : isCoordinatorControlFact(args.parentTask) ? [] : [args.parentTask.id];
  const taskId = args.taskId || payload.taskId || defaultMaterializedTaskId(args.proposal);
  const status = args.proposal.kind === 'need_user_input' ? 'waiting_user' : 'pending';
  const owner = args.proposal.kind === 'need_user_input'
    ? (payload.suggestedAssignee || 'user')
    : (payload.suggestedAssignee || null);
  return {
    id: taskId,
    goal: payload.goal,
    requiredCapability: payload.requiredCapability,
    createdBy: args.decision.decidedBy || args.proposal.proposerAgentId,
    requestId: args.proposal.requestId,
    executionScope: {
      ...args.parentTask.executionScope,
      ...(payload.executionScope || {}),
      artifactsRoot: payload.executionScope?.artifactsRoot || args.parentTask.executionScope.artifactsRoot,
    },
    requires: baseRequires,
    supersedesTaskId: payload.supersedesTaskId,
    acceptanceCriteria: payload.acceptanceCriteria,
    evidenceRequirements: payload.evidenceRequirements,
    endpointHints: payload.endpointHints,
    toolBindings: payload.toolBindings,
    networkMode: payload.networkMode,
    riskClass: payload.riskClass,
    status,
    owner,
    currentRunId: null,
    attempt: 0,
  };
}
