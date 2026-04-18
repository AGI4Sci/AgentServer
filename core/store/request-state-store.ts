import type { BlackboardStore } from './blackboard-store.js';
import { getBlackboardStore } from './blackboard-store.js';
import type { DecisionFact, ProposalFact, TaskFact } from '../runtime/blackboard-types.js';
import { getTeamChatStore, type TeamChatStore } from './team-chat-store.js';
import { getTeamRegistry } from '../team/registry.js';
import {
  deriveDoneTaskIntegrityGaps,
  type DoneTaskIntegrityGap,
  summarizeDoneTaskIntegrityGaps,
} from '../runtime/done-task-integrity.js';
import { deriveRequestFinalGate } from '../runtime/request-final-gate.js';

export type RequestLifecycleState =
  | 'open'
  | 'planning'
  | 'executing'
  | 'waiting_user'
  | 'ready_for_final'
  | 'closed';

export interface RequestStateRecord {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  state: RequestLifecycleState;
  stateReason: string;
  resumable: boolean;
  focusTaskIds: string[];
  taskCount: number;
  pendingTaskCount: number;
  runningTaskCount: number;
  blockedTaskCount: number;
  waitingUserTaskCount: number;
  doneTaskCount: number;
  archivedTaskCount: number;
  doneEvidenceGapCount: number;
  doneEvidenceGapTaskIds: string[];
  doneEvidenceGaps: DoneTaskIntegrityGap[];
  coordinatorAgentId: string | null;
  finalPublished: boolean;
  updatedAt: string;
}

interface RequestOverlay {
  finalPublished: boolean;
  coordinatorAgentId?: string | null;
  updatedAt: string;
}

const FINAL_REPLY_PREFIX = '根据当前已完成的任务，结论如下：';

export interface RequestTaskSummary {
  taskCount: number;
  terminalTaskCount: number;
  blockedTaskCount: number;
  runningTaskCount: number;
  pendingTaskCount: number;
}

function requestStatePriority(state: RequestLifecycleState): number {
  switch (state) {
    case 'executing':
      return 6;
    case 'waiting_user':
      return 5;
    case 'planning':
      return 4;
    case 'ready_for_final':
      return 3;
    case 'open':
      return 2;
    case 'closed':
    default:
      return 1;
  }
}

function requestUpdatedAtMs(request: Pick<RequestStateRecord, 'updatedAt'>): number {
  const timestamp = Date.parse(String(request.updatedAt || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function compareRequestStateRecords(left: RequestStateRecord, right: RequestStateRecord): number {
  const priorityDelta = requestStatePriority(right.state) - requestStatePriority(left.state);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  const updatedAtDelta = requestUpdatedAtMs(right) - requestUpdatedAtMs(left);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }
  const focusDelta = (right.focusTaskIds?.length || 0) - (left.focusTaskIds?.length || 0);
  if (focusDelta !== 0) {
    return focusDelta;
  }
  return right.requestId.localeCompare(left.requestId);
}

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'user-input'
    || fact.requiredCapability === 'retrieval'
    || fact.id.startsWith('coordinator:');
}

function isTerminalSubstantiveFact(fact: Pick<TaskFact, 'status' | 'blockedBy'>): boolean {
  if (fact.status === 'done' || fact.status === 'failed') {
    return true;
  }
  return fact.status === 'blocked' && fact.blockedBy?.retryable === false;
}

function isTerminalCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability' | 'status' | 'blockedBy'>): boolean {
  return isCoordinatorControlFact(fact) && isTerminalSubstantiveFact(fact);
}

function key(teamId: string, chatSessionId: string, requestId: string): string {
  return `${teamId}:${chatSessionId}:${requestId}`;
}

function summarizeFacts(statuses: string[]): RequestTaskSummary & {
  waitingUserTaskCount: number;
  doneTaskCount: number;
} {
  const pendingTaskCount = statuses.filter((status) => status === 'pending').length;
  const runningTaskCount = statuses.filter((status) => status === 'running').length;
  const blockedTaskCount = statuses.filter((status) => status === 'blocked' || status === 'failed').length;
  const waitingUserTaskCount = statuses.filter((status) => status === 'waiting_user').length;
  const doneTaskCount = statuses.filter((status) => status === 'done').length;
  return {
    taskCount: statuses.length,
    terminalTaskCount: doneTaskCount,
    blockedTaskCount,
    runningTaskCount,
    pendingTaskCount,
    waitingUserTaskCount,
    doneTaskCount,
  };
}

