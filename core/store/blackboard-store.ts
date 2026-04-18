import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { loadOpenTeamConfig } from '../../server/utils/openteam-config.js';
import {
  buildAutoDecisionForProposal,
  buildTaskPatchFromProposalDecision,
  isAutoApprovableProposalKind,
} from '../runtime/blackboard-proposals.js';
import { isRecoverableRunningHeartbeatState } from '../runtime/agent-liveness.js';
import type {
  AgentCapability,
  BlackboardOpEntityType,
  BlackboardOpKind,
  BlackboardOpRecord,
  BlackboardOpSource,
  BlackboardTaskStatus,
  BlockedBy,
  CompletionEvidenceRequirements,
  DecisionFact,
  EndpointNetworkMode,
  EndpointRiskClass,
  ExecutionScope,
  FailureEvent,
  ProposalFact,
  ProposalFactPayload,
  ProposalFactKind,
  ResetKind,
  SubscribeFilter,
  TaskEndpointHint,
  TaskFact,
  ToolBinding,
} from '../runtime/blackboard-types.js';
import { deriveRunningHeartbeatWindow } from '../runtime/running-heartbeat.js';

interface StoredBlackboardState {
  teamId: string;
  chatSessionId: string;
  active: TaskFact[];
  archive: TaskFact[];
  proposals: ProposalFact[];
  decisions: DecisionFact[];
  ops: BlackboardOpRecord[];
  capabilities: AgentCapability[];
}

interface BlackboardStoreOptions {
  dataDir?: string;
  leaseDurationMs?: number;
  maxActiveFactsPerBucket?: number;
  now?: () => number;
}

interface ListTaskFactOptions {
  requestId?: string;
  workspaceId?: string;
  owner?: string;
  capability?: string;
  status?: BlackboardTaskStatus | BlackboardTaskStatus[];
  includeArchive?: boolean;
}

interface ListProposalOptions {
  requestId?: string;
  parentTaskId?: string;
  proposerAgentId?: string;
  kind?: ProposalFactKind | ProposalFactKind[];
}

interface ListDecisionOptions {
  requestId?: string;
  proposalId?: string;
  decidedBy?: string;
  decision?: DecisionFact['decision'] | DecisionFact['decision'][];
}

interface ListOperationOptions {
  requestId?: string;
  op?: BlackboardOpKind | BlackboardOpKind[];
  entityType?: BlackboardOpEntityType | BlackboardOpEntityType[];
  limit?: number;
}

interface TaskWriteAuditContext {
  op?: BlackboardOpKind;
  actor?: string | null;
  source?: BlackboardOpSource;
  reason?: string;
  proposalId?: string;
  decisionId?: string;
  runId?: string | null;
}

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ACTIVE_FACTS_PER_BUCKET = 64;
const DEFAULT_MAX_OPS_PER_BUCKET = 500;
const DATA_DIR = join(process.cwd(), 'data', 'blackboard');
const ACTIVE_STATUSES = new Set<BlackboardTaskStatus>(['pending', 'running', 'waiting_user', 'blocked', 'failed']);

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function uniqueStrings(values: string[] | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values.map(value => String(value).trim()).filter(Boolean))];
}

function normalizeExecutionScope(scope: ExecutionScope): ExecutionScope {
  return {
    workspaceId: String(scope.workspaceId || '').trim(),
    cwd: String(scope.cwd || '').trim(),
    allowedRoots: uniqueStrings(scope.allowedRoots),
    artifactsRoot: String(scope.artifactsRoot || '').trim(),
    allowedTools: scope.allowedTools ? uniqueStrings(scope.allowedTools) : undefined,
  };
}

const ENDPOINT_NETWORK_MODES = new Set<EndpointNetworkMode>(['local-egress', 'remote-direct', 'remote-via-local-proxy', 'offline']);
const ENDPOINT_RISK_CLASSES = new Set<EndpointRiskClass>([
  'read',
  'write-file',
  'run-command',
  'network-egress',
  'credential-access',
  'physical-action',
  'destructive',
  'long-running',
]);

function normalizeEndpointNetworkMode(value: unknown): EndpointNetworkMode | undefined {
  const normalized = String(value || '').trim() as EndpointNetworkMode;
  return ENDPOINT_NETWORK_MODES.has(normalized) ? normalized : undefined;
}

function normalizeEndpointRiskClass(value: unknown): EndpointRiskClass | undefined {
  const normalized = String(value || '').trim() as EndpointRiskClass;
  return ENDPOINT_RISK_CLASSES.has(normalized) ? normalized : undefined;
}

function normalizeEndpointHints(input: TaskEndpointHint[] | undefined): TaskEndpointHint[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input
    .map((hint) => ({
      endpointId: typeof hint.endpointId === 'string' ? hint.endpointId.trim() || undefined : undefined,
      kind: typeof hint.kind === 'string' ? hint.kind.trim() || undefined : undefined,
      capability: typeof hint.capability === 'string' ? hint.capability.trim() || undefined : undefined,
      networkMode: normalizeEndpointNetworkMode(hint.networkMode),
      riskClass: normalizeEndpointRiskClass(hint.riskClass),
    }))
    .filter((hint) => hint.endpointId || hint.kind || hint.capability || hint.networkMode || hint.riskClass);
  return normalized.length ? normalized : undefined;
}

function normalizeToolBindings(input: ToolBinding[] | undefined): ToolBinding[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = input
    .map((binding) => ({
      endpointId: String(binding.endpointId || '').trim(),
      capability: String(binding.capability || '').trim(),
      cwd: typeof binding.cwd === 'string' ? binding.cwd.trim() || undefined : undefined,
      networkMode: normalizeEndpointNetworkMode(binding.networkMode),
      allowedRoots: binding.allowedRoots ? uniqueStrings(binding.allowedRoots) : undefined,
      allowedTools: binding.allowedTools ? uniqueStrings(binding.allowedTools) : undefined,
      riskClass: normalizeEndpointRiskClass(binding.riskClass),
      evidencePolicy: binding.evidencePolicy && typeof binding.evidencePolicy === 'object'
        ? {
            recordCommands: binding.evidencePolicy.recordCommands === true,
            recordFiles: binding.evidencePolicy.recordFiles === true,
            recordTelemetry: binding.evidencePolicy.recordTelemetry === true,
            recordArtifacts: binding.evidencePolicy.recordArtifacts === true,
          }
        : undefined,
    }))
    .filter((binding) => binding.endpointId && binding.capability);
  return normalized.length ? normalized : undefined;
}

function normalizeEvidenceRequirements(input: CompletionEvidenceRequirements | undefined): CompletionEvidenceRequirements | undefined {
  if (!input) {
    return undefined;
  }
  const normalized: CompletionEvidenceRequirements = {
    requireRuntimeToolCall: input.requireRuntimeToolCall === true,
    requireSummaryArtifact: input.requireSummaryArtifact === true,
    minSourceCount: Number.isFinite(input.minSourceCount) ? Math.max(0, Number(input.minSourceCount)) : undefined,
    maxSourceAgeHours: Number.isFinite(input.maxSourceAgeHours) ? Math.max(0, Number(input.maxSourceAgeHours)) : undefined,
    requireSourceLinks: input.requireSourceLinks === true,
  };
  return normalized.requireRuntimeToolCall
    || normalized.requireSummaryArtifact
    || typeof normalized.minSourceCount === 'number'
    || typeof normalized.maxSourceAgeHours === 'number'
    || normalized.requireSourceLinks
    ? normalized
    : undefined;
}

