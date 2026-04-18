import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentServerService } from '../server/agent_server/service.ts';
import type { AgentEvolutionProposal } from '../server/agent_server/types.ts';

function createProposalService(): AgentServerService {
  const proposals = new Map<string, AgentEvolutionProposal>();
  const store = {
    async listAgents() {
      return [];
    },
    async saveEvolutionProposal(proposal: AgentEvolutionProposal) {
      proposals.set(proposal.id, proposal);
    },
    async getEvolutionProposal(proposalId: string) {
      return proposals.get(proposalId) ?? null;
    },
    async listEvolutionProposals() {
      return [...proposals.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
  };
  return new AgentServerService(store as never);
}

test('evolution proposal lifecycle is auditable and gated', async () => {
  const service = createProposalService();
  const proposal = await service.createEvolutionProposal({
    type: 'context-policy-experiment',
    title: 'Try shorter memory context',
    evidence: [{ runId: 'run-1', outcome: 'success' }],
    expectedImpact: 'Reduce context cost for small bugfix tasks.',
    risk: 'medium',
    rollbackPlan: 'Restore the previous context policy id.',
    actor: 'test',
  });

  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.history.length, 1);

  await assert.rejects(
    () => service.applyEvolutionProposal(proposal.id, { actor: 'test' }),
    /must be approved/,
  );

  const approved = await service.approveEvolutionProposal(proposal.id, {
    actor: 'reviewer',
    note: 'safe to test',
  });
  assert.equal(approved.status, 'approved');

  const applied = await service.applyEvolutionProposal(proposal.id, {
    actor: 'operator',
  });
  assert.equal(applied.status, 'applied');
  assert.ok(applied.appliedAt);

  const rolledBack = await service.rollbackEvolutionProposal(proposal.id, {
    actor: 'operator',
    note: 'rollback drill',
  });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.ok(rolledBack.rolledBackAt);
  assert.deepEqual(
    rolledBack.history.map((entry) => entry.status),
    ['proposed', 'approved', 'applied', 'rolled_back'],
  );
});