function countSubstantiveDoneFacts(facts: Array<Pick<TaskFact, 'id' | 'requiredCapability' | 'status'>>): number {
  return facts.filter((fact) => fact.status === 'done' && !isCoordinatorControlFact(fact)).length;
}

function inferCoordinatorAgentIdFromFacts(
  teamId: string,
  facts: Array<Pick<TaskFact, 'id' | 'requiredCapability' | 'owner' | 'updatedAt'>>,
): string | null {
  const coordinatorFacts = facts
    .filter((fact) => isCoordinatorControlFact(fact) && String(fact.owner || '').trim())
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  const inferred = String(coordinatorFacts[0]?.owner || '').trim();
  if (inferred) {
    return inferred;
  }
  return getTeamRegistry(teamId)?.getCoordinator?.() || null;
}

function focusTaskIdsForState(state: RequestLifecycleState, facts: TaskFact[]): string[] {
  if (state === 'waiting_user') {
    return facts.filter((fact) => fact.status === 'waiting_user').map((fact) => fact.id).slice(0, 8);
  }
  if (state === 'executing') {
    return facts
      .filter((fact) => fact.status === 'running' || fact.status === 'blocked' || fact.status === 'failed')
      .map((fact) => fact.id)
      .slice(0, 8);
  }
  if (state === 'planning') {
    return facts.filter((fact) => fact.status === 'pending').map((fact) => fact.id).slice(0, 8);
  }
  if (state === 'ready_for_final') {
    return facts
      .filter((fact) => !isCoordinatorControlFact(fact) && isTerminalSubstantiveFact(fact))
      .map((fact) => fact.id)
      .slice(0, 8);
  }
  return [];
}

function buildStateReason(args: {
  state: RequestLifecycleState;
  summary: ReturnType<typeof summarizeFacts>;
  substantiveDoneTaskCount: number;
  substantiveTerminalTaskCount: number;
  coordinatorTerminalTaskCount: number;
  activeNonDoneCount: number;
  invalidDoneGaps?: DoneTaskIntegrityGap[];
  unresolvedProposalCount?: number;
  facts: TaskFact[];
  finalPublished: boolean;
}): string {
  if (args.finalPublished || args.state === 'closed') {
    return args.substantiveDoneTaskCount > 0
      ? 'final answer published after substantive task completion'
      : 'request closed without active blackboard work';
  }
  if (args.state === 'waiting_user') {
    return `waiting for user input on ${args.summary.waitingUserTaskCount} task(s)`;
  }
  if (args.state === 'ready_for_final') {
    if (args.substantiveTerminalTaskCount === 0 && args.coordinatorTerminalTaskCount > 0) {
      return `all coordinator tasks are terminal (${args.coordinatorTerminalTaskCount}), no substantive task was materialized`;
    }
    const terminalFailedOrBlockedCount = Math.max(0, args.substantiveTerminalTaskCount - args.substantiveDoneTaskCount);
    if (terminalFailedOrBlockedCount > 0) {
      return `all substantive tasks are terminal (${args.substantiveDoneTaskCount} done, ${terminalFailedOrBlockedCount} failed/non-retryable blocked)`;
    }
    return `all substantive tasks are done (${args.substantiveDoneTaskCount})`;
  }
  if ((args.invalidDoneGaps || []).length > 0) {
    return summarizeDoneTaskIntegrityGaps(args.invalidDoneGaps || []);
  }
  if (args.state === 'executing') {
    if ((args.unresolvedProposalCount || 0) > 0) {
      return `request has ${args.unresolvedProposalCount} unresolved proposal(s) awaiting decision or materialization`;
    }
    return `request has ${args.summary.runningTaskCount} running and ${args.summary.blockedTaskCount} blocked/failed task(s)`;
  }
  if (args.state === 'planning') {
    return `request still has ${args.summary.pendingTaskCount} pending task(s) or no substantive result yet`;
  }
  if (args.activeNonDoneCount === 0 && args.facts.length === 0) {
    return 'request opened with no blackboard facts yet';
  }
  return 'request is open and waiting for first planning step';
}

export function summarizeRequestTasks(
  specs: Array<{ taskId: string }>,
  states: Array<{ taskId: string; status: string }>,
  _dispatchedAgents: string[] = [],
): RequestTaskSummary {
  const stateByTaskId = new Map(states.map((state) => [state.taskId, state.status]));
  const statuses = specs.map((spec) => stateByTaskId.get(spec.taskId) || 'pending');
  const summary = summarizeFacts(statuses);
  return {
    taskCount: summary.taskCount,
    terminalTaskCount: summary.terminalTaskCount,
    blockedTaskCount: summary.blockedTaskCount,
    runningTaskCount: summary.runningTaskCount,
    pendingTaskCount: summary.pendingTaskCount,
  };
}

