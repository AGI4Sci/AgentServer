import type { TeamRuntimePhase, TeamRuntimeState, TeamMemberRuntime, TeamApprovalRecord } from '../runtime/types.js';
import { parseApprovalRequestGoal, parseApprovalResponseResult } from '../runtime/waiting-user.js';
import { getBlackboardStore } from './blackboard-store.js';
import { getRequestStateStore } from './request-state-store.js';
import { compareRequestStateRecords } from './request-state-store.js';
import { getTeamChatStore } from './team-chat-store.js';
import { getTeamRegistry } from '../team/registry.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function derivePhase(state: ReturnType<ReturnType<typeof getRequestStateStore>['getRequestForSession']>): TeamRuntimePhase {
  if (!state) {
    return 'intaking';
  }
  if (state.state === 'planning' || state.state === 'open') {
    return 'planning';
  }
  if (state.state === 'executing') {
    return 'executing';
  }
  if (state.state === 'waiting_user') {
    return 'paused';
  }
  if (state.state === 'ready_for_final') {
    return 'summarizing';
  }
  return 'paused';
}

function uniqueCapabilityTags(member: {
  roleName?: string;
  roleType?: string;
  skills?: string[];
}): string[] {
  return [...new Set([
    member.roleName || '',
    member.roleType || '',
    ...(Array.isArray(member.skills) ? member.skills : []),
  ].filter(Boolean))];
}

function pickLatestTask(tasks: ReturnType<ReturnType<typeof getBlackboardStore>['list']>): (typeof tasks)[number] | null {
  return [...tasks].sort((a, b) =>
    b.updatedAt - a.updatedAt
    || Number(Boolean(b.claimedAt)) - Number(Boolean(a.claimedAt))
    || Number(Boolean(b.currentRunId)) - Number(Boolean(a.currentRunId))
    || a.id.localeCompare(b.id)
  )[0] || null;
}

