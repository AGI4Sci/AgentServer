import { existsSync, readdirSync } from 'fs';
import { relative } from 'path';

import type { BlackboardTaskStatus, TaskFact } from '../../core/runtime/blackboard-types.js';

export type BlackboardExecutionTraceEvent = {
  timestamp: string;
  eventType: string;
  taskId: string | null;
  runId: string | null;
  summary: string | null;
};

const OPEN_PROGRESS_STATUSES = new Set<BlackboardTaskStatus>([
  'pending',
  'running',
  'waiting_user',
  'blocked',
]);

const ARTIFACT_SAMPLE_LIMIT = 8;
const ARTIFACT_FILE_SCAN_LIMIT = 64;
const ARTIFACT_DIRECTORY_SCAN_LIMIT = 32;
const STALLED_IDLE_MS = 5 * 60 * 1000;

function listArtifactSamples(root: string | null | undefined): {
  artifactsRoot: string | null;
  exists: boolean;
  fileCount: number;
  samplePaths: string[];
} {
  const artifactsRoot = String(root || '').trim() || null;
  if (!artifactsRoot || !existsSync(artifactsRoot)) {
    return {
      artifactsRoot,
      exists: false,
      fileCount: 0,
      samplePaths: [],
    };
  }

  const samplePaths: string[] = [];
  let fileCount = 0;
  const queue: string[] = [artifactsRoot];
  let visitedDirectories = 0;

  while (queue.length > 0 && visitedDirectories < ARTIFACT_DIRECTORY_SCAN_LIMIT && fileCount < ARTIFACT_FILE_SCAN_LIMIT) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    visitedDirectories += 1;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }
      fileCount += 1;
      if (samplePaths.length < ARTIFACT_SAMPLE_LIMIT) {
        samplePaths.push(relative(artifactsRoot, fullPath) || entry.name);
      }
      if (fileCount >= ARTIFACT_FILE_SCAN_LIMIT) {
        break;
      }
    }
  }

  return {
    artifactsRoot,
    exists: true,
    fileCount,
    samplePaths,
  };
}

function toMillis(value: string | number | null | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function compactText(value: string | null | undefined, max = 180): string | null {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

export function deriveOpenTaskProgressSnapshots(args: {
  tasks: TaskFact[];
  executionEvents: BlackboardExecutionTraceEvent[];
  now?: number;
}): {
  openTaskProgress: Array<{
    taskId: string;
    requestId: string;
    owner: string | null;
    status: string;
    currentRunId: string | null;
    lastEventAt: string | null;
    lastEventType: string | null;
    lastToolCallSummary: string | null;
    lastToolCallAt: string | null;
    latestProgressSummary: string | null;
    lastHeartbeatAt: string | null;
    idleMs: number | null;
    stalledHint: string | null;
    artifactsRoot: string | null;
    artifactsExist: boolean;
    artifactFileCount: number;
    artifactSamplePaths: string[];
    relatedCoordinatorStallApproval: boolean;
  }>;
  stalledCoordinatorRequests: Array<{
    requestId: string;
    coordinatorTaskId: string | null;
    approvalTaskId: string;
    hint: string;
  }>;
} {
  const now = Number.isFinite(args.now) ? Number(args.now) : Date.now();
  const byRequest = new Map<string, TaskFact[]>();
  for (const task of args.tasks) {
    const bucket = byRequest.get(task.requestId) || [];
    bucket.push(task);
    byRequest.set(task.requestId, bucket);
  }

  const stalledCoordinatorRequests = args.tasks
    .filter((task) => task.id.includes(':approval:approval-coordinator-stalled'))
    .map((task) => {
      const coordinatorTask = (byRequest.get(task.requestId) || []).find((candidate) => candidate.id === `coordinator:${task.requestId}`);
      return {
        requestId: task.requestId,
        coordinatorTaskId: coordinatorTask?.id || null,
        approvalTaskId: task.id,
        hint: 'request 出现 approval-coordinator-stalled；coordinator 很可能做了探索但未产出正式 dispatch DAG，宜优先判断是否需要 salvage/续派。',
      };
    });
  const stalledRequestIds = new Set(stalledCoordinatorRequests.map((item) => item.requestId));

  const openTaskProgress = args.tasks
    .filter((task) => OPEN_PROGRESS_STATUSES.has(task.status))
    .map((task) => {
      const relatedEvents = args.executionEvents
        .filter((event) => event.taskId === task.id || (!!task.currentRunId && event.runId === task.currentRunId))
        .sort((left, right) => toMillis(right.timestamp) - toMillis(left.timestamp));
      const lastEvent = relatedEvents[0] || null;
      const lastToolCall = relatedEvents.find((event) => event.eventType === 'runtime-tool-call') || null;
      const artifacts = listArtifactSamples(task.executionScope.artifactsRoot);
      const latestTouchMs = Math.max(
        toMillis(task.updatedAt),
        toMillis(task.lastHeartbeatAt),
        toMillis(lastEvent?.timestamp || null),
      );
      const idleMs = task.status === 'running' && latestTouchMs > 0
        ? Math.max(0, now - latestTouchMs)
        : null;

      let stalledHint: string | null = null;
      if (task.status === 'running' && idleMs !== null && idleMs >= STALLED_IDLE_MS) {
        stalledHint = artifacts.fileCount > 0
          ? `任务运行中但最近 ${Math.round(idleMs / 1000)}s 无新事件；已有产物文件，可考虑先审查产物再决定是否继续等待。`
          : `任务运行中但最近 ${Math.round(idleMs / 1000)}s 无新事件，且尚未观察到产物文件；宜检查运行时是否卡住。`;
      } else if (task.status === 'pending' && stalledRequestIds.has(task.requestId)) {
        stalledHint = '上游 request 已出现 coordinator stalled approval；当前 pending 更可能需要 salvage/续派，而不是单纯等待。';
      } else if (task.status === 'blocked') {
        stalledHint = '任务已 blocked；优先查看 blocked reason 或已有产物，再决定是否新开续作任务。';
      }

      return {
        taskId: task.id,
        requestId: task.requestId,
        owner: task.owner || null,
        status: task.status,
        currentRunId: task.currentRunId || null,
        lastEventAt: lastEvent?.timestamp || null,
        lastEventType: lastEvent?.eventType || null,
        lastToolCallSummary: compactText(lastToolCall?.summary || null),
        lastToolCallAt: lastToolCall?.timestamp || null,
        latestProgressSummary: compactText(lastEvent?.summary || null),
        lastHeartbeatAt: task.lastHeartbeatAt ? new Date(task.lastHeartbeatAt).toISOString() : null,
        idleMs,
        stalledHint,
        artifactsRoot: artifacts.artifactsRoot,
        artifactsExist: artifacts.exists,
        artifactFileCount: artifacts.fileCount,
        artifactSamplePaths: artifacts.samplePaths,
        relatedCoordinatorStallApproval: stalledRequestIds.has(task.requestId),
      };
    })
    .sort((left, right) => {
      const idleDelta = (right.idleMs || 0) - (left.idleMs || 0);
      if (idleDelta !== 0) {
        return idleDelta;
      }
      return toMillis(right.lastEventAt) - toMillis(left.lastEventAt);
    });

  return {
    openTaskProgress,
    stalledCoordinatorRequests,
  };
}
