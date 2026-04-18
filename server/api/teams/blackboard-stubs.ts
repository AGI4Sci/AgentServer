/**
 * 黑板扩展 API：`subscribe` 为登记说明；其余路径对接 BlackboardStore（需 sessionId）。
 */
import type { IncomingMessage, ServerResponse } from 'http';
import type { DecisionFact, ProposalFact, TaskFact } from '../../../core/runtime/blackboard-types.js';
import { deriveRequestAuditSnapshot } from '../../../core/runtime/request-audit.js';
import { buildApprovalRequestGoal, parseApprovalRequestGoal, upsertWaitingUserTask } from '../../../core/runtime/waiting-user.js';
import { getBlackboardStore } from '../../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../../core/store/request-state-store.js';
import { getTeamChatStore } from '../../../core/store/team-chat-store.js';
import { sendJson } from '../../utils/response.js';
import { readRequestBody } from './shared.js';
import { recordBlackboardSubscribeInterest } from './blackboard-subscribe-registry.js';
import { triggerBlackboardDispatch } from '../../ws/blackboard-runtime-loop.js';
import { ensureCoordinatorRecoveryIfNeeded, finalizeSynthesizedRequestIfReady } from '../../ws-handler.js';
import { resolveLowRiskProposalBacklog } from '../../runtime/blackboard-low-risk.js';
import { queueCoordinatorControlTask } from '../../runtime/request-finalization.js';

function parseSessionId(fullUrl: string, body?: Record<string, unknown>): string | null {
  try {
    const u = new URL(fullUrl, 'http://127.0.0.1');
    const q = u.searchParams.get('sessionId')?.trim();
    if (q) {
      return q;
    }
  } catch {
    /* ignore */
  }
  const fromBody = body?.sessionId ?? body?.chatSessionId;
  if (typeof fromBody === 'string' && fromBody.trim()) {
    return fromBody.trim();
  }
  return null;
}

function decodePathComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveSessionByRequest(teamId: string, requestId: string): string | null {
  const normalized = String(requestId || '').trim();
  if (!normalized) return null;
  const board = getBlackboardStore();
  const sessions = getTeamChatStore().listSessions(teamId);
  for (const session of sessions) {
    const hasFacts = board.list(teamId, session.sessionId, {
      requestId: normalized,
      includeArchive: true,
    }).length > 0;
    if (hasFacts) return session.sessionId;
  }
  return null;
}

