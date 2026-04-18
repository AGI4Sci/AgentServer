import type { BlackboardStore } from '../store/blackboard-store.js';
import { canRequestPublishFinal, type RequestStateRecord } from '../store/request-state-store.js';
import type { TaskFact } from './blackboard-types.js';
import { getTeamChatStore } from '../store/team-chat-store.js';
import { deriveDoneTaskIntegrityGaps, summarizeDoneTaskIntegrityGaps } from './done-task-integrity.js';
import {
  evaluateStandardRequestCompletionPolicy,
  isCoordinatorControlFact,
  isTerminalCoordinatorControlFact,
  isTerminalSubstantiveFact,
  type RequestCompletionPolicy,
} from './request-completion-policy.js';

export interface BlackboardFinalReadiness {
  canPublish: boolean;
  reason: string;
  doneCount: number;
  activeNonDoneCount: number;
  invalidDoneTaskIds: string[];
  completionPolicy?: RequestCompletionPolicy;
}

export interface BlackboardFinalizeResult {
  closed: boolean;
  reason: string;
  archivedTaskIds: string[];
  readiness: BlackboardFinalReadiness;
}

export interface BlackboardSynthesisDisposition {
  shouldPublishFinalAnswer: boolean;
  shouldQueueSummaryFollowup: boolean;
  reason: string;
  readiness: BlackboardFinalReadiness;
}

