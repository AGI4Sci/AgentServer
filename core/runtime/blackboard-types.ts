export type BlackboardTaskStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'blocked'
  | 'done'
  | 'failed';

export type BlockedByKind =
  | 'missing_input'
  | 'env_error'
  | 'too_complex'
  | 'permission'
  | 'unknown';

export interface BlockedBy {
  kind: BlockedByKind;
  message: string;
  retryable: boolean;
  missingInputs?: string[];
  suggestedCapability?: string;
}

export interface ExecutionScope {
  workspaceId: string;
  cwd: string;
  allowedRoots: string[];
  artifactsRoot: string;
  allowedTools?: string[];
}

export type EndpointNetworkMode = 'local-egress' | 'remote-direct' | 'remote-via-local-proxy' | 'offline';

export type EndpointRiskClass =
  | 'read'
  | 'write-file'
  | 'run-command'
  | 'network-egress'
  | 'credential-access'
  | 'physical-action'
  | 'destructive'
  | 'long-running';

export interface TaskEndpointHint {
  endpointId?: string;
  kind?: string;
  capability?: string;
  networkMode?: EndpointNetworkMode;
  riskClass?: EndpointRiskClass;
}

export interface ToolBinding {
  endpointId: string;
  capability: string;
  cwd?: string;
  networkMode?: EndpointNetworkMode;
  allowedRoots?: string[];
  allowedTools?: string[];
  riskClass?: EndpointRiskClass;
  evidencePolicy?: {
    recordCommands?: boolean;
    recordFiles?: boolean;
    recordTelemetry?: boolean;
    recordArtifacts?: boolean;
  };
}

export interface CompletionEvidenceRequirements {
  requireRuntimeToolCall?: boolean;
  requireSummaryArtifact?: boolean;
  minSourceCount?: number;
  maxSourceAgeHours?: number;
  requireSourceLinks?: boolean;
}

export type ResetKind =
  | 'lease_expired_reset'
  | 'manual_requeue'
  | 'hosted_run_recovery_reset'
  | 'approved_retry_reset';

export interface FailureEvent {
  runId: string;
  at: number;
  blockedBy: BlockedBy;
  resetKind?: ResetKind;
}

export interface TaskFact {
  id: string;
  revision: number;
  chatSessionId: string;
  requestId: string;
  teamId: string;
  goal: string;
  requires: string[];
  requiredCapability: string;
  acceptanceCriteria?: string[];
  evidenceRequirements?: CompletionEvidenceRequirements;
  endpointHints?: TaskEndpointHint[];
  toolBindings?: ToolBinding[];
  networkMode?: EndpointNetworkMode;
  riskClass?: EndpointRiskClass;
  executionScope: ExecutionScope;
  status: BlackboardTaskStatus;
  owner: string | null;
  currentRunId: string | null;
  attempt: number;
  leaseUntil?: number;
  claimedAt?: number;
  lastHeartbeatAt?: number;
  blockedBy?: BlockedBy;
  result?: string;
  resultRef?: string;
  supersedesTaskId?: string;
  failureHistory: FailureEvent[];
  createdBy: string;
  updatedAt: number;
}

export type ProposalFactKind =
  | 'split'
  | 'handoff'
  | 'retry'
  | 'need_review'
  | 'need_qa'
  | 'need_user_input'
  | 'blocked_replan';

export interface ProposalFactPayload {
  taskId?: string;
  goal: string;
  requiredCapability: string;
  suggestedAssignee?: string | null;
  requires?: string[];
  supersedesTaskId?: string;
  reason: string;
  acceptanceCriteria?: string[];
  evidenceRequirements?: CompletionEvidenceRequirements;
  endpointHints?: TaskEndpointHint[];
  toolBindings?: ToolBinding[];
  networkMode?: EndpointNetworkMode;
  riskClass?: EndpointRiskClass;
  executionScope?: Partial<ExecutionScope>;
}

export interface ProposalFact {
  id: string;
  revision: number;
  chatSessionId: string;
  requestId: string;
  teamId: string;
  parentTaskId: string;
  proposerAgentId: string;
  kind: ProposalFactKind;
  payload: ProposalFactPayload;
  createdAt: number;
  updatedAt: number;
}

export type DecisionFactDecision = 'approve' | 'reject' | 'amend';

export interface DecisionFact {
  id: string;
  revision: number;
  chatSessionId: string;
  requestId: string;
  teamId: string;
  proposalId: string;
  decision: DecisionFactDecision;
  decidedBy: string;
  decidedAt: number;
  note?: string;
  amendedPayload?: ProposalFactPayload;
  materializedTaskIds?: string[];
  materializedAt?: number;
  updatedAt: number;
}

export type BlackboardOpKind =
  | 'write'
  | 'claim'
  | 'heartbeat'
  | 'complete'
  | 'block'
  | 'ping'
  | 'reset'
  | 'propose'
  | 'decide'
  | 'materialize'
  | 'archive';

export type BlackboardOpEntityType = 'task' | 'proposal' | 'decision' | 'capability';

export type BlackboardOpSource = 'user' | 'agent' | 'coordinator' | 'system' | 'system_rule' | 'unknown';

export interface BlackboardOpRecord {
  id: string;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  op: BlackboardOpKind;
  entityType: BlackboardOpEntityType;
  entityId: string;
  actor: string | null;
  source: BlackboardOpSource;
  reason?: string;
  taskId?: string;
  proposalId?: string;
  decisionId?: string;
  runId?: string | null;
  beforeRevision?: number;
  afterRevision?: number;
  fromStatus?: BlackboardTaskStatus | null;
  toStatus?: BlackboardTaskStatus | null;
  timestamp: number;
}

export interface AgentCapability {
  agentId: string;
  capabilities: string[];
  status: 'available' | 'busy';
}

export interface SubscribeFilter {
  teamId: string;
  chatSessionId: string;
  capabilities?: string[];
  workspaceIds?: string[];
  ownerAgentId?: string;
}
