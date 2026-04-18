import { randomUUID } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { InboundMessage, OutboundMessage, WebSocketClient } from '../core/types/index.js';
import { parseBlackboardProtocolGuard, resolveBlackboardCoordinatorMode } from '../core/runtime/blackboard-coordinator.js';
import { resolveWaitingUserTasks } from '../core/runtime/waiting-user.js';
import { archiveDoneFactsForRequest, buildBlackboardFinalReply, finalizeBlackboardSynthesis } from '../core/runtime/blackboard-synthesis.js';
import { getBlackboardStore } from '../core/store/blackboard-store.js';
import { getRequestStateStore } from '../core/store/request-state-store.js';
import { getTaskStateStore } from '../core/store/task-state-store.js';
import { getTeamRuntimeStateStore } from '../core/store/team-runtime-state-store.js';
import { getConversationFactsStore } from '../core/store/conversation-facts-store.js';
import { getSessionContextStore } from '../core/store/session-context-store.js';
import { getTeamChatStore } from '../core/store/team-chat-store.js';
import { getAllTeams, getTeamRegistry, loadTeamsFromDirectory } from '../core/team/registry.js';
import { resolveAgentArtifactsRoot } from '../core/runtime/agent-artifacts.js';
import type { RequestCompletionMode } from '../core/runtime/request-completion-policy.js';
import { setBlackboardDispatchRunner, triggerBlackboardDispatch } from './ws/blackboard-runtime-loop.js';
import { createAgentDelivery } from './ws/agent-delivery.js';
import { createAgentResponseEventHandler } from './ws/agent-response-events.js';
import { recordDeliveryContext } from './ws/delivery-context.js';
import { persistSharedChatMessage } from './ws/message-persistence.js';
import { disposeSupervisorSession, listSupervisorSessions } from './runtime/supervisor-client.js';
import { deriveRequestScopedRuntimeDiagnostics } from './runtime/request-scoped-diagnostics.js';
import { resolveRuntimeBackend } from './runtime/session-runner-registry.js';
import { probeRequestRuntimeDiagnostics } from './runtime/request-runtime-probe.js';
import { deriveRequestStatusFailureView } from './runtime/request-status-view.js';
import { coordinatorControlTaskId, ensureCoordinatorSynthesisTask, queueCoordinatorControlTask, settleActiveCoordinatorControlTasks } from './runtime/request-finalization.js';
import { indexRequestProjectArtifacts } from './runtime/project-workspace-artifact-index.js';
import { TEAMS_DIR } from './utils/paths.js';
import type { TaskFact } from '../core/runtime/blackboard-types.js';

type BroadcastCallback = (teamId: string, message: OutboundMessage) => void;

function isCoordinatorControlFact(fact: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.id.startsWith('coordinator:');
}

type RouterMessageInput = {
  from: string;
  to: string;
  body: string;
  requestId?: string;
  sessionId?: string;
  coordinatorAgentId?: string;
  sourceClientId?: string;
  isPrivate?: boolean;
  projectId?: string;
  currentProjectWorkspace?: InboundMessage['context']['currentProjectWorkspace'];
};

export interface RouterHandleResult {
  requestId: string;
  sessionId: string;
  taskId: string | null;
  waitingResolvedTaskIds: string[];
  requestState: string | null;
}

let broadcastCallback: BroadcastCallback | null = null;

const requestSessionBindings = new Map<string, string>();
const MAX_AUTO_RESET_COORDINATOR_RECOVERY_FAILURES = 3;

function nowIso(): string {
  return new Date().toISOString();
}

function makeBindingKey(teamId: string, requestId: string): string {
  return `${teamId}:${requestId}`;
}

function ensureRequestId(requestId?: string | null): string {
  return String(requestId || '').trim() || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function countCoordinatorRecoveryAutoResets(task: { failureHistory?: Array<{ resetKind?: string | null; blockedBy?: { retryable?: boolean | null } | null }> }): number {
  return (task.failureHistory || []).filter((event) =>
    event.resetKind === 'hosted_run_recovery_reset'
    && event.blockedBy?.retryable === true,
  ).length;
}

function markActiveCoordinatorFactsDone(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  result: string;
}): string[] {
  const board = getBlackboardStore();
  const changed: string[] = [];
  const activeCoordinatorFacts = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  }).filter((fact) =>
    fact.requiredCapability === 'coordination'
    && (fact.status === 'pending' || fact.status === 'running'),
  );
  for (const fact of activeCoordinatorFacts) {
    const next = board.write(args.teamId, args.chatSessionId, {
      id: fact.id,
      revision: fact.revision,
      status: 'done',
      owner: fact.owner,
      currentRunId: fact.currentRunId,
      result: args.result,
    });
    if (next) {
      changed.push(next.id);
    }
  }
  return changed;
}

