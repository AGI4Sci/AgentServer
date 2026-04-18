import type { RequestStateRecord } from '../store/request-state-store.js';
import type { BlackboardStore } from '../store/blackboard-store.js';
import type { CoordinatorOutput } from './coordinator-context.js';
import type { DecisionFact, ProposalFact, TaskFact } from './blackboard-types.js';
import { deriveProposalLifecycle } from './blackboard-proposals.js';
import { deriveRequestFinalGate } from './request-final-gate.js';

export type BlackboardCoordinatorMode = 'decompose' | 'recovery' | 'synthesize';

export interface BlackboardProtocolGuard {
  phase: string | null;
  allowedProposalKinds: string[];
  requiredProposalKinds: string[];
  requiredTaskIds: string[];
  supersedesTaskIds: string[];
  requiredCapability: string | null;
  requiredCapabilities: string[];
  requiredGoal: string | null;
  requiredGoals: string[];
  dependencyMode: 'ordered' | 'parallel' | null;
  evidenceMode: 'source' | 'impossible_source' | null;
  evidenceModes: Array<'none' | 'source' | 'impossible_source'>;
  forbidDecisions: boolean;
}

export interface BlackboardCoordinatorModeSnapshot {
  requestId: string | null;
  mode: BlackboardCoordinatorMode;
  reason: string;
  facts: TaskFact[];
  proposals: ProposalFact[];
  decisions: DecisionFact[];
  pendingFacts: TaskFact[];
  runningFacts: TaskFact[];
  waitingUserFacts: TaskFact[];
  recoverableFacts: TaskFact[];
  doneFacts: TaskFact[];
  archivedDoneFacts: TaskFact[];
  requestState: RequestStateRecord | null;
}

function limitIds(facts: TaskFact[], max = 6): string {
  const ids = facts.map((fact) => fact.id).filter(Boolean);
  if (ids.length === 0) {
    return '(none)';
  }
  if (ids.length <= max) {
    return ids.join(', ');
  }
  return `${ids.slice(0, max).join(', ')}, ...`;
}

function summarizeFact(fact: TaskFact): string {
  const parts = [
    `taskId=${fact.id}`,
    `status=${fact.status}`,
    `owner=${fact.owner || 'unclaimed'}`,
    `capability=${fact.requiredCapability}`,
  ];
  if (fact.requires.length > 0) {
    parts.push(`requires=${fact.requires.join(',')}`);
  }
  if (fact.blockedBy?.message) {
    parts.push(`blockedBy=${fact.blockedBy.message.replace(/\s+/g, ' ').trim()}`);
  }
  if (fact.goal) {
    parts.push(`goal=${fact.goal.replace(/\s+/g, ' ').trim()}`);
  }
  if (fact.result) {
    const result = fact.result.replace(/\s+/g, ' ').trim();
    if (result) {
      parts.push(`result=${result.slice(0, 280)}`);
    }
  }
  return parts.join(' | ');
}

function appendFactSection(lines: string[], label: string, facts: TaskFact[], max = 8): void {
  if (facts.length === 0) {
    return;
  }
  lines.push(`${label}:`);
  for (const fact of facts.slice(0, max)) {
    lines.push(`- ${summarizeFact(fact)}`);
  }
  if (facts.length > max) {
    lines.push(`- ...and ${facts.length - max} more`);
  }
}

