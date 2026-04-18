import type { RequestStateRecord } from '../store/request-state-store.js';
import type { BlackboardFinalReadiness } from './blackboard-synthesis.js';
import type { DoneTaskIntegrityGap } from './done-task-integrity.js';
import type { TaskFact } from './blackboard-types.js';
import { deriveRunningHeartbeatSummary } from './running-heartbeat.js';
import {
  derivePublishedRequestCompletionMode,
  evaluateStandardRequestCompletionPolicy,
  type RequestCompletionMode,
} from './request-completion-policy.js';

export type RequestClosureMode =
  | 'successful_handoff'
  | 'terminal_failure_closure'
  | 'zero_materialization_closure'
  | null;

export interface RequestIntegritySummary {
  requestId: string;
  sessionId: string | null;
  requestState: string | null;
  requestStateReason: string | null;
  finalPublished: boolean;
  completionMode: RequestCompletionMode | null;
  closureMode: RequestClosureMode;
  focusTaskIds: string[];
  canPublishFinal: boolean;
  finalReadinessReason: string | null;
  doneEvidenceGapCount: number;
  doneEvidenceGapTaskIds: string[];
  doneEvidenceGaps: DoneTaskIntegrityGap[];
  runtimeActiveSessionCount: number;
  runtimeBlockingStaleSessionCount: number;
  runtimeBlockingStaleAgentIds: string[];
  runtimeBlockedReason: string | null;
}

function summarizeRuntimeBlockedReason(args: {
  runtimeActiveSessionCount: number;
  runtimeBlockingStaleSessionCount: number;
  runtimeBlockingStaleAgentIds: string[];
  tasks?: TaskFact[] | null;
}): string | null {
  if (args.runtimeBlockingStaleSessionCount <= 0) {
    return null;
  }
  const heartbeatSummary = deriveRunningHeartbeatSummary(args.tasks || []);
  const activeRunningTaskIds = [
    ...heartbeatSummary.healthyTaskIds,
    ...heartbeatSummary.awaitingHeartbeatTaskIds,
  ];
  if (activeRunningTaskIds.length > 0) {
    return null;
  }
  const agentSummary = args.runtimeBlockingStaleAgentIds.length > 0
    ? ` blocking agents: ${args.runtimeBlockingStaleAgentIds.join(', ')}.`
    : '';
  return `request has ${args.runtimeBlockingStaleSessionCount} blocking stale runtime session(s) while only ${args.runtimeActiveSessionCount} active session(s) are attached.${agentSummary}`.trim();
}

export function deriveRequestClosureMode(args: {
  requestState?: Pick<RequestStateRecord, 'state' | 'finalPublished'> | null;
  tasks?: TaskFact[] | null;
}): RequestClosureMode {
  if (args.requestState?.state !== 'closed' || args.requestState?.finalPublished !== true) {
    return null;
  }
  const substantiveTasks = (args.tasks || []).filter((task) => String(task.requiredCapability || '').trim() !== 'coordination');
  if (substantiveTasks.length === 0) {
    return 'zero_materialization_closure';
  }
  const allDone = substantiveTasks.every((task) => String(task.status || '').trim() === 'done');
  return allDone ? 'successful_handoff' : 'terminal_failure_closure';
}

export function buildRequestIntegritySummary(args: {
  requestId: string;
  sessionId: string | null;
  requestState?: RequestStateRecord | null;
  readiness?: BlackboardFinalReadiness | null;
  runtimeDiagnostics?: {
    activeSessionCount?: number | null;
    blockingStaleSessions?: Array<{ agentId?: string | null }> | null;
  } | null;
  tasks?: TaskFact[] | null;
}): RequestIntegritySummary {
  const gaps = args.requestState?.doneEvidenceGaps || [];
  const blockingStaleSessions = Array.isArray(args.runtimeDiagnostics?.blockingStaleSessions)
    ? args.runtimeDiagnostics?.blockingStaleSessions
    : [];
  const runtimeBlockingStaleAgentIds = Array.from(
    new Set(
      blockingStaleSessions
        .map((session) => String(session?.agentId || '').trim())
        .filter(Boolean),
    ),
  );
  const runtimeActiveSessionCount = Number(args.runtimeDiagnostics?.activeSessionCount || 0);
  const runtimeBlockingStaleSessionCount = blockingStaleSessions.length;
  const completionMode = derivePublishedRequestCompletionMode({
    requestState: args.requestState,
    tasks: args.tasks,
  }) || args.readiness?.completionPolicy?.mode || (args.readiness
    ? evaluateStandardRequestCompletionPolicy({
        facts: args.tasks || [],
        readiness: args.readiness,
        requestState: args.requestState,
      }).mode
    : null);
  return {
    requestId: args.requestId,
    sessionId: args.sessionId,
    requestState: args.requestState?.state || null,
    requestStateReason: args.requestState?.stateReason || null,
    finalPublished: args.requestState?.finalPublished === true,
    completionMode,
    closureMode: deriveRequestClosureMode(args),
    focusTaskIds: [...(args.requestState?.focusTaskIds || [])],
    canPublishFinal: args.readiness?.canPublish === true,
    finalReadinessReason: args.readiness?.reason || null,
    doneEvidenceGapCount: gaps.length,
    doneEvidenceGapTaskIds: gaps.map((gap) => gap.taskId),
    doneEvidenceGaps: gaps.map((gap) => ({
      taskId: gap.taskId,
      requestId: gap.requestId,
      reasons: [...gap.reasons],
    })),
    runtimeActiveSessionCount,
    runtimeBlockingStaleSessionCount,
    runtimeBlockingStaleAgentIds,
    runtimeBlockedReason: summarizeRuntimeBlockedReason({
      runtimeActiveSessionCount,
      runtimeBlockingStaleSessionCount,
      runtimeBlockingStaleAgentIds,
      tasks: args.tasks,
    }),
  };
}