function ensureCoordinatorRecoveryTask(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
}): string[] {
  const board = getBlackboardStore();
  const requestState = getRequestStateStore().getRequestForSession(args.teamId, args.requestId, args.chatSessionId);
  const snapshot = resolveBlackboardCoordinatorMode({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState,
  });
  if (snapshot.mode !== 'recovery' || snapshot.recoverableFacts.length === 0) {
    return [];
  }

  const activeCoordinatorFacts = snapshot.facts.filter((fact) =>
    fact.requiredCapability === 'coordination'
    && (fact.status === 'pending' || fact.status === 'running'),
  );
  if (activeCoordinatorFacts.length > 0) {
    return [];
  }
  const latestRecoverableUpdatedAt = snapshot.recoverableFacts.reduce(
    (max, fact) => Math.max(max, Number(fact.updatedAt || 0)),
    0,
  );
  const canonicalTask = board.get(args.teamId, args.chatSessionId, coordinatorControlTaskId(args.requestId));
  if (
    canonicalTask
    && (canonicalTask.status === 'blocked' || canonicalTask.status === 'failed')
    && canonicalTask.blockedBy?.retryable === false
    && Number(canonicalTask.updatedAt || 0) >= latestRecoverableUpdatedAt
  ) {
    return [];
  }
  if (
    canonicalTask
    && (canonicalTask.status === 'blocked' || canonicalTask.status === 'failed')
    && canonicalTask.blockedBy?.retryable
    && Number(canonicalTask.updatedAt || 0) >= latestRecoverableUpdatedAt
  ) {
    if (countCoordinatorRecoveryAutoResets(canonicalTask) >= MAX_AUTO_RESET_COORDINATOR_RECOVERY_FAILURES) {
      return [];
    }
  }

  return queueCoordinatorControlTask({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorId: args.coordinatorId,
    phase: 'recovery',
    requestGoal: snapshot.facts.find((fact) => fact.id === coordinatorControlTaskId(args.requestId))?.goal || null,
    recoverableIds: snapshot.recoverableFacts.map((fact) => fact.id),
  });
}

export function finalizeSynthesizedRequestIfReady(input: {
  teamId: string;
  requestId: string;
  chatSessionId: string;
  coordinatorId?: string | null;
}): { finalized: boolean; body: string; changedTaskIds: string[]; reason: string } {
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const requestState = requestStore.getRequestForSession(input.teamId, input.requestId, input.chatSessionId);
  const snapshot = resolveBlackboardCoordinatorMode({
    board,
    teamId: input.teamId,
    chatSessionId: input.chatSessionId,
    requestId: input.requestId,
    requestState,
  });
  if (snapshot.mode !== 'synthesize') {
    return {
      finalized: false,
      body: '',
      changedTaskIds: [],
      reason: snapshot.reason,
    };
  }
  const coordinatorId = requestStore.resolveCoordinatorForSession(
    input.teamId,
    input.requestId,
    input.chatSessionId,
    input.coordinatorId || null,
  );
  const canonicalCoordinatorTask = board.get(
    input.teamId,
    input.chatSessionId,
    coordinatorControlTaskId(input.requestId),
  );
  const changedTaskIds = coordinatorId
    ? ensureCoordinatorSynthesisTask({
        teamId: input.teamId,
        chatSessionId: input.chatSessionId,
        requestId: input.requestId,
        coordinatorId,
      })
    : [];
  const terminalSynthesizeFailure =
    canonicalCoordinatorTask
    && snapshot.facts.some((fact) => !isCoordinatorControlFact(fact))
    && (
      canonicalCoordinatorTask.status === 'failed'
      || (
        canonicalCoordinatorTask.status === 'blocked'
        && canonicalCoordinatorTask.blockedBy?.retryable === false
      )
    );
  if (coordinatorId && changedTaskIds.length === 0 && terminalSynthesizeFailure) {
    const fallbackBody = buildBlackboardFinalReply({
      board,
      teamId: input.teamId,
      chatSessionId: input.chatSessionId,
      requestId: input.requestId,
    });
    const published = publishBlackboardFinalAnswer({
      teamId: input.teamId,
      requestId: input.requestId,
      sessionId: input.chatSessionId,
      from: coordinatorId,
      body: fallbackBody,
      isPrivate: false,
    });
    if (published.published) {
      return {
        finalized: true,
        body: published.body,
        changedTaskIds: [],
        reason: 'published fallback final answer after terminal synthesize failure',
      };
    }
  }
  return {
    finalized: false,
    body: '',
    changedTaskIds,
    reason: coordinatorId
      ? (
          changedTaskIds.length > 0
            ? 'queued a coordinator synthesize task; waiting for a coordinator-authored final answer'
            : 'automatic system synthesis is disabled; waiting for a coordinator-authored final answer'
        )
      : 'automatic system synthesis is disabled; no coordinator is currently assigned to publish the final answer',
  };
}

export function ensureCoordinatorRecoveryIfNeeded(input: {
  teamId: string;
  requestId: string;
  chatSessionId: string;
  coordinatorId?: string | null;
}): { queued: boolean; changedTaskIds: string[]; reason: string } {
  const requestStore = getRequestStateStore();
  const requestState = requestStore.getRequestForSession(input.teamId, input.requestId, input.chatSessionId);
  if (requestState?.finalPublished) {
    return {
      queued: false,
      changedTaskIds: [],
      reason: 'request already published final answer; skipping coordinator recovery',
    };
  }
  const coordinatorId = requestStore.resolveCoordinatorForSession(
    input.teamId,
    input.requestId,
    input.chatSessionId,
    input.coordinatorId || null,
  );
  if (!coordinatorId) {
    return {
      queued: false,
      changedTaskIds: [],
      reason: 'no coordinator is currently assigned to handle recovery',
    };
  }
  const changedTaskIds = ensureCoordinatorRecoveryTask({
    teamId: input.teamId,
    chatSessionId: input.chatSessionId,
    requestId: input.requestId,
    coordinatorId,
  });
  return {
    queued: changedTaskIds.length > 0,
    changedTaskIds,
    reason: changedTaskIds.length > 0
      ? 'queued a coordinator recovery task for recoverable blocked/failed work'
      : 'recovery mode does not currently require a new coordinator task',
  };
}

