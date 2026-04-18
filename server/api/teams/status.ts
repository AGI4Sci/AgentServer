import type { IncomingMessage, ServerResponse } from 'http';
import { compareRequestStateRecords, getRequestStateStore } from '../../../core/store/request-state-store.js';
import { getBlackboardStore } from '../../../core/store/blackboard-store.js';
import { getTeamChatStore } from '../../../core/store/team-chat-store.js';
import { getTeamRuntimeStateStore } from '../../../core/store/team-runtime-state-store.js';
import { error, sendJson, success } from '../../utils/response.js';
import { deriveDoneEvidenceIntegrityGaps } from '../../runtime/blackboard-t006-diagnostics.js';
import { deriveActiveRequestRuntimeBlockers, deriveRequestStatusFailureView } from '../../runtime/request-status-view.js';
import { probeRequestRuntimeDiagnostics } from '../../runtime/request-runtime-probe.js';
import { maybeTriggerSessionlessRuntimeRecovery } from '../../runtime/request-runtime-recovery.js';
import { triggerBlackboardDispatch } from '../../ws/blackboard-runtime-loop.js';
import { finalizeSynthesizedRequestIfReady } from '../../ws-handler.js';
import { ensureTeamDirs, readManifest } from './shared.js';
export { deriveActiveRequestRuntimeBlockers } from '../../runtime/request-status-view.js';

export async function maybeQueueReadyForFinalSynthesis(args: {
  teamId: string;
  chatSessionId: string;
  activeRequest: {
    requestId: string;
    state: string;
    finalPublished?: boolean;
    coordinatorAgentId?: string | null;
  } | null;
  finalize?: typeof finalizeSynthesizedRequestIfReady;
  dispatch?: typeof triggerBlackboardDispatch;
}): Promise<boolean> {
  const request = args.activeRequest;
  if (!request || request.state !== 'ready_for_final' || request.finalPublished) {
    return false;
  }
  const finalize = args.finalize || finalizeSynthesizedRequestIfReady;
  const dispatch = args.dispatch || triggerBlackboardDispatch;
  const finalized = finalize({
    teamId: args.teamId,
    requestId: request.requestId,
    chatSessionId: args.chatSessionId,
    coordinatorId: request.coordinatorAgentId || null,
  });
  if (!finalized.finalized && finalized.changedTaskIds.length > 0) {
    await dispatch({
      teamId: args.teamId,
      requestId: request.requestId,
      chatSessionId: args.chatSessionId,
    });
    return true;
  }
  return false;
}

function findLatestStatusSessionId(teamId: string): string | null {
  const chatStore = getTeamChatStore();
  const requestStore = getRequestStateStore();
  const board = getBlackboardStore();
  const activeSessionId = chatStore.getActiveSessionId(teamId);
  const activeRequestCount = activeSessionId ? requestStore.listRequests(teamId, activeSessionId).length : 0;
  const activeTaskCount = activeSessionId ? board.list(teamId, activeSessionId, { includeArchive: true }).length : 0;
  if (activeSessionId && (activeRequestCount > 0 || activeTaskCount > 0)) {
    return activeSessionId;
  }

  const ranked = chatStore
    .listSessions(teamId)
    .map((session) => {
      const requests = requestStore
        .listRequests(teamId, session.sessionId)
        .sort(compareRequestStateRecords);
      const tasks = board.list(teamId, session.sessionId, { includeArchive: true });
      const latestTaskUpdatedAt = tasks.reduce((max, task) => Math.max(max, Number(task.updatedAt || 0)), 0);
      return {
        sessionId: session.sessionId,
        request: requests[0] || null,
        latestTaskUpdatedAt,
        sessionUpdatedAt: Date.parse(String(session.updatedAt || '')) || 0,
        requestCount: requests.length,
        taskCount: tasks.length,
      };
    })
    .filter((item) => item.requestCount > 0 || item.taskCount > 0)
    .sort((left, right) => {
      if (left.request && right.request) {
        return compareRequestStateRecords(left.request, right.request);
      }
      if (left.request) {
        return -1;
      }
      if (right.request) {
        return 1;
      }
      const scoreDelta = Math.max(right.latestTaskUpdatedAt, right.sessionUpdatedAt)
        - Math.max(left.latestTaskUpdatedAt, left.sessionUpdatedAt);
      if (scoreDelta !== 0) {
        return scoreDelta;
      }
      return right.sessionId.localeCompare(left.sessionId);
    });
  return ranked[0]?.sessionId || activeSessionId || null;
}

