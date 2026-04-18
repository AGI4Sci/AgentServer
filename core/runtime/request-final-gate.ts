import type { DecisionFact, ProposalFact, TaskFact } from './blackboard-types.js';
import {
  deriveProposalLifecycle,
  isHighRiskProposalKind,
  type ProposalLifecycle,
} from './blackboard-proposals.js';

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.requiredCapability === 'user-input'
    || fact.id.startsWith('coordinator:');
}

function isSupersededByDoneReplacement(fact: Pick<TaskFact, 'id'>, facts: TaskFact[]): boolean {
  return facts.some((candidate) =>
    candidate.status === 'done'
    && String(candidate.supersedesTaskId || '').trim() === fact.id);
}

export interface RequestFinalGateSnapshot {
  canReadyForFinal: boolean;
  pendingTaskIds: string[];
  runningTaskIds: string[];
  waitingUserTaskIds: string[];
  approvedUnmaterializedProposalIds: string[];
  pendingDecisionHighRiskProposalIds: string[];
  autoAdvanceBlockedTaskIds: string[];
  retryableBlockedTaskIds: string[];
  visibleRecoveryResidueTaskIds: string[];
  blockingReason: string | null;
}

export function deriveRequestFinalGate(args: {
  facts: TaskFact[];
  proposals: ProposalFact[];
  decisions: DecisionFact[];
}): RequestFinalGateSnapshot {
  const activeFacts = args.facts.filter((fact) => fact.status !== 'done');
  const activeSubstantiveFacts = activeFacts.filter((fact) => !isCoordinatorControlFact(fact));
  const proposalLifecycle = new Map<string, ProposalLifecycle>(
    args.proposals.map((proposal) => [proposal.id, deriveProposalLifecycle(proposal, args.decisions)]),
  );

  const pendingTaskIds = activeSubstantiveFacts.filter((fact) => fact.status === 'pending').map((fact) => fact.id);
  const runningTaskIds = activeSubstantiveFacts.filter((fact) => fact.status === 'running').map((fact) => fact.id);
  const waitingUserTaskIds = activeFacts.filter((fact) => fact.status === 'waiting_user').map((fact) => fact.id);
  const approvedUnmaterializedProposalIds = args.proposals
    .filter((proposal) => proposalLifecycle.get(proposal.id) === 'approved_unmaterialized')
    .map((proposal) => proposal.id);
  const pendingDecisionHighRiskProposalIds = args.proposals
    .filter((proposal) =>
      proposalLifecycle.get(proposal.id) === 'pending_decision'
      && isHighRiskProposalKind(proposal.kind))
    .map((proposal) => proposal.id);
  const autoAdvanceBlockedTaskIds = activeFacts
    .filter((fact) =>
      (fact.status === 'blocked' || fact.status === 'failed')
      && args.proposals.some((proposal) =>
        proposal.parentTaskId === fact.id
        && proposalLifecycle.get(proposal.id) !== 'rejected'))
    .map((fact) => fact.id);
  const retryableBlockedTaskIds = activeSubstantiveFacts
    .filter((fact) =>
      (fact.status === 'blocked' || fact.status === 'failed')
      && fact.blockedBy?.retryable !== false
      && !isSupersededByDoneReplacement(fact, args.facts))
    .map((fact) => fact.id);
  const visibleRecoveryResidueTaskIds = activeFacts
    .filter((fact) =>
      isCoordinatorControlFact(fact)
      && (
        fact.status === 'waiting_user'
        || (
          (fact.status === 'blocked' || fact.status === 'failed')
          && fact.blockedBy?.retryable !== false
        )
      ))
    .map((fact) => fact.id);

  const blockingReason =
    pendingTaskIds.length > 0
      ? `pending tasks remain: ${pendingTaskIds.join(', ')}`
      : runningTaskIds.length > 0
        ? `running tasks remain: ${runningTaskIds.join(', ')}`
        : waitingUserTaskIds.length > 0
          ? `waiting_user tasks remain: ${waitingUserTaskIds.join(', ')}`
          : approvedUnmaterializedProposalIds.length > 0
            ? `approved but unmaterialized proposals remain: ${approvedUnmaterializedProposalIds.join(', ')}`
            : pendingDecisionHighRiskProposalIds.length > 0
              ? `high-risk proposals still need decision: ${pendingDecisionHighRiskProposalIds.join(', ')}`
              : autoAdvanceBlockedTaskIds.length > 0
                ? `blocked tasks still have unresolved proposal-driven next steps: ${autoAdvanceBlockedTaskIds.join(', ')}`
                : retryableBlockedTaskIds.length > 0
                  ? `retryable blocked tasks still need recovery: ${retryableBlockedTaskIds.join(', ')}`
                  : visibleRecoveryResidueTaskIds.length > 0
                    ? `recovery/user-input control residue is still active: ${visibleRecoveryResidueTaskIds.join(', ')}`
                    : null;

  return {
    canReadyForFinal: !blockingReason,
    pendingTaskIds,
    runningTaskIds,
    waitingUserTaskIds,
    approvedUnmaterializedProposalIds,
    pendingDecisionHighRiskProposalIds,
    autoAdvanceBlockedTaskIds,
    retryableBlockedTaskIds,
    visibleRecoveryResidueTaskIds,
    blockingReason,
  };
}
