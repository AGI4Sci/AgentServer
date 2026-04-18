import type { TeamChatStore } from '../store/team-chat-store.js';
import type { TaskFact } from './blackboard-types.js';
import { extractTaskEvidenceBlock, validateTaskCompletionEvidence } from '../../server/ws/task-completion-evidence.js';

export interface DoneTaskIntegrityGap {
  taskId: string;
  requestId: string;
  reasons: string[];
}

export function summarizeDoneTaskIntegrityGaps(
  gaps: DoneTaskIntegrityGap[],
  options?: {
    maxTasks?: number;
    maxReasonsPerTask?: number;
  },
): string {
  const maxTasks = Math.max(1, options?.maxTasks ?? 2);
  const maxReasonsPerTask = Math.max(1, options?.maxReasonsPerTask ?? 1);
  if (gaps.length === 0) {
    return 'no invalid done task detected';
  }
  const taskSummaries = gaps.slice(0, maxTasks).map((gap) => {
    const reasons = (gap.reasons || [])
      .filter(Boolean)
      .slice(0, maxReasonsPerTask)
      .join('; ');
    return reasons
      ? `${gap.taskId} (${reasons})`
      : gap.taskId;
  });
  const remainder = gaps.length - taskSummaries.length;
  const suffix = remainder > 0 ? `; +${remainder} more` : '';
  return `request has ${gaps.length} done task(s) still missing reviewable completion evidence: ${taskSummaries.join('; ')}${suffix}`;
}

export function deriveDoneTaskIntegrityGaps(args: {
  teamChatStore: Pick<TeamChatStore, 'getHistory'>;
  teamId: string;
  chatSessionId: string;
  tasks: TaskFact[];
}): DoneTaskIntegrityGap[] {
  const gaps: DoneTaskIntegrityGap[] = [];
  const supersededByDoneReplacementIds = new Set(
    args.tasks
      .filter((task) => task.status === 'done' && typeof task.supersedesTaskId === 'string' && task.supersedesTaskId.trim())
      .map((task) => String(task.supersedesTaskId || '').trim())
      .filter(Boolean),
  );

  for (const task of args.tasks) {
    if (
      task.status !== 'done'
      || supersededByDoneReplacementIds.has(task.id)
      || (
        !task.evidenceRequirements
        && !(task.acceptanceCriteria?.length)
      )
    ) {
      continue;
    }
    const { hasBlock } = extractTaskEvidenceBlock(String(task.result || ''));
    const validation = validateTaskCompletionEvidence({
      teamChatStore: args.teamChatStore as TeamChatStore,
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      task,
      taskEvidenceProvided: hasBlock,
      completionBody: task.result,
    });
    if (!validation.ok) {
      gaps.push({
        taskId: task.id,
        requestId: task.requestId,
        reasons: validation.reasons,
      });
    }
  }

  return gaps;
}