export async function handleGetTeamStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const manifest = readManifest(teamId);
    if (!manifest) {
      sendJson(res, 200, success({ agents: [] }));
      return;
    }

    const sessionId = findLatestStatusSessionId(teamId);
    if (!sessionId) {
      sendJson(res, 200, success({
        agents: [],
        activeRequest: null,
        runtimeState: null,
        runtimeDiagnostics: null,
      }));
      return;
    }
    const runtimeState = getTeamRuntimeStateStore().getStateForSession(teamId, sessionId);
    const requests = getRequestStateStore()
      .listRequests(teamId, sessionId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const activeRequest = requests[0] || null;
    const allTasks = getBlackboardStore().list(teamId, sessionId, { includeArchive: true });
    const doneWithEvidenceGaps = deriveDoneEvidenceIntegrityGaps({
      teamId,
      chatSessionId: sessionId,
      tasks: activeRequest
        ? allTasks.filter((task) => task.requestId === activeRequest.requestId)
        : [],
    });
    const { runtimeDiagnostics: probedRuntimeDiagnostics, transportError, failureTransport } = await probeRequestRuntimeDiagnostics({
      teamId,
      requests,
    });
    let runtimeDiagnostics = probedRuntimeDiagnostics;
    if (runtimeDiagnostics && typeof runtimeDiagnostics === 'object') {
      runtimeDiagnostics = {
        ...runtimeDiagnostics,
        evidenceIntegrity: {
          doneWithEvidenceGaps,
        },
      };
    }
    const scopedTasks = activeRequest
      ? allTasks.filter((task) => task.requestId === activeRequest.requestId)
      : [];
    const failureView = deriveRequestStatusFailureView({
      teamId,
      chatSessionId: sessionId,
      requestId: activeRequest?.requestId || null,
      requestState: activeRequest?.state || null,
      requestFinalPublished: activeRequest?.finalPublished === true,
      tasks: scopedTasks,
      runtimeDiagnostics,
      failureTransport,
      transportError,
    });
    await maybeTriggerSessionlessRuntimeRecovery({
      teamId,
      chatSessionId: sessionId,
      requestId: activeRequest?.requestId || null,
      failureCategory: failureView.failureCategory,
      runtimeBlockedReason: failureView.runtimeBlockers.runtimeBlockedReason,
      runtimeDiagnostics: runtimeDiagnostics && typeof runtimeDiagnostics === 'object' ? runtimeDiagnostics as Record<string, unknown> : null,
      tasks: scopedTasks,
    });
    await maybeQueueReadyForFinalSynthesis({
      teamId,
      chatSessionId: sessionId,
      activeRequest,
    });

    const refreshedTasks = getBlackboardStore().list(teamId, sessionId, { includeArchive: true });
    const refreshedRequests = getRequestStateStore()
      .listRequests(teamId, sessionId)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const refreshedActiveRequest = refreshedRequests[0] || null;
    const refreshedScopedTasks = refreshedActiveRequest
      ? refreshedTasks.filter((task) => task.requestId === refreshedActiveRequest.requestId)
      : [];
    const refreshedFailureView = deriveRequestStatusFailureView({
      teamId,
      chatSessionId: sessionId,
      requestId: refreshedActiveRequest?.requestId || null,
      requestState: refreshedActiveRequest?.state || null,
      requestFinalPublished: refreshedActiveRequest?.finalPublished === true,
      tasks: refreshedScopedTasks,
      runtimeDiagnostics,
      failureTransport,
      transportError,
    });

    const agents = (runtimeState?.members || []).map((member) => ({
      id: member.agentId,
      status: member.lifecycle || member.availability || 'idle',
      task: member.assignmentTaskId || '等待任务分配',
      role: member.role,
      capabilityTags: member.capabilityTags,
      availability: member.availability,
      failureCount: member.failureCount,
      lastResultAt: member.lastResultAt || null,
    }));

    sendJson(res, 200, success({
      agents,
      activeRequest: refreshedActiveRequest ? {
        requestId: refreshedActiveRequest.requestId,
        state: refreshedActiveRequest.state,
        stateReason: refreshedActiveRequest.stateReason,
        resumable: refreshedActiveRequest.resumable,
        focusTaskIds: refreshedActiveRequest.focusTaskIds,
        doneEvidenceGapCount: refreshedActiveRequest.doneEvidenceGapCount,
        doneEvidenceGapTaskIds: refreshedActiveRequest.doneEvidenceGapTaskIds,
        doneEvidenceGaps: refreshedActiveRequest.doneEvidenceGaps,
        runtimeActiveSessionCount: refreshedFailureView.runtimeBlockers.runtimeActiveSessionCount,
        runtimeBlockingStaleSessionCount: refreshedFailureView.runtimeBlockers.runtimeBlockingStaleSessionCount,
        runtimeBlockingStaleAgentIds: refreshedFailureView.runtimeBlockers.runtimeBlockingStaleAgentIds,
        runtimeBlockedReason: refreshedFailureView.runtimeBlockers.runtimeBlockedReason,
        runtimeTaskLiveness: refreshedFailureView.runtimeBlockers.runtimeTaskLiveness,
        failureCategory: refreshedFailureView.failureCategory,
        failureSummary: refreshedFailureView.failureSummary,
        failureTaskIds: refreshedFailureView.failureTaskIds,
        closureMode: refreshedFailureView.closureMode,
        failureTransport: refreshedFailureView.failureTransport,
        updatedAt: refreshedActiveRequest.updatedAt,
      } : null,
      runtimeState: runtimeState ? {
        phase: runtimeState.phase,
        degradationMode: runtimeState.degradationMode,
        coordinator: runtimeState.coordinator,
        approvals: runtimeState.approvals,
        workingSetTaskIds: runtimeState.workingSetTaskIds || [],
        updatedAt: runtimeState.updatedAt,
      } : null,
      runtimeDiagnostics,
    }));
  } catch (err) {
    console.error('[API] Failed to get team status:', err);
    sendJson(res, 500, error(String(err)));
  }
}