function resolveReplyTargetRequestId(teamId: string, requestId: string | null | undefined): string | null {
  const normalized = String(requestId || '').trim();
  if (normalized) {
    return normalized;
  }
  const sessionId = getTeamChatStore().getActiveSessionId(teamId);
  const candidates = getRequestStateStore()
    .listRequests(teamId, sessionId)
    .filter((item) => item.state === 'waiting_user')
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  return candidates[0]?.requestId || null;
}

function requestTaskId(requestId: string): string {
  return coordinatorControlTaskId(requestId);
}

function resolveRequestCoordinatorId(args: {
  teamId: string;
  requestId: string;
  chatSessionId: string;
  registry: ReturnType<typeof getTeamRegistry> | null | undefined;
  requestedCoordinatorId?: string | null;
  fallbackTargetAgentId?: string | null;
}): string {
  const registry = args.registry || null;
  const explicitCoordinatorId = String(args.requestedCoordinatorId || '').trim();
  if (explicitCoordinatorId && registry?.isMember(explicitCoordinatorId)) {
    return explicitCoordinatorId;
  }
  const fallbackCoordinatorId = registry?.getCoordinator?.()
    || (args.fallbackTargetAgentId && registry?.isMember(args.fallbackTargetAgentId) ? args.fallbackTargetAgentId : null)
    || args.fallbackTargetAgentId
    || 'coordinator';
  return getRequestStateStore().resolveCoordinatorForSession(
    args.teamId,
    args.requestId,
    args.chatSessionId,
    fallbackCoordinatorId,
  ) || fallbackCoordinatorId;
}

function emit(teamId: string, message: OutboundMessage): void {
  broadcastCallback?.(teamId, message);
}

function bindRequestSession(teamId: string, requestId: string, sessionId: string): void {
  requestSessionBindings.set(makeBindingKey(teamId, requestId), sessionId);
}

function resolveBlackboardSessionId(teamId: string, requestId: string): string | null {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return null;
  }
  const teamDir = join(process.cwd(), 'data', 'blackboard', teamId);
  if (!existsSync(teamDir)) {
    return null;
  }

  let bestMatch: { sessionId: string; score: number } | null = null;
  for (const entry of readdirSync(teamDir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const payload = JSON.parse(readFileSync(join(teamDir, entry), 'utf-8')) as {
        active?: Array<{ requestId?: string; status?: string; requiredCapability?: string }>;
        archive?: Array<{ requestId?: string; status?: string; requiredCapability?: string }>;
      };
      const facts = [...(payload.active || []), ...(payload.archive || [])]
        .filter((fact) => String(fact.requestId || '').trim() === normalizedRequestId);
      if (facts.length === 0) {
        continue;
      }
      const hasWaitingUser = facts.some((fact) => fact.status === 'waiting_user');
      const hasNonCoordinator = facts.some((fact) => {
        const capability = String(fact.requiredCapability || '').trim();
        return capability && capability !== 'coordination';
      });
      const hasActiveNonCoordinator = facts.some((fact) => {
        const capability = String(fact.requiredCapability || '').trim();
        return capability !== 'coordination' && fact.status && fact.status !== 'done';
      });
      const hasActive = facts.some((fact) => fact.status && fact.status !== 'done');
      const score =
        (hasWaitingUser ? 100 : 0)
        + (hasNonCoordinator ? 50 : 0)
        + (hasActiveNonCoordinator ? 25 : 0)
        + (hasActive ? 10 : 0)
        + facts.length;
      const sessionId = entry.replace(/\.json$/i, '');
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { sessionId, score };
      }
    } catch {
      continue;
    }
  }

  return bestMatch?.sessionId || null;
}

function resolvePersistedRequestSessionId(teamId: string, requestId: string): string | null {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return null;
  }
  const blackboardSessionId = resolveBlackboardSessionId(teamId, normalizedRequestId);
  if (blackboardSessionId) {
    bindRequestSession(teamId, normalizedRequestId, blackboardSessionId);
    return blackboardSessionId;
  }
  const requestStore = getRequestStateStore();
  const chatStore = getTeamChatStore();
  for (const session of chatStore.listSessions(teamId)) {
    const record = requestStore.getRequestForSession(teamId, normalizedRequestId, session.sessionId);
    if (record) {
      bindRequestSession(teamId, normalizedRequestId, session.sessionId);
      return session.sessionId;
    }
  }
  return null;
}

function unbindRequestSessions(teamId: string, sessionId?: string | null): void {
  for (const [bindingKey, boundSessionId] of Array.from(requestSessionBindings.entries())) {
    if (!bindingKey.startsWith(`${teamId}:`)) {
      continue;
    }
    if (sessionId && boundSessionId !== sessionId) {
      continue;
    }
    requestSessionBindings.delete(bindingKey);
  }
}

function listBlackboardSessionsForRequest(teamId: string, requestId: string): string[] {
  const normalizedRequestId = String(requestId || '').trim();
  if (!normalizedRequestId) {
    return [];
  }
  const teamDir = join(process.cwd(), 'data', 'blackboard', teamId);
  if (!existsSync(teamDir)) {
    return [];
  }
  const sessionIds: string[] = [];
  for (const entry of readdirSync(teamDir)) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    try {
      const payload = JSON.parse(readFileSync(join(teamDir, entry), 'utf-8')) as {
        active?: Array<{ requestId?: string }>;
        archive?: Array<{ requestId?: string }>;
      };
      const facts = [...(payload.active || []), ...(payload.archive || [])];
      if (facts.some((fact) => String(fact.requestId || '').trim() === normalizedRequestId)) {
        sessionIds.push(entry.replace(/\.json$/i, ''));
      }
    } catch {
      continue;
    }
  }
  return sessionIds;
}