function normalizeBlockedBy(input: BlockedBy | undefined): BlockedBy | undefined {
  if (!input) {
    return undefined;
  }
  return {
    kind: input.kind,
    message: String(input.message || '').trim(),
    retryable: Boolean(input.retryable),
    missingInputs: input.missingInputs ? uniqueStrings(input.missingInputs) : undefined,
    suggestedCapability: input.suggestedCapability ? String(input.suggestedCapability).trim() : undefined,
  };
}

function normalizeFailureEvent(event: FailureEvent): FailureEvent {
  return {
    runId: String(event.runId || '').trim(),
    at: Number.isFinite(event.at) ? Number(event.at) : Date.now(),
    blockedBy: normalizeBlockedBy(event.blockedBy) || {
      kind: 'unknown',
      message: 'Unknown failure',
      retryable: true,
    },
    resetKind: event.resetKind,
  };
}

const RESULT_INLINE_MAX_LENGTH = 2_000;

function trimResult(result: string | undefined): string | undefined {
  if (typeof result !== 'string') {
    return undefined;
  }
  const normalized = result.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > RESULT_INLINE_MAX_LENGTH ? normalized.slice(0, RESULT_INLINE_MAX_LENGTH) : normalized;
}

function cloneTaskFact(fact: TaskFact): TaskFact {
  return {
    ...fact,
    requires: [...fact.requires],
    acceptanceCriteria: fact.acceptanceCriteria ? [...fact.acceptanceCriteria] : undefined,
    evidenceRequirements: fact.evidenceRequirements ? { ...fact.evidenceRequirements } : undefined,
    endpointHints: fact.endpointHints ? fact.endpointHints.map((hint) => ({ ...hint })) : undefined,
    toolBindings: fact.toolBindings
      ? fact.toolBindings.map((binding) => ({
          ...binding,
          allowedRoots: binding.allowedRoots ? [...binding.allowedRoots] : undefined,
          allowedTools: binding.allowedTools ? [...binding.allowedTools] : undefined,
          evidencePolicy: binding.evidencePolicy ? { ...binding.evidencePolicy } : undefined,
        }))
      : undefined,
    executionScope: {
      ...fact.executionScope,
      allowedRoots: [...fact.executionScope.allowedRoots],
      allowedTools: fact.executionScope.allowedTools ? [...fact.executionScope.allowedTools] : undefined,
    },
    blockedBy: fact.blockedBy ? { ...fact.blockedBy, missingInputs: fact.blockedBy.missingInputs ? [...fact.blockedBy.missingInputs] : undefined } : undefined,
    supersedesTaskId: fact.supersedesTaskId,
    failureHistory: fact.failureHistory.map(item => ({
      ...item,
      blockedBy: {
        ...item.blockedBy,
        missingInputs: item.blockedBy.missingInputs ? [...item.blockedBy.missingInputs] : undefined,
      },
    })),
  };
}

function normalizeProposalPayload(input: ProposalFactPayload): ProposalFactPayload {
  const normalizedScope = input.executionScope
    ? {
        ...(typeof input.executionScope.workspaceId === 'string'
          ? { workspaceId: String(input.executionScope.workspaceId).trim() }
          : {}),
        ...(typeof input.executionScope.cwd === 'string'
          ? { cwd: String(input.executionScope.cwd).trim() }
          : {}),
        ...(input.executionScope.allowedRoots
          ? { allowedRoots: uniqueStrings(input.executionScope.allowedRoots) }
          : {}),
        ...(typeof input.executionScope.artifactsRoot === 'string'
          ? { artifactsRoot: String(input.executionScope.artifactsRoot).trim() }
          : {}),
        ...(input.executionScope.allowedTools
          ? { allowedTools: uniqueStrings(input.executionScope.allowedTools) }
          : {}),
      }
    : undefined;
  const hasScopeSignal = Boolean(
    normalizedScope?.workspaceId
    || normalizedScope?.cwd
    || normalizedScope?.artifactsRoot
    || normalizedScope?.allowedRoots?.length
    || normalizedScope?.allowedTools?.length,
  );
  return {
    taskId: typeof input.taskId === 'string' ? String(input.taskId).trim() || undefined : undefined,
    goal: String(input.goal || '').trim(),
    requiredCapability: String(input.requiredCapability || '').trim(),
    suggestedAssignee: input.suggestedAssignee == null ? undefined : String(input.suggestedAssignee || '').trim() || null,
    requires: uniqueStrings(input.requires),
    supersedesTaskId: typeof input.supersedesTaskId === 'string' ? String(input.supersedesTaskId).trim() || undefined : undefined,
    reason: String(input.reason || '').trim(),
    acceptanceCriteria: input.acceptanceCriteria ? uniqueStrings(input.acceptanceCriteria) : undefined,
    evidenceRequirements: normalizeEvidenceRequirements(input.evidenceRequirements),
    endpointHints: normalizeEndpointHints(input.endpointHints),
    toolBindings: normalizeToolBindings(input.toolBindings),
    networkMode: normalizeEndpointNetworkMode(input.networkMode),
    riskClass: normalizeEndpointRiskClass(input.riskClass),
    executionScope: hasScopeSignal ? normalizedScope : undefined,
  };
}

function normalizeProposalFact(input: ProposalFact): ProposalFact {
  return {
    id: String(input.id || '').trim(),
    revision: Math.max(0, Number(input.revision) || 0),
    chatSessionId: String(input.chatSessionId || '').trim(),
    requestId: String(input.requestId || '').trim(),
    teamId: String(input.teamId || '').trim(),
    parentTaskId: String(input.parentTaskId || '').trim(),
    proposerAgentId: String(input.proposerAgentId || '').trim(),
    kind: input.kind,
    payload: normalizeProposalPayload(input.payload),
    createdAt: Number.isFinite(input.createdAt) ? Number(input.createdAt) : Date.now(),
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
  };
}

function cloneProposalFact(fact: ProposalFact): ProposalFact {
  return {
    ...fact,
    payload: {
      ...fact.payload,
      requires: fact.payload.requires ? [...fact.payload.requires] : undefined,
      acceptanceCriteria: fact.payload.acceptanceCriteria ? [...fact.payload.acceptanceCriteria] : undefined,
      evidenceRequirements: fact.payload.evidenceRequirements ? { ...fact.payload.evidenceRequirements } : undefined,
      executionScope: fact.payload.executionScope
        ? {
            ...fact.payload.executionScope,
            allowedRoots: fact.payload.executionScope.allowedRoots ? [...fact.payload.executionScope.allowedRoots] : undefined,
            allowedTools: fact.payload.executionScope.allowedTools ? [...fact.payload.executionScope.allowedTools] : undefined,
          }
        : undefined,
    },
  };
}

function normalizeDecisionFact(input: DecisionFact): DecisionFact {
  return {
    id: String(input.id || '').trim(),
    revision: Math.max(0, Number(input.revision) || 0),
    chatSessionId: String(input.chatSessionId || '').trim(),
    requestId: String(input.requestId || '').trim(),
    teamId: String(input.teamId || '').trim(),
    proposalId: String(input.proposalId || '').trim(),
    decision: input.decision,
    decidedBy: String(input.decidedBy || '').trim(),
    decidedAt: Number.isFinite(input.decidedAt) ? Number(input.decidedAt) : Date.now(),
    note: input.note ? String(input.note).trim() : undefined,
    amendedPayload: input.amendedPayload ? normalizeProposalPayload(input.amendedPayload) : undefined,
    materializedTaskIds: input.materializedTaskIds ? uniqueStrings(input.materializedTaskIds) : undefined,
    materializedAt: Number.isFinite(input.materializedAt) ? Number(input.materializedAt) : undefined,
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
  };
}

