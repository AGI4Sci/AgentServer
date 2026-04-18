import { resolveAgentArtifactsRoot } from './agent-artifacts.js';
import type { SubscribeFilter, TaskFact } from './blackboard-types.js';
import { BlackboardStore } from '../store/blackboard-store.js';

export interface BlackboardAgentRegistration {
  teamId: string;
  chatSessionId: string;
  agentId: string;
  requestId?: string;
  capabilities: string[];
  workspaceIds?: string[];
  servedRoots?: string[];
  status?: 'available' | 'busy';
}

export interface BlackboardTickParams extends BlackboardAgentRegistration {
  board: BlackboardStore;
  runIdFactory?: (task: TaskFact) => string;
  now?: () => number;
  heartbeatRunning?: boolean;
}

export type BlackboardTickResult =
  | {
      kind: 'continue';
      task: TaskFact;
    }
  | {
      kind: 'claimed';
      task: TaskFact;
      runId: string;
    }
  | {
      kind: 'idle';
    };

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function normalizeRoot(path: string): string {
  const trimmed = String(path || '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

export function buildAgentSubscribeFilter(input: BlackboardAgentRegistration): SubscribeFilter {
  return {
    teamId: input.teamId,
    chatSessionId: input.chatSessionId,
    capabilities: uniqueStrings(input.capabilities),
    workspaceIds: uniqueStrings(input.workspaceIds),
  };
}

export function registerBlackboardAgent(board: BlackboardStore, input: BlackboardAgentRegistration): SubscribeFilter {
  const capabilities = uniqueStrings(input.capabilities);
  const filter = buildAgentSubscribeFilter({
    ...input,
    capabilities,
  });

  board.upsertCapability(input.teamId, input.chatSessionId, {
    agentId: input.agentId,
    capabilities,
    status: input.status || 'available',
  });
  board.subscribe(input.agentId, filter);
  return filter;
}

export function canAgentServeExecutionScope(task: TaskFact, input: Pick<BlackboardAgentRegistration, 'workspaceIds' | 'servedRoots'>): boolean {
  const workspaceIds = uniqueStrings(input.workspaceIds);
  if (workspaceIds.length > 0 && !workspaceIds.includes(task.executionScope.workspaceId)) {
    return false;
  }

  const servedRoots = uniqueStrings(input.servedRoots).map(normalizeRoot).filter(Boolean);
  if (servedRoots.length === 0) {
    return true;
  }

  const normalizedCwd = normalizeRoot(task.executionScope.cwd);
  if (!servedRoots.some(root => normalizedCwd === root || normalizedCwd.startsWith(`${root}/`))) {
    return false;
  }

  return task.executionScope.allowedRoots.every((allowedRoot) => {
    const normalizedAllowedRoot = normalizeRoot(allowedRoot);
    return servedRoots.some(root => normalizedAllowedRoot === root || normalizedAllowedRoot.startsWith(`${root}/`));
  });
}

function sortRunningTasks(tasks: TaskFact[]): TaskFact[] {
  return [...tasks].sort((a, b) => {
    const claimedAtA = Number(a.claimedAt || a.updatedAt || 0);
    const claimedAtB = Number(b.claimedAt || b.updatedAt || 0);
    return claimedAtA - claimedAtB;
  });
}

function sortPendingTasks(tasks: TaskFact[]): TaskFact[] {
  return [...tasks].sort((a, b) => {
    const updatedDelta = Number(a.updatedAt || 0) - Number(b.updatedAt || 0);
    if (updatedDelta !== 0) {
      return updatedDelta;
    }
    return a.id.localeCompare(b.id);
  });
}

function areDependenciesSatisfied(board: BlackboardStore, teamId: string, chatSessionId: string, task: TaskFact): boolean {
  return task.requires.every((dependencyId) => board.get(teamId, chatSessionId, dependencyId)?.status === 'done');
}

export function tickBlackboardAgent(params: BlackboardTickParams): BlackboardTickResult {
  const {
    board,
    teamId,
    chatSessionId,
    agentId,
    capabilities,
    workspaceIds,
    servedRoots,
    status = 'available',
    runIdFactory = (task) => `${task.id}:run:${Date.now()}`,
    now = () => Date.now(),
  } = params;

  registerBlackboardAgent(board, {
    teamId,
    chatSessionId,
    agentId,
    requestId: params.requestId,
    capabilities,
    workspaceIds,
    servedRoots,
    status,
  });

  const relevant = board.getRelevant(agentId).filter((task) => {
    if (!params.requestId) {
      return true;
    }
    return task.requestId === params.requestId;
  });
  const myRunningTask = sortRunningTasks(
    relevant.filter((task) => task.owner === agentId && task.status === 'running' && task.currentRunId),
  )[0];

  if (myRunningTask?.currentRunId) {
    const shouldHeartbeat = params.heartbeatRunning !== false;
    const continued = shouldHeartbeat
      ? board.heartbeat(teamId, chatSessionId, myRunningTask.id, agentId, myRunningTask.currentRunId)
      : myRunningTask;
    // A busy runtime is already executing this task, so we only refresh the lease.
    // Re-dispatching the same running task would create duplicate runs and trip
    // runtime-level "already has an active run" protection.
    if (status === 'busy') {
      return { kind: 'idle' };
    }
    if (!continued) {
      return { kind: 'idle' };
    }
    return { kind: 'continue', task: continued };
  }

  if (status === 'busy') {
    return { kind: 'idle' };
  }

  const pendingTasks = sortPendingTasks(
    relevant.filter((task) =>
      task.status === 'pending'
      && (
        (task.owner && task.owner === agentId)
        || (!task.owner && capabilities.includes(task.requiredCapability))
      )
      && areDependenciesSatisfied(board, teamId, chatSessionId, task)
      && canAgentServeExecutionScope(task, { workspaceIds, servedRoots }),
    ),
  );

  for (const task of pendingTasks) {
    const runId = runIdFactory(task);
    const claimed = board.write(teamId, chatSessionId, {
      id: task.id,
      revision: task.revision,
      owner: agentId,
      status: 'running',
      currentRunId: runId,
      attempt: task.attempt + 1,
        executionScope: {
          ...task.executionScope,
          artifactsRoot: resolveAgentArtifactsRoot(agentId, runId, { teamId }),
        },
      leaseUntil: now() + 5 * 60_000,
      claimedAt: now(),
      lastHeartbeatAt: now(),
    });
    if (claimed) {
      return {
        kind: 'claimed',
        task: claimed,
        runId,
      };
    }
  }

  return { kind: 'idle' };
}