function summarizeProposal(proposal: ProposalFact, decision: DecisionFact | null): string {
  const parts = [
    `proposalId=${proposal.id}`,
    `kind=${proposal.kind}`,
    `parentTaskId=${proposal.parentTaskId}`,
    `proposer=${proposal.proposerAgentId}`,
    `capability=${proposal.payload.requiredCapability}`,
  ];
  if (proposal.payload.suggestedAssignee) {
    parts.push(`suggestedAssignee=${proposal.payload.suggestedAssignee}`);
  }
  if (proposal.payload.requires?.length) {
    parts.push(`requires=${proposal.payload.requires.join(',')}`);
  }
  if (proposal.payload.endpointHints?.length) {
    parts.push(`endpointHints=${proposal.payload.endpointHints.map((hint) => hint.endpointId || hint.kind || hint.capability).filter(Boolean).join(',')}`);
  }
  if (proposal.payload.networkMode) {
    parts.push(`networkMode=${proposal.payload.networkMode}`);
  }
  if (proposal.payload.riskClass) {
    parts.push(`riskClass=${proposal.payload.riskClass}`);
  }
  if (proposal.payload.goal) {
    parts.push(`goal=${proposal.payload.goal.replace(/\s+/g, ' ').trim()}`);
  }
  if (proposal.payload.reason) {
    parts.push(`reason=${proposal.payload.reason.replace(/\s+/g, ' ').trim()}`);
  }
  if (decision) {
    parts.push(`decision=${decision.decision}`);
    parts.push(`decidedBy=${decision.decidedBy}`);
    if (decision.materializedTaskIds?.length) {
      parts.push(`materialized=${decision.materializedTaskIds.join(',')}`);
    }
  } else {
    parts.push('decision=pending');
  }
  return parts.join(' | ');
}

function appendProposalSection(lines: string[], label: string, proposals: ProposalFact[], decisions: DecisionFact[], max = 8): void {
  if (proposals.length === 0) {
    return;
  }
  lines.push(`${label}:`);
  for (const proposal of proposals.slice(0, max)) {
    const latestDecision = [...decisions]
      .filter((decision) => decision.proposalId === proposal.id)
      .sort((left, right) => Number(right.decidedAt || 0) - Number(left.decidedAt || 0) || Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
    lines.push(`- ${summarizeProposal(proposal, latestDecision)}`);
  }
  if (proposals.length > max) {
    lines.push(`- ...and ${proposals.length - max} more`);
  }
}

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.requiredCapability === 'user-input'
    || fact.id.startsWith('coordinator:');
}

function hasExecutableDecomposeOutput(output: CoordinatorOutput | null): boolean {
  if (!output) {
    return false;
  }
  if (output.proposals?.length) {
    return true;
  }
  if (output.decisions?.length) {
    return true;
  }
  return false;
}

function hasResolvableDecisionTargets(args: {
  snapshot: BlackboardCoordinatorModeSnapshot;
  output: CoordinatorOutput | null;
}): boolean {
  const decisions = args.output?.decisions || [];
  if (decisions.length === 0) {
    return true;
  }
  const knownProposalIds = new Set<string>([
    ...args.snapshot.proposals.map((proposal) => proposal.id),
    ...(args.output?.proposals || []).map((proposal) => String(proposal.proposalId || '').trim()).filter(Boolean),
  ]);
  return decisions.every((decision) => knownProposalIds.has(String(decision.proposalId || '').trim()));
}

function countStructuredDecomposeTasks(output: CoordinatorOutput | null): number {
  if (!output) {
    return 0;
  }
  const taskIds = new Set<string>();
  for (const proposal of output.proposals || []) {
    const key = String(proposal.taskId || proposal.proposalId || proposal.suggestedAssignee || proposal.requiredCapability || '').trim();
    if (key) {
      taskIds.add(key);
    }
  }
  return taskIds.size;
}

/** Exported for unit tests：从自然语言中推断「声称的 DAG 节点数」，与结构化 proposals 交叉校验。 */
export function inferClaimedDagTaskCount(text: string | null | undefined): number {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return 0;
  }
  const directNumber =
    /三步|3\s*步|3-step|three-step/i.test(normalized) ? 3
    : /两步|2\s*步|2-step|two-step/i.test(normalized) ? 2
    : 0;
  if (directNumber > 0) {
    return directNumber;
  }
  // 中文流水线：开发/实现 → 审查/评审 → 测试/质检（无显式 agent id 时仍可能声称多段 DAG）
  if (/(开发|实现|编码).{0,160}?(审查|评审|code\s*review).{0,160}?(测试|质检|qa\b)/i.test(normalized)) {
    return 3;
  }
  const uniqueMembers = new Set((normalized.match(/\b(?:dev|reviewer|qa|pm)-\d+\b/gi) || []).map((item) => item.toLowerCase()));
  if (uniqueMembers.size >= 2) {
    return uniqueMembers.size;
  }
  const arrowSegments = normalized.split(/->|→|=>/).map((item) => item.trim()).filter(Boolean);
  if (arrowSegments.length >= 2) {
    return arrowSegments.length;
  }
  return 0;
}