function compactResult(result: string | undefined, maxLength = 120): string {
  const normalized = String(result || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no result)';
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function compactFailureReason(fact: TaskFact, maxLength = 120): string {
  const reason = fact.blockedBy?.message || fact.failureHistory.at(-1)?.blockedBy.message || '';
  const normalized = String(reason || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(no failure reason)';
  }
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

export function evaluateBlackboardFinalReadiness(args: {
  board: Pick<BlackboardStore, 'list'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  requestState?: RequestStateRecord | null;
}): BlackboardFinalReadiness {
  const facts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
  });
  const substantiveFacts = facts.filter((fact) => !isCoordinatorControlFact(fact));
  const coordinatorFacts = facts.filter((fact) => isCoordinatorControlFact(fact));
  const doneFacts = substantiveFacts.filter((fact) => fact.status === 'done');
  const invalidDoneGaps = deriveDoneTaskIntegrityGaps({
    teamChatStore: getTeamChatStore(),
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    tasks: doneFacts,
  });
  const invalidDoneTaskIds = invalidDoneGaps.map((gap) => gap.taskId);
  const validDoneFacts = doneFacts.filter((fact) => !invalidDoneTaskIds.includes(fact.id));
  const doneCount = validDoneFacts.length;
  const activeNonDoneCount = substantiveFacts.filter((fact) => !isTerminalSubstantiveFact(fact)).length;
  const terminalCount = substantiveFacts.filter((fact) => isTerminalSubstantiveFact(fact)).length;
  const coordinatorTerminalCount = coordinatorFacts.filter((fact) => isTerminalCoordinatorControlFact(fact)).length;
  const coordinatorOnlyTerminalRequest =
    facts.length > 0
    && substantiveFacts.length === 0
    && coordinatorFacts.length > 0
    && coordinatorTerminalCount === coordinatorFacts.length;
  const withCompletionPolicy = (readiness: Omit<BlackboardFinalReadiness, 'completionPolicy'>): BlackboardFinalReadiness => ({
    ...readiness,
    completionPolicy: evaluateStandardRequestCompletionPolicy({
      facts,
      readiness,
      requestState: args.requestState,
    }),
  });

  if (args.requestState?.finalPublished) {
    return withCompletionPolicy({
      canPublish: false,
      reason: 'request already published final answer',
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (args.requestState && !canRequestPublishFinal(args.requestState)) {
    const stateLabel = String(args.requestState.state || '').trim() || 'unknown';
    const stateReason = String(args.requestState.stateReason || '').trim();
    return withCompletionPolicy({
      canPublish: false,
      reason: stateReason
        ? `request state ${stateLabel} is not publishable yet: ${stateReason}`
        : `request state ${stateLabel} is not publishable yet`,
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (facts.length === 0) {
    return withCompletionPolicy({
      canPublish: Boolean((args.requestState?.taskCount || 0) === 0),
      reason: (args.requestState?.taskCount || 0) === 0
        ? 'request has no tasks'
        : 'request has no blackboard facts yet',
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (substantiveFacts.length === 0) {
    return withCompletionPolicy({
      canPublish: false,
      reason: coordinatorOnlyTerminalRequest
        ? 'request has only terminal coordinator facts and no substantive task results yet'
        : 'request has no substantive task results yet',
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (invalidDoneTaskIds.length > 0) {
    return withCompletionPolicy({
      canPublish: false,
      reason: summarizeDoneTaskIntegrityGaps(invalidDoneGaps),
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (activeNonDoneCount === 0 && terminalCount > 0) {
    return withCompletionPolicy({
      canPublish: true,
      reason: 'all request facts are terminal',
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  if (args.requestState?.state === 'ready_for_final' && doneCount > 0) {
    return withCompletionPolicy({
      canPublish: true,
      reason: 'request state is ready_for_final',
      doneCount,
      activeNonDoneCount,
      invalidDoneTaskIds,
    });
  }

  return withCompletionPolicy({
    canPublish: false,
    reason: activeNonDoneCount > 0
      ? 'request still has non-done blackboard facts'
      : 'request has no done facts to synthesize',
    doneCount,
    activeNonDoneCount,
    invalidDoneTaskIds,
  });
}

export function archiveDoneFactsForRequest(args: {
  board: Pick<BlackboardStore, 'list' | 'archive'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): TaskFact[] {
  const doneFacts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    status: 'done',
  });
  if (doneFacts.length === 0) {
    return [];
  }
  return args.board.archive(
    args.teamId,
    args.chatSessionId,
    doneFacts.map((fact) => fact.id),
  );
}

export function buildBlackboardSynthesisDigest(args: {
  board: Pick<BlackboardStore, 'list'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string {
  const doneFacts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
    status: 'done',
  });
  const failedFacts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
    status: 'failed',
  });
  if (doneFacts.length === 0 && failedFacts.length === 0) {
    return '';
  }

  const lines = [
    '[[BLACKBOARD_SYNTHESIS]]',
    `doneCount: ${doneFacts.length}`,
    `failedCount: ${failedFacts.length}`,
  ];
  for (const fact of doneFacts.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`- taskId: ${fact.id}`);
    lines.push(`  goal: ${fact.goal}`);
    lines.push(`  result: ${compactResult(fact.result)}`);
  }
  for (const fact of failedFacts.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`- failedTaskId: ${fact.id}`);
    lines.push(`  goal: ${fact.goal}`);
    lines.push(`  reason: ${compactFailureReason(fact)}`);
  }
  lines.push('rule: synthesize the final user-facing answer from these done task results first, then use chat context only as supporting detail.');
  lines.push('[[/BLACKBOARD_SYNTHESIS]]');
  return lines.join('\n');
}

export function buildBlackboardFinalReply(args: {
  board: Pick<BlackboardStore, 'list'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string {
  const doneFacts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
    status: 'done',
  });
  const failedFacts = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
    status: 'failed',
  });
  if (doneFacts.length === 0 && failedFacts.length === 0) {
    return '';
  }

  const lines = ['根据当前已完成的任务，结论如下：'];
  for (const fact of doneFacts.sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`- ${fact.goal}: ${compactResult(fact.result, 180)}`);
  }
  if (failedFacts.length > 0) {
    lines.push('以下任务未成功完成：');
    for (const fact of failedFacts.sort((left, right) => left.id.localeCompare(right.id))) {
      lines.push(`- ${fact.goal}: ${compactFailureReason(fact, 180)}`);
    }
  }
  return lines.join('\n');
}

export function finalizeBlackboardSynthesis(args: {
  board: Pick<BlackboardStore, 'list' | 'archive'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  requestState?: RequestStateRecord | null;
  onPublished?: () => void;
}): BlackboardFinalizeResult {
  const readiness = evaluateBlackboardFinalReadiness({
    board: args.board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState: args.requestState,
  });
  if (!readiness.canPublish) {
    return {
      closed: false,
      reason: readiness.reason,
      archivedTaskIds: [],
      readiness,
    };
  }

  const archived = archiveDoneFactsForRequest({
    board: args.board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
  });
  args.onPublished?.();
  return {
    closed: true,
    reason: readiness.reason,
    archivedTaskIds: archived.map((fact) => fact.id),
    readiness,
  };
}

export function decideBlackboardSynthesisDisposition(args: {
  board: Pick<BlackboardStore, 'list'>;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  requestState?: RequestStateRecord | null;
  hasVisibleBody: boolean;
  hasStructuredDispatches: boolean;
}): BlackboardSynthesisDisposition {
  const readiness = evaluateBlackboardFinalReadiness({
    board: args.board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState: args.requestState,
  });
  const shouldPublishFinalAnswer =
    args.hasVisibleBody
    && !args.hasStructuredDispatches
    && readiness.canPublish;
  const shouldQueueSummaryFollowup =
    !shouldPublishFinalAnswer
    && !args.hasStructuredDispatches
    && !args.hasVisibleBody
    && readiness.canPublish
    && canRequestPublishFinal(args.requestState);

  return {
    shouldPublishFinalAnswer,
    shouldQueueSummaryFollowup,
    reason: readiness.reason,
    readiness,
  };
}
