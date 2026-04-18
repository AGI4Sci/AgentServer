import type { ApiResponse } from '../utils/response.js';
import type {
  AcknowledgeRecoveryRequest,
  AgentClarificationRecord,
  AgentConstraintRecord,
  AgentContextSnapshot,
  AgentCurrentWorkRequest,
  AgentEvolutionProposal,
  AgentGoalRecord,
  AgentGoalRequest,
  AgentManifest,
  AgentMessageRequest,
  AgentRecoverySnapshot,
  AgentRetrievalRequest,
  AgentRetrievalResult,
  AgentRunRecord,
  AgentServerRunRequest,
  AgentServerRunResult,
  AgentTurnLogQuery,
  AgentTurnRecord,
  AgentWorkEntry,
  AgentWorkspaceSearchRequest,
  AgentWorkspaceSearchResult,
  ApplyPersistentBudgetRequest,
  AppendMemoryConstraintsRequest,
  AppendMemorySummaryRequest,
  AppendPersistentConstraintsRequest,
  AppendPersistentSummaryRequest,
  AutonomousAgentRunRequest,
  AutonomousAgentRunResult,
  CompactAgentRequest,
  CompactPreviewResult,
  CreateAgentEvolutionProposalRequest,
  CreateAgentRequest,
  EnsureAutonomousAgentRequest,
  FinalizeSessionPreview,
  FinalizeSessionRequest,
  PersistentBudgetPreview,
  ReplaceCurrentWorkRequest,
  ResolveClarificationRequest,
  ReviveAgentRequest,
  UpdateAgentEvolutionProposalStatusRequest,
} from './types.js';

export interface AgentServerHttpClient {
  runTask(input: AgentServerRunRequest): Promise<AgentServerRunResult>;
  getRun(runId: string): Promise<AgentRunRecord>;
  createEvolutionProposal(input: CreateAgentEvolutionProposalRequest): Promise<AgentEvolutionProposal>;
  listEvolutionProposals(): Promise<AgentEvolutionProposal[]>;
  getEvolutionProposal(proposalId: string): Promise<AgentEvolutionProposal>;
  approveEvolutionProposal(proposalId: string, input?: UpdateAgentEvolutionProposalStatusRequest): Promise<AgentEvolutionProposal>;
  rejectEvolutionProposal(proposalId: string, input?: UpdateAgentEvolutionProposalStatusRequest): Promise<AgentEvolutionProposal>;
  applyEvolutionProposal(proposalId: string, input?: UpdateAgentEvolutionProposalStatusRequest): Promise<AgentEvolutionProposal>;
  rollbackEvolutionProposal(proposalId: string, input?: UpdateAgentEvolutionProposalStatusRequest): Promise<AgentEvolutionProposal>;
  ensureAutonomousAgent(input: EnsureAutonomousAgentRequest): Promise<AgentManifest>;
  runAutonomousTask(input: AutonomousAgentRunRequest): Promise<AutonomousAgentRunResult>;
  createAgent(input: CreateAgentRequest): Promise<AgentManifest>;
  getAgent(agentId: string): Promise<AgentManifest>;
  listRuns(agentId: string): Promise<AgentRunRecord[]>;
  getCurrentWork(agentId: string, query?: AgentCurrentWorkRequest): Promise<AgentWorkEntry[]>;
  replaceCurrentWork(agentId: string, input: ReplaceCurrentWorkRequest): Promise<AgentWorkEntry[]>;
  getContextSnapshot(agentId: string): Promise<AgentContextSnapshot>;
  getRecoverySnapshot(agentId: string): Promise<AgentRecoverySnapshot>;
  acknowledgeRecovery(agentId: string, input: AcknowledgeRecoveryRequest): Promise<AgentRecoverySnapshot>;
  sendMessage(agentId: string, input: AgentMessageRequest): Promise<AgentRunRecord>;
  enqueueGoal(agentId: string, input: AgentGoalRequest): Promise<AgentGoalRecord[]>;
  listClarifications(agentId: string): Promise<AgentClarificationRecord[]>;
  resolveClarification(agentId: string, input: ResolveClarificationRequest): Promise<AgentClarificationRecord>;
  retrieveContext(agentId: string, input: AgentRetrievalRequest): Promise<AgentRetrievalResult>;
  searchWorkspace(agentId: string, input: AgentWorkspaceSearchRequest): Promise<AgentWorkspaceSearchResult>;
  getTurns(agentId: string, query?: AgentTurnLogQuery): Promise<AgentTurnRecord[]>;
  finalizeSession(agentId: string, input?: FinalizeSessionRequest): Promise<unknown>;
  previewFinalizeSession(agentId: string, input?: FinalizeSessionRequest): Promise<FinalizeSessionPreview>;
  compactAgent(agentId: string, input?: CompactAgentRequest): Promise<unknown>;
  previewCompaction(agentId: string, input?: CompactAgentRequest): Promise<CompactPreviewResult>;
  previewPersistentBudgetRecovery(agentId: string): Promise<PersistentBudgetPreview>;
  applyPersistentBudgetRecovery(agentId: string, input: ApplyPersistentBudgetRequest): Promise<PersistentBudgetPreview>;
  appendMemorySummary(agentId: string, input: AppendMemorySummaryRequest): Promise<string[]>;
  appendPersistentSummary(agentId: string, input: AppendPersistentSummaryRequest): Promise<string[]>;
  appendMemoryConstraints(agentId: string, input: AppendMemoryConstraintsRequest): Promise<AgentConstraintRecord[]>;
  appendPersistentConstraints(agentId: string, input: AppendPersistentConstraintsRequest): Promise<AgentConstraintRecord[]>;
  reviveAgent(agentId: string, input?: ReviveAgentRequest): Promise<AgentManifest>;
}