function looksLikeFuturePlanText(text: string | null | undefined): boolean {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return [
    '后续',
    '下一步',
    '随后',
    '之后',
    '待',
    '等待',
    '收到结果后',
    '将派发',
    '将收到',
    '计划',
    'future',
    'next step',
    'later',
    'after ',
    'will dispatch',
    'will fan out',
    'once ',
  ].some((cue) => normalized.includes(cue));
}

export function parseBlackboardProtocolGuard(text: string | null | undefined): BlackboardProtocolGuard | null {
  const raw = String(text || '');
  const match = raw.match(/\[\[BLACKBOARD_PROTOCOL_GUARD\]\]([\s\S]*?)\[\[\/BLACKBOARD_PROTOCOL_GUARD\]\]/i);
  if (!match?.[1]) {
    return null;
  }
  const guardBody = match[1].replace(
    /\s+(phase|allowedProposalKinds|requiredProposalKinds|requiredTaskIds|supersedesTaskId|supersedesTaskIds|requiredCapability|requiredCapabilities|requiredGoal|requiredGoals|dependencyMode|evidenceMode|evidenceModes|forbidDecisions)\s*:/gi,
    '\n$1:',
  );
  const fields = new Map<string, string>();
  for (const line of guardBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    fields.set(key, value);
  }
  const csv = (value: string | undefined): string[] =>
    String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const pipeList = (value: string | undefined): string[] =>
    String(value || '')
      .split(/\s*\|\|\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  const evidenceList = (value: string | undefined): Array<'none' | 'source' | 'impossible_source'> =>
    csv(value)
      .map((item) => item.toLowerCase())
      .filter((item): item is 'none' | 'source' | 'impossible_source' => item === 'none' || item === 'source' || item === 'impossible_source');
  return {
    phase: fields.get('phase') || null,
    allowedProposalKinds: csv(fields.get('allowedproposalkinds')),
    requiredProposalKinds: csv(fields.get('requiredproposalkinds')),
    requiredTaskIds: csv(fields.get('requiredtaskids')),
    supersedesTaskIds: csv(fields.get('supersedestaskids') || fields.get('supersedestaskid')),
    requiredCapability: fields.get('requiredcapability') || null,
    requiredCapabilities: csv(fields.get('requiredcapabilities')),
    requiredGoal: fields.get('requiredgoal') || null,
    requiredGoals: pipeList(fields.get('requiredgoals')),
    dependencyMode: /^(ordered|parallel)$/i.test(String(fields.get('dependencymode') || '').trim())
      ? String(fields.get('dependencymode') || '').trim().toLowerCase() as 'ordered' | 'parallel'
      : null,
    evidenceMode: /^(source|impossible_source)$/i.test(String(fields.get('evidencemode') || '').trim())
      ? String(fields.get('evidencemode') || '').trim().toLowerCase() as 'source' | 'impossible_source'
      : null,
    evidenceModes: evidenceList(fields.get('evidencemodes')),
    forbidDecisions: /^(1|true|yes)$/i.test(String(fields.get('forbiddecisions') || '').trim()),
  };
}

export function resolveBlackboardProtocolGuard(snapshot: BlackboardCoordinatorModeSnapshot): BlackboardProtocolGuard | null {
  const factIds = new Set(snapshot.facts.map((fact) => fact.id));
  for (const fact of [...snapshot.facts].sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0))) {
    const guard = parseBlackboardProtocolGuard(`${fact.goal || ''}\n${fact.result || ''}`);
    if (guard) {
      if (guard.requiredTaskIds.length > 0 && guard.requiredTaskIds.every((taskId) => factIds.has(taskId))) {
        continue;
      }
      return guard;
    }
  }
  return null;
}