function cloneDecisionFact(fact: DecisionFact): DecisionFact {
  return {
    ...fact,
    amendedPayload: fact.amendedPayload
      ? {
          ...fact.amendedPayload,
          requires: fact.amendedPayload.requires ? [...fact.amendedPayload.requires] : undefined,
        }
      : undefined,
    materializedTaskIds: fact.materializedTaskIds ? [...fact.materializedTaskIds] : undefined,
  };
}

function normalizeOperationFact(input: BlackboardOpRecord): BlackboardOpRecord {
  return {
    id: String(input.id || '').trim(),
    teamId: String(input.teamId || '').trim(),
    chatSessionId: String(input.chatSessionId || '').trim(),
    requestId: String(input.requestId || '').trim(),
    op: input.op,
    entityType: input.entityType,
    entityId: String(input.entityId || '').trim(),
    actor: input.actor == null ? null : String(input.actor || '').trim() || null,
    source: input.source,
    reason: typeof input.reason === 'string' ? String(input.reason).trim() || undefined : undefined,
    taskId: typeof input.taskId === 'string' ? String(input.taskId).trim() || undefined : undefined,
    proposalId: typeof input.proposalId === 'string' ? String(input.proposalId).trim() || undefined : undefined,
    decisionId: typeof input.decisionId === 'string' ? String(input.decisionId).trim() || undefined : undefined,
    runId: input.runId == null ? undefined : String(input.runId || '').trim() || null,
    beforeRevision: Number.isFinite(input.beforeRevision) ? Number(input.beforeRevision) : undefined,
    afterRevision: Number.isFinite(input.afterRevision) ? Number(input.afterRevision) : undefined,
    fromStatus: input.fromStatus || undefined,
    toStatus: input.toStatus || undefined,
    timestamp: Number.isFinite(input.timestamp) ? Number(input.timestamp) : Date.now(),
  };
}

function cloneOperationFact(fact: BlackboardOpRecord): BlackboardOpRecord {
  return { ...fact };
}

function inferOperationSource(actor: string | null | undefined): BlackboardOpSource {
  const normalized = String(actor || '').trim();
  if (!normalized) {
    return 'system';
  }
  if (normalized === 'user') {
    return 'user';
  }
  if (normalized === 'system-rule') {
    return 'system_rule';
  }
  if (normalized.startsWith('system')) {
    return 'system';
  }
  if (normalized.includes('pm-') || normalized.includes('coordinator')) {
    return 'coordinator';
  }
  return 'agent';
}

function isDoneStatus(status: BlackboardTaskStatus): boolean {
  return status === 'done';
}