export async function handleBlackboardStubRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
): Promise<boolean> {
  const requestProtocolAction = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/requests\/([^/]+)\/protocol-action(?:\?|$)/);
  if (requestProtocolAction && method === 'POST') {
    const teamId = requestProtocolAction[1];
    const requestId = decodePathComponent(requestProtocolAction[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body) || resolveSessionByRequest(teamId, requestId);
    if (!sessionId) {
      sendJson(res, 404, {
        ok: false,
        error: 'request_session_not_found',
        data: { teamId, requestId },
      });
      return true;
    }

    const actionKind = typeof body.actionKind === 'string' ? body.actionKind.trim() : '';
    const targetProposalId = typeof body.targetProposalId === 'string' ? body.targetProposalId.trim() : '';
    const targetTaskId = typeof body.targetTaskId === 'string' ? body.targetTaskId.trim() : '';
    const board = getBlackboardStore();
    const requestStore = getRequestStateStore();
    const requestState = requestStore.getRequestForSession(teamId, requestId, sessionId);
    const requestAudit = deriveRequestAuditSnapshot({
      board,
      teamId,
      chatSessionId: sessionId,
      requestId,
      requestState,
    });

    if (actionKind === 'materialize_task') {
      if (!targetProposalId) {
        sendJson(res, 400, {
          ok: false,
          error: 'target_proposal_id_required',
          data: { hint: 'materialize_task requires targetProposalId.' },
        });
        return true;
      }
      const repairTemplate = requestAudit.protocolRepairTemplates.find((template) =>
        template.actionKind === 'materialize_task'
        && template.targetProposalId === targetProposalId);
      if (!repairTemplate || !requestAudit.approvedButUnmaterializedProposalIds.includes(targetProposalId)) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_not_currently_executable',
          data: { teamId, requestId, actionKind, targetProposalId },
        });
        return true;
      }
      const task = board.materializeApprovedProposal(teamId, sessionId, targetProposalId);
      if (!task) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_materialize_rejected',
          data: {
            teamId,
            requestId,
            targetProposalId,
            hint: 'Proposal missing, not approved, already materialized, blocked by fanout, or task validation failed.',
          },
        });
        return true;
      }
      const nextRequestState = requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
      await triggerBlackboardDispatch({ teamId, requestId, chatSessionId: sessionId });
      sendJson(res, 200, {
        ok: true,
        data: {
          teamId,
          chatSessionId: sessionId,
          requestId,
          actionKind,
          targetProposalId,
          executed: true,
          task,
          requestState: nextRequestState,
        },
      });
      return true;
    }

    if (actionKind === 'resolve_blocked_neighborhood') {
      const repairTemplate = requestAudit.protocolRepairTemplates.find((template) =>
        template.actionKind === 'resolve_blocked_neighborhood'
        && (!targetTaskId || template.targetTaskId === targetTaskId));
      const recoverableTaskIds = [...new Set([
        ...requestAudit.blockedTaskIds,
        ...requestAudit.historicalRetryableBlockedTaskIds,
        ...requestAudit.finalGate.autoAdvanceBlockedTaskIds,
      ])];
      if (!repairTemplate || recoverableTaskIds.length === 0 || (targetTaskId && !recoverableTaskIds.includes(targetTaskId))) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_not_currently_executable',
          data: { teamId, requestId, actionKind, targetTaskId: targetTaskId || null },
        });
        return true;
      }
      const recovery = ensureCoordinatorRecoveryIfNeeded({
        teamId,
        requestId,
        chatSessionId: sessionId,
        coordinatorId: requestState?.coordinatorAgentId || null,
      });
      const nextRequestState = requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
      await triggerBlackboardDispatch({ teamId, requestId, chatSessionId: sessionId });
      sendJson(res, 200, {
        ok: true,
        data: {
          teamId,
          chatSessionId: sessionId,
          requestId,
          actionKind,
          targetTaskId: repairTemplate.targetTaskId || targetTaskId || null,
          executed: true,
          recovery,
          requestState: nextRequestState,
        },
      });
      return true;
    }

    if (actionKind === 'collect_user_input') {
      const repairTemplate = requestAudit.protocolRepairTemplates.find((template) =>
        template.actionKind === 'collect_user_input'
        && (!targetTaskId || template.targetTaskId === targetTaskId));
      const waitingTaskId = targetTaskId || repairTemplate?.targetTaskId || '';
      if (!repairTemplate || !waitingTaskId || !requestAudit.waitingUserTaskIds.includes(waitingTaskId)) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_not_currently_executable',
          data: { teamId, requestId, actionKind, targetTaskId: targetTaskId || null },
        });
        return true;
      }
      const coordinatorId = requestStore.resolveCoordinatorForSession(
        teamId,
        requestId,
        sessionId,
        requestState?.coordinatorAgentId || null,
      );
      if (!coordinatorId) {
        sendJson(res, 409, {
          ok: false,
          error: 'coordinator_not_available',
          data: { teamId, requestId, actionKind, targetTaskId: waitingTaskId },
        });
        return true;
      }
      const changedTaskIds = queueCoordinatorControlTask({
        teamId,
        chatSessionId: sessionId,
        requestId,
        coordinatorId,
        phase: 'recovery',
        recoverableIds: [waitingTaskId],
      });
      const nextRequestState = requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
      await triggerBlackboardDispatch({ teamId, requestId, chatSessionId: sessionId });
      sendJson(res, 200, {
        ok: true,
        data: {
          teamId,
          chatSessionId: sessionId,
          requestId,
          actionKind,
          targetTaskId: waitingTaskId,
          executed: true,
          recovery: {
            queued: changedTaskIds.length > 0,
            changedTaskIds,
            reason: changedTaskIds.length > 0
              ? 'queued a coordinator recovery task for waiting_user input loop'
              : 'waiting_user recovery mode does not currently require a new coordinator task',
          },
          requestState: nextRequestState,
        },
      });
      return true;
    }

    if (actionKind === 'auto_resolve_low_risk_backlog') {
      const resolution = resolveLowRiskProposalBacklog({
        board,
        teamId,
        chatSessionId: sessionId,
        requestId,
        decidedBy: 'coordinator:protocol-action',
        notePrefix: 'protocol-action-low-risk',
      });
      if (resolution.autoResolvedProposalIds.length === 0 && resolution.materializedTaskIds.length === 0) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_not_currently_executable',
          data: { teamId, requestId, actionKind },
        });
        return true;
      }
      const nextRequestState = requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
      await triggerBlackboardDispatch({ teamId, requestId, chatSessionId: sessionId });
      sendJson(res, 200, {
        ok: true,
        data: {
          teamId,
          chatSessionId: sessionId,
          requestId,
          actionKind,
          executed: true,
          autoResolvedProposalIds: resolution.autoResolvedProposalIds,
          decidedIds: resolution.decidedIds,
          materializedTaskIds: resolution.materializedTaskIds,
          requestState: nextRequestState,
        },
      });
      return true;
    }

    if (actionKind === 'finalize_request') {
      if (!requestAudit.readiness.canPublish) {
        sendJson(res, 409, {
          ok: false,
          error: 'protocol_action_not_currently_executable',
          data: {
            teamId,
            requestId,
            actionKind,
            blockingReason: requestAudit.readiness.reason || requestAudit.finalGate.blockingReason || null,
          },
        });
        return true;
      }
      const finalization = finalizeSynthesizedRequestIfReady({
        teamId,
        requestId,
        chatSessionId: sessionId,
        coordinatorId: requestState?.coordinatorAgentId || null,
      });
      await triggerBlackboardDispatch({ teamId, requestId, chatSessionId: sessionId });
      sendJson(res, 200, {
        ok: true,
        data: {
          teamId,
          chatSessionId: sessionId,
          requestId,
          actionKind,
          executed: true,
          finalization,
          requestState: requestStore.getRequestForSession(teamId, requestId, sessionId),
        },
      });
      return true;
    }

    sendJson(res, 409, {
      ok: false,
      error: 'protocol_action_not_executable',
      data: {
        teamId,
        requestId,
        actionKind,
        hint: 'Unsupported request-level protocol action.',
      },
    });
    return true;
  }

  const requestAutoResolveLowRisk = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/requests\/([^/]+)\/auto-resolve-low-risk(?:\?|$)/);
  if (requestAutoResolveLowRisk && method === 'POST') {
    const teamId = requestAutoResolveLowRisk[1];
    const requestId = decodePathComponent(requestAutoResolveLowRisk[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body) || resolveSessionByRequest(teamId, requestId);
    if (!sessionId) {
      sendJson(res, 404, {
        ok: false,
        error: 'request_session_not_found',
        data: { teamId, requestId },
      });
      return true;
    }
    const board = getBlackboardStore();
    const requestStore = getRequestStateStore();
    const resolution = resolveLowRiskProposalBacklog({
      board,
      teamId,
      chatSessionId: sessionId,
      requestId,
      decidedBy: 'coordinator:auto-low-risk',
      notePrefix: 'bulk-auto-resolve',
    });
    const requestState = requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        requestId,
        autoResolvedProposalIds: resolution.autoResolvedProposalIds,
        decidedIds: resolution.decidedIds,
        materializedTaskIds: resolution.materializedTaskIds,
        requestState,
      },
    });
    return true;
  }

  const dispatchRoute = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/dispatch(?:\?|$)/);
  if (dispatchRoute && method === 'POST') {
    const teamId = dispatchRoute[1];
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (!requestId) {
      sendJson(res, 400, {
        ok: false,
        error: 'request_id_required',
        data: { hint: 'Provide JSON body.requestId for in-process blackboard dispatch.' },
      });
      return true;
    }
    const sessionId = parseSessionId(url, body) || resolveSessionByRequest(teamId, requestId);
    if (!sessionId) {
      sendJson(res, 404, {
        ok: false,
        error: 'request_session_not_found',
        data: { teamId, requestId },
      });
      return true;
    }
    const board = getBlackboardStore();
    const requestFacts = board.list(teamId, sessionId, {
      requestId,
      includeArchive: true,
    });
    if (requestFacts.length === 0) {
      sendJson(res, 404, {
        ok: false,
        error: 'request_not_found',
        data: { teamId, chatSessionId: sessionId, requestId },
      });
      return true;
    }
    const plan = await triggerBlackboardDispatch({
      teamId,
      requestId,
      chatSessionId: sessionId,
    });
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        requestId,
        dispatchCount: plan.length,
        plan,
      },
    });
    return true;
  }

  const archiveList = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/archive(?:\?|$)/);
  if (archiveList && method === 'GET') {
    const teamId = archiveList[1];
    const sessionId = parseSessionId(url);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'Query ?sessionId=<chatSessionId> is required for archive list.' },
      });
      return true;
    }
    const board = getBlackboardStore();
    const tasks = board.listArchivedFacts(teamId, sessionId);
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        tasks,
        stub: false,
        message: 'Archived TaskFact[] from BlackboardStore.listArchivedFacts',
      },
    });
    return true;
  }

  const taskArchive = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/tasks\/([^/]+)\/archive$/);
  if (taskArchive && method === 'POST') {
    const teamId = taskArchive[1];
    const taskId = decodePathComponent(taskArchive[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const board = getBlackboardStore();
    const archived = board.archive(teamId, sessionId, [taskId]);
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        taskId,
        archived: archived.length,
        tasks: archived,
      },
    });
    return true;
  }

  const taskHeartbeat = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/tasks\/([^/]+)\/heartbeat$/);
  if (taskHeartbeat && method === 'POST') {
    const teamId = taskHeartbeat[1];
    const taskId = decodePathComponent(taskHeartbeat[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
    const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
    if (!sessionId || !agentId || !runId) {
      sendJson(res, 400, {
        ok: false,
        error: 'invalid_heartbeat_payload',
        data: { hint: 'Require sessionId, agentId, runId (body or query).' },
      });
      return true;
    }
    const board = getBlackboardStore();
    const fact = board.heartbeat(teamId, sessionId, taskId, agentId, runId);
    if (!fact) {
      sendJson(res, 409, {
        ok: false,
        error: 'heartbeat_rejected',
        data: { hint: 'Task not running, owner/run mismatch, or revision conflict.' },
      });
      return true;
    }
    sendJson(res, 200, { ok: true, data: { teamId, chatSessionId: sessionId, task: fact } });
    return true;
  }

  const taskWrite = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/tasks\/([^/]+)\/write$/);
  if (taskWrite && (method === 'POST' || method === 'PUT')) {
    const teamId = taskWrite[1];
    const taskId = decodePathComponent(taskWrite[2]);
    let body: Record<string, unknown>;
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const revisionRaw = body.revision;
    const revision = typeof revisionRaw === 'number' ? revisionRaw : Number(revisionRaw);
    if (!Number.isFinite(revision)) {
      sendJson(res, 400, { ok: false, error: 'revision_required' });
      return true;
    }
    const patch = { ...body, id: taskId, revision } as Partial<TaskFact> & { id: string; revision: number };
    const board = getBlackboardStore();
    const fact = board.write(teamId, sessionId, patch);
    if (!fact) {
      sendJson(res, 409, {
        ok: false,
        error: 'write_rejected',
        data: { hint: 'Optimistic lock mismatch, validation failed, or done-task immutability.' },
      });
      return true;
    }
    sendJson(res, 200, { ok: true, data: { teamId, chatSessionId: sessionId, task: fact } });
    return true;
  }

  const proposalWrite = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/proposals\/([^/]+)\/write$/);
  if (proposalWrite && (method === 'POST' || method === 'PUT')) {
    const teamId = proposalWrite[1];
    const proposalId = decodePathComponent(proposalWrite[2]);
    let body: Record<string, unknown>;
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const revisionRaw = body.revision;
    const revision = typeof revisionRaw === 'number' ? revisionRaw : Number(revisionRaw);
    if (!Number.isFinite(revision)) {
      sendJson(res, 400, { ok: false, error: 'revision_required' });
      return true;
    }
    const patch = { ...body, id: proposalId, revision } as Partial<ProposalFact> & { id: string; revision: number };
    const board = getBlackboardStore();
    const proposal = board.propose(teamId, sessionId, patch as Parameters<typeof board.propose>[2]);
    if (!proposal) {
      sendJson(res, 409, {
        ok: false,
        error: 'proposal_write_rejected',
        data: { hint: 'Parent task missing, proposer not allowed, or validation failed.' },
      });
      return true;
    }
    sendJson(res, 200, { ok: true, data: { teamId, chatSessionId: sessionId, proposal } });
    return true;
  }

  const decisionWrite = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/decisions\/([^/]+)\/write$/);
  if (decisionWrite && (method === 'POST' || method === 'PUT')) {
    const teamId = decisionWrite[1];
    const decisionId = decodePathComponent(decisionWrite[2]);
    let body: Record<string, unknown>;
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const revisionRaw = body.revision;
    const revision = typeof revisionRaw === 'number' ? revisionRaw : Number(revisionRaw);
    if (!Number.isFinite(revision)) {
      sendJson(res, 400, { ok: false, error: 'revision_required' });
      return true;
    }
    const patch = { ...body, id: decisionId, revision } as Partial<DecisionFact> & { id: string; revision: number };
    const board = getBlackboardStore();
    const decision = board.decide(teamId, sessionId, patch as Parameters<typeof board.decide>[2]);
    if (!decision) {
      sendJson(res, 409, {
        ok: false,
        error: 'decision_write_rejected',
        data: { hint: 'Proposal missing, revision mismatch, or validation failed.' },
      });
      return true;
    }
    const dispatchPlan = await triggerBlackboardDispatch({
      teamId,
      requestId: decision.requestId,
      chatSessionId: sessionId,
    });
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        decision,
        dispatchCount: dispatchPlan.length,
        plan: dispatchPlan,
      },
    });
    return true;
  }

  const proposalMaterialize = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/proposals\/([^/]+)\/materialize$/);
  if (proposalMaterialize && method === 'POST') {
    const teamId = proposalMaterialize[1];
    const proposalId = decodePathComponent(proposalMaterialize[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : undefined;
    const board = getBlackboardStore();
    const task = board.materializeApprovedProposal(teamId, sessionId, proposalId, { taskId });
    if (!task) {
      sendJson(res, 409, {
        ok: false,
        error: 'materialize_rejected',
        data: { hint: 'Proposal missing, not approved, already materialized, or task validation failed.' },
      });
      return true;
    }
    const dispatchPlan = await triggerBlackboardDispatch({
      teamId,
      requestId: task.requestId,
      chatSessionId: sessionId,
    });
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        task,
        dispatchCount: dispatchPlan.length,
        plan: dispatchPlan,
      },
    });
    return true;
  }

  const approvalRespond = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/approvals\/([^/]+)\/respond$/);
  const approvalRequest = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/approvals$/);
  if (approvalRequest && method === 'POST') {
    const teamId = approvalRequest[1];
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    const sessionId = parseSessionId(url, body) || (requestId ? resolveSessionByRequest(teamId, requestId) : null);
    const kind = typeof body.kind === 'string' ? body.kind.trim() : 'high_risk_action';
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    const approvalId = typeof body.approvalId === 'string' && body.approvalId.trim()
      ? body.approvalId.trim()
      : `${requestId || 'request'}:approval:${Date.now()}`;
    const options = Array.isArray(body.options)
      ? body.options.map((item) => String(item || '').trim()).filter(Boolean)
      : ['approved', 'rejected'];
    if (!sessionId || !requestId || !reason) {
      sendJson(res, 400, {
        ok: false,
        error: 'missing_required_fields',
        data: { required: ['sessionId or resolvable requestId', 'requestId', 'reason'] },
      });
      return true;
    }
    const board = getBlackboardStore();
    const task = upsertWaitingUserTask(board, {
      teamId,
      chatSessionId: sessionId,
      requestId,
      taskId: `${requestId}:approval:${approvalId.replace(/[^a-zA-Z0-9._:-]+/g, '-')}`,
      goal: buildApprovalRequestGoal({ approvalId, kind, reason, options }),
      createdBy: 'web-user',
    });
    if (!task) {
      sendJson(res, 409, { ok: false, error: 'approval_task_write_rejected' });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        requestId,
        approvalId,
        task,
      },
    });
    return true;
  }

  if (approvalRespond && method === 'POST') {
    const teamId = approvalRespond[1];
    const approvalId = decodePathComponent(approvalRespond[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : '';
    const taskIdHint = typeof body.taskId === 'string' ? body.taskId.trim() : '';
    const decisionRaw = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const source = typeof body.source === 'string' ? body.source.trim() : 'external';
    const responder = typeof body.responder === 'string' ? body.responder.trim() : 'user';
    const sessionId = parseSessionId(url, body) || (requestId ? resolveSessionByRequest(teamId, requestId) : null);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'Provide sessionId, or provide requestId that can resolve an existing blackboard session.' },
      });
      return true;
    }
    const board = getBlackboardStore();
    const waitingTasks = board.list(teamId, sessionId, {
      requestId: requestId || undefined,
      status: 'waiting_user',
    });
    const target = waitingTasks.find((task) => {
      if (taskIdHint && task.id !== taskIdHint) return false;
      const approval = parseApprovalRequestGoal(task.goal);
      return approval?.approvalId === approvalId;
    });
    if (!target) {
      sendJson(res, 404, {
        ok: false,
        error: 'approval_waiting_task_not_found',
        data: { teamId, chatSessionId: sessionId, requestId: requestId || null, approvalId, taskId: taskIdHint || null },
      });
      return true;
    }
    const normalizedDecision = decisionRaw === 'approved' || decisionRaw === 'rejected' ? decisionRaw : 'responded';
    const result = JSON.stringify({
      type: 'approval_response',
      approvalId,
      status: normalizedDecision,
      decision: normalizedDecision,
      note: note || null,
      source,
      responder,
    });
    const next = board.write(teamId, sessionId, {
      id: target.id,
      revision: target.revision,
      owner: 'user',
      status: 'done',
      result,
    });
    if (!next) {
      sendJson(res, 409, {
        ok: false,
        error: 'write_rejected',
        data: { hint: 'Optimistic lock mismatch or task immutable.' },
      });
      return true;
    }
    await triggerBlackboardDispatch({
      teamId,
      requestId: next.requestId,
      chatSessionId: sessionId,
    });
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        task: next,
      },
    });
    return true;
  }

  const taskDelete = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/tasks\/([^/]+)$/);
  if (taskDelete && method === 'DELETE') {
    const teamId = taskDelete[1];
    const taskId = decodePathComponent(taskDelete[2]);
    let body: Record<string, unknown> = {};
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        body = JSON.parse(raw) as Record<string, unknown>;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
    const sessionId = parseSessionId(url, body);
    if (!sessionId) {
      sendJson(res, 400, {
        ok: false,
        error: 'session_id_required',
        data: { hint: 'JSON body.sessionId or ?sessionId=' },
      });
      return true;
    }
    const board = getBlackboardStore();
    const allFactsBeforeDelete = board.list(teamId, sessionId, { includeArchive: true });
    const removedFact = allFactsBeforeDelete.find((fact) => fact.id === taskId) || null;
    const removed = board.remove(teamId, sessionId, [taskId]);
    if (removed <= 0) {
      sendJson(res, 404, {
        ok: false,
        error: 'task_not_found',
        data: { teamId, chatSessionId: sessionId, taskId },
      });
      return true;
    }

    // If this request has no remaining facts after manual deletion, clear request lifecycle overlay.
    // Otherwise background blackboard loop may recreate coordinator followup tasks automatically.
    if (removedFact?.requestId) {
      const remainForRequest = board.list(teamId, sessionId, {
        requestId: removedFact.requestId,
        includeArchive: true,
      });
      if (remainForRequest.length === 0) {
        getRequestStateStore().clearRequestForSession(teamId, removedFact.requestId, sessionId);
      }
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        chatSessionId: sessionId,
        taskId,
        removed,
      },
    });
    return true;
  }

  const subscribe = url.match(/^\/api\/teams\/([^/]+)\/blackboard\/subscribe$/);
  if (subscribe && method === 'POST') {
    const teamId = subscribe[1];
    let sessionId: string | null = null;
    try {
      const raw = await readRequestBody(req);
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as { sessionId?: string | null };
        if (typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) {
          sessionId = parsed.sessionId.trim();
        }
      }
    } catch {
      /* ignore malformed body */
    }
    const { subscribedAt } = recordBlackboardSubscribeInterest(teamId, sessionId);
    sendJson(res, 200, {
      ok: true,
      data: {
        teamId,
        sessionId,
        channel: 'websocket' as const,
        message: '已登记对本团队黑板更新的关注。实际推送通过既有 WebSocket（如 team-status、各类控制/黑板相关事件）下发；请保持页面 WS 连接，并可用 GET /api/teams/:teamId/blackboard 轮询作兜底。',
        subscribedAt,
      },
    });
    return true;
  }

  return false;
}