function validateProtocolGuardOutput(args: {
  guard: BlackboardProtocolGuard | null;
  output: CoordinatorOutput | null;
}): string | null {
  const guard = args.guard;
  if (!guard || !args.output) {
    return null;
  }
  const proposals = args.output.proposals || [];
  const decisions = args.output.decisions || [];
  if (guard.forbidDecisions && decisions.length > 0) {
    return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，本轮禁止输出 decisions。`;
  }
  if (guard.allowedProposalKinds.length > 0) {
    const allowed = new Set(guard.allowedProposalKinds);
    const invalid = proposals.find((proposal) => !allowed.has(proposal.kind));
    if (invalid) {
      return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，本轮只允许 proposal kind=${guard.allowedProposalKinds.join(', ')}，不能输出 ${invalid.kind}。`;
    }
  }
  if (guard.requiredProposalKinds.length > 0 && guard.requiredTaskIds.length > 0) {
    const expectedByTaskId = new Map<string, string>();
    guard.requiredTaskIds.forEach((taskId, index) => {
      const kind = guard.requiredProposalKinds[index] || guard.requiredProposalKinds[guard.requiredProposalKinds.length - 1] || '';
      if (kind) {
        expectedByTaskId.set(taskId, kind);
      }
    });
    const invalid = proposals.find((proposal) => {
      const expected = expectedByTaskId.get(String(proposal.taskId || '').trim());
      return expected && proposal.kind !== expected;
    });
    if (invalid) {
      return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，proposal ${invalid.taskId} kind 必须是 ${expectedByTaskId.get(String(invalid.taskId || '').trim())}。`;
    }
  }
  if (guard.requiredTaskIds.length > 0) {
    const outputTaskIds = new Set(proposals.map((proposal) => String(proposal.taskId || '').trim()).filter(Boolean));
    const missing = guard.requiredTaskIds.filter((taskId) => !outputTaskIds.has(taskId));
    if (missing.length > 0) {
      return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，必须输出 taskId=${missing.join(', ')} 的 proposal。`;
    }
  }
  if (guard.requiredCapability) {
    const invalid = proposals.find((proposal) => proposal.requiredCapability !== guard.requiredCapability);
    if (invalid) {
      return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，proposal requiredCapability 必须是 ${guard.requiredCapability}。`;
    }
  }
  if (guard.requiredCapabilities.length > 0 && guard.requiredTaskIds.length > 0) {
    const expectedByTaskId = new Map<string, string>();
    guard.requiredTaskIds.forEach((taskId, index) => {
      const capability = guard.requiredCapabilities[index] || guard.requiredCapabilities[guard.requiredCapabilities.length - 1] || '';
      if (capability) {
        expectedByTaskId.set(taskId, capability);
      }
    });
    const invalid = proposals.find((proposal) => {
      const expected = expectedByTaskId.get(String(proposal.taskId || '').trim());
      return expected && proposal.requiredCapability !== expected;
    });
    if (invalid) {
      return `当前 request 带有协议流 guard(${guard.phase || 'unknown'})，proposal ${invalid.taskId} requiredCapability 必须是 ${expectedByTaskId.get(String(invalid.taskId || '').trim())}。`;
    }
  }
  return null;
}

export function resolveBlackboardCoordinatorMode(args: {
  board: Pick<BlackboardStore, 'list' | 'listProposals' | 'listDecisions'>;
  teamId: string;
  chatSessionId: string;
  requestId?: string | null;
  requestState?: RequestStateRecord | null;
}): BlackboardCoordinatorModeSnapshot {
  const requestId = String(args.requestId || '').trim() || null;
  const facts = requestId
    ? args.board.list(args.teamId, args.chatSessionId, {
        requestId,
        includeArchive: true,
      })
    : [];
  const proposals = requestId && typeof args.board.listProposals === 'function'
    ? args.board.listProposals(args.teamId, args.chatSessionId, { requestId })
    : [];
  const decisions = requestId && typeof args.board.listDecisions === 'function'
    ? args.board.listDecisions(args.teamId, args.chatSessionId, { requestId })
    : [];
  const pendingFacts = facts.filter((fact) => fact.status === 'pending');
  const runningFacts = facts.filter((fact) => fact.status === 'running');
  const waitingUserFacts = facts.filter((fact) => fact.status === 'waiting_user');
  const recoverableFacts = facts.filter((fact) => fact.status === 'blocked' || fact.status === 'failed');
  const doneFacts = facts.filter((fact) => fact.status === 'done');
  const substantiveFacts = facts.filter((fact) => !isCoordinatorControlFact(fact));
  const archivedDoneFacts = [...doneFacts];
  const requestState = args.requestState || null;
  const finalGate = deriveRequestFinalGate({
    facts: facts.filter((fact) => fact.status !== 'done'),
    proposals,
    decisions,
  });
  const unresolvedProposalCount = proposals.filter((proposal) => {
    const lifecycle = deriveProposalLifecycle(proposal, decisions);
    return lifecycle === 'pending_decision' || lifecycle === 'approved_unmaterialized';
  }).length;
  const hasActiveCoordinatorFollowup = facts.some((fact) =>
    isCoordinatorControlFact(fact)
    && fact.id !== `coordinator:${requestId}`
    && fact.requiredCapability === 'coordination'
    && fact.status !== 'done');

  const readyForFinal = requestState?.state === 'ready_for_final';
  const allSubstantiveTasksDone =
    substantiveFacts.length > 0
    && substantiveFacts.every((fact) => fact.status === 'done')
    && unresolvedProposalCount === 0;
  if (
    !hasActiveCoordinatorFollowup
    && ((readyForFinal && finalGate.canReadyForFinal) || allSubstantiveTasksDone)
    && finalGate.canReadyForFinal
  ) {
    return {
      requestId,
      mode: 'synthesize',
      reason: readyForFinal
        ? 'request state is ready_for_final'
        : 'all substantive blackboard tasks are done',
      facts,
      proposals,
      decisions,
      pendingFacts,
      runningFacts,
      waitingUserFacts,
      recoverableFacts,
      doneFacts,
      archivedDoneFacts,
      requestState,
    };
  }

  if (recoverableFacts.length > 0) {
    return {
      requestId,
      mode: 'recovery',
      reason: 'blackboard contains blocked/failed tasks that need rewrite, reset, or user input',
      facts,
      proposals,
      decisions,
      pendingFacts,
      runningFacts,
      waitingUserFacts,
      recoverableFacts,
      doneFacts,
      archivedDoneFacts,
      requestState,
    };
  }

  return {
    requestId,
    mode: 'decompose',
    reason: facts.length === 0
      ? 'request has no blackboard tasks yet'
      : finalGate.blockingReason
        ? `request is not ready for final: ${finalGate.blockingReason}`
      : unresolvedProposalCount > 0
        ? `request has ${unresolvedProposalCount} unresolved proposal(s) requiring decision or materialization`
        : 'request still needs decomposition or additional pending work planning',
    facts,
    proposals,
    decisions,
    pendingFacts,
    runningFacts,
    waitingUserFacts,
    recoverableFacts,
    doneFacts,
    archivedDoneFacts,
    requestState,
  };
}

/** 黑板 API `runtimeDiagnostics.phaseD` 用：不含完整 `facts`，避免 JSON 过大。 */
export interface CoordinatorModeDiagnosticsSummary {
  requestId: string | null;
  mode: BlackboardCoordinatorMode;
  reason: string;
  requestState: string | null;
  counts: {
    pending: number;
    running: number;
    waiting_user: number;
    recoverable: number;
    done: number;
    factsTotal: number;
  };
  taskIds: {
    pending: string[];
    running: string[];
    waiting_user: string[];
    recoverable: string[];
    done: string[];
  };
}

export function summarizeCoordinatorModeSnapshotForDiagnostics(
  snapshot: BlackboardCoordinatorModeSnapshot,
  options?: { maxIdsPerBucket?: number },
): CoordinatorModeDiagnosticsSummary {
  const max = Math.min(32, Math.max(1, options?.maxIdsPerBucket ?? 16));
  const take = (facts: TaskFact[]) => facts.slice(0, max).map((f) => f.id);
  return {
    requestId: snapshot.requestId,
    mode: snapshot.mode,
    reason: snapshot.reason,
    requestState: snapshot.requestState?.state ?? null,
    counts: {
      pending: snapshot.pendingFacts.length,
      running: snapshot.runningFacts.length,
      waiting_user: snapshot.waitingUserFacts.length,
      recoverable: snapshot.recoverableFacts.length,
      done: snapshot.doneFacts.length,
      factsTotal: snapshot.facts.length,
    },
    taskIds: {
      pending: take(snapshot.pendingFacts),
      running: take(snapshot.runningFacts),
      waiting_user: take(snapshot.waitingUserFacts),
      recoverable: take(snapshot.recoverableFacts),
      done: take(snapshot.doneFacts),
    },
  };
}

export function buildBlackboardCoordinatorFollowup(snapshot: BlackboardCoordinatorModeSnapshot): string {
  const unresolvedProposals = snapshot.proposals.filter((proposal) => {
    const lifecycle = deriveProposalLifecycle(proposal, snapshot.decisions);
    return lifecycle === 'pending_decision' || lifecycle === 'approved_unmaterialized';
  });
  const lines = [
    '[[BLACKBOARD_COORDINATOR_MODE]]',
    `mode: ${snapshot.mode}`,
    `reason: ${snapshot.reason}`,
    `requestState: ${snapshot.requestState?.state || 'unknown'}`,
    `counts: pending=${snapshot.pendingFacts.length} running=${snapshot.runningFacts.length} waiting_user=${snapshot.waitingUserFacts.length} recoverable=${snapshot.recoverableFacts.length} done=${snapshot.doneFacts.length} proposals=${snapshot.proposals.length} unresolvedProposals=${unresolvedProposals.length} decisions=${snapshot.decisions.length}`,
    `pendingTaskIds: ${limitIds(snapshot.pendingFacts)}`,
    `recoverableTaskIds: ${limitIds(snapshot.recoverableFacts)}`,
    `doneTaskIds: ${limitIds(snapshot.doneFacts)}`,
    `unresolvedProposalIds: ${unresolvedProposals.length ? unresolvedProposals.map((proposal) => proposal.id).slice(0, 8).join(', ') : '(none)'}`,
  ];

  if (snapshot.mode === 'decompose') {
    lines.push('rule: focus on goal decomposition and unresolved proposals first. Prefer DECISIONS for existing ProposalFacts before inventing fresh proposals.');
    lines.push('rule: emit concrete PROPOSAL actions only for genuinely new top-level work that is not already represented by a ProposalFact.');
    lines.push('rule: if a required fact is missing from the user, express it as a need_user_input proposal instead of pretending work is complete.');
    lines.push('rule: when a downstream task should use specific tools/machines/services, set endpointHints/toolBindings/networkMode/riskClass on the proposal instead of hiding that routing requirement in prose.');
    lines.push('rule: do not publish final summary while non-done tasks still exist or while no executable plan has been created.');
    lines.push('rule: treat the fact list below as the canonical blackboard; do not read or reconstruct .blackboard/* shadow files.');
  } else if (snapshot.mode === 'recovery') {
    lines.push('rule: focus on blocked/failed tasks and unresolved proposals; decide whether to retry, replace, ask user, amend proposal payloads, or rewrite the local plan.');
    lines.push('rule: if recovery changes the execution endpoint, amend the proposal with endpointHints/toolBindings/networkMode/riskClass so dispatcher can audit the route.');
    lines.push('rule: keep already done tasks stable; do not overwrite completed results.');
    lines.push('rule: do not jump to final summary until recoverable tasks are resolved or intentionally replaced.');
    lines.push('rule: use the fact list below as the only source of truth; do not inspect .blackboard/* files.');
  } else {
    lines.push('rule: focus on final synthesis for the user based on done task results.');
    lines.push('rule: do not emit new proposals or reopen tasks unless the blackboard changes first.');
    lines.push('rule: prefer concise SUMMARY / user reply and archive-ready closure.');
  }

  appendFactSection(lines, 'runningFacts', snapshot.runningFacts);
  appendFactSection(lines, 'pendingFacts', snapshot.pendingFacts);
  appendFactSection(lines, 'waitingUserFacts', snapshot.waitingUserFacts);
  appendFactSection(lines, 'recoverableFacts', snapshot.recoverableFacts);
  appendFactSection(lines, 'doneFacts', snapshot.doneFacts);
  appendProposalSection(lines, 'unresolvedProposals', unresolvedProposals, snapshot.decisions);
  appendProposalSection(lines, 'allProposals', snapshot.proposals, snapshot.decisions, 6);

  lines.push('[[/BLACKBOARD_COORDINATOR_MODE]]');
  return lines.join('\n');
}

function hasActionableRecoveryOutput(output: CoordinatorOutput | null): boolean {
  return Boolean(
    output?.proposals?.length
    || output?.decisions?.length
    || output?.summary?.trim()
    || output?.userReply?.trim(),
  );
}

export function validateBlackboardCoordinatorOutput(args: {
  snapshot: BlackboardCoordinatorModeSnapshot;
  output: CoordinatorOutput | null;
  allowSummaryOnlyDecompose?: boolean;
}): string | null {
  const { snapshot, output } = args;
  const guardBlockedReason = validateProtocolGuardOutput({
    guard: resolveBlackboardProtocolGuard(snapshot),
    output,
  });
  if (guardBlockedReason) {
    return guardBlockedReason;
  }

  if (snapshot.mode === 'synthesize') {
    if (output?.proposals?.length) {
      return '当前 request 已进入 synthesize 模式，禁止继续提出 proposal。';
    }
    if (output?.decisions?.length) {
      return '当前 request 已进入 synthesize 模式，禁止继续处理 proposal 决策。';
    }
  }

  if (snapshot.mode === 'decompose') {
    if (!hasResolvableDecisionTargets({ snapshot, output })) {
      return '当前 decompose 输出里的 decisions 引用了黑板中不存在的 proposalId；请先为当前 request 明确提出 proposals，再对这些 proposal 做决策。';
    }
    if (!hasExecutableDecomposeOutput(output) && !snapshot.requestState?.finalPublished && !args.allowSummaryOnlyDecompose) {
      return '当前 request 仍处于 decompose 模式；需要产出 proposals 或 decisions，不能只输出 summary 后收口。';
    }
    const claimedDagTaskCount = Math.max(
      inferClaimedDagTaskCount(output?.summary),
      inferClaimedDagTaskCount(output?.userReply),
    );
    const structuredTaskCount = countStructuredDecomposeTasks(output);
    const futurePlanOnly =
      looksLikeFuturePlanText(output?.summary)
      || looksLikeFuturePlanText(output?.userReply);
    if (!futurePlanOnly && claimedDagTaskCount >= 2 && structuredTaskCount > 0 && structuredTaskCount < claimedDagTaskCount) {
      return `当前 summary/userReply 声称已有 ${claimedDagTaskCount} 个 DAG 节点，但结构化输出只覆盖 ${structuredTaskCount} 个；请把所有下游任务都写进 proposals。`;
    }
  }

  if (snapshot.mode === 'recovery' && !hasActionableRecoveryOutput(output)) {
    return '当前 request 处于 recovery 模式；需要对 blocked/failed 任务给出恢复动作、用户追问或明确的处置结果。';
  }

  return null;
}