function deriveReplacementCandidateIds(
  memberTasks: ReturnType<ReturnType<typeof getBlackboardStore>['list']>,
  tasks: ReturnType<ReturnType<typeof getBlackboardStore>['list']>,
): string[] {
  if (memberTasks.length === 0) {
    return [];
  }
  const memberTaskIds = new Set(memberTasks.map((task) => task.id));
  return tasks
    .filter((task) => {
      const supersedesTaskId = String(task.supersedesTaskId || '').trim();
      return supersedesTaskId && memberTaskIds.has(supersedesTaskId);
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((task) => task.id);
}

function deriveApprovals(
  facts: ReturnType<ReturnType<typeof getBlackboardStore>['list']>,
): TeamApprovalRecord[] {
  const approvals: TeamApprovalRecord[] = [];
  for (const fact of facts) {
      const approval = parseApprovalRequestGoal(fact.goal);
      if (!approval) {
        continue;
      }
      const response = parseApprovalResponseResult(fact.result);
      approvals.push({
        approvalId: approval.approvalId,
        kind: approval.kind,
        reason: approval.reason,
        options: approval.options,
        status: fact.status === 'waiting_user'
          ? 'pending'
          : response?.status || (fact.status === 'done' ? 'responded' : 'pending'),
        requestedAt: new Date(fact.updatedAt).toISOString(),
        respondedAt: fact.status === 'done' ? new Date(fact.updatedAt).toISOString() : null,
        decision: response?.decision || null,
        note: response?.note || null,
      });
    }
  return approvals.sort((left, right) => String(right.requestedAt || '').localeCompare(String(left.requestedAt || '')));
}

function deriveMemberRuntime(args: {
  member: {
    id: string;
    roleName?: string;
    roleType?: string;
    skills?: string[];
  };
  coordinatorId: string;
  requestPhase: TeamRuntimePhase;
  tasks: ReturnType<ReturnType<typeof getBlackboardStore>['list']>;
}): TeamMemberRuntime {
  const memberTasks = args.tasks.filter((task) => task.owner === args.member.id);
  const latestTask = pickLatestTask(memberTasks);
  const base: TeamMemberRuntime = {
    agentId: args.member.id,
    role: args.member.roleName || args.member.roleType || 'member',
    capabilityTags: uniqueCapabilityTags(args.member),
    availability: 'idle',
    lifecycle: 'idle',
    assignmentTaskId: null,
    lastHeartbeatAt: null,
    lastResultAt: null,
    failureCount: latestTask?.failureHistory.length || 0,
    replacementCandidateIds: deriveReplacementCandidateIds(memberTasks, args.tasks),
  };

  if (!latestTask) {
    if (args.member.id === args.coordinatorId && (args.requestPhase === 'planning' || args.requestPhase === 'summarizing')) {
      base.availability = 'active';
      base.lifecycle = 'active';
    }
    return base;
  }

  base.assignmentTaskId = latestTask.id;
  base.lastHeartbeatAt = latestTask.lastHeartbeatAt ? new Date(latestTask.lastHeartbeatAt).toISOString() : null;
  base.lastResultAt = latestTask.result || latestTask.status === 'done' || latestTask.status === 'failed'
    ? new Date(latestTask.updatedAt).toISOString()
    : null;

  if (latestTask.status === 'running') {
    base.availability = 'busy';
    base.lifecycle = 'active';
    return base;
  }
  if (latestTask.status === 'blocked' || latestTask.status === 'failed' || latestTask.status === 'waiting_user') {
    base.availability = 'blocked';
    base.lifecycle = 'blocked';
    return base;
  }
  if (latestTask.status === 'pending') {
    base.availability = 'active';
    base.lifecycle = 'active';
    return base;
  }
  return base;
}

function deriveState(teamId: string, chatSessionId: string): TeamRuntimeState {
  const registry = getTeamRegistry(teamId);
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const requestStates = requestStore.listRequests(teamId, chatSessionId)
    .sort(compareRequestStateRecords);
  const primaryRequest = requestStates[0] || null;
  const phase = derivePhase(primaryRequest);
  const coordinatorId = primaryRequest?.coordinatorAgentId || registry?.getCoordinator?.() || '';
  const facts = board.list(teamId, chatSessionId, { includeArchive: true });
  const activeFacts = board.list(teamId, chatSessionId);

  return {
    teamId,
    chatSessionId,
    scenarioId: null,
    coordinator: {
      agentId: coordinatorId,
      laneId: primaryRequest ? `team:${teamId}:request:${primaryRequest.requestId}:coordinator` : `team:${teamId}:coordinator`,
      requestOwner: 'user',
      status: phase === 'paused' ? 'blocked' : phase === 'intaking' ? 'waiting' : 'active',
    },
    members: (registry?.getMembers?.() || []).map((member) => deriveMemberRuntime({
      member,
      coordinatorId,
      requestPhase: phase,
      tasks: facts,
    })),
    approvals: deriveApprovals(facts),
    lifecycleEvents: [],
    workingSetTaskIds: activeFacts
      .filter((fact) => fact.status !== 'done')
      .map((fact) => fact.id),
    phase,
    degradationMode: 'none',
    updatedAt: new Date().toISOString(),
  };
}

export class TeamRuntimeStateStore {
  getStateForSession(teamId: string, chatSessionId: string): TeamRuntimeState | null {
    return clone(deriveState(teamId, chatSessionId));
  }

  getForSession(teamId: string, chatSessionId: string): TeamRuntimeState | null {
    return this.getStateForSession(teamId, chatSessionId);
  }

  listStates(teamId: string): TeamRuntimeState[] {
    return getTeamChatStore()
      .listSessions(teamId)
      .map((session) => this.getStateForSession(teamId, session.sessionId))
      .filter((state): state is TeamRuntimeState => Boolean(state));
  }

  clear(_teamId: string, _chatSessionId?: string | null): void {
    // Runtime state is now derived from blackboard + chat sessions.
  }
}

let store: TeamRuntimeStateStore | null = null;

export function getTeamRuntimeStateStore(): TeamRuntimeStateStore {
  if (!store) {
    store = new TeamRuntimeStateStore();
  }
  return store;
}