async function cleanupDuplicateRequestSessions(args: {
  teamId: string;
  requestId: string;
  canonicalSessionId: string;
  registry?: ReturnType<typeof getTeamRegistry>;
}): Promise<void> {
  const normalizedRequestId = String(args.requestId || '').trim();
  if (!normalizedRequestId) {
    return;
  }
  const allSessionIds = listBlackboardSessionsForRequest(args.teamId, normalizedRequestId);
  const duplicateSessionIds = allSessionIds.filter((sessionId) => sessionId !== args.canonicalSessionId);
  if (duplicateSessionIds.length === 0) {
    return;
  }
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  for (const sessionId of duplicateSessionIds) {
    const staleFacts = board.list(args.teamId, sessionId, {
      requestId: normalizedRequestId,
      includeArchive: true,
    });
    if (staleFacts.length > 0) {
      board.remove(args.teamId, sessionId, staleFacts.map((fact) => fact.id));
      requestStore.clearRequestForSession(args.teamId, normalizedRequestId, sessionId);
      unbindRequestSessions(args.teamId, sessionId);
    }
  }

  if (!args.registry) {
    return;
  }
  try {
    const runtime = resolveRuntimeBackend(args.registry.raw.runtime);
    const sessions = await listSupervisorSessions(runtime, args.teamId);
    await Promise.all(
      sessions
        .filter((session) =>
          session.sessionMode === 'ephemeral'
          && !!session.cacheKey
          && (
            String(session.currentRequestId || '').trim() === normalizedRequestId
            || String(session.lastRequestId || '').trim() === normalizedRequestId
          ),
        )
        .map(async (session) => {
          try {
            await disposeSupervisorSession(runtime, {
              teamId: args.teamId,
              agentId: session.agentId,
              cacheKey: session.cacheKey,
              persistentKey: session.persistentKey,
              reason: `dispose duplicate request session for ${normalizedRequestId}`,
            });
          } catch (error) {
            console.warn('[WS] Failed to dispose duplicate request runtime session:', error);
          }
        }),
    );
  } catch (error) {
    console.warn('[WS] Failed to inspect runtime sessions while cleaning duplicate request sessions:', error);
  }
}

function resolveChatSessionId(teamId: string, requestId?: string | null): string {
  const normalizedRequestId = String(requestId || '').trim();
  if (normalizedRequestId) {
    const existing = requestSessionBindings.get(makeBindingKey(teamId, normalizedRequestId));
    if (existing) {
      return existing;
    }
    const persisted = resolvePersistedRequestSessionId(teamId, normalizedRequestId);
    if (persisted) {
      return persisted;
    }
  }
  return getTeamChatStore().getActiveSessionId(teamId);
}

function resolveRouterSessionId(teamId: string, input: { requestId?: string | null; sessionId?: string | null }): string {
  const explicitSessionId = String(input.sessionId || '').trim();
  if (explicitSessionId) {
    return explicitSessionId;
  }
  return resolveChatSessionId(teamId, input.requestId);
}

