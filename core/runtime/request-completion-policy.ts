import type { RequestStateRecord } from '../store/request-state-store.js';
import type { DecisionFact, ProposalFact, TaskFact } from './blackboard-types.js';
import type { CoordinatorOutput } from './coordinator-context.js';

export type RequestCompletionMode =
  | 'standard_synthesis'
  | 'terminal_failure_closure'
  | 'waiting_user_closure'
  | 'direct_coordinator_answer'
  | 'not_publishable';

export interface RequestCompletionPolicy {
  mode: RequestCompletionMode;
  canPublish: boolean;
  reason: string;
}

export interface StandardRequestCompletionPolicyInput {
  facts: TaskFact[];
  readiness?: {
    canPublish: boolean;
    reason: string;
  } | null;
  requestState?: RequestStateRecord | null;
}

export interface DirectCoordinatorAnswerPolicyInput {
  coordinatorMode: 'decompose' | 'recovery' | 'synthesize';
  facts: TaskFact[];
  proposals?: ProposalFact[];
  decisions?: DecisionFact[];
  output: CoordinatorOutput | null;
  hasCoordinatorRuntimeToolEvidence: boolean;
  requestState?: RequestStateRecord | null;
}

export function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.requiredCapability === 'user-input'
    || fact.id.startsWith('coordinator:');
}

export function isTerminalFactStatus(status: TaskFact['status']): boolean {
  return status === 'done' || status === 'failed';
}

export function isTerminalSubstantiveFact(fact: Pick<TaskFact, 'status' | 'blockedBy'>): boolean {
  if (isTerminalFactStatus(fact.status)) {
    return true;
  }
  return fact.status === 'blocked' && fact.blockedBy?.retryable === false;
}

export function isTerminalCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability' | 'status' | 'blockedBy'>): boolean {
  return isCoordinatorControlFact(fact) && isTerminalSubstantiveFact(fact);
}

export function isSummaryOnlyCoordinatorOutput(output: CoordinatorOutput | null): boolean {
  if (!output) {
    return false;
  }
  return !output.proposals?.length
    && !output.decisions?.length
    && Boolean(output.summary?.trim() || output.userReply?.trim());
}

export function evaluateDirectCoordinatorAnswerPolicy(input: DirectCoordinatorAnswerPolicyInput): RequestCompletionPolicy {
  if (input.requestState?.finalPublished) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'request already published final answer',
    };
  }
  if (input.coordinatorMode !== 'decompose') {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: `direct coordinator answer is only allowed in decompose mode, current mode=${input.coordinatorMode}`,
    };
  }
  if (!isSummaryOnlyCoordinatorOutput(input.output)) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'direct coordinator answer requires summary-only coordinator output',
    };
  }
  if (!input.hasCoordinatorRuntimeToolEvidence) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'direct coordinator answer requires runtime-tool-call evidence from the coordinator',
    };
  }
  const substantiveFacts = input.facts.filter((fact) => !isCoordinatorControlFact(fact));
  if (substantiveFacts.length > 0) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'direct coordinator answer cannot close a request that already has downstream substantive work',
    };
  }
  if ((input.proposals?.length || 0) > 0 || (input.decisions?.length || 0) > 0) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'direct coordinator answer cannot close a request that already has proposal/decision state',
    };
  }
  return {
    mode: 'direct_coordinator_answer',
    canPublish: true,
    reason: 'summary-only coordinator answer is backed by runtime tool evidence and has no downstream DAG state',
  };
}

export function evaluateStandardRequestCompletionPolicy(input: StandardRequestCompletionPolicyInput): RequestCompletionPolicy {
  if (input.requestState?.finalPublished) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'request already published final answer',
    };
  }

  const substantiveFacts = input.facts.filter((fact) => !isCoordinatorControlFact(fact));
  const waitingUserFacts = input.facts.filter((fact) => fact.status === 'waiting_user');
  if (waitingUserFacts.length > 0) {
    return {
      mode: 'waiting_user_closure',
      canPublish: false,
      reason: `request is waiting for user input: ${waitingUserFacts.map((fact) => fact.id).join(', ')}`,
    };
  }

  if (input.readiness?.canPublish !== true) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: input.readiness?.reason || 'request is not ready for final publication',
    };
  }

  if (substantiveFacts.length === 0) {
    return {
      mode: 'not_publishable',
      canPublish: false,
      reason: 'standard synthesis requires substantive task results',
    };
  }

  const allDone = substantiveFacts.every((fact) => fact.status === 'done');
  if (allDone) {
    return {
      mode: 'standard_synthesis',
      canPublish: true,
      reason: input.readiness.reason,
    };
  }

  const allTerminal = substantiveFacts.every((fact) => isTerminalSubstantiveFact(fact));
  if (allTerminal) {
    return {
      mode: 'terminal_failure_closure',
      canPublish: true,
      reason: input.readiness.reason,
    };
  }

  return {
    mode: 'standard_synthesis',
    canPublish: true,
    reason: input.readiness.reason,
  };
}

export function derivePublishedRequestCompletionMode(input: {
  requestState?: Pick<RequestStateRecord, 'state' | 'finalPublished'> | null;
  tasks?: TaskFact[] | null;
}): Extract<RequestCompletionMode, 'standard_synthesis' | 'terminal_failure_closure' | 'direct_coordinator_answer'> | null {
  if (input.requestState?.state !== 'closed' || input.requestState?.finalPublished !== true) {
    return null;
  }
  const substantiveTasks = (input.tasks || []).filter((task) => !isCoordinatorControlFact(task));
  if (substantiveTasks.length === 0) {
    return 'direct_coordinator_answer';
  }
  const allDone = substantiveTasks.every((task) => task.status === 'done');
  return allDone ? 'standard_synthesis' : 'terminal_failure_closure';
}
