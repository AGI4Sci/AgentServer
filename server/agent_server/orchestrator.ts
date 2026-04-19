import type { AgentBackendId } from '../../core/runtime/backend-catalog.js';
import type {
  AgentRunOrchestratorLedger,
  AgentRunStageRecord,
  AgentRunStageOwnership,
  AgentRunStagePlan,
  AgentRunStageType,
  BackendHandoffPacket,
  CanonicalSessionContextSnapshot,
  StageSummary,
  WorkspaceFacts,
} from './types.js';

export type RuleBasedStagePlanKind =
  | 'implement-only'
  | 'implement-review'
  | 'diagnose-implement-verify';

export interface RuleBasedOrchestratorPlanInput {
  runId: string;
  primaryBackend: AgentBackendId;
  workspace: string;
  requestText: string;
  createdAt: string;
  planKind?: RuleBasedStagePlanKind;
  reviewBackend?: AgentBackendId;
  diagnoseBackend?: AgentBackendId;
  verifyBackend?: AgentBackendId;
}

export interface StageExecutionWave {
  wave: number;
  stageIds: string[];
  canRunInParallel: boolean;
  reason: string;
}

export interface StageDependencyGraph {
  stageIds: string[];
  waves: StageExecutionWave[];
  blockedStageIds: string[];
  diagnostics: string[];
}