function appendTeamMessage(
  teamId: string,
  sessionId: string,
  input: {
    agent: string;
    text: string;
    requestId: string;
    messageId?: string;
  },
): void {
  getTeamChatStore().appendMessage(teamId, {
    messageId: input.messageId || `msg-${teamId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent: input.agent,
    text: input.text,
    time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    requestId: input.requestId,
    timestamp: nowIso(),
  }, sessionId);
}

function emitControlEvent(teamId: string, requestId: string, coordinatorId: string, body: string): void {
  emit(teamId, {
    type: 'control-event',
    from: 'system',
    to: coordinatorId,
    body,
    requestId,
    timestamp: nowIso(),
  });
}

function buildBlackboardWakeupBody(requestId: string, reason: 'tasks_blocked' | 'summary_ready', sourceAgent?: string | null): string {
  return [
    '[[BLACKBOARD_WAKEUP]]',
    `requestId: ${requestId}`,
    `reason: ${reason}`,
    `sourceAgent: ${String(sourceAgent || 'system').trim() || 'system'}`,
    'rule: re-read current blackboard facts and continue in the mode implied by the board.',
    '[[/BLACKBOARD_WAKEUP]]',
  ].join('\n');
}

function buildCoordinatorSessionLane(requestId?: string | null): string {
  return `coord-${requestId || 'main'}`;
}

function resolveDispatchSessionLane(teamId: string, agentId: string, msg: { requestId?: string | null }): string {
  const registry = getTeamRegistry(teamId);
  const coordinatorId = registry?.getCoordinator?.();
  if (coordinatorId && agentId === coordinatorId) {
    return buildCoordinatorSessionLane(msg.requestId);
  }
  return msg.requestId || 'main';
}

const agentResponseEventHandler = createAgentResponseEventHandler({
  resolveChatSessionId,
  normalizeExecutorEvidence: (body) => body,
  resolveExecutorResultTaskId: () => null,
  persistSharedChatMessage,
  teamChatStore: getTeamChatStore(),
  getBroadcastCallback: () => broadcastCallback,
  defaultExecutorMaxWorkMinutes: 30,
  executorReportGraceMs: 60_000,
});

async function handleRuntimeAgentResponse(
  response: import('./runtime/agent-response.js').AgentResponse,
  context: {
    teamId: string;
    requestId: string | null;
    localFrom: string | null;
    sourceClientId: string | null;
    isPrivate: boolean;
    isStale: boolean;
  },
): Promise<void> {
  if (
    response.type === 'agent-stream'
    || response.type === 'agent-thinking'
    || response.type === 'agent-status'
    || response.type === 'runtime-tool-call'
    || response.type === 'runtime-permission-request'
  ) {
    agentResponseEventHandler.handleStream(response, context);
    return;
  }
  if (response.type === 'agent-error') {
    agentResponseEventHandler.handleError(response, context);
    return;
  }
  if (response.type === 'agent-reply') {
    await agentResponseEventHandler.handleFinal(response, context);
  }
}

const blackboardAgentDelivery = createAgentDelivery({
  buildAgentInputBody: (_agentId, msg) => String(msg.body || ''),
  broadcastMessage: (teamId, message) => emit(teamId, message),
  getSessionContextStore,
  getCoordinationFactsByRequest: () => new Map(),
  getRequestKey: (teamId, requestId) => `${teamId}:${requestId}`,
  resolveChatSessionId,
  onAgentResponse: handleRuntimeAgentResponse,
  recordDeliveryContext,
  resolveSessionLaneForDelivery: resolveDispatchSessionLane,
  harnessRunRecorder: {
    recordMessageDelivered: () => {},
    recordMessageIntercepted: () => {},
  },
  defaultExecutorMaxWorkMinutes: 30,
  executorReportGraceMs: 60_000,
});

function ensureCoordinatorTask(args: {
  teamId: string;
  sessionId: string;
  requestId: string;
  body: string;
  projectId?: string;
  currentProjectWorkspace?: InboundMessage['context']['currentProjectWorkspace'];
  coordinatorId: string;
  createdBy: string;
}): string {
  const canonicalTaskId = requestTaskId(args.requestId);
  const workspace = normalizeCurrentProjectWorkspace(args.currentProjectWorkspace, args.projectId, canonicalTaskId);
  queueCoordinatorControlTask({
    teamId: args.teamId,
    chatSessionId: args.sessionId,
    requestId: args.requestId,
    coordinatorId: args.coordinatorId,
    phase: 'decompose',
    requestGoal: args.body.trim() || 'Handle user request',
    workspaceId: workspace.workspaceId,
    cwd: workspace.cwd,
    allowedRoots: workspace.allowedRoots,
    artifactsRoot: workspace.artifactsRoot || resolveAgentArtifactsRoot(args.coordinatorId, canonicalTaskId, {
      teamId: args.teamId,
    }),
  });
  return canonicalTaskId;
}

function normalizeCurrentProjectWorkspace(
  workspace: InboundMessage['context']['currentProjectWorkspace'] | undefined,
  projectId: string | undefined,
  taskId: string,
): {
  workspaceId: string;
  cwd: string;
  allowedRoots: string[];
  artifactsRoot?: string;
  env: Record<string, string>;
} {
  const cwd = String(workspace?.cwd || '').trim() || process.cwd();
  const workspaceId = String(workspace?.workspaceId || projectId || '').trim() || 'local';
  const allowedRoots = Array.isArray(workspace?.allowedRoots) && workspace.allowedRoots.length
    ? workspace.allowedRoots.map((item) => String(item || '').trim()).filter(Boolean)
    : [cwd];
  const artifactBase = String(workspace?.artifactsRoot || '').trim();
  const artifactsRoot = artifactBase
    ? `${artifactBase.replace(/\/+$/, '')}/${taskId}`
    : undefined;
  const env: Record<string, string> = {
    ...(projectId ? { 'project.id': projectId } : {}),
    'workspace.id': workspaceId,
    'workspace.transport': String(workspace?.transport || 'local'),
    'workspace.cwd': cwd,
    'workspace.allowedRoots': allowedRoots.join(','),
    'workspace.defaultExecutionTarget': String(workspace?.defaultExecutionTarget || (workspace?.transport === 'ssh' ? 'remote' : 'local')),
    'workspace.networkMode': String(workspace?.networkMode || ''),
    'exec.cwd': cwd,
    'cwd.target': cwd,
  };
  if (artifactsRoot) {
    env['workspace.artifactsRoot'] = artifactsRoot;
  }
  if (workspace?.remoteSessionId) {
    env['workspace.remoteSessionId'] = workspace.remoteSessionId;
    env['remote.sessionId'] = workspace.remoteSessionId;
  }
  if (workspace?.checkedAt) {
    env['workspace.checkedAt'] = workspace.checkedAt;
  }
  return { workspaceId, cwd, allowedRoots, artifactsRoot, env };
}

function emitUserMessage(teamId: string, message: RouterMessageInput, requestId: string): void {
  emit(teamId, {
    type: 'user-message',
    from: message.from,
    to: message.to,
    body: message.body,
    requestId,
    sourceClientId: message.sourceClientId,
    isPrivate: message.isPrivate,
    timestamp: nowIso(),
  });
}

export function setBroadcastCallback(callback: BroadcastCallback): void {
  broadcastCallback = callback;
  setBlackboardDispatchRunner(async (input) => {
    let registry = getTeamRegistry(input.teamId);
    if (!registry) {
      loadTeamsFromDirectory(TEAMS_DIR);
      registry = getTeamRegistry(input.teamId);
    }
    if (!registry) {
      return [];
    }
    const { drainBlackboardDispatch } = await import('./ws/blackboard-dispatcher.js');
    const runtimeBusyAgentIds = new Set<string>();
    try {
      const runtime = resolveRuntimeBackend(registry.raw.runtime);
      const sessions = await listSupervisorSessions(runtime, input.teamId);
      const requestStateStore = getRequestStateStore();
      const scopedDiagnostics = deriveRequestScopedRuntimeDiagnostics({
        requests: requestStateStore.listRequests(input.teamId, input.chatSessionId),
        sessions,
        activeRequestId: input.requestId,
      });
      await Promise.all(
        scopedDiagnostics.disposableStaleSessions.map(async (session) => {
          try {
            await disposeSupervisorSession(runtime, {
              teamId: input.teamId,
              agentId: session.agentId,
              cacheKey: session.cacheKey,
              persistentKey: session.persistentKey,
              reason: `dispose stale request-scoped session for ${session.lastRequestId || session.currentRequestId || 'unknown-request'}`,
            });
          } catch (error) {
            console.warn('[WS] Failed to dispose stale runtime session before blackboard dispatch:', error);
          }
        }),
      );
      for (const agentId of scopedDiagnostics.busyAgentIdsForActiveRequest) {
        runtimeBusyAgentIds.add(agentId);
      }
    } catch (error) {
      console.warn('[WS] Failed to inspect runtime session busy state before blackboard dispatch:', error);
    }
    ensureCoordinatorRecoveryIfNeeded({
      teamId: input.teamId,
      requestId: input.requestId,
      chatSessionId: input.chatSessionId,
      coordinatorId: getRequestStateStore().resolveCoordinatorForSession(
        input.teamId,
        input.requestId,
        input.chatSessionId,
        registry.getCoordinator?.() || null,
      ),
    });
    const finalized = finalizeSynthesizedRequestIfReady({
      teamId: input.teamId,
      requestId: input.requestId,
      chatSessionId: input.chatSessionId,
      coordinatorId: getRequestStateStore().resolveCoordinatorForSession(
        input.teamId,
        input.requestId,
        input.chatSessionId,
        registry.getCoordinator?.() || null,
      ),
    });
    if (finalized.finalized) {
      return [];
    }
    return drainBlackboardDispatch({
      teamId: input.teamId,
      requestId: input.requestId,
      chatSessionId: input.chatSessionId,
      registry,
      runtimeBusyAgentIds,
      deliver: (message) => blackboardAgentDelivery(input.teamId, message),
    });
  });
}

export function publishBlackboardFinalAnswer(input: {
  teamId: string;
  requestId: string;
  sessionId?: string;
  body?: string | null;
  from?: string;
  sourceClientId?: string;
  isPrivate?: boolean;
  completionOverride?: {
    mode: Extract<RequestCompletionMode, 'direct_coordinator_answer'>;
    reason: string;
  };
}): { published: boolean; reason: string; body: string } {
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const sessionId = input.sessionId || resolveChatSessionId(input.teamId, input.requestId);
  const requestState = requestStore.getRequestForSession(input.teamId, input.requestId, sessionId);
  const body = String(input.body || '').trim();
  const coordinatorId = requestStore.resolveCoordinatorForSession(
    input.teamId,
    input.requestId,
    sessionId,
    input.from || null,
  ) || input.from || 'coordinator';

  if (!body) {
    return {
      published: false,
      reason: 'final reply body is required; system-side synthesis is disabled',
      body,
    };
  }

  const finalized = finalizeBlackboardSynthesis({
    board,
    teamId: input.teamId,
    chatSessionId: sessionId,
    requestId: input.requestId,
    requestState,
    onPublished: () => {
      requestStore.markFinalPublishedForSession(input.teamId, input.requestId, sessionId);
      settleActiveCoordinatorControlTasks({
        teamId: input.teamId,
        chatSessionId: sessionId,
        requestId: input.requestId,
      });
    },
  });

  const canForceCoordinatorOnlyFinal =
    input.completionOverride?.mode === 'direct_coordinator_answer'
    && !finalized.closed;
  if (!finalized.closed && canForceCoordinatorOnlyFinal) {
    archiveDoneFactsForRequest({
      board,
      teamId: input.teamId,
      chatSessionId: sessionId,
      requestId: input.requestId,
    });
    requestStore.markFinalPublishedForSession(input.teamId, input.requestId, sessionId);
    settleActiveCoordinatorControlTasks({
      teamId: input.teamId,
      chatSessionId: sessionId,
      requestId: input.requestId,
    });
  }

  if ((!finalized.closed && !canForceCoordinatorOnlyFinal) || !body) {
    return {
      published: false,
      reason: finalized.reason,
      body,
    };
  }

  const sessionContext = getSessionContextStore().getCurrent(input.teamId, sessionId);
  const requestTasks = board.list(input.teamId, sessionId, {
    requestId: input.requestId,
    includeArchive: true,
  });
  try {
    indexRequestProjectArtifacts({
      teamId: input.teamId,
      requestId: input.requestId,
      projectId: sessionContext?.env?.['project.id'] || null,
      tasks: requestTasks,
      finalAnswer: body,
    });
  } catch (err) {
    console.warn('[ProjectArtifacts] Failed to index final answer:', err);
  }

  appendTeamMessage(input.teamId, sessionId, {
    agent: coordinatorId,
    text: body,
    requestId: input.requestId,
  });
  emit(input.teamId, {
    type: 'agent-chat-final',
    from: coordinatorId,
    to: 'user',
    body,
    requestId: input.requestId,
    sourceClientId: input.sourceClientId,
    isPrivate: input.isPrivate,
    timestamp: nowIso(),
  });
  return {
    published: true,
    reason: finalized.closed ? finalized.reason : input.completionOverride?.reason || finalized.reason,
    body,
  };
}

export async function handleMessageViaRouter(
  teamId: string,
  message: RouterMessageInput,
): Promise<RouterHandleResult> {
  const registry = getTeamRegistry(teamId);
  const requestId = ensureRequestId(resolveReplyTargetRequestId(teamId, message.requestId));
  const sessionId = resolveRouterSessionId(teamId, {
    requestId,
    sessionId: message.sessionId,
  });
  const coordinatorId = resolveRequestCoordinatorId({
    teamId,
    requestId,
    chatSessionId: sessionId,
    registry,
    requestedCoordinatorId: message.coordinatorAgentId || (registry?.isCoordinator(message.to) ? message.to : null),
    fallbackTargetAgentId: message.to,
  });
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();

  await cleanupDuplicateRequestSessions({
    teamId,
    requestId,
    canonicalSessionId: sessionId,
    registry,
  });
  bindRequestSession(teamId, requestId, sessionId);
  const currentProjectWorkspace = normalizeCurrentProjectWorkspace(
    message.currentProjectWorkspace,
    message.projectId,
    requestTaskId(requestId),
  );
  getSessionContextStore().mergeForSession(teamId, sessionId, {
    requestId,
    envPatch: {
      'team.active': teamId,
      'team.id': teamId,
      'request.id': requestId,
      ...currentProjectWorkspace.env,
    },
    incrementRevision: true,
  });
  requestStore.markOpenForSession(teamId, requestId, sessionId, {
    coordinatorAgentId: coordinatorId,
  });

  appendTeamMessage(teamId, sessionId, {
    agent: message.from || 'user',
    text: message.body,
    requestId,
  });
  emitUserMessage(teamId, message, requestId);

  const resolvedWaiting = resolveWaitingUserTasks(board, {
    teamId,
    chatSessionId: sessionId,
    requestId,
    userReply: message.body,
    limit: 8,
  });
  const protocolGuard = parseBlackboardProtocolGuard(message.body);

  let taskId: string | null = null;
  if (resolvedWaiting.length > 0) {
    requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
    taskId = ensureCoordinatorTask({
      teamId,
      sessionId,
      requestId,
      body: buildBlackboardWakeupBody(requestId, 'tasks_blocked', 'user'),
      currentProjectWorkspace: message.currentProjectWorkspace,
      coordinatorId,
      createdBy: 'system',
    });
    emitControlEvent(
      teamId,
      requestId,
      coordinatorId,
      buildBlackboardWakeupBody(requestId, 'tasks_blocked', 'user'),
    );
  } else {
    taskId = ensureCoordinatorTask({
      teamId,
      sessionId,
      requestId,
      body: message.body,
      projectId: message.projectId,
      currentProjectWorkspace: message.currentProjectWorkspace,
      coordinatorId,
      createdBy: message.from || 'user',
    });
    requestStore.syncTaskSnapshotForSession(teamId, requestId, sessionId);
    emitControlEvent(
      teamId,
      requestId,
      coordinatorId,
      protocolGuard
        ? message.body
        : buildBlackboardWakeupBody(requestId, 'tasks_blocked', message.from || 'user'),
    );
  }
  await triggerBlackboardDispatch({
    teamId,
    requestId,
    chatSessionId: sessionId,
  });

  const nextRequestState = requestStore.getRequestForSession(teamId, requestId, sessionId);
  const { runtimeDiagnostics, transportError: runtimeTransportError } = await probeRequestRuntimeDiagnostics({
    teamId,
    requests: requestStore.listRequests(teamId, sessionId),
    activeRequestId: requestId,
  });
  if (runtimeTransportError) {
    console.warn('[WS] Failed to derive request-scoped runtime blockers for team-status:', new Error(runtimeTransportError));
  }
  const requestTasks = getBlackboardStore()
    .list(teamId, sessionId, { includeArchive: true })
    .filter((task) => task.requestId === requestId);
  const failureView = deriveRequestStatusFailureView({
    teamId,
    chatSessionId: sessionId,
    requestId,
    requestState: nextRequestState?.state || null,
    requestFinalPublished: nextRequestState?.finalPublished === true,
    tasks: requestTasks,
    runtimeDiagnostics,
    transportError: runtimeTransportError,
  });
  emit(teamId, {
    type: 'team-status',
    from: 'system',
    body: JSON.stringify({
      requestId,
      state: nextRequestState?.state || 'open',
      stateReason: nextRequestState?.stateReason || null,
      resumable: nextRequestState?.resumable ?? true,
      focusTaskIds: nextRequestState?.focusTaskIds || [],
      doneEvidenceGapCount: nextRequestState?.doneEvidenceGapCount || 0,
      doneEvidenceGapTaskIds: nextRequestState?.doneEvidenceGapTaskIds || [],
      doneEvidenceGaps: nextRequestState?.doneEvidenceGaps || [],
      runtimeActiveSessionCount: failureView.runtimeBlockers.runtimeActiveSessionCount,
      runtimeBlockingStaleSessionCount: failureView.runtimeBlockers.runtimeBlockingStaleSessionCount,
      runtimeBlockingStaleAgentIds: failureView.runtimeBlockers.runtimeBlockingStaleAgentIds,
      runtimeBlockedReason: failureView.runtimeBlockers.runtimeBlockedReason,
      runtimeTaskLiveness: failureView.runtimeBlockers.runtimeTaskLiveness,
      failureCategory: failureView.failureCategory,
      failureSummary: failureView.failureSummary,
      failureTaskIds: failureView.failureTaskIds,
      closureMode: failureView.closureMode,
      failureTransport: failureView.failureTransport,
      resumedFromWaitingUser: resolvedWaiting.length > 0,
      waitingResolvedTaskIds: resolvedWaiting.map((task) => task.id),
      coordinatorTaskId: taskId,
    }),
    requestId,
    timestamp: nowIso(),
  });

  return {
    requestId,
    sessionId,
    taskId,
    waitingResolvedTaskIds: resolvedWaiting.map((task) => task.id),
    requestState: nextRequestState?.state || null,
  };
}

export async function handleInboundMessage(message: InboundMessage, client: WebSocketClient): Promise<OutboundMessage | null> {
  if (message.type !== 'user-message') {
    return {
      type: 'error',
      error: `Unsupported inbound message type: ${String((message as { type?: string }).type || 'unknown')}`,
      timestamp: nowIso(),
    };
  }

  const requestedTeamId = message.context?.teamId;
  if (!requestedTeamId) {
    return {
      type: 'error',
      error: 'Missing context.teamId',
      timestamp: nowIso(),
    };
  }

  const resolvedTeamId = resolveTeamIdForTargetAgent(requestedTeamId, message.to);
  if (!resolvedTeamId) {
    return {
      type: 'error',
      error: `No available team found for agent "${message.to}"`,
      timestamp: nowIso(),
    };
  }

  const isTestChatDirect = Boolean((message as any)?.context?.testChatDirect);
  if (isTestChatDirect) {
    const requestId = ensureRequestId(message.requestId);
    await blackboardAgentDelivery(resolvedTeamId, {
      id: `direct-${randomUUID()}`,
      from: 'user',
      to: message.to,
      body: message.body,
      replyTo: null,
      mentions: [message.to],
      timestamp: Date.now(),
      teamId: resolvedTeamId,
      requestId,
      isPrivate: false,
      stale: false,
      messagePlane: 'control',
    });
    return null;
  }

  await handleMessageViaRouter(resolvedTeamId, {
      from: 'user',
      to: message.to,
      body: message.body,
      requestId: message.requestId,
      sessionId: message.sessionId || client.sessionId,
      coordinatorAgentId: (message as any).context?.coordinatorAgentId,
      projectId: message.context?.projectId,
      currentProjectWorkspace: message.context?.currentProjectWorkspace,
      sourceClientId: client.id,
    });

  return null;
}

function resolveTeamIdForTargetAgent(requestedTeamId: string, targetAgentId: string): string | null {
  let registry = getTeamRegistry(requestedTeamId);
  if (!registry) {
    loadTeamsFromDirectory(TEAMS_DIR);
    registry = getTeamRegistry(requestedTeamId);
  }

  if (registry && registry.isMember(targetAgentId)) {
    return requestedTeamId;
  }

  const fallbackIds = ['default', 'vibe-coding'];
  for (const fallbackId of fallbackIds) {
    const fallbackRegistry = getTeamRegistry(fallbackId);
    if (fallbackRegistry && fallbackRegistry.isMember(targetAgentId)) {
      return fallbackId;
    }
  }

  for (const team of getAllTeams()) {
    if (team.isMember(targetAgentId)) {
      return team.id;
    }
  }

  return null;
}

export function resetTeamConversationRuntime(
  teamId: string,
  options?: {
    clearConversationFacts?: boolean;
    clearSessionContext?: boolean;
    clearTaskState?: boolean;
    clearAcrossAllSessions?: boolean;
    dropInactiveChatSessions?: boolean;
    clearChatHistory?: boolean;
  },
): void {
  const chatStore = getTeamChatStore();
  const clearChatHistory = options?.clearChatHistory === true;
  const clearAcrossAllSessions =
    options?.clearAcrossAllSessions === true
    || clearChatHistory;
  if (clearChatHistory) {
    chatStore.clearHistory(teamId);
  }
  const activeSessionId = chatStore.getActiveSessionId(teamId);
  const sessionIds = clearAcrossAllSessions
    ? chatStore.listSessions(teamId).map((session) => session.sessionId)
    : [activeSessionId];
  const board = getBlackboardStore();

  if (options?.clearConversationFacts) {
    getConversationFactsStore().clear(teamId, clearAcrossAllSessions ? null : activeSessionId);
  }
  if (options?.clearSessionContext) {
    getSessionContextStore().clear(teamId, clearAcrossAllSessions ? null : activeSessionId);
  }
  if (options?.clearTaskState) {
    board.clear(teamId, clearAcrossAllSessions ? undefined : activeSessionId);
  }

  if (clearAcrossAllSessions) {
    unbindRequestSessions(teamId);
    getRequestStateStore().clear(teamId);
    getTaskStateStore().clear(teamId);
    getTeamRuntimeStateStore().clear(teamId);
  } else {
    unbindRequestSessions(teamId, activeSessionId);
    getRequestStateStore().clear(teamId, activeSessionId);
    getTaskStateStore().clear(teamId, activeSessionId);
    getTeamRuntimeStateStore().clear(teamId, activeSessionId);
  }

  if (options?.dropInactiveChatSessions) {
    for (const sessionId of sessionIds) {
      if (sessionId === activeSessionId) {
        continue;
      }
      chatStore.deleteSession(teamId, sessionId);
    }
  }
}

export function createRouterRequestId(): string {
  return `req-${randomUUID()}`;
}
