import type { BackendType } from '../../core/runtime/backend-catalog.js';
import type { LocalDevPolicyHint, SessionOutput, SessionStreamEvent } from '../runtime/session-types.js';

export type AgentLifecycleStatus = 'active' | 'paused' | 'waiting_user' | 'error';
export type AgentSessionStatus = 'active' | 'archived';
export type AgentRecoveryStatus = 'clean' | 'recovered' | 'needs_human';
export type AgentRecoveryIssueKind =
  | 'compaction_intent_recovered'
  | 'current_work_rebuilt_from_log'
  | 'covered_turns_pruned'
  | 'duplicate_tags_pruned'
  | 'missing_turn_log'
  | 'active_session_pointer_recovered'
  | 'active_session_recreated'
  | 'persistent_budget_exceeded';
export type ConstraintSourceType =
  | 'api_behavior'
  | 'db_state'
  | 'env_config'
  | 'tool_behavior'
  | 'protocol';
export type ConstraintPriority = 'critical' | 'high' | 'medium' | 'low';
export type ConstraintDurability = 'stable' | 'session' | 'mutable';
export type CompactionMode = 'auto' | 'partial' | 'full';
export type CompactionDecisionBy = 'human' | 'agent';

export interface AgentAutonomyConfig {
  enabled: boolean;
  intervalMs: number;
  autoReflect: boolean;
  maxConsecutiveErrors: number;
}

export interface AgentRuntimeState {
  isRunning: boolean;
  pendingGoalCount: number;
  currentRunId?: string;
  pendingClarificationId?: string;
  consecutiveErrors: number;
  lastTickAt?: string;
  lastRunAt?: string;
  lastError?: string;
}