function isActiveStatus(status: BlackboardTaskStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function buildSupersededResult(args: {
  original: TaskFact;
  replacement: TaskFact;
}): string {
  const replacementResult = trimResult(args.replacement.result);
  if (replacementResult) {
    return trimResult(`Superseded by ${args.replacement.id}: ${replacementResult}`) || `Superseded by ${args.replacement.id}`;
  }
  return `Superseded by ${args.replacement.id}`;
}

function normalizeTaskFact(input: TaskFact): TaskFact {
  return {
    id: String(input.id || '').trim(),
    revision: Math.max(0, Number(input.revision) || 0),
    chatSessionId: String(input.chatSessionId || '').trim(),
    requestId: String(input.requestId || '').trim(),
    teamId: String(input.teamId || '').trim(),
    goal: String(input.goal || '').trim(),
    requires: uniqueStrings(input.requires),
    requiredCapability: String(input.requiredCapability || '').trim(),
    acceptanceCriteria: uniqueStrings(input.acceptanceCriteria),
    evidenceRequirements: normalizeEvidenceRequirements(input.evidenceRequirements),
    endpointHints: normalizeEndpointHints(input.endpointHints),
    toolBindings: normalizeToolBindings(input.toolBindings),
    networkMode: normalizeEndpointNetworkMode(input.networkMode),
    riskClass: normalizeEndpointRiskClass(input.riskClass),
    executionScope: normalizeExecutionScope(input.executionScope),
    status: input.status,
    owner: input.owner ? String(input.owner).trim() : null,
    currentRunId: input.currentRunId ? String(input.currentRunId).trim() : null,
    attempt: Math.max(0, Number(input.attempt) || 0),
    leaseUntil: Number.isFinite(input.leaseUntil) ? Number(input.leaseUntil) : undefined,
    claimedAt: Number.isFinite(input.claimedAt) ? Number(input.claimedAt) : undefined,
    lastHeartbeatAt: Number.isFinite(input.lastHeartbeatAt) ? Number(input.lastHeartbeatAt) : undefined,
    blockedBy: normalizeBlockedBy(input.blockedBy),
    result: trimResult(input.result),
    resultRef: input.resultRef ? String(input.resultRef).trim() : undefined,
    supersedesTaskId: typeof input.supersedesTaskId === 'string' ? String(input.supersedesTaskId).trim() || undefined : undefined,
    failureHistory: Array.isArray(input.failureHistory) ? input.failureHistory.map(normalizeFailureEvent) : [],
    createdBy: String(input.createdBy || '').trim(),
    updatedAt: Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now(),
  };
}

function defaultState(teamId: string, chatSessionId: string): StoredBlackboardState {
  return {
    teamId,
    chatSessionId,
    active: [],
    archive: [],
    proposals: [],
    decisions: [],
    ops: [],
    capabilities: [],
  };
}

export class BlackboardStore {
  private readonly dataDir: string;

  private readonly leaseDurationMs: number;

  private readonly maxActiveFactsPerBucket: number;

  private readonly now: () => number;

  private readonly subscriptions = new Map<string, SubscribeFilter>();

  constructor(options?: BlackboardStoreOptions) {
    this.dataDir = options?.dataDir || DATA_DIR;
    this.leaseDurationMs = options?.leaseDurationMs || DEFAULT_LEASE_DURATION_MS;
    this.maxActiveFactsPerBucket = options?.maxActiveFactsPerBucket || DEFAULT_MAX_ACTIVE_FACTS_PER_BUCKET;
    this.now = options?.now || (() => Date.now());
  }

  private getTeamDir(teamId: string): string {
    const teamDir = join(this.dataDir, teamId);
    ensureDir(teamDir);
    return teamDir;
  }

  private getPath(teamId: string, chatSessionId: string): string {
    return join(this.getTeamDir(teamId), `${chatSessionId}.json`);
  }

  private writeState(teamId: string, chatSessionId: string, state: StoredBlackboardState): void {
    const path = this.getPath(teamId, chatSessionId);
    ensureDir(dirname(path));
    const tempPath = `${path}.tmp-${process.pid}-${this.now()}-${randomUUID()}`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  }

  private recordOperation(state: StoredBlackboardState, operation: BlackboardOpRecord): void {
    state.ops.push(normalizeOperationFact(operation));
    if (state.ops.length > DEFAULT_MAX_OPS_PER_BUCKET) {
      state.ops.splice(0, state.ops.length - DEFAULT_MAX_OPS_PER_BUCKET);
    }
  }

  private buildTaskWriteOperation(args: {
    teamId: string;
    chatSessionId: string;
    next: TaskFact;
    existing?: TaskFact;
    audit?: TaskWriteAuditContext;
  }): BlackboardOpRecord {
    const { next, existing } = args;
    const actor = args.audit?.actor ?? next.owner ?? existing?.owner ?? next.createdBy ?? null;
    const inferredOp = (() => {
      if (args.audit?.op) {
        return args.audit.op;
      }
      if (next.status === 'running' && (existing?.status !== 'running' || next.currentRunId !== existing?.currentRunId || next.owner !== existing?.owner)) {
        return 'claim';
      }
      if (next.status === 'done' && existing?.status !== 'done') {
        return 'complete';
      }
      if ((next.status === 'blocked' || next.status === 'failed' || next.status === 'waiting_user') && existing?.status !== next.status) {
        return 'block';
      }
      return 'write';
    })();
    return normalizeOperationFact({
      id: `op-${randomUUID()}`,
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: next.requestId,
      op: inferredOp,
      entityType: 'task',
      entityId: next.id,
      actor,
      source: args.audit?.source || inferOperationSource(actor),
      reason: args.audit?.reason || next.blockedBy?.message || next.result || undefined,
      taskId: next.id,
      proposalId: args.audit?.proposalId,
      decisionId: args.audit?.decisionId,
      runId: args.audit?.runId ?? next.currentRunId ?? existing?.currentRunId ?? null,
      beforeRevision: existing?.revision,
      afterRevision: next.revision,
      fromStatus: existing?.status ?? null,
      toStatus: next.status,
      timestamp: this.now(),
    });
  }

  private enforceBucketLimit(state: StoredBlackboardState, candidate: TaskFact): boolean {
    if (!isActiveStatus(candidate.status)) {
      return true;
    }

    let count = 0;
    for (const fact of state.active) {
      if (fact.id === candidate.id) {
        continue;
      }
      if (!isActiveStatus(fact.status)) {
        continue;
      }
      if (fact.requestId !== candidate.requestId) {
        continue;
      }
      if (fact.executionScope.workspaceId !== candidate.executionScope.workspaceId) {
        continue;
      }
      count += 1;
    }
    return count < this.maxActiveFactsPerBucket;
  }

  private applySupersedeLifecycle(state: StoredBlackboardState, completedTask: TaskFact): void {
    if (!isDoneStatus(completedTask.status)) {
      return;
    }
    const supersededTaskId = String(completedTask.supersedesTaskId || '').trim() || null;
    if (!supersededTaskId) {
      return;
    }
    const activeIndex = state.active.findIndex((fact) => fact.id === supersededTaskId);
    const archiveIndex = activeIndex >= 0 ? -1 : state.archive.findIndex((fact) => fact.id === supersededTaskId);
    const original = activeIndex >= 0
      ? state.active[activeIndex]
      : archiveIndex >= 0
        ? state.archive[archiveIndex]
        : null;
    if (!original || original.requestId !== completedTask.requestId) {
      return;
    }
    if (original.status === 'done' && /^Superseded by /.test(String(original.result || ''))) {
      return;
    }
    const updatedOriginal = normalizeTaskFact({
      ...original,
      revision: original.revision + 1,
      status: 'done',
      blockedBy: undefined,
      leaseUntil: undefined,
      claimedAt: undefined,
      lastHeartbeatAt: undefined,
      result: buildSupersededResult({
        original,
        replacement: completedTask,
      }),
      updatedAt: completedTask.updatedAt,
    });
    if (!this.validateTaskFact(updatedOriginal, original)) {
      return;
    }
    if (activeIndex >= 0) {
      state.active[activeIndex] = updatedOriginal;
    } else if (archiveIndex >= 0) {
      state.archive[archiveIndex] = updatedOriginal;
    }
  }

  private validateTaskFact(next: TaskFact, existing?: TaskFact): boolean {
    if (!next.id || !next.chatSessionId || !next.requestId || !next.teamId || !next.goal || !next.requiredCapability || !next.createdBy) {
      return false;
    }
    if (!next.executionScope.workspaceId || !next.executionScope.cwd || next.executionScope.allowedRoots.length === 0 || !next.executionScope.artifactsRoot) {
      return false;
    }
    if (next.status === 'done' && !next.result) {
      return false;
    }
    if ((next.status === 'blocked' || next.status === 'failed') && !next.blockedBy) {
      return false;
    }
    if (existing?.status === 'done') {
      const supersedeDoneUpdate =
        next.status === 'done'
        && typeof next.result === 'string'
        && next.result.startsWith('Superseded by ')
        && next.owner === existing.owner
        && next.currentRunId === existing.currentRunId
        && next.attempt === existing.attempt
        && next.goal === existing.goal
        && next.requiredCapability === existing.requiredCapability
        && JSON.stringify(next.requires) === JSON.stringify(existing.requires)
        && JSON.stringify(next.acceptanceCriteria) === JSON.stringify(existing.acceptanceCriteria)
        && JSON.stringify(next.evidenceRequirements) === JSON.stringify(existing.evidenceRequirements)
        && JSON.stringify(next.executionScope) === JSON.stringify(existing.executionScope)
        && JSON.stringify(next.failureHistory) === JSON.stringify(existing.failureHistory)
        && JSON.stringify(next.blockedBy) === JSON.stringify(existing.blockedBy)
        && next.supersedesTaskId === existing.supersedesTaskId
        && next.resultRef === existing.resultRef
        && next.createdBy === existing.createdBy;
      if (supersedeDoneUpdate) {
        return true;
      }
      const stable =
        next.status === 'done'
        && next.result === existing.result
        && next.owner === existing.owner
        && next.currentRunId === existing.currentRunId
        && next.attempt === existing.attempt
        && next.goal === existing.goal
        && next.requiredCapability === existing.requiredCapability
        && JSON.stringify(next.requires) === JSON.stringify(existing.requires)
        && JSON.stringify(next.acceptanceCriteria) === JSON.stringify(existing.acceptanceCriteria)
        && JSON.stringify(next.evidenceRequirements) === JSON.stringify(existing.evidenceRequirements)
        && JSON.stringify(next.executionScope) === JSON.stringify(existing.executionScope)
        && JSON.stringify(next.failureHistory) === JSON.stringify(existing.failureHistory)
        && JSON.stringify(next.blockedBy) === JSON.stringify(existing.blockedBy)
        && next.supersedesTaskId === existing.supersedesTaskId
        && next.resultRef === existing.resultRef
        && next.createdBy === existing.createdBy;
      return stable;
    }
    return true;
  }

  getState(teamId: string, chatSessionId: string): StoredBlackboardState {
    const path = this.getPath(teamId, chatSessionId);
    if (!existsSync(path)) {
      return defaultState(teamId, chatSessionId);
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredBlackboardState>;
      return {
        teamId,
        chatSessionId,
        active: Array.isArray(parsed.active) ? parsed.active.map(item => normalizeTaskFact(item as TaskFact)) : [],
        archive: Array.isArray(parsed.archive) ? parsed.archive.map(item => normalizeTaskFact(item as TaskFact)) : [],
        proposals: Array.isArray((parsed as { proposals?: ProposalFact[] }).proposals)
          ? ((parsed as { proposals?: ProposalFact[] }).proposals || []).map((item) => normalizeProposalFact(item as ProposalFact))
          : [],
        decisions: Array.isArray((parsed as { decisions?: DecisionFact[] }).decisions)
          ? ((parsed as { decisions?: DecisionFact[] }).decisions || []).map((item) => normalizeDecisionFact(item as DecisionFact))
          : [],
        ops: Array.isArray((parsed as { ops?: BlackboardOpRecord[] }).ops)
          ? ((parsed as { ops?: BlackboardOpRecord[] }).ops || []).map((item) => normalizeOperationFact(item as BlackboardOpRecord))
          : [],
        capabilities: Array.isArray(parsed.capabilities)
          ? parsed.capabilities.map(item => ({
              agentId: String(item.agentId || '').trim(),
              capabilities: uniqueStrings(item.capabilities),
              status: item.status === 'busy' ? 'busy' : 'available',
            }))
          : [],
      };
    } catch (error) {
      console.warn(`[BlackboardStore] Failed to read blackboard for ${teamId}/${chatSessionId}:`, error);
      return defaultState(teamId, chatSessionId);
    }
  }

  get(teamId: string, chatSessionId: string, taskId: string): TaskFact | null {
    const state = this.getState(teamId, chatSessionId);
    const fact = state.active.find(item => item.id === taskId) || state.archive.find(item => item.id === taskId);
    return fact ? cloneTaskFact(fact) : null;
  }

  /** 仅返回已从 Active Board 归档的 done 任务（用于 GET /blackboard/archive 等只读查询）。 */
  listArchivedFacts(teamId: string, chatSessionId: string): TaskFact[] {
    return this.getState(teamId, chatSessionId).archive.map(cloneTaskFact);
  }

  list(teamId: string, chatSessionId: string, options?: ListTaskFactOptions): TaskFact[] {
    const state = this.getState(teamId, chatSessionId);
    const statuses = options?.status ? new Set(Array.isArray(options.status) ? options.status : [options.status]) : null;
    const source = options?.includeArchive ? [...state.active, ...state.archive] : state.active;
    return source
      .filter((fact) => {
        if (options?.requestId && fact.requestId !== options.requestId) {
          return false;
        }
        if (options?.workspaceId && fact.executionScope.workspaceId !== options.workspaceId) {
          return false;
        }
        if (options?.owner && fact.owner !== options.owner) {
          return false;
        }
        if (options?.capability && fact.requiredCapability !== options.capability) {
          return false;
        }
        if (statuses && !statuses.has(fact.status)) {
          return false;
        }
        return true;
      })
      .map(cloneTaskFact);
  }

  listProposals(teamId: string, chatSessionId: string, options?: ListProposalOptions): ProposalFact[] {
    const state = this.getState(teamId, chatSessionId);
    const kinds = options?.kind ? new Set(Array.isArray(options.kind) ? options.kind : [options.kind]) : null;
    return state.proposals
      .filter((proposal) => {
        if (options?.requestId && proposal.requestId !== options.requestId) {
          return false;
        }
        if (options?.parentTaskId && proposal.parentTaskId !== options.parentTaskId) {
          return false;
        }
        if (options?.proposerAgentId && proposal.proposerAgentId !== options.proposerAgentId) {
          return false;
        }
        if (kinds && !kinds.has(proposal.kind)) {
          return false;
        }
        return true;
      })
      .map(cloneProposalFact);
  }

  listDecisions(teamId: string, chatSessionId: string, options?: ListDecisionOptions): DecisionFact[] {
    const state = this.getState(teamId, chatSessionId);
    const decisions = options?.decision ? new Set(Array.isArray(options.decision) ? options.decision : [options.decision]) : null;
    return state.decisions
      .filter((fact) => {
        if (options?.requestId && fact.requestId !== options.requestId) {
          return false;
        }
        if (options?.proposalId && fact.proposalId !== options.proposalId) {
          return false;
        }
        if (options?.decidedBy && fact.decidedBy !== options.decidedBy) {
          return false;
        }
        if (decisions && !decisions.has(fact.decision)) {
          return false;
        }
        return true;
      })
      .map(cloneDecisionFact);
  }

  listOps(teamId: string, chatSessionId: string, options?: ListOperationOptions): BlackboardOpRecord[] {
    const state = this.getState(teamId, chatSessionId);
    const ops = options?.op ? new Set(Array.isArray(options.op) ? options.op : [options.op]) : null;
    const entityTypes = options?.entityType
      ? new Set(Array.isArray(options.entityType) ? options.entityType : [options.entityType])
      : null;
    const filtered = state.ops.filter((record) => {
      if (options?.requestId && record.requestId !== options.requestId) {
        return false;
      }
      if (ops && !ops.has(record.op)) {
        return false;
      }
      if (entityTypes && !entityTypes.has(record.entityType)) {
        return false;
      }
      return true;
    });
    const limit = Number.isFinite(options?.limit) ? Math.max(0, Number(options?.limit)) : null;
    const sliced = limit == null ? filtered : filtered.slice(Math.max(0, filtered.length - limit));
    return sliced.map(cloneOperationFact);
  }

  propose(teamId: string, chatSessionId: string, patch: Partial<ProposalFact> & {
    id: string;
    revision: number;
    requestId: string;
    parentTaskId: string;
    proposerAgentId: string;
    kind: ProposalFactKind;
    payload: ProposalFactPayload;
  }): ProposalFact | null {
    const state = this.getState(teamId, chatSessionId);
    const now = this.now();
    const existingIndex = state.proposals.findIndex((item) => item.id === patch.id);
    const parentTask = this.get(teamId, chatSessionId, patch.parentTaskId);
    if (!parentTask || parentTask.requestId !== patch.requestId) {
      return null;
    }
    if (parentTask.owner !== patch.proposerAgentId && parentTask.createdBy !== patch.proposerAgentId) {
      return null;
    }
    if (existingIndex >= 0) {
      return null;
    }
    if (patch.revision !== 0) {
      return null;
    }
    const created = normalizeProposalFact({
      id: patch.id,
      revision: 1,
      chatSessionId,
      requestId: patch.requestId,
      teamId,
      parentTaskId: patch.parentTaskId,
      proposerAgentId: patch.proposerAgentId,
      kind: patch.kind,
      payload: patch.payload,
      createdAt: now,
      updatedAt: now,
    });
    state.proposals.push(created);
    this.recordOperation(state, {
      id: `op-${randomUUID()}`,
      teamId,
      chatSessionId,
      requestId: created.requestId,
      op: 'propose',
      entityType: 'proposal',
      entityId: created.id,
      actor: created.proposerAgentId,
      source: inferOperationSource(created.proposerAgentId),
      reason: created.payload.reason || created.payload.goal,
      taskId: created.parentTaskId,
      proposalId: created.id,
      afterRevision: created.revision,
      timestamp: now,
    });
    this.writeState(teamId, chatSessionId, state);
    if (isAutoApprovableProposalKind(created.kind)) {
      const autoDecisionId = `${created.id}:decision:auto`;
      const autoDecision = this.decide(teamId, chatSessionId, {
        id: autoDecisionId,
        revision: 0,
        requestId: created.requestId,
        proposalId: created.id,
        ...buildAutoDecisionForProposal(created),
      });
      if (autoDecision) {
        this.materializeApprovedProposal(teamId, chatSessionId, created.id);
      }
    }
    return cloneProposalFact(created);
  }

  decide(teamId: string, chatSessionId: string, patch: Partial<DecisionFact> & {
    id: string;
    revision: number;
    requestId: string;
    proposalId: string;
    decision: DecisionFact['decision'];
    decidedBy: string;
  }): DecisionFact | null {
    const state = this.getState(teamId, chatSessionId);
    const now = this.now();
    const existingIndex = state.decisions.findIndex((item) => item.id === patch.id);
    const proposal = state.proposals.find((item) => item.id === patch.proposalId);
    if (!proposal || proposal.requestId !== patch.requestId) {
      return null;
    }
    if (existingIndex < 0) {
      if (patch.revision !== 0) {
        return null;
      }
      const created = normalizeDecisionFact({
        id: patch.id,
        revision: 1,
        chatSessionId,
        requestId: patch.requestId,
        teamId,
        proposalId: patch.proposalId,
        decision: patch.decision,
        decidedBy: patch.decidedBy,
        decidedAt: Number.isFinite(patch.decidedAt) ? Number(patch.decidedAt) : now,
        note: patch.note,
        amendedPayload: patch.amendedPayload,
        materializedTaskIds: patch.materializedTaskIds,
        materializedAt: patch.materializedAt,
        updatedAt: now,
      });
      state.decisions.push(created);
      this.recordOperation(state, {
        id: `op-${randomUUID()}`,
        teamId,
        chatSessionId,
        requestId: created.requestId,
        op: 'decide',
        entityType: 'decision',
        entityId: created.id,
        actor: created.decidedBy,
        source: inferOperationSource(created.decidedBy),
        reason: created.note || created.decision,
        proposalId: created.proposalId,
        decisionId: created.id,
        afterRevision: created.revision,
        timestamp: now,
      });
      this.writeState(teamId, chatSessionId, state);
      return cloneDecisionFact(created);
    }
    const existing = state.decisions[existingIndex];
    if (existing.revision !== patch.revision) {
      return null;
    }
    const updated = normalizeDecisionFact({
      ...existing,
      ...patch,
      id: existing.id,
      chatSessionId: existing.chatSessionId,
      requestId: existing.requestId,
      teamId: existing.teamId,
      proposalId: existing.proposalId,
      revision: existing.revision + 1,
      updatedAt: now,
    });
    state.decisions[existingIndex] = updated;
    this.recordOperation(state, {
      id: `op-${randomUUID()}`,
      teamId,
      chatSessionId,
      requestId: updated.requestId,
      op: 'decide',
      entityType: 'decision',
      entityId: updated.id,
      actor: updated.decidedBy,
      source: inferOperationSource(updated.decidedBy),
      reason: updated.note || updated.decision,
      proposalId: updated.proposalId,
      decisionId: updated.id,
      beforeRevision: existing.revision,
      afterRevision: updated.revision,
      timestamp: now,
    });
    this.writeState(teamId, chatSessionId, state);
    return cloneDecisionFact(updated);
  }

  materializeApprovedProposal(teamId: string, chatSessionId: string, proposalId: string, options?: {
    taskId?: string;
  }): TaskFact | null {
    const state = this.getState(teamId, chatSessionId);
    const proposal = state.proposals.find((item) => item.id === proposalId);
    if (!proposal) {
      return null;
    }
    const decision = [...state.decisions]
      .filter((item) => item.proposalId === proposalId && (item.decision === 'approve' || item.decision === 'amend'))
      .sort((a, b) => b.decidedAt - a.decidedAt || b.updatedAt - a.updatedAt)[0];
    if (!decision) {
      return null;
    }
    if (decision.materializedTaskIds?.length) {
      const existingTask = decision.materializedTaskIds
        .map((id) => this.get(teamId, chatSessionId, id))
        .find(Boolean);
      return existingTask || null;
    }
    const parentTask = this.get(teamId, chatSessionId, proposal.parentTaskId);
    if (!parentTask) {
      return null;
    }
    if (proposal.kind === 'retry') {
      const retryPayload = decision.amendedPayload || proposal.payload;
      const retryTaskId = String(decision.amendedPayload?.taskId || proposal.payload.taskId || options?.taskId || '').trim();
      if (!retryTaskId) {
        return null;
      }
      const targetTask = this.get(teamId, chatSessionId, retryTaskId);
      if (!targetTask || targetTask.requestId !== proposal.requestId) {
        return null;
      }
      if (targetTask.status === 'done' || targetTask.status === 'waiting_user' || targetTask.status === 'running') {
        return null;
      }
      const resetTask = this.reset(teamId, chatSessionId, retryTaskId, 'approved_retry_reset');
      if (!resetTask) {
        return null;
      }
      const mergedExecutionScope = retryPayload.executionScope
        ? normalizeExecutionScope({
            ...targetTask.executionScope,
            ...retryPayload.executionScope,
            allowedRoots: retryPayload.executionScope.allowedRoots || targetTask.executionScope.allowedRoots,
            allowedTools: retryPayload.executionScope.allowedTools || targetTask.executionScope.allowedTools,
            artifactsRoot: retryPayload.executionScope.artifactsRoot || targetTask.executionScope.artifactsRoot,
          })
        : targetTask.executionScope;
      const nextOwner =
        String(retryPayload.suggestedAssignee || targetTask.owner || '').trim()
        || null;
      const reassigned = this.write(teamId, chatSessionId, {
        id: resetTask.id,
        revision: resetTask.revision,
        goal: retryPayload.goal || targetTask.goal,
        requiredCapability: retryPayload.requiredCapability || targetTask.requiredCapability,
        acceptanceCriteria: retryPayload.acceptanceCriteria || targetTask.acceptanceCriteria,
        evidenceRequirements: retryPayload.evidenceRequirements || targetTask.evidenceRequirements,
        executionScope: mergedExecutionScope,
        owner: nextOwner,
      }, {
        actor: decision.decidedBy,
        source: inferOperationSource(decision.decidedBy),
        reason: proposal.kind,
        proposalId: proposal.id,
        decisionId: decision.id,
      });
      const materialized = reassigned || resetTask;
      this.decide(teamId, chatSessionId, {
        id: decision.id,
        revision: decision.revision,
        requestId: decision.requestId,
        proposalId: decision.proposalId,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        note: decision.note,
        amendedPayload: decision.amendedPayload,
        materializedTaskIds: [...(decision.materializedTaskIds || []), materialized.id],
        materializedAt: this.now(),
      });
      const refreshed = this.getState(teamId, chatSessionId);
      this.recordOperation(refreshed, {
        id: `op-${randomUUID()}`,
        teamId,
        chatSessionId,
        requestId: proposal.requestId,
        op: 'materialize',
        entityType: 'task',
        entityId: materialized.id,
        actor: decision.decidedBy,
        source: inferOperationSource(decision.decidedBy),
        reason: proposal.kind,
        taskId: materialized.id,
        proposalId: proposal.id,
        decisionId: decision.id,
        afterRevision: materialized.revision,
        timestamp: this.now(),
      });
      this.writeState(teamId, chatSessionId, refreshed);
      return materialized;
    }
    const taskPatch = buildTaskPatchFromProposalDecision({
      proposal,
      decision,
      parentTask,
      taskId: options?.taskId,
    });
    const existingTask = this.get(teamId, chatSessionId, taskPatch.id);
    if (existingTask && existingTask.requestId === proposal.requestId) {
      this.decide(teamId, chatSessionId, {
        id: decision.id,
        revision: decision.revision,
        requestId: decision.requestId,
        proposalId: decision.proposalId,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        note: decision.note,
        amendedPayload: decision.amendedPayload,
        materializedTaskIds: [...(decision.materializedTaskIds || []), existingTask.id],
        materializedAt: this.now(),
      });
      const refreshed = this.getState(teamId, chatSessionId);
      this.recordOperation(refreshed, {
        id: `op-${randomUUID()}`,
        teamId,
        chatSessionId,
        requestId: proposal.requestId,
        op: 'materialize',
        entityType: 'task',
        entityId: existingTask.id,
        actor: decision.decidedBy,
        source: inferOperationSource(decision.decidedBy),
        reason: proposal.kind,
        taskId: existingTask.id,
        proposalId: proposal.id,
        decisionId: decision.id,
        afterRevision: existingTask.revision,
        timestamp: this.now(),
      });
      this.writeState(teamId, chatSessionId, refreshed);
      return existingTask;
    }
    const created = this.write(teamId, chatSessionId, {
      ...taskPatch,
      revision: 0,
    }, {
      actor: decision.decidedBy,
      source: inferOperationSource(decision.decidedBy),
      reason: proposal.kind,
      proposalId: proposal.id,
      decisionId: decision.id,
    });
    if (!created) {
      return null;
    }
    this.decide(teamId, chatSessionId, {
      id: decision.id,
      revision: decision.revision,
      requestId: decision.requestId,
      proposalId: decision.proposalId,
      decision: decision.decision,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      note: decision.note,
      amendedPayload: decision.amendedPayload,
      materializedTaskIds: [...(decision.materializedTaskIds || []), created.id],
      materializedAt: this.now(),
    });
    const refreshed = this.getState(teamId, chatSessionId);
    this.recordOperation(refreshed, {
      id: `op-${randomUUID()}`,
      teamId,
      chatSessionId,
      requestId: proposal.requestId,
      op: 'materialize',
      entityType: 'task',
      entityId: created.id,
      actor: decision.decidedBy,
      source: inferOperationSource(decision.decidedBy),
      reason: proposal.kind,
      taskId: created.id,
      proposalId: proposal.id,
      decisionId: decision.id,
      afterRevision: created.revision,
      timestamp: this.now(),
    });
    this.writeState(teamId, chatSessionId, refreshed);
    return created;
  }

  write(
    teamId: string,
    chatSessionId: string,
    patch: Partial<TaskFact> & { id: string; revision: number },
    audit?: TaskWriteAuditContext,
  ): TaskFact | null {
    const state = this.getState(teamId, chatSessionId);
    const now = this.now();
    const activeIndex = state.active.findIndex(item => item.id === patch.id);
    const archiveIndex = state.archive.findIndex(item => item.id === patch.id);
    const existing = activeIndex >= 0 ? state.active[activeIndex] : archiveIndex >= 0 ? state.archive[archiveIndex] : undefined;

    if (!existing) {
      if (patch.revision !== 0) {
        return null;
      }

      const created = normalizeTaskFact({
        id: patch.id,
        revision: 1,
        chatSessionId,
        requestId: String(patch.requestId || '').trim(),
        teamId,
        goal: String(patch.goal || '').trim(),
        requires: uniqueStrings(patch.requires),
        requiredCapability: String(patch.requiredCapability || '').trim(),
        acceptanceCriteria: uniqueStrings(patch.acceptanceCriteria),
        evidenceRequirements: normalizeEvidenceRequirements(patch.evidenceRequirements),
        endpointHints: normalizeEndpointHints(patch.endpointHints),
        toolBindings: normalizeToolBindings(patch.toolBindings),
        networkMode: normalizeEndpointNetworkMode(patch.networkMode),
        riskClass: normalizeEndpointRiskClass(patch.riskClass),
        executionScope: normalizeExecutionScope(patch.executionScope as ExecutionScope),
        status: patch.status || 'pending',
        owner: patch.owner ? String(patch.owner).trim() : null,
        currentRunId: patch.currentRunId ? String(patch.currentRunId).trim() : null,
        attempt: Math.max(0, Number(patch.attempt) || 0),
        leaseUntil: Number.isFinite(patch.leaseUntil) ? Number(patch.leaseUntil) : undefined,
        claimedAt: Number.isFinite(patch.claimedAt) ? Number(patch.claimedAt) : undefined,
        lastHeartbeatAt: Number.isFinite(patch.lastHeartbeatAt) ? Number(patch.lastHeartbeatAt) : undefined,
        blockedBy: normalizeBlockedBy(patch.blockedBy),
        result: trimResult(patch.result),
        resultRef: patch.resultRef ? String(patch.resultRef).trim() : undefined,
        supersedesTaskId: typeof patch.supersedesTaskId === 'string' ? patch.supersedesTaskId.trim() || undefined : undefined,
        failureHistory: Array.isArray(patch.failureHistory) ? patch.failureHistory.map(normalizeFailureEvent) : [],
        createdBy: String(patch.createdBy || '').trim(),
        updatedAt: now,
      });

      if (created.status !== 'running') {
        created.leaseUntil = undefined;
        created.claimedAt = undefined;
        created.lastHeartbeatAt = undefined;
      }
      if (created.status === 'waiting_user') {
        created.currentRunId = null;
      }
      if (!isDoneStatus(created.status)) {
        created.result = undefined;
        created.resultRef = created.status === 'done' ? created.resultRef : undefined;
      }
      if (!this.validateTaskFact(created) || !this.enforceBucketLimit(state, created)) {
        return null;
      }

      state.active.push(created);
      this.applySupersedeLifecycle(state, created);
      this.recordOperation(state, this.buildTaskWriteOperation({
        teamId,
        chatSessionId,
        next: created,
        audit,
      }));
      this.writeState(teamId, chatSessionId, state);
      return cloneTaskFact(created);
    }

    if (patch.revision !== existing.revision) {
      return null;
    }

    const next = normalizeTaskFact({
      ...existing,
      ...patch,
      revision: existing.revision + 1,
      id: existing.id,
      chatSessionId: existing.chatSessionId,
      requestId: existing.requestId,
      teamId: existing.teamId,
      supersedesTaskId: typeof patch.supersedesTaskId === 'string'
        ? patch.supersedesTaskId.trim() || undefined
        : existing.supersedesTaskId,
      failureHistory: Array.isArray(patch.failureHistory) ? patch.failureHistory : existing.failureHistory,
      updatedAt: now,
    });

    if (next.status !== 'running') {
      next.leaseUntil = undefined;
      next.claimedAt = undefined;
      next.lastHeartbeatAt = undefined;
    }
    if (next.status === 'waiting_user') {
      next.currentRunId = null;
      next.leaseUntil = undefined;
      next.claimedAt = undefined;
      next.lastHeartbeatAt = undefined;
    }
    if (!isDoneStatus(next.status)) {
      next.result = undefined;
      next.resultRef = undefined;
    }
    if ((next.status === 'blocked' || next.status === 'failed') && !next.blockedBy) {
      next.blockedBy = existing.blockedBy;
    }
    if (!this.validateTaskFact(next, existing) || !this.enforceBucketLimit(state, next)) {
      return null;
    }

    const updated = cloneTaskFact(next);
    if (archiveIndex >= 0) {
      state.archive[archiveIndex] = updated;
    } else if (activeIndex >= 0) {
      state.active[activeIndex] = updated;
    }
    this.applySupersedeLifecycle(state, updated);
    this.recordOperation(state, this.buildTaskWriteOperation({
      teamId,
      chatSessionId,
      next: updated,
      existing,
      audit,
    }));
    this.writeState(teamId, chatSessionId, state);
    return cloneTaskFact(updated);
  }

  heartbeat(teamId: string, chatSessionId: string, taskId: string, agentId: string, runId: string): TaskFact | null {
    const fact = this.get(teamId, chatSessionId, taskId);
    if (!fact || fact.status !== 'running' || fact.owner !== agentId || fact.currentRunId !== runId) {
      return null;
    }
    return this.write(teamId, chatSessionId, {
      id: fact.id,
      revision: fact.revision,
      lastHeartbeatAt: this.now(),
      leaseUntil: this.now() + this.leaseDurationMs,
    }, {
      op: 'heartbeat',
      actor: agentId,
      source: inferOperationSource(agentId),
      reason: 'lease heartbeat',
      runId,
    });
  }

  recordTaskOperation(teamId: string, chatSessionId: string, input: {
    requestId: string;
    op: BlackboardOpKind;
    taskId: string;
    actor?: string | null;
    source?: BlackboardOpSource;
    reason?: string;
    runId?: string | null;
  }): BlackboardOpRecord | null {
    const state = this.getState(teamId, chatSessionId);
    const task = state.active.find((item) => item.id === input.taskId)
      || state.archive.find((item) => item.id === input.taskId)
      || null;
    if (!task || task.requestId !== input.requestId) {
      return null;
    }
    const op = normalizeOperationFact({
      id: `op-${randomUUID()}`,
      teamId,
      chatSessionId,
      requestId: task.requestId,
      op: input.op,
      entityType: 'task',
      entityId: task.id,
      actor: input.actor ?? null,
      source: input.source || inferOperationSource(input.actor || null),
      reason: input.reason,
      taskId: task.id,
      runId: input.runId ?? task.currentRunId ?? null,
      beforeRevision: task.revision,
      afterRevision: task.revision,
      fromStatus: task.status,
      toStatus: task.status,
      timestamp: this.now(),
    });
    this.recordOperation(state, op);
    this.writeState(teamId, chatSessionId, state);
    return op;
  }

  reset(teamId: string, chatSessionId: string, taskId: string, kind: ResetKind): TaskFact | null {
    const state = this.getState(teamId, chatSessionId);
    const activeIndex = state.active.findIndex(item => item.id === taskId);
    if (activeIndex < 0) {
      return null;
    }

    const existing = state.active[activeIndex];
    if (existing.status === 'done') {
      return null;
    }

    const failureEvent: FailureEvent = {
      runId: existing.currentRunId || `reset-${existing.id}-${existing.revision}`,
      at: this.now(),
      blockedBy: normalizeBlockedBy(existing.blockedBy) || {
        kind: 'unknown',
        message: kind === 'lease_expired_reset' ? 'Lease expired before task completed' : 'Task reset for reassignment',
        retryable: true,
      },
      resetKind: kind,
    };

    return this.write(teamId, chatSessionId, {
      id: existing.id,
      revision: existing.revision,
      status: 'pending',
      owner: null,
      currentRunId: null,
      blockedBy: undefined,
      leaseUntil: undefined,
      claimedAt: undefined,
      lastHeartbeatAt: undefined,
      failureHistory: [...existing.failureHistory, failureEvent],
    }, {
      op: 'reset',
      actor: existing.owner || existing.createdBy || null,
      source: inferOperationSource(existing.owner || existing.createdBy || null),
      reason: kind,
      runId: failureEvent.runId,
    });
  }

  archive(teamId: string, chatSessionId: string, ids: string[]): TaskFact[] {
    if (ids.length === 0) {
      return [];
    }

    const state = this.getState(teamId, chatSessionId);
    const archived: TaskFact[] = [];
    const remaining: TaskFact[] = [];

    for (const fact of state.active) {
      if (ids.includes(fact.id) && fact.status === 'done') {
        archived.push(fact);
      } else {
        remaining.push(fact);
      }
    }

    if (archived.length === 0) {
      return [];
    }

    state.active = remaining;
    state.archive.push(...archived);
    const timestamp = this.now();
    for (const fact of archived) {
      this.recordOperation(state, {
        id: `op-${randomUUID()}`,
        teamId,
        chatSessionId,
        requestId: fact.requestId,
        op: 'archive',
        entityType: 'task',
        entityId: fact.id,
        actor: 'system',
        source: 'system',
        reason: 'archive done fact from active board',
        taskId: fact.id,
        beforeRevision: fact.revision,
        afterRevision: fact.revision,
        fromStatus: fact.status,
        toStatus: fact.status,
        timestamp,
      });
    }
    this.writeState(teamId, chatSessionId, state);
    return archived.map(cloneTaskFact);
  }

  remove(teamId: string, chatSessionId: string, ids: string[]): number {
    if (ids.length === 0) {
      return 0;
    }
    const state = this.getState(teamId, chatSessionId);
    const idSet = new Set(ids);
    const activeBefore = state.active.length;
    const archiveBefore = state.archive.length;
    state.active = state.active.filter((fact) => !idSet.has(fact.id));
    state.archive = state.archive.filter((fact) => !idSet.has(fact.id));
    const removed = (activeBefore - state.active.length) + (archiveBefore - state.archive.length);
    if (removed > 0) {
      this.writeState(teamId, chatSessionId, state);
    }
    return removed;
  }

  scanExpiredLeases(teamId: string, chatSessionId: string): TaskFact[] {
    const state = this.getState(teamId, chatSessionId);
    const now = this.now();
    const expired = state.active
      .filter(fact => fact.status === 'running' && Number.isFinite(fact.leaseUntil) && Number(fact.leaseUntil) < now)
      .filter(fact => isRecoverableRunningHeartbeatState(deriveRunningHeartbeatWindow(fact, now).state))
      .map(fact => fact.id);

    const resetFacts: TaskFact[] = [];
    for (const taskId of expired) {
      const resetFact = this.reset(teamId, chatSessionId, taskId, 'lease_expired_reset');
      if (resetFact) {
        resetFacts.push(resetFact);
      }
    }
    return resetFacts;
  }

  upsertCapability(teamId: string, chatSessionId: string, capability: AgentCapability): AgentCapability {
    const state = this.getState(teamId, chatSessionId);
    const normalized: AgentCapability = {
      agentId: String(capability.agentId || '').trim(),
      capabilities: uniqueStrings(capability.capabilities),
      status: capability.status === 'busy' ? 'busy' : 'available',
    };
    state.capabilities = state.capabilities.filter(item => item.agentId !== normalized.agentId);
    state.capabilities.push(normalized);
    state.capabilities.sort((a, b) => a.agentId.localeCompare(b.agentId));
    this.writeState(teamId, chatSessionId, state);
    return { ...normalized, capabilities: [...normalized.capabilities] };
  }

  listCapabilities(teamId: string, chatSessionId: string): AgentCapability[] {
    return this.getState(teamId, chatSessionId).capabilities.map(item => ({
      ...item,
      capabilities: [...item.capabilities],
    }));
  }

  subscribe(agentId: string, filter: SubscribeFilter): void {
    this.subscriptions.set(agentId, {
      teamId: filter.teamId,
      chatSessionId: filter.chatSessionId,
      capabilities: filter.capabilities ? [...filter.capabilities] : undefined,
      workspaceIds: filter.workspaceIds ? [...filter.workspaceIds] : undefined,
      ownerAgentId: filter.ownerAgentId,
    });
  }

  unsubscribe(agentId: string): void {
    this.subscriptions.delete(agentId);
  }

  getRelevant(agentId: string): TaskFact[] {
    const filter = this.subscriptions.get(agentId);
    if (!filter) {
      return [];
    }

    return this.list(filter.teamId, filter.chatSessionId).filter((fact) => {
      if (filter.ownerAgentId && fact.owner === filter.ownerAgentId) {
        return true;
      }
      if (fact.owner === agentId) {
        return true;
      }
      if (filter.capabilities?.length && !filter.capabilities.includes(fact.requiredCapability)) {
        return false;
      }
      if (filter.workspaceIds?.length && !filter.workspaceIds.includes(fact.executionScope.workspaceId)) {
        return false;
      }
      return true;
    });
  }

  clear(teamId: string, chatSessionId?: string): void {
    if (chatSessionId) {
      const path = this.getPath(teamId, chatSessionId);
      if (existsSync(path)) {
        rmSync(path, { force: true, maxRetries: 5, retryDelay: 20 });
      }
      return;
    }

    const teamDir = join(this.dataDir, teamId);
    if (existsSync(teamDir)) {
      rmSync(teamDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
}

let store: BlackboardStore | null = null;

export function getBlackboardStore(): BlackboardStore {
  if (!store) {
    const config = loadOpenTeamConfig();
    store = new BlackboardStore({
      leaseDurationMs: config.runtime.blackboard.leaseDurationMs,
    });
  }
  return store;
}

export function setBlackboardStoreForTests(nextStore: BlackboardStore | null): void {
  store = nextStore;
}