export function canRequestPublishFinal(requestState: RequestStateRecord | null | undefined): boolean {
  if (!requestState || requestState.finalPublished) {
    return false;
  }
  return requestState.state === 'ready_for_final';
}

export class RequestStateStore {
  private readonly overlays = new Map<string, RequestOverlay>();

  constructor(
    private readonly board: Pick<BlackboardStore, 'list' | 'listProposals' | 'listDecisions'> = getBlackboardStore(),
    private readonly teamChatStore: Pick<TeamChatStore, 'getHistory'> = getTeamChatStore(),
  ) {}

  private countUnresolvedProposals(
    teamId: string,
    chatSessionId: string,
    requestId: string,
    _activeFacts: TaskFact[],
  ): number {
    if (typeof this.board.listProposals !== 'function' || typeof this.board.listDecisions !== 'function') {
      return 0;
    }
    const proposals = this.board.listProposals(teamId, chatSessionId, { requestId });
    const decisions = this.board.listDecisions(teamId, chatSessionId, { requestId });
    return proposals.filter((proposal) => {
      const latestDecision = decisions
        .filter((decision) => decision.proposalId === proposal.id)
        .sort((left, right) => Number(right.decidedAt || 0) - Number(left.decidedAt || 0) || Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0];
      if (!latestDecision) {
        return true;
      }
      if (latestDecision.decision === 'reject') {
        return false;
      }
      const materializedTaskIds = latestDecision.materializedTaskIds || [];
      if (materializedTaskIds.length === 0) {
        return true;
      }
      return false;
    }).length;
  }

