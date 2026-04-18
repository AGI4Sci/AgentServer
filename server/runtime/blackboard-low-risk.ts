import {
  isAutoApprovableProposalKind,
  latestDecisionForProposal,
} from '../../core/runtime/blackboard-proposals.js';
import type { BlackboardStore } from '../../core/store/blackboard-store.js';

export function resolveLowRiskProposalBacklog(args: {
  board: Pick<BlackboardStore, 'listProposals' | 'listDecisions' | 'decide' | 'materializeApprovedProposal'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  decidedBy?: string;
  notePrefix?: string;
}): {
  autoResolvedProposalIds: string[];
  decidedIds: string[];
  materializedTaskIds: string[];
} {
  const proposals = args.board.listProposals(args.teamId, args.chatSessionId, { requestId: args.requestId });
  const decisions = args.board.listDecisions(args.teamId, args.chatSessionId, { requestId: args.requestId });
  const decidedIds: string[] = [];
  const materializedTaskIds: string[] = [];
  const autoResolvedProposalIds: string[] = [];

  for (const proposal of proposals) {
    if (!isAutoApprovableProposalKind(proposal.kind)) {
      continue;
    }
    const latestDecision = latestDecisionForProposal(decisions, proposal.id);
    let activeDecision = latestDecision;
    if (!activeDecision) {
      activeDecision = args.board.decide(args.teamId, args.chatSessionId, {
        id: `decision:${proposal.id}:auto-low-risk`,
        revision: 0,
        requestId: args.requestId,
        proposalId: proposal.id,
        decision: 'approve',
        decidedBy: args.decidedBy || 'coordinator:auto-low-risk',
        note: `${args.notePrefix || 'auto-low-risk'}:${proposal.kind}`,
      });
      if (activeDecision) {
        decidedIds.push(activeDecision.id);
      }
    }
    const materialized = args.board.materializeApprovedProposal(args.teamId, args.chatSessionId, proposal.id);
    if (!latestDecision || materialized) {
      autoResolvedProposalIds.push(proposal.id);
    }
    if (materialized) {
      materializedTaskIds.push(materialized.id);
    }
  }

  return {
    autoResolvedProposalIds: [...new Set(autoResolvedProposalIds)],
    decidedIds: [...new Set(decidedIds)],
    materializedTaskIds: [...new Set(materializedTaskIds)],
  };
}