export interface AgentManifest {
  id: string;
  name: string;
  backend: BackendType;
  workingDirectory: string;
  runtimeTeamId: string;
  runtimeAgentId: string;
  runtimePersistentKey: string;
  systemPrompt: string;
  status: AgentLifecycleStatus;
  autonomy: AgentAutonomyConfig;
  runtime: AgentRuntimeState;
  activeSessionId: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionRecord {
  id: string;
  agentId: string;
  status: AgentSessionStatus;
  nextTurnNumber?: number;
  recovery?: {
    status?: AgentRecoveryStatus;
    lastRecoveredAt?: string;
    acknowledgedAt?: string;
    issues?: AgentRecoveryIssueRecord[];
  };
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface AgentRecoveryIssueRecord {
  id: string;
  kind: AgentRecoveryIssueKind;
  severity: 'info' | 'warning' | 'critical';
  detail: string;
  createdAt: string;
}

export interface AgentCompactionIntentRecord {
  id: string;
  agentId: string;
  sessionId: string;
  mode: 'partial' | 'full';
  phase: 'writing_tag' | 'replacing_current_work';
  targetTurns?: string;
  createdAt: string;
}

export interface AgentRunRecord {
  id: string;
  agentId: string;
  sessionId: string;
  status: AgentRunStatus;
  request: {
    message: string;
    context: string;
  };
  output: SessionOutput;
  events: SessionStreamEvent[];
  stages?: AgentRunStageRecord[];
  contextRefs?: AgentContextRef[];
  metrics?: AgentRunMetrics;
  evaluation?: AgentRunEvaluation;
  metadata?: Record<string, unknown>;
  createdAt: string;
  completedAt: string;
}

export type AgentRunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting_user'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout';

export type AgentRunStageType =
  | 'plan'
  | 'diagnose'
  | 'implement'
  | 'review'
  | 'verify'
  | 'summarize';

export type AgentRunStageStatus =
  | 'pending'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped';

export interface AgentRunStageOwnership {
  workspaceId: string;
  paths?: string[];
  worktree?: string;
  writeMode: 'none' | 'serial' | 'owned_paths' | 'isolated_worktree';
}

export interface AgentRunStageRecord {
  id: string;
  runId: string;
  type: AgentRunStageType;
  backend: BackendType;
  status: AgentRunStageStatus;
  dependsOn: string[];
  ownership?: AgentRunStageOwnership;
  input: BackendHandoffPacket;
  result?: BackendStageResult;
  metrics?: AgentRunStageMetrics;
  audit: AgentRunStageAudit;
  createdAt: string;
  completedAt?: string;
}

export interface AgentRunStageMetrics {
  durationMs: number;
  toolCallCount: number;
  approxInputTokens?: number;
  usage?: SessionOutput['usage'];
}

export interface AgentRunStageAudit {
  backend: BackendType;
  backendKind?: 'model_provider' | 'agent_backend';
  backendTier?: 'strategic' | 'experimental' | 'compatibility' | 'legacy';
  inputSummary: string;
  outputSummary?: string;
  fallbackFromStageId?: string;
  failureReason?: string;
  nativeSessionRef?: BackendSessionRef;
}

export interface BackendSessionRef {
  id: string;
  backend: BackendType;
  scope: 'session' | 'stage';
  resumable: boolean;
  metadata?: Record<string, unknown>;
}

export interface BackendHandoffPacket {
  runId: string;
  stageId: string;
  stageType: AgentRunStageType;
  goal: string;
  userRequest: string;
  canonicalContext: CanonicalSessionContextSnapshot;
  stageInstructions: string;
  constraints: string[];
  workspaceFacts: WorkspaceFacts;
  priorStageSummaries: StageSummary[];
  openQuestions: string[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalSessionContextSnapshot {
  goal: string;
  plan: string[];
  decisions: string[];
  constraints: string[];
  workspaceState: WorkspaceFacts;
  artifacts: ArtifactRef[];
  backendRunRecords: StageSummary[];
  openQuestions: string[];
}

export interface WorkspaceFacts {
  root: string;
  branch?: string;
  dirtyFiles: string[];
  lastKnownDiffSummary?: string;
}

export interface StageSummary {
  runId: string;
  stageId: string;
  backend: BackendType;
  summary: string;
  filesChanged: string[];
  testsRun: string[];
  risks: string[];
}

export interface BackendStageResult {
  status: AgentRunStageStatus;
  finalText?: string;
  filesChanged: string[];
  diffSummary?: string;
  toolCalls: ToolCallSummary[];
  testsRun: TestRunSummary[];
  findings: Finding[];
  handoffSummary: string;
  nextActions: string[];
  risks: string[];
  artifacts: ArtifactRef[];
  nativeSessionRef?: BackendSessionRef;
}

export interface ToolCallSummary {
  toolName: string;
  detail?: string;
  status?: 'succeeded' | 'failed' | 'unknown';
}

export interface TestRunSummary {
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  summary?: string;
}

export interface Finding {
  title: string;
  detail: string;
  severity?: 'info' | 'warning' | 'error';
  file?: string;
  line?: number;
}

export interface ArtifactRef {
  id: string;
  kind: string;
  path?: string;
  uri?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentContextRef {
  scope: 'memory' | 'state' | 'work' | 'policy' | 'runtime';
  kind: string;
  id?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunMetrics {
  durationMs: number;
  toolCallCount: number;
  approxContextTokens: number;
  backend: BackendType;
  usage?: SessionOutput['usage'];
}

export interface AgentRunEvaluation {
  outcome: 'success' | 'partial' | 'failed' | 'blocked' | 'unknown';
  score?: number;
  reasons: string[];
  evaluator?: string;
}

export type AgentEvolutionProposalType =
  | 'context-weight-change'
  | 'context-merge'
  | 'context-policy-experiment'
  | 'backend-routing-experiment'
  | 'directive-change';

export type AgentEvolutionProposalRisk = 'low' | 'medium' | 'high';

export type AgentEvolutionProposalStatus =
  | 'draft'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'rolled_back';

export interface AgentEvolutionProposalHistoryEntry {
  status: AgentEvolutionProposalStatus;
  note?: string;
  actor?: string;
  createdAt: string;
}

export interface AgentEvolutionProposal {
  id: string;
  type: AgentEvolutionProposalType;
  title: string;
  evidence: unknown[];
  expectedImpact?: string;
  risk: AgentEvolutionProposalRisk;
  rollbackPlan: string;
  status: AgentEvolutionProposalStatus;
  metadata?: Record<string, unknown>;
  history: AgentEvolutionProposalHistoryEntry[];
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
  rolledBackAt?: string;
}

export interface CreateAgentEvolutionProposalRequest {
  type: AgentEvolutionProposalType;
  title: string;
  evidence?: unknown[];
  expectedImpact?: string;
  risk: AgentEvolutionProposalRisk;
  rollbackPlan: string;
  status?: Extract<AgentEvolutionProposalStatus, 'draft' | 'proposed'>;
  metadata?: Record<string, unknown>;
  actor?: string;
  note?: string;
}

export interface UpdateAgentEvolutionProposalStatusRequest {
  note?: string;
  actor?: string;
}

export interface AgentTurnRecord {
  kind?: 'turn';
  turnId: string;
  runId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  turnNumber?: number;
}

export interface AgentConstraintRecord {
  key: string;
  family?: string;
  familyMembers?: string[];
  desc: string;
  turn: number;
  type: ConstraintSourceType;
  priority?: ConstraintPriority;
  durability?: ConstraintDurability;
  evidence?: string[];
  createdAt: string;
}

export interface AgentCompactionTagRecord {
  kind: 'compaction' | 'partial_compaction';
  id: string;
  createdAt: string;
  decisionBy: CompactionDecisionBy;
  archived: string | string[];
  turns: string;
  tools: string[];
  files: string[];
  constraints?: AgentConstraintRecord[];
  summary: string[];
  workRatio?: number;
  mode: Exclude<CompactionMode, 'auto'>;
  stableBoundaryTurn?: number;
  dynamicTailTurns?: string;
  safetyPointTurn?: number;
  rationale?: string[];
}

export type AgentWorkEntry = AgentTurnRecord | AgentCompactionTagRecord;

export interface AgentWorkLayoutSegment {
  kind: 'stable_work' | 'compressed_work' | 'dynamic_work';
  source: 'raw' | 'partial_compaction_tag' | 'compaction_tag';
  turnRange?: {
    start: number;
    end: number;
  };
  entryCount: number;
  note?: string;
}

export interface AgentWorkLayout {
  strategy: 'empty' | 'live_only' | 'partial_compacted' | 'partial_compaction_candidate' | 'full_compaction';
  safetyPointReached: boolean;
  safetyPointTurn?: number;
  stableBoundaryTurn?: number;
  rationale: string[];
  boundaryCandidates?: Array<{
    turnNumber: number;
    score: number;
    selected: boolean;
    signals: string[];
    excerpt: string;
  }>;
  segments: AgentWorkLayoutSegment[];
}

export interface AgentWorkBudgetSnapshot {
  approxContextTokens: number;
  approxPrefixTokens: number;
  approxCurrentWorkTokens: number;
  approxRemainingTokens: number;
  workRatio: number;
  softThreshold: number;
  hardThreshold: number;
  status: 'healthy' | 'soft_threshold_reached' | 'hard_threshold_reached';
  tokenEconomics: AgentTokenEconomicsSnapshot;
  rationale: string[];
}

export interface AgentPersistentBudgetSnapshot {
  approxSummaryTokens: number;
  approxConstraintTokens: number;
  approxTotalTokens: number;
  summarySoftLimit: number;
  summaryHardLimit: number;
  constraintSoftLimit: number;
  constraintHardLimit: number;
  totalHardLimit: number;
  status: 'healthy' | 'summary_soft_limit_reached' | 'constraint_soft_limit_reached' | 'hard_limit_reached';
  tokenEconomics: AgentTokenEconomicsSnapshot;
  rationale: string[];
}

export interface AgentMemoryBudgetSnapshot {
  approxSummaryTokens: number;
  approxConstraintTokens: number;
  approxTotalTokens: number;
  summarySoftLimit: number;
  summaryHardLimit: number;
  constraintSoftLimit: number;
  constraintHardLimit: number;
  totalHardLimit: number;
  status: 'healthy' | 'summary_soft_limit_reached' | 'constraint_soft_limit_reached' | 'hard_limit_reached';
  tokenEconomics: AgentTokenEconomicsSnapshot;
  rationale: string[];
}

export interface AgentTokenEconomicsSnapshot {
  approxCacheEligibleTokens: number;
  approxUncachedTokens: number;
  cacheHitPriceFactor: number;
  effectivePerTurnCostUnits: number;
  rationale: string[];
}

export interface AgentTokenCostDelta {
  beforeEffectivePerTurnCostUnits: number;
  afterEffectivePerTurnCostUnits: number;
  estimatedSavingsPerFutureTurn: number;
  estimatedSavingsRatio: number;
  oneTimeRewriteCostUnits: number;
  estimatedBreakEvenTurns?: number;
  rationale: string[];
}

export interface AgentCurrentWorkRequest {
  sessionId?: string;
}

export interface ReplaceCurrentWorkRequest {
  sessionId?: string;
  entries: AgentWorkEntry[];
  nextTurnNumber?: number;
}

export interface AppendMemorySummaryRequest {
  value: string;
}

export interface AppendPersistentSummaryRequest {
  sessionId?: string;
  value: string;
}

export interface AppendMemoryConstraintsRequest {
  items: AgentConstraintRecord[];
}

export interface AppendPersistentConstraintsRequest {
  sessionId?: string;
  items: AgentConstraintRecord[];
}

export interface ReviveAgentRequest {
  clearLastError?: boolean;
  resetConsecutiveErrors?: boolean;
  resumeAutonomy?: boolean;
}

export interface CompactAgentRequest {
  mode?: CompactionMode;
  decisionBy?: CompactionDecisionBy;
}

export interface CompactPreviewCandidate {
  mode: Exclude<CompactionMode, 'auto'>;
  available: boolean;
  reason: string;
  estimatedCompressionRatio?: number;
  semanticOpportunityScore?: number;
  costDelta?: AgentTokenCostDelta;
  turnRange?: string;
  stableBoundaryTurn?: number;
  dynamicTailTurns?: string;
  boundaryCandidates?: AgentWorkLayout['boundaryCandidates'];
  rationale: string[];
}

export interface CompactSemanticSuggestion {
  available: boolean;
  provider: 'llm' | 'heuristic' | 'unavailable';
  recommendedMode: Exclude<CompactionMode, 'auto'> | 'none';
  suggestedStableBoundaryTurn?: number;
  boundarySource?: 'llm_candidate' | 'heuristic_candidate' | 'none';
  candidateTurns?: Array<{
    turnNumber: number;
    score: number;
    signals: string[];
    excerpt: string;
  }>;
  compressibleTurnRange?: string;
  confidence: 'low' | 'medium' | 'high';
  rationale: string[];
}

export interface CompactDecisionSnapshot {
  budgetRecommendedMode: Exclude<CompactionMode, 'auto'> | 'none';
  semanticOpportunityMode: Exclude<CompactionMode, 'auto'> | 'none';
  semanticRecommendedMode: Exclude<CompactionMode, 'auto'> | 'none';
  resolvedMode: Exclude<CompactionMode, 'auto'> | 'none';
  source: 'hard_threshold' | 'semantic' | 'budget' | 'none';
  selectedStableBoundaryTurn?: number;
  selectedBoundarySource?: 'llm_candidate' | 'heuristic_candidate' | 'none';
  rationale: string[];
}

export interface CompactPreviewResult {
  agentId: string;
  sessionId: string;
  requestedMode: CompactionMode;
  recommendedMode: Exclude<CompactionMode, 'auto'> | 'none';
  decision: CompactDecisionSnapshot;
  workLayout: AgentWorkLayout;
  workBudget: AgentWorkBudgetSnapshot;
  candidates: CompactPreviewCandidate[];
  semanticSuggestion?: CompactSemanticSuggestion;
  rationale: string[];
}

export type FinalizeMemoryStrategy = 'conservative' | 'balanced' | 'aggressive';

export interface FinalizeSessionRequest {
  carryOverSummary?: string;
  promotePersistentToMemory?: boolean;
  strategy?: FinalizeMemoryStrategy;
  seedPersistentFromMemory?: boolean;
  discardArchivedSessionContext?: boolean;
}

export interface FinalizeSessionCandidate {
  strategy: FinalizeMemoryStrategy;
  description: string;
  memoryBudgetAfter: AgentMemoryBudgetSnapshot;
  nextSessionSeedBudget: AgentPersistentBudgetSnapshot;
  costDelta: AgentTokenCostDelta;
  promotedHighValueSummaryCount: number;
  promotedCriticalConstraintCount: number;
  promotedStableConstraintCount: number;
  promotedSummaryCount: number;
  promotedConstraintCount: number;
  promotedSummarySamples: string[];
  promotedConstraintKeys: string[];
  nextSessionSeedSummaryCount: number;
  nextSessionSeedConstraintCount: number;
  nextSessionSeedSummarySamples: string[];
  nextSessionSeedConstraintKeys: string[];
  rationale: string[];
}

export interface FinalizeSemanticSuggestion {
  available: boolean;
  provider: 'llm' | 'heuristic' | 'unavailable';
  recommendedStrategy: FinalizeMemoryStrategy;
  confidence: 'low' | 'medium' | 'high';
  rationale: string[];
}

export interface FinalizeDecisionSnapshot {
  heuristicStrategy: FinalizeMemoryStrategy;
  semanticRecommendedStrategy: FinalizeMemoryStrategy;
  resolvedStrategy: FinalizeMemoryStrategy;
  source: 'semantic' | 'heuristic';
  rationale: string[];
}

export interface FinalizeSessionPreview {
  agentId: string;
  sessionId: string;
  promotePersistentToMemory: boolean;
  currentStrategy: FinalizeMemoryStrategy;
  carryOverSummary?: string;
  memoryBudgetBefore: AgentMemoryBudgetSnapshot;
  memorySummaryCountBefore: number;
  memoryConstraintCountBefore: number;
  decision: FinalizeDecisionSnapshot;
  semanticSuggestion?: FinalizeSemanticSuggestion;
  candidates: FinalizeSessionCandidate[];
  rationale: string[];
}

export interface ClearMemoryRequest {
  confirm: boolean;
}

export interface ResetPersistentRequest {
  confirm: boolean;
  clearCurrentWork?: boolean;
  reseedFromMemory?: boolean;
}

export interface AgentTurnLogQuery {
  sessionId?: string;
  startTurn?: number;
  endTurn?: number;
  limit?: number;
}

export interface AgentRetrievalRequest {
  query: string;
  sessionId?: string;
  maxItemsPerLayer?: number;
  openClarificationOnMiss?: boolean;
  includeWorkspaceSearch?: boolean;
  optimizeForTokenEconomics?: boolean;
  fileGlob?: string;
  maxArchivedRangesToReopen?: number;
}

export interface AgentClarificationRecord {
  id: string;
  agentId: string;
  sessionId: string;
  status: 'pending' | 'resolved';
  kind: 'history_missing' | 'workspace_missing' | 'mixed_missing';
  question: string;
  reason: string;
  query: string;
  createdAt: string;
  resolvedAt?: string;
  response?: string;
}

export interface ResolveClarificationRequest {
  clarificationId?: string;
  response: string;
  resumeAutonomy?: boolean;
}

export interface AgentWorkspaceSearchRequest {
  query?: string;
  mode?: 'files' | 'content' | 'both';
  fileGlob?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface AgentWorkspaceSearchHit {
  layer: 'workspace_files' | 'workspace_content';
  path: string;
  line?: number;
  excerpt: string;
}

export interface AgentRetrievalTokenEconomics {
  approxArchivedReopenTokens: number;
  approxWorkspaceSearchTokens: number;
  approxInjectedEvidenceTokens: number;
  additionalEffectiveCostUnits: number;
  prefixStabilityRisk: 'low' | 'medium' | 'high';
  rationale: string[];
}

export interface AgentWorkspaceSearchResult {
  agentId: string;
  workingDirectory: string;
  mode: 'files' | 'content' | 'both';
  query?: string;
  fileGlob?: string;
  hits: AgentWorkspaceSearchHit[];
  tokenEconomics: AgentRetrievalTokenEconomics;
}

export interface AgentRetrievalHit {
  layer:
    | 'current_compaction_constraints'
    | 'current_compaction_summary'
    | 'current_partial_summary'
    | 'turn_log'
    | 'workspace_files'
    | 'workspace_content'
    | 'persistent_constraints'
    | 'persistent_summary'
    | 'memory_constraints'
    | 'memory_summary';
  score: number;
  label: string;
  excerpt: string;
  archived?: string;
  turnRange?: {
    start: number;
    end: number;
  };
}

export interface AgentRetrievalLayerResult {
  layer: AgentRetrievalHit['layer'];
  hits: AgentRetrievalHit[];
}

export interface AgentRetrievalResult {
  agentId: string;
  sessionId: string;
  query: string;
  needsHumanClarification: boolean;
  recommendedAction: 'answer_from_history' | 'ask_human_for_clarification';
  clarification?: AgentClarificationRecord;
  planner: {
    queryKind: 'history_fact' | 'workspace_fact' | 'mixed';
    strategy: 'history_first' | 'workspace_first' | 'balanced';
    orderedLayers: AgentRetrievalHit['layer'][];
    usedWorkspaceSearch: boolean;
    workspaceSearchExecuted: boolean;
    economicsAdjusted: boolean;
    economicsRationale: string[];
    searchedLayers: AgentRetrievalHit['layer'][];
    skippedLayers: AgentRetrievalHit['layer'][];
    evidenceQuality: 'none' | 'weak' | 'moderate' | 'strong';
    stopReason: 'strong_evidence' | 'searched_all_layers' | 'no_evidence';
    reopenedArchivedRanges: Array<{
      source: string;
      start: number;
      end: number;
    }>;
    evidenceSummary: string[];
    tokenEconomics: AgentRetrievalTokenEconomics;
  };
  layers: AgentRetrievalLayerResult[];
}

export interface CreateAgentRequest {
  id?: string;
  name?: string;
  backend?: BackendType;
  workingDirectory: string;
  runtimeTeamId?: string;
  runtimeAgentId?: string;
  systemPrompt?: string;
  initialMemorySummary?: string;
  autonomy?: Partial<AgentAutonomyConfig>;
  initialGoal?: string;
  metadata?: Record<string, unknown>;
}

export interface AutonomousAgentPolicy {
  autoRevive?: boolean;
  autoPersistentRecovery?: boolean;
  allowPersistentReset?: boolean;
  resetReusesMemorySeed?: boolean;
  clearCurrentWorkOnReset?: boolean;
  resumeAutonomyAfterRecovery?: boolean;
}

export interface EnsureAutonomousAgentRequest extends CreateAgentRequest {
  reconcileExisting?: boolean;
  policy?: AutonomousAgentPolicy;
}

export interface CreateSessionRequest {
  carryOverSummary?: string;
  promotePersistentToMemory?: boolean;
  strategy?: FinalizeMemoryStrategy;
  seedPersistentFromMemory?: boolean;
  discardArchivedSessionContext?: boolean;
}

export interface AgentMessageRequest {
  message: string;
  localDevPolicy?: LocalDevPolicyHint;
  contextPolicy?: AgentMessageContextPolicy;
  metadata?: Record<string, unknown>;
}

export interface AgentMessageContextPolicy {
  includeCurrentWork?: boolean;
  includeRecentTurns?: boolean;
  includePersistent?: boolean;
  includeMemory?: boolean;
  persistRunSummary?: boolean;
  persistExtractedConstraints?: boolean;
}

export interface AgentRunStreamOptions {
  onEvent?: (event: SessionStreamEvent) => void;
}

export interface AutonomousAgentRunRequest {
  agent: EnsureAutonomousAgentRequest;
  message: AgentMessageRequest;
  policy?: AutonomousAgentPolicy;
}

export interface AutonomousAgentRecoveryAction {
  kind:
    | 'created'
    | 'reconciled'
    | 'revived'
    | 'persistent_recovery'
    | 'persistent_reset';
  detail: string;
  createdAt: string;
}

export interface AutonomousAgentRunResult {
  agent: AgentManifest;
  run: AgentRunRecord;
  recoveryActions: AutonomousAgentRecoveryAction[];
  retried: boolean;
}

export interface AgentServerRunRequest {
  agent: {
    id?: string;
    name?: string;
    backend?: BackendType;
    workspace?: string;
    workingDirectory?: string;
    systemPrompt?: string;
    runtimeTeamId?: string;
    runtimeAgentId?: string;
    initialMemorySummary?: string;
    autonomy?: Partial<AgentAutonomyConfig>;
    reconcileExisting?: boolean;
    policy?: AutonomousAgentPolicy;
    metadata?: Record<string, unknown>;
  };
  input: {
    text: string;
    attachments?: unknown[];
    metadata?: Record<string, unknown>;
  };
  contextPolicy?: AgentMessageContextPolicy;
  runtime?: {
    backend?: BackendType;
    cwd?: string;
    localDevPolicy?: LocalDevPolicyHint;
    metadata?: Record<string, unknown>;
  };
  policy?: AutonomousAgentPolicy;
  metadata?: Record<string, unknown>;
}

export interface AgentServerRunResult extends AutonomousAgentRunResult {
  metadata?: Record<string, unknown>;
}

export interface AgentGoalRecord {
  id: string;
  content: string;
  source: 'user' | 'system';
  createdAt: string;
}

export interface AgentGoalRequest {
  goal: string;
}

export interface AgentAutonomyRequest {
  enabled?: boolean;
  intervalMs?: number;
  autoReflect?: boolean;
}

export interface AgentContextSnapshot {
  agent: AgentManifest;
  session: AgentSessionRecord;
  assembledContext: string;
  pendingClarification?: AgentClarificationRecord | null;
  operationalGuidance: AgentOperationalGuidance;
  workLayout: AgentWorkLayout;
  workBudget: AgentWorkBudgetSnapshot;
  persistentBudget: AgentPersistentBudgetSnapshot;
  memoryBudget: AgentMemoryBudgetSnapshot;
  recoveryIssues: AgentRecoveryIssueRecord[];
  memorySummaryEntries: string[];
  memoryConstraintEntries: AgentConstraintRecord[];
  persistentSummaryEntries: string[];
  persistentConstraintEntries: AgentConstraintRecord[];
  recentTurns: AgentTurnRecord[];
  currentWorkEntries: AgentWorkEntry[];
  pendingGoals: AgentGoalRecord[];
}

export interface AgentOperationalGuidanceItem {
  area: 'compaction' | 'session_finalize' | 'persistent_recovery';
  recommendedAction: string;
  urgency: 'low' | 'medium' | 'high';
  estimatedSavingsPerFutureTurn?: number;
  rationale: string[];
}

export interface AgentOperationalGuidance {
  summary: string[];
  items: AgentOperationalGuidanceItem[];
}

export interface AgentRecoverySnapshot {
  agentId: string;
  sessionId: string;
  status: AgentRecoveryStatus;
  issues: AgentRecoveryIssueRecord[];
  lastRecoveredAt?: string;
  acknowledgedAt?: string;
}

export interface AcknowledgeRecoveryRequest {
  clearIssues?: boolean;
  resumeAutonomy?: boolean;
}

export type PersistentRecoveryStrategy = 'conservative' | 'balanced' | 'aggressive';

export interface PersistentBudgetCandidate {
  strategy: PersistentRecoveryStrategy;
  description: string;
  beforeApproxTokens: number;
  afterApproxTokens: number;
  budgetApproxTokens: number;
  costDelta: AgentTokenCostDelta;
  keptHighValueSummaryCount: number;
  keptCriticalConstraintCount: number;
  keptStableConstraintCount: number;
  currentSummaryCount: number;
  currentConstraintCount: number;
  keptSummaryCount: number;
  keptConstraintCount: number;
  droppedSummaryCount: number;
  droppedConstraintCount: number;
  keptSummarySamples: string[];
  droppedSummarySamples: string[];
  keptConstraintKeys: string[];
  droppedConstraintKeys: string[];
  reasoning: string[];
  statusAfterApply: 'clean' | 'needs_human';
}

export interface PersistentRecoverySemanticSuggestion {
  available: boolean;
  provider: 'llm' | 'heuristic' | 'unavailable';
  recommendedStrategy: PersistentRecoveryStrategy;
  confidence: 'low' | 'medium' | 'high';
  rationale: string[];
}

export interface PersistentRecoveryDecisionSnapshot {
  heuristicStrategy: PersistentRecoveryStrategy;
  semanticRecommendedStrategy: PersistentRecoveryStrategy;
  resolvedStrategy: PersistentRecoveryStrategy;
  source: 'semantic' | 'heuristic';
  rationale: string[];
}

export interface PersistentBudgetPreview {
  agentId: string;
  sessionId: string;
  currentStrategy?: PersistentRecoveryStrategy;
  decision: PersistentRecoveryDecisionSnapshot;
  semanticSuggestion?: PersistentRecoverySemanticSuggestion;
  candidates: PersistentBudgetCandidate[];
}

export interface ApplyPersistentBudgetRequest {
  confirm: boolean;
  strategy?: PersistentRecoveryStrategy;
  resumeAutonomy?: boolean;
}