  private derivePersistedFinalPublication(
    teamId: string,
    chatSessionId: string,
    requestId: string,
    latestFactUpdatedAt: number,
    coordinatorAgentId: string | null,
  ): { finalPublished: boolean; updatedAt: string | null } {
    const history = this.teamChatStore.getHistory(teamId, chatSessionId);
    const normalizedCoordinatorId = String(coordinatorAgentId || '').trim();
    const finalMessage = [...history.messages]
      .filter((message) =>
        message.requestId === requestId
        && (
          String(message.agent || '').trim() === 'coordinator'
          || (normalizedCoordinatorId && String(message.agent || '').trim() === normalizedCoordinatorId)
        )
        && (
          String(message.text || '').startsWith(FINAL_REPLY_PREFIX)
          || String(message.text || '').includes('验收收口')
        ),
      )
      .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))[0] || null;
    if (!finalMessage) {
      return {
        finalPublished: false,
        updatedAt: null,
      };
    }
    const finalMessageAt = Date.parse(String(finalMessage.timestamp || '')) || 0;
    if (latestFactUpdatedAt > 0 && finalMessageAt < latestFactUpdatedAt) {
      return {
        finalPublished: false,
        updatedAt: null,
      };
    }
    return {
      finalPublished: true,
      updatedAt: finalMessage.timestamp || null,
    };
  }

  private derive(teamId: string, chatSessionId: string, requestId: string): RequestStateRecord | null {
    const allFacts = this.board.list(teamId, chatSessionId, { requestId, includeArchive: true });
    const activeFacts = this.board.list(teamId, chatSessionId, { requestId });
    const overlay = this.overlays.get(key(teamId, chatSessionId, requestId)) || null;

    if (allFacts.length === 0 && !overlay) {
      return null;
    }

    const summary = summarizeFacts(allFacts.map((fact) => fact.status));
    const activeNonDoneCount = activeFacts.filter((fact) =>
      !isCoordinatorControlFact(fact) && !isTerminalSubstantiveFact(fact),
    ).length;
    const invalidDoneGaps = deriveDoneTaskIntegrityGaps({
      teamChatStore: this.teamChatStore,
      teamId,
      chatSessionId,
      tasks: allFacts,
    });
    const invalidDoneTaskIds = new Set(invalidDoneGaps.map((gap) => gap.taskId));
    const substantiveDoneTaskCount = allFacts.filter((fact) =>
      fact.status === 'done'
      && !isCoordinatorControlFact(fact)
      && !invalidDoneTaskIds.has(fact.id),
    ).length;
    const substantiveTerminalTaskCount = allFacts.filter((fact) =>
      !isCoordinatorControlFact(fact) && isTerminalSubstantiveFact(fact),
    ).length;
    const coordinatorTerminalTaskCount = allFacts.filter((fact) =>
      isTerminalCoordinatorControlFact(fact),
    ).length;
    const coordinatorOnlyTerminalRequest =
      allFacts.length > 0
      && allFacts.every((fact) => isCoordinatorControlFact(fact))
      && allFacts.every((fact) => isTerminalCoordinatorControlFact(fact));
    const finalGate = deriveRequestFinalGate({
      facts: activeFacts,
      proposals: typeof this.board.listProposals === 'function'
        ? this.board.listProposals(teamId, chatSessionId, { requestId })
        : [],
      decisions: typeof this.board.listDecisions === 'function'
        ? this.board.listDecisions(teamId, chatSessionId, { requestId })
        : [],
    });
    const unresolvedProposalCount = this.countUnresolvedProposals(teamId, chatSessionId, requestId, activeFacts);
    const latestFactUpdatedAt = allFacts.reduce((max, fact) => Math.max(max, Number(fact.updatedAt || 0)), 0);
    const coordinatorAgentId =
      overlay?.coordinatorAgentId
      || inferCoordinatorAgentIdFromFacts(teamId, allFacts)
      || null;
    const persistedFinal = this.derivePersistedFinalPublication(
      teamId,
      chatSessionId,
      requestId,
      latestFactUpdatedAt,
      coordinatorAgentId,
    );
    const finalPublished = overlay?.finalPublished === true || persistedFinal.finalPublished;
    const overlayUpdatedAt = overlay?.updatedAt ? (Date.parse(overlay.updatedAt) || 0) : 0;
    const persistedFinalUpdatedAt = persistedFinal.updatedAt ? (Date.parse(persistedFinal.updatedAt) || 0) : 0;
    const effectiveUpdatedAt = Math.max(latestFactUpdatedAt, overlayUpdatedAt);
    let state: RequestLifecycleState = 'open';
    if (finalPublished) {
      state = 'closed';
    } else if (finalGate.waitingUserTaskIds.length > 0 || summary.waitingUserTaskCount > 0) {
      state = 'waiting_user';
    } else if (
      finalGate.canReadyForFinal
      && unresolvedProposalCount === 0
      && invalidDoneTaskIds.size === 0
      && (
        activeNonDoneCount === 0 && substantiveTerminalTaskCount > 0
      )
    ) {
      state = 'ready_for_final';
    } else if (summary.runningTaskCount > 0 || activeNonDoneCount > 0 || unresolvedProposalCount > 0) {
      state = 'executing';
    } else if (summary.pendingTaskCount > 0 || (summary.taskCount > 0 && substantiveDoneTaskCount === 0)) {
      state = 'planning';
    }
    const stateReason = buildStateReason({
      state,
      summary,
      substantiveDoneTaskCount,
      substantiveTerminalTaskCount,
      coordinatorTerminalTaskCount,
      activeNonDoneCount,
      invalidDoneGaps,
      unresolvedProposalCount,
      facts: allFacts,
      finalPublished,
    }) || finalGate.blockingReason || '';
    const focusTaskIds = focusTaskIdsForState(state, allFacts);

    return {
      teamId,
      chatSessionId,
      requestId,
      state,
      stateReason,
      resumable: state !== 'closed',
      focusTaskIds,
      taskCount: summary.taskCount,
      pendingTaskCount: summary.pendingTaskCount,
      runningTaskCount: summary.runningTaskCount,
      blockedTaskCount: summary.blockedTaskCount,
      waitingUserTaskCount: summary.waitingUserTaskCount,
      doneTaskCount: summary.doneTaskCount,
      archivedTaskCount: Math.max(0, allFacts.length - activeFacts.length),
      doneEvidenceGapCount: invalidDoneGaps.length,
      doneEvidenceGapTaskIds: invalidDoneGaps.map((gap) => gap.taskId),
      doneEvidenceGaps: invalidDoneGaps,
      coordinatorAgentId,
      finalPublished,
      updatedAt: new Date(Math.max(effectiveUpdatedAt, persistedFinalUpdatedAt) || Date.now()).toISOString(),
    };
  }

  markOpenForSession(
    teamId: string,
    requestId: string,
    chatSessionId: string,
    options?: { coordinatorAgentId?: string | null },
  ): RequestStateRecord {
    const previous = this.overlays.get(key(teamId, chatSessionId, requestId));
    this.overlays.set(key(teamId, chatSessionId, requestId), {
      finalPublished: false,
      coordinatorAgentId: options?.coordinatorAgentId ?? previous?.coordinatorAgentId ?? null,
      updatedAt: new Date().toISOString(),
    });
    return this.derive(teamId, chatSessionId, requestId)!;
  }

  markFinalPublishedForSession(teamId: string, requestId: string, chatSessionId: string): RequestStateRecord {
    const previous = this.overlays.get(key(teamId, chatSessionId, requestId));
    this.overlays.set(key(teamId, chatSessionId, requestId), {
      finalPublished: true,
      coordinatorAgentId: previous?.coordinatorAgentId ?? null,
      updatedAt: new Date().toISOString(),
    });
    return this.derive(teamId, chatSessionId, requestId)!;
  }

  setCoordinatorForSession(
    teamId: string,
    requestId: string,
    chatSessionId: string,
    coordinatorAgentId: string | null | undefined,
  ): RequestStateRecord | null {
    const normalizedCoordinatorId = String(coordinatorAgentId || '').trim() || null;
    const previous = this.overlays.get(key(teamId, chatSessionId, requestId));
    if (!previous && !this.derive(teamId, chatSessionId, requestId)) {
      return null;
    }
    this.overlays.set(key(teamId, chatSessionId, requestId), {
      finalPublished: previous?.finalPublished === true,
      coordinatorAgentId: normalizedCoordinatorId,
      updatedAt: new Date().toISOString(),
    });
    return this.derive(teamId, chatSessionId, requestId);
  }

  resolveCoordinatorForSession(
    teamId: string,
    requestId: string,
    chatSessionId: string,
    fallbackCoordinatorId?: string | null,
  ): string | null {
    return this.derive(teamId, chatSessionId, requestId)?.coordinatorAgentId
      || String(fallbackCoordinatorId || '').trim()
      || getTeamRegistry(teamId)?.getCoordinator?.()
      || null;
  }

  syncTaskSnapshotForSession(teamId: string, requestId: string, chatSessionId: string): RequestStateRecord | null {
    return this.derive(teamId, chatSessionId, requestId);
  }

  getRequestForSession(teamId: string, requestId: string, chatSessionId: string): RequestStateRecord | null {
    return this.derive(teamId, chatSessionId, requestId);
  }

  getRequest(teamId: string, requestId: string): RequestStateRecord | null {
    for (const overlayKey of Array.from(this.overlays.keys())) {
      const [overlayTeamId, chatSessionId, overlayRequestId] = overlayKey.split(':');
      if (overlayTeamId === teamId && overlayRequestId === requestId) {
        return this.derive(teamId, chatSessionId, requestId);
      }
    }
    return null;
  }

  clearRequestForSession(teamId: string, requestId: string, chatSessionId: string): void {
    this.overlays.delete(key(teamId, chatSessionId, requestId));
  }

  listRequests(teamId: string, chatSessionId: string): RequestStateRecord[] {
    const requestIds = new Set<string>();
    for (const fact of this.board.list(teamId, chatSessionId, { includeArchive: true })) {
      requestIds.add(fact.requestId);
    }
    for (const overlayKey of Array.from(this.overlays.keys())) {
      const [overlayTeamId, overlaySessionId, requestId] = overlayKey.split(':');
      if (overlayTeamId === teamId && overlaySessionId === chatSessionId) {
        requestIds.add(requestId);
      }
    }
    return Array.from(requestIds)
      .map((requestId) => this.derive(teamId, chatSessionId, requestId))
      .filter((item): item is RequestStateRecord => Boolean(item))
      .sort(compareRequestStateRecords);
  }

  clear(teamId: string, chatSessionId?: string | null): void {
    for (const overlayKey of Array.from(this.overlays.keys())) {
      const [overlayTeamId, overlaySessionId] = overlayKey.split(':');
      if (overlayTeamId !== teamId) {
        continue;
      }
      if (chatSessionId && overlaySessionId !== chatSessionId) {
        continue;
      }
      this.overlays.delete(overlayKey);
    }
  }
}

let store: RequestStateStore | null = null;

export function getRequestStateStore(): RequestStateStore {
  if (!store) {
    store = new RequestStateStore();
  }
  return store;
}

export function setRequestStateStoreForTests(nextStore: RequestStateStore | null): void {
  store = nextStore;
}
