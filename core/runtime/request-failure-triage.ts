import type { TaskFact } from './blackboard-types.js';

export type BlackboardFailureCategory =
  | 'transport_split'
  | 'dependency_handoff_gap'
  | 'coordinator_only_stall'
  | 'runtime_deadlock';

export interface BlackboardFailureTransport {
  source?: string | null;
  layer?: string | null;
  health?: string | null;
  status?: string | null;
  ws?: string | null;
}

export interface DependencyHandoffHintLike {
  taskId: string;
  requestId: string;
  dependencyTaskId: string;
  dependencyStatus?: string | null;
  blocking?: boolean;
  issue: string;
}

export interface BlackboardFailureTriage {
  failureCategory: BlackboardFailureCategory | null;
  failureSummary: string | null;
  failureTaskIds: string[];
  failureTransport: BlackboardFailureTransport | null;
}

function isCoordinatorControlTask(task: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return task.requiredCapability === 'coordination'
    || task.requiredCapability === 'user-input'
    || task.requiredCapability === 'retrieval'
    || task.id.startsWith('coordinator:');
}

function summarizeCoordinatorOnlyStall(tasks: TaskFact[]): string | null {
  const scoped = tasks.filter((task) => task.status !== 'done');
  if (scoped.length === 0) {
    return null;
  }
  const runningOrPending = scoped.filter((task) =>
    task.status === 'running'
    || task.status === 'pending'
    || task.status === 'waiting_user'
    || task.status === 'blocked'
    || task.status === 'failed',
  );
  if (runningOrPending.length === 0) {
    return null;
  }
  if (!runningOrPending.every((task) => isCoordinatorControlTask(task))) {
    return null;
  }
  const coordinatorTaskIds = runningOrPending.map((task) => task.id).slice(0, 6);
  return `request 仍停留在 coordinator/control task（${coordinatorTaskIds.join(', ')}），尚未形成下游多 agent handoff`;
}

export function deriveBlackboardFailureTriage(args: {
  requestId: string | null;
  requestState?: string | null;
  runtimeBlockedReason?: string | null;
  failureTransport?: BlackboardFailureTransport | null;
  transportError?: string | null;
  dependencyHandoffHints?: DependencyHandoffHintLike[] | null;
  tasks?: TaskFact[] | null;
}): BlackboardFailureTriage {
  const requestId = String(args.requestId || '').trim();
  const failureTransport = args.failureTransport || (
    String(args.transportError || '').trim()
      ? {
          source: 'server-runtime',
          layer: 'runtime-diagnostics',
          health: String(args.transportError || '').trim(),
          status: null,
          ws: null,
        }
      : null
  );
  const scopedHints = (args.dependencyHandoffHints || []).filter((hint) =>
    !requestId || String(hint.requestId || '').trim() === requestId,
  );
  const scopedTasks = (args.tasks || []).filter((task) =>
    !requestId || String(task.requestId || '').trim() === requestId,
  );
  const scopedBlockingHints = scopedHints.filter((hint) => hint.blocking !== false);
  if (scopedBlockingHints.length > 0) {
    return {
      failureCategory: 'dependency_handoff_gap',
      failureSummary: scopedBlockingHints[0]?.issue || `${scopedBlockingHints.length} 条依赖交接仍未形成`,
      failureTaskIds: Array.from(new Set(scopedBlockingHints.map((hint) => String(hint.taskId || '').trim()).filter(Boolean))),
      failureTransport,
    };
  }

  const blockedByTerminalDependency = scopedTasks
    .filter((task) => task.status === 'blocked' || task.status === 'failed')
    .filter((task) => /依赖任务「.+」已\s+(?:blocked|failed)\s+且不可自动恢复/i.test(String(task.blockedBy?.message || '')));
  if (blockedByTerminalDependency.length > 0) {
    return {
      failureCategory: 'dependency_handoff_gap',
      failureSummary: String(blockedByTerminalDependency[0]?.blockedBy?.message || '').trim() || '依赖任务已终局失败，无法形成可交接 handoff。',
      failureTaskIds: blockedByTerminalDependency.map((task) => task.id),
      failureTransport,
    };
  }

  if (String(args.runtimeBlockedReason || '').trim()) {
    return {
      failureCategory: 'runtime_deadlock',
      failureSummary: String(args.runtimeBlockedReason || '').trim(),
      failureTaskIds: [],
      failureTransport,
    };
  }

  const normalizedState = String(args.requestState || '').trim().toLowerCase();
  if (normalizedState === 'executing') {
    const coordinatorOnlySummary = summarizeCoordinatorOnlyStall(scopedTasks);
    if (coordinatorOnlySummary) {
      return {
        failureCategory: 'coordinator_only_stall',
        failureSummary: coordinatorOnlySummary,
        failureTaskIds: scopedTasks
          .filter((task) => task.status !== 'done' && isCoordinatorControlTask(task))
          .map((task) => task.id)
          .slice(0, 8),
        failureTransport,
      };
    }
  }

  if (failureTransport) {
    return {
      failureCategory: 'transport_split',
      failureSummary: failureTransport.health || 'runtime diagnostics unavailable',
      failureTaskIds: [],
      failureTransport,
    };
  }

  return {
    failureCategory: null,
    failureSummary: null,
    failureTaskIds: [],
    failureTransport: null,
  };
}