export interface BuildStageHandoffPacketInput {
  runId: string;
  stage: AgentRunStagePlan;
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

export interface ResolveStageFailureActionInput {
  stage: AgentRunStagePlan;
  policy: AgentRunOrchestratorLedger['policy'];
  retryCount: number;
  maxRetries?: number;
  fallbackBackend?: AgentBackendId;
  failureReason: string;
}

export interface ExecuteMultiStagePlanInput {
  runId: string;
  ledger: AgentRunOrchestratorLedger;
  goal: string;
  userRequest: string;
  canonicalContext: CanonicalSessionContextSnapshot;
  constraints: string[];
  openQuestions: string[];
  metadata?: Record<string, unknown>;
  maxRetries?: number;
  fallbackBackend?: AgentBackendId;
  getWorkspaceFacts: (stage: AgentRunStagePlan, priorStages: AgentRunStageRecord[]) => Promise<WorkspaceFacts> | WorkspaceFacts;
  renderStageInstructions: (stage: AgentRunStagePlan) => string;
  runStage: (
    handoff: BackendHandoffPacket,
    stage: AgentRunStagePlan,
    attempt: number,
  ) => Promise<AgentRunStageRecord> | AgentRunStageRecord;
}

export interface ExecuteMultiStagePlanResult {
  stages: AgentRunStageRecord[];
  ledger: AgentRunOrchestratorLedger;
  failureAction?: StageFailureAction;
}

export type StageFailureAction =
  | {
      type: 'fail_run';
      stageId: string;
      reason: string;
    }
  | {
      type: 'retry_stage';
      stageId: string;
      retryCount: number;
      reason: string;
    }
  | {
      type: 'fallback_backend';
      stageId: string;
      backend: AgentBackendId;
      reason: string;
    };

export function selectRuleBasedStagePlanKind(requestText: string): RuleBasedStagePlanKind {
  const normalized = requestText.toLowerCase();
  if (containsAny(normalized, ['diagnose', 'debug', 'root cause', 'investigate', '排查', '诊断', '定位'])) {
    return 'diagnose-implement-verify';
  }
  if (containsAny(normalized, ['review', 'audit', 'check my change', '审查', '评审', '检查修改'])) {
    return 'implement-review';
  }
  return 'implement-only';
}

export function buildRuleBasedOrchestratorLedger(
  input: RuleBasedOrchestratorPlanInput,
): AgentRunOrchestratorLedger {
  const planKind = input.planKind || selectRuleBasedStagePlanKind(input.requestText);
  const plan = buildRuleBasedStagePlan(input, planKind);
  return {
    version: 1,
    mode: plan.length > 1 ? 'multi_stage' : 'single_stage',
    policy: {
      name: 'default-rule-based',
      version: 'v1',
      planner: 'rule_based',
      failureStrategy: 'fail_run',
    },
    plan,
    stageOrder: plan.map((stage) => stage.stageId),
    completedStageIds: [],
    failedStageIds: [],
    skippedStageIds: [],
    stageSummaries: [],
    summary: `Run ${input.runId} planned as ${planKind} with ${plan.length} stage(s).`,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

export function buildStageDependencyGraph(plan: AgentRunStagePlan[]): StageDependencyGraph {
  const byId = new Map(plan.map((stage) => [stage.stageId, stage]));
  const completed = new Set<string>();
  const scheduled = new Set<string>();
  const waves: StageExecutionWave[] = [];
  const diagnostics: string[] = [];

  while (scheduled.size < plan.length) {
    const ready = plan.filter((stage) => (
      !scheduled.has(stage.stageId)
      && stage.dependsOn.every((dependency) => completed.has(dependency))
    ));
    if (ready.length === 0) {
      const blockedStageIds = plan
        .filter((stage) => !scheduled.has(stage.stageId))
        .map((stage) => stage.stageId);
      diagnostics.push(`No schedulable stage found; dependency cycle or missing dependency among: ${blockedStageIds.join(', ')}`);
      return {
        stageIds: plan.map((stage) => stage.stageId),
        waves,
        blockedStageIds,
        diagnostics,
      };
    }

    for (const batch of splitWriteConflicts(ready)) {
      const stageIds = batch.map((stage) => stage.stageId);
      const canRunInParallel = batch.length > 1;
      waves.push({
        wave: waves.length + 1,
        stageIds,
        canRunInParallel,
        reason: canRunInParallel
          ? 'All stages in this wave have satisfied dependencies and no same-workspace serial write conflict.'
          : 'Single stage wave or split from a same-workspace serial write conflict.',
      });
      for (const stageId of stageIds) {
        scheduled.add(stageId);
        completed.add(stageId);
      }
    }
  }

  for (const stage of plan) {
    for (const dependency of stage.dependsOn) {
      if (!byId.has(dependency)) {
        diagnostics.push(`Stage ${stage.stageId} depends on unknown stage ${dependency}.`);
      }
    }
  }

  return {
    stageIds: plan.map((stage) => stage.stageId),
    waves,
    blockedStageIds: [],
    diagnostics,
  };
}

export function buildStageHandoffPacket(
  input: BuildStageHandoffPacketInput,
): BackendHandoffPacket {
  return {
    runId: input.runId,
    stageId: input.stage.stageId,
    stageType: input.stage.type,
    goal: input.goal,
    userRequest: input.userRequest,
    canonicalContext: {
      ...input.canonicalContext,
      workspaceState: {
        ...input.workspaceFacts,
      },
      backendRunRecords: [...input.priorStageSummaries],
      artifacts: [...input.canonicalContext.artifacts],
      plan: [...input.canonicalContext.plan],
      decisions: [...input.canonicalContext.decisions],
      constraints: [...input.canonicalContext.constraints],
      openQuestions: [...input.openQuestions],
    },
    stageInstructions: input.stageInstructions,
    constraints: [...input.constraints],
    workspaceFacts: {
      ...input.workspaceFacts,
    },
    priorStageSummaries: [...input.priorStageSummaries],
    openQuestions: [...input.openQuestions],
    metadata: input.metadata,
  };
}

export function resolveStageFailureAction(
  input: ResolveStageFailureActionInput,
): StageFailureAction {
  if (input.policy.failureStrategy === 'retry_stage') {
    const maxRetries = input.maxRetries ?? 1;
    if (input.retryCount < maxRetries) {
      return {
        type: 'retry_stage',
        stageId: input.stage.stageId,
        retryCount: input.retryCount + 1,
        reason: `Retrying stage after failure: ${input.failureReason}`,
      };
    }
  }

  if (
    input.policy.failureStrategy === 'fallback_backend'
    && input.fallbackBackend
    && input.fallbackBackend !== input.stage.backend
  ) {
    return {
      type: 'fallback_backend',
      stageId: input.stage.stageId,
      backend: input.fallbackBackend,
      reason: `Falling back from ${input.stage.backend} after failure: ${input.failureReason}`,
    };
  }

  return {
    type: 'fail_run',
    stageId: input.stage.stageId,
    reason: input.policy.failureStrategy === 'continue_with_warnings'
      ? `Continue-with-warnings is not enabled for workspace-writing stages yet: ${input.failureReason}`
      : `Stage failure fails the run under ${input.policy.name}/${input.policy.version}: ${input.failureReason}`,
  };
}

export async function executeMultiStagePlan(
  input: ExecuteMultiStagePlanInput,
): Promise<ExecuteMultiStagePlanResult> {
  const graph = buildStageDependencyGraph(input.ledger.plan);
  if (graph.blockedStageIds.length > 0) {
    return {
      stages: [],
      ledger: completeOrchestratorLedgerFromStages(input.ledger, []),
      failureAction: {
        type: 'fail_run',
        stageId: graph.blockedStageIds[0] || '(unknown)',
        reason: graph.diagnostics.join('; ') || 'stage dependency graph is blocked',
      },
    };
  }

  const stages: AgentRunStageRecord[] = [];
  let failureAction: StageFailureAction | undefined;
  const retryCounts = new Map<string, number>();

  for (const wave of graph.waves) {
    const waveStages = wave.stageIds
      .map((stageId) => input.ledger.plan.find((stage) => stage.stageId === stageId))
      .filter((stage): stage is AgentRunStagePlan => Boolean(stage));
    const records = await Promise.all(waveStages.map(async (stage) => (
      await runStageWithPolicy(input, stage, stages, retryCounts)
    )));

    for (const record of records) {
      stages.push(...record.stageRecords);
      if (record.failureAction) {
        failureAction = record.failureAction;
        return {
          stages,
          ledger: completeOrchestratorLedgerFromStages(input.ledger, stages),
          failureAction,
        };
      }
    }
  }

  return {
    stages,
    ledger: completeOrchestratorLedgerFromStages(input.ledger, stages),
  };
}

export function completeOrchestratorLedgerFromStages(
  ledger: AgentRunOrchestratorLedger,
  stages: AgentRunStageRecord[],
): AgentRunOrchestratorLedger {
  const completedStageIds = stages
    .filter((stage) => stage.status === 'completed')
    .map((stage) => stage.id);
  const failedStageIds = stages
    .filter((stage) => stage.status === 'failed' || stage.status === 'timeout' || stage.status === 'cancelled')
    .map((stage) => stage.id);
  const skippedStageIds = stages
    .filter((stage) => stage.status === 'skipped')
    .map((stage) => stage.id);
  return {
    ...ledger,
    completedStageIds,
    failedStageIds,
    skippedStageIds,
    stageSummaries: stages
      .filter((stage) => Boolean(stage.result))
      .map(stageRecordToSummary),
    summary: [
      ledger.summary,
      `Completed=${completedStageIds.length}; failed=${failedStageIds.length}; skipped=${skippedStageIds.length}.`,
    ].join(' '),
    updatedAt: new Date().toISOString(),
  };
}

async function runStageWithPolicy(
  input: ExecuteMultiStagePlanInput,
  stage: AgentRunStagePlan,
  priorStages: AgentRunStageRecord[],
  retryCounts: Map<string, number>,
): Promise<{
  stageRecords: AgentRunStageRecord[];
  failureAction?: StageFailureAction;
}> {
  const attempt = retryCounts.get(stage.stageId) || 0;
  const stageRecord = await runStageOnce(input, stage, priorStages, attempt);
  if (stageRecord.status === 'completed' || stageRecord.status === 'skipped') {
    return { stageRecords: [stageRecord] };
  }

  const failureAction = resolveStageFailureAction({
    stage,
    policy: input.ledger.policy,
    retryCount: attempt,
    maxRetries: input.maxRetries,
    fallbackBackend: input.fallbackBackend,
    failureReason: stageRecord.audit.failureReason || stageRecord.result?.handoffSummary || stageRecord.status,
  });
  if (failureAction.type === 'retry_stage') {
    retryCounts.set(stage.stageId, failureAction.retryCount);
    return await runStageWithPolicy(input, stage, priorStages, retryCounts);
  }
  if (failureAction.type === 'fallback_backend') {
    const fallbackStage: AgentRunStagePlan = {
      ...stage,
      stageId: `${stage.stageId}-fallback-${failureAction.backend}`,
      backend: failureAction.backend,
      dependsOn: [...stage.dependsOn],
      reason: failureAction.reason,
    };
    const fallbackRecord = await runStageOnce(input, fallbackStage, [...priorStages, stageRecord], 0);
    if (fallbackRecord.status === 'completed') {
      return { stageRecords: [stageRecord, fallbackRecord] };
    }
    return {
      stageRecords: [stageRecord, fallbackRecord],
      failureAction: {
        type: 'fail_run',
        stageId: fallbackStage.stageId,
        reason: fallbackRecord.audit.failureReason || fallbackRecord.result?.handoffSummary || 'fallback stage failed',
      },
    };
  }
  return {
    stageRecords: [stageRecord],
    failureAction,
  };
}

async function runStageOnce(
  input: ExecuteMultiStagePlanInput,
  stage: AgentRunStagePlan,
  priorStages: AgentRunStageRecord[],
  attempt: number,
): Promise<AgentRunStageRecord> {
  const workspaceFacts = await input.getWorkspaceFacts(stage, priorStages);
  const priorStageSummaries = priorStages
    .filter((record) => Boolean(record.result))
    .map(stageRecordToSummary);
  const handoff = buildStageHandoffPacket({
    runId: input.runId,
    stage,
    goal: input.goal,
    userRequest: input.userRequest,
    canonicalContext: input.canonicalContext,
    stageInstructions: input.renderStageInstructions(stage),
    constraints: input.constraints,
    workspaceFacts,
    priorStageSummaries,
    openQuestions: input.openQuestions,
    metadata: input.metadata,
  });
  return await input.runStage(handoff, stage, attempt);
}

function stageRecordToSummary(stage: AgentRunStageRecord): StageSummary {
  return {
    runId: stage.runId,
    stageId: stage.id,
    backend: stage.backend,
    summary: stage.result?.handoffSummary || stage.audit.outputSummary || '',
    filesChanged: stage.result?.filesChanged || [],
    testsRun: stage.result?.testsRun.map((item) => `${item.command}: ${item.status}`) || [],
    risks: stage.result?.risks || [],
  };
}

function buildRuleBasedStagePlan(
  input: RuleBasedOrchestratorPlanInput,
  planKind: RuleBasedStagePlanKind,
): AgentRunStagePlan[] {
  if (planKind === 'implement-review') {
    const implement = stage(input, 'implement', 1, input.primaryBackend, [], 'Primary backend performs the requested implementation.');
    const review = stage(input, 'review', 2, input.reviewBackend || 'codex', [implement.stageId], 'Review backend checks correctness, risks, and verification gaps.');
    return [implement, review];
  }
  if (planKind === 'diagnose-implement-verify') {
    const diagnose = stage(input, 'diagnose', 1, input.diagnoseBackend || 'gemini', [], 'Diagnose stage gathers broad context and root-cause evidence before writes.');
    const implement = stage(input, 'implement', 2, input.primaryBackend, [diagnose.stageId], 'Primary backend performs coherent workspace edits after diagnosis.');
    const verify = stage(input, 'verify', 3, input.verifyBackend || 'codex', [implement.stageId], 'Verification stage checks tests, diff, and residual risks.');
    return [diagnose, implement, verify];
  }
  return [
    stage(input, 'implement', 1, input.primaryBackend, [], 'Default v1 policy maps the request to one implement stage on the selected backend.'),
  ];
}

function stage(
  input: RuleBasedOrchestratorPlanInput,
  type: AgentRunStageType,
  index: number,
  backend: AgentBackendId,
  dependsOn: string[],
  reason: string,
): AgentRunStagePlan {
  const ownership: AgentRunStageOwnership = {
    workspaceId: input.workspace,
    writeMode: type === 'implement' ? 'serial' : 'none',
  };
  return {
    stageId: `${input.runId}-stage-${type}-${index}`,
    type,
    backend,
    dependsOn,
    reason,
    ownership,
  };
}

function splitWriteConflicts(stages: AgentRunStagePlan[]): AgentRunStagePlan[][] {
  const batches: AgentRunStagePlan[][] = [];
  for (const stage of stages) {
    const workspaceId = stage.ownership?.workspaceId;
    const isSerialWrite = stage.ownership?.writeMode === 'serial';
    const compatibleBatch = batches.find((batch) => (
      !isSerialWrite
      || !workspaceId
      || !batch.some((item) => (
        item.ownership?.writeMode === 'serial'
        && item.ownership?.workspaceId === workspaceId
      ))
    ));
    if (compatibleBatch) {
      compatibleBatch.push(stage);
    } else {
      batches.push([stage]);
    }
  }
  return batches;
}

function containsAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}