function withQuery(path: string, query?: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

export function createAgentServerHttpClient(baseUrl: string): AgentServerHttpClient {
  const normalizedBaseUrl = String(baseUrl || '').trim().replace(/\/+$/g, '');
  if (!normalizedBaseUrl) {
    throw new Error('baseUrl is required');
  }

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${normalizedBaseUrl}${path}`, init);
    const payload = await response.json() as ApiResponse<T>;
    if (!response.ok || !payload.ok || payload.data === undefined) {
      throw new Error(payload.error || `HTTP ${response.status} for ${path}`);
    }
    return payload.data;
  }

  function postJson<T>(path: string, body?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  return {
    runTask(input) {
      return postJson('/api/agent-server/runs', input);
    },
    getRun(runId) {
      return request(`/api/agent-server/runs/${runId}`);
    },
    createEvolutionProposal(input) {
      return postJson('/api/agent-server/evolution/proposals', input);
    },
    listEvolutionProposals() {
      return request('/api/agent-server/evolution/proposals');
    },
    getEvolutionProposal(proposalId) {
      return request(`/api/agent-server/evolution/proposals/${proposalId}`);
    },
    approveEvolutionProposal(proposalId, input = {}) {
      return postJson(`/api/agent-server/evolution/proposals/${proposalId}/approve`, input);
    },
    rejectEvolutionProposal(proposalId, input = {}) {
      return postJson(`/api/agent-server/evolution/proposals/${proposalId}/reject`, input);
    },
    applyEvolutionProposal(proposalId, input = {}) {
      return postJson(`/api/agent-server/evolution/proposals/${proposalId}/apply`, input);
    },
    rollbackEvolutionProposal(proposalId, input = {}) {
      return postJson(`/api/agent-server/evolution/proposals/${proposalId}/rollback`, input);
    },
    ensureAutonomousAgent(input) {
      return postJson('/api/agent-server/autonomous/ensure', input);
    },
    runAutonomousTask(input) {
      return postJson('/api/agent-server/autonomous/run', input);
    },
    createAgent(input) {
      return postJson('/api/agent-server/agents', input);
    },
    getAgent(agentId) {
      return request(`/api/agent-server/agents/${agentId}`);
    },
    listRuns(agentId) {
      return request(`/api/agent-server/agents/${agentId}/runs`);
    },
    getCurrentWork(agentId, query = {}) {
      return request(withQuery(`/api/agent-server/agents/${agentId}/work/current`, {
        sessionId: query.sessionId,
      }));
    },
    replaceCurrentWork(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/work/current`, input);
    },
    getContextSnapshot(agentId) {
      return request(`/api/agent-server/agents/${agentId}/context`);
    },
    getRecoverySnapshot(agentId) {
      return request(`/api/agent-server/agents/${agentId}/recovery`);
    },
    acknowledgeRecovery(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/recovery/acknowledge`, input);
    },
    sendMessage(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/messages`, input);
    },
    enqueueGoal(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/goals`, input);
    },
    listClarifications(agentId) {
      return request(`/api/agent-server/agents/${agentId}/clarifications`);
    },
    resolveClarification(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/clarifications/resolve`, input);
    },
    retrieveContext(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/retrieve`, input);
    },
    searchWorkspace(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/workspace-search`, input);
    },
    getTurns(agentId, query = {}) {
      return request(withQuery(`/api/agent-server/agents/${agentId}/turns`, {
        sessionId: query.sessionId,
        startTurn: query.startTurn,
        endTurn: query.endTurn,
        limit: query.limit,
      }));
    },
    finalizeSession(agentId, input = {}) {
      return postJson(`/api/agent-server/agents/${agentId}/sessions/finalize`, input);
    },
    previewFinalizeSession(agentId, input = {}) {
      return postJson(`/api/agent-server/agents/${agentId}/sessions/finalize/preview`, input);
    },
    compactAgent(agentId, input = {}) {
      return postJson(`/api/agent-server/agents/${agentId}/compact`, input);
    },
    previewCompaction(agentId, input = {}) {
      return postJson(`/api/agent-server/agents/${agentId}/compact/preview`, input);
    },
    previewPersistentBudgetRecovery(agentId) {
      return request(`/api/agent-server/agents/${agentId}/persistent/recovery/preview`);
    },
    applyPersistentBudgetRecovery(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/persistent/recovery/apply`, input);
    },
    appendMemorySummary(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/memory/summary`, input);
    },
    appendPersistentSummary(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/persistent/summary`, input);
    },
    appendMemoryConstraints(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/memory/constraints`, input);
    },
    appendPersistentConstraints(agentId, input) {
      return postJson(`/api/agent-server/agents/${agentId}/persistent/constraints`, input);
    },
    reviveAgent(agentId, input = {}) {
      return postJson(`/api/agent-server/agents/${agentId}/revive`, input);
    },
  };
}
