import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { resolveAgentArtifactsRoot } from '../../core/runtime/agent-artifacts.js';

type CoordinatorPhase = 'decompose' | 'recovery' | 'synthesize';

export function coordinatorControlTaskId(requestId: string): string {
  return `coordinator:${requestId}`;
}

function isCoordinatorControlTaskId(requestId: string, taskId: string): boolean {
  const canonicalId = coordinatorControlTaskId(requestId);
  return taskId === canonicalId || taskId.startsWith(`${canonicalId}:`);
}

function collapseLegacyCoordinatorControlTasks(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string[] {
  const board = getBlackboardStore();
  const canonicalId = coordinatorControlTaskId(args.requestId);
  const legacyIds = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
  }).filter((fact) =>
    fact.requiredCapability === 'coordination'
    && fact.id !== canonicalId
    && isCoordinatorControlTaskId(args.requestId, fact.id),
  ).map((fact) => fact.id);
  if (legacyIds.length === 0) {
    return [];
  }
  board.remove(args.teamId, args.chatSessionId, legacyIds);
  return legacyIds;
}

function deriveCoordinatorGoal(args: {
  requestId: string;
  phase: CoordinatorPhase;
  requestGoal?: string | null;
  recoverableIds?: string[];
}): string {
  const baseGoal = String(args.requestGoal || '').trim() || `处理请求 ${args.requestId}`;
  if (args.phase === 'recovery') {
    const recoverableIds = (args.recoverableIds || []).filter(Boolean).slice(0, 4).join(', ');
    return `恢复 request ${args.requestId} 中的 blocked/failed 任务，并决定重试、replacement、need_user_input 或计划修正。当前 recoverable: ${recoverableIds || '(none)'}`;
  }
  if (args.phase === 'synthesize') {
    return `完成请求 ${args.requestId} 的最终综合总结并发布 final answer。原始请求：${baseGoal}`;
  }
  return baseGoal;
}

export function queueCoordinatorControlTask(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
  phase: CoordinatorPhase;
  requestGoal?: string | null;
  workspaceId?: string | null;
  cwd?: string | null;
  allowedRoots?: string[] | null;
  artifactsRoot?: string | null;
  recoverableIds?: string[];
  skipIfTerminalNonRetryable?: boolean;
}): string[] {
  const board = getBlackboardStore();
  const changedTaskIds = new Set<string>();
  const canonicalId = coordinatorControlTaskId(args.requestId);

  for (const removedId of collapseLegacyCoordinatorControlTasks(args)) {
    changedTaskIds.add(removedId);
  }

  const latestCoordinatorFact = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
  }).filter((fact) => fact.requiredCapability === 'coordination')
    .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0) || right.id.localeCompare(left.id))[0] || null;

  const activeCanonical = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  }).find((fact) => fact.id === canonicalId) || null;
  if (activeCanonical && (activeCanonical.status === 'pending' || activeCanonical.status === 'running')) {
    return Array.from(changedTaskIds);
  }

  const archivedOrTerminalCanonical = board.get(args.teamId, args.chatSessionId, canonicalId);
  if (
    args.skipIfTerminalNonRetryable
    && archivedOrTerminalCanonical
    && (archivedOrTerminalCanonical.status === 'failed' || archivedOrTerminalCanonical.status === 'blocked')
    && archivedOrTerminalCanonical.blockedBy?.retryable === false
  ) {
    return Array.from(changedTaskIds);
  }

  const goal = deriveCoordinatorGoal({
    requestId: args.requestId,
    phase: args.phase,
    requestGoal: args.requestGoal || latestCoordinatorFact?.goal || null,
    recoverableIds: args.recoverableIds,
  });
  const executionScope = latestCoordinatorFact?.executionScope || {
    workspaceId: String(args.workspaceId || args.chatSessionId).trim(),
    cwd: String(args.cwd || process.cwd()).trim(),
    allowedRoots: (args.allowedRoots && args.allowedRoots.length > 0 ? args.allowedRoots : [String(args.cwd || process.cwd()).trim()])
      .map((item) => String(item || '').trim())
      .filter(Boolean),
    artifactsRoot: String(
      args.artifactsRoot
      || resolveAgentArtifactsRoot(args.coordinatorId, canonicalId, {
        teamId: args.teamId,
      }),
    ).trim(),
  };

  if (activeCanonical && activeCanonical.status !== 'done') {
    const reset = activeCanonical.status === 'pending'
      ? activeCanonical
      : board.reset(args.teamId, args.chatSessionId, canonicalId, 'manual_requeue');
    const target = reset || activeCanonical;
    const updated = board.write(args.teamId, args.chatSessionId, {
      id: canonicalId,
      revision: target.revision,
      goal,
      requires: [],
      requiredCapability: 'coordination',
      executionScope,
      status: 'pending',
      owner: args.coordinatorId,
      currentRunId: null,
      blockedBy: undefined,
      result: undefined,
      resultRef: undefined,
      failureHistory: target.failureHistory,
    });
    if (updated) {
      changedTaskIds.add(updated.id);
    }
    return Array.from(changedTaskIds);
  }

  if (archivedOrTerminalCanonical) {
    board.remove(args.teamId, args.chatSessionId, [canonicalId]);
    changedTaskIds.add(canonicalId);
  }

  const created = board.write(args.teamId, args.chatSessionId, {
    id: canonicalId,
    revision: 0,
    requestId: args.requestId,
    goal,
    requires: [],
    requiredCapability: 'coordination',
    executionScope,
    status: 'pending',
    owner: args.coordinatorId,
    currentRunId: null,
    attempt: 0,
    failureHistory: [],
    createdBy: args.coordinatorId,
  });
  if (created) {
    changedTaskIds.add(created.id);
  }
  return Array.from(changedTaskIds);
}

export function settleActiveCoordinatorControlTasks(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string[] {
  const board = getBlackboardStore();
  const canonicalId = coordinatorControlTaskId(args.requestId);
  const activeCoordinatorFacts = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  }).filter((fact) =>
    fact.requiredCapability === 'coordination'
    && fact.id === canonicalId,
  );
  const changedTaskIds: string[] = [];
  for (const fact of activeCoordinatorFacts) {
    if (fact.status === 'done') {
      changedTaskIds.push(fact.id);
      continue;
    }
    if (fact.status === 'failed' || fact.status === 'blocked') {
      changedTaskIds.push(fact.id);
      continue;
    }
    if (fact.status === 'waiting_user') {
      continue;
    }
    const settled = board.write(args.teamId, args.chatSessionId, {
      id: fact.id,
      revision: fact.revision,
      status: 'done',
      result: 'request finalized; coordinator control task was settled during final publish cleanup',
      blockedBy: undefined,
    });
    if (settled?.id) {
      changedTaskIds.push(settled.id);
    }
  }
  if (changedTaskIds.length > 0) {
    board.archive(args.teamId, args.chatSessionId, changedTaskIds);
  }
  collapseLegacyCoordinatorControlTasks(args);
  return changedTaskIds;
}

export function ensureCoordinatorSynthesisTask(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
}): string[] {
  return queueCoordinatorControlTask({
    ...args,
    phase: 'synthesize',
    skipIfTerminalNonRetryable: true,
  });
}
