import type { OutboundMessage } from '../../core/types/index.js';
import type { AgentResponse } from '../runtime/agent-response.js';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../core/store/request-state-store.js';
import { getSessionContextStore } from '../../core/store/session-context-store.js';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';
import { getTeamRegistry } from '../../core/team/registry.js';
import { applyCoordinatorOutputToBlackboard } from './blackboard-coordinator-apply.js';
import { formatCoordinatorOutputForDisplay } from '../../core/runtime/coordinator-context.js';
import type { CoordinatorOutput } from '../../core/runtime/coordinator-context.js';
import { triggerBlackboardDispatch } from './blackboard-runtime-loop.js';
import { hasAssignedSubstantiveRuntimeTask } from './agent-delivery.js';
import { extractTaskEvidenceBlock, inferTaskEvidenceFromSummary, validateTaskCompletionEvidence, type TaskEvidenceDiagnostics } from './task-completion-evidence.js';
import { extractTaskProposalBlock } from './task-proposal-evidence.js';
import {
  isAutoApprovableProposalKind,
  latestDecisionForProposal,
} from '../../core/runtime/blackboard-proposals.js';
import { requiresStructuredSourceEvidence } from '../../core/runtime/task-evidence.js';
import type { BlockedBy } from '../../core/runtime/blackboard-types.js';
import { extendLeaseWithoutShortening } from '../../core/runtime/agent-liveness.js';
import { indexRequestProjectArtifacts } from '../runtime/project-workspace-artifact-index.js';

interface AgentResponseEventContext {
  teamId: string;
  requestId: string | null;
  localFrom: string | null;
  sourceClientId: string | null;
  isPrivate: boolean;
  isStale: boolean;
}

interface AgentResponseEventDeps {
  resolveChatSessionId: (teamId: string, requestId?: string | null) => string;
  normalizeExecutorEvidence: (body: string) => string;
  resolveExecutorResultTaskId: (
    teamId: string,
    requestId: string,
    agentId: string,
    explicitTaskId: string | null,
    sessionId?: string | null,
  ) => string | null;
  persistSharedChatMessage: typeof import('./message-persistence.js').persistSharedChatMessage;
  teamChatStore: ReturnType<typeof import('../../core/store/team-chat-store.js').getTeamChatStore>;
  getBroadcastCallback: () => ((teamId: string, message: OutboundMessage) => void) | null;
  defaultExecutorMaxWorkMinutes: number;
  executorReportGraceMs: number;
}

function compactText(value: string | null | undefined, max = 220): string | null {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function looksLikeEmbeddedToolCallResult(body: string | null | undefined): boolean {
  const normalized = String(body || '');
  if (!normalized.trim()) {
    return false;
  }
  return /<minimax:tool_call>/i.test(normalized)
    || /<tool_call>/i.test(normalized)
    || /<invoke\s+name=/i.test(normalized)
    || /<\/invoke>/i.test(normalized);
}

function looksLikePlannedButUnexecutedShellWork(body: string | null | undefined): boolean {
  const normalized = String(body || '');
  if (!normalized.trim()) {
    return false;
  }
  const hasBashFence = /```(?:bash|sh|shell)\b[\s\S]*?```/i.test(normalized);
  const hasPlanLanguage = /(让我执行|我来(?:先)?(?:检查|验证|准备|执行)|逐步检查|以下检查|将执行|准备执行|先检查)/i.test(normalized);
  const hasShellFlow = /\b(if\s+\[|for\s+\w+\s+in|find\s+\/|ls\s+-la|cat\s+\/|curl\s+|rg\s+|grep\s+)/i.test(normalized);
  const hasObservedOutput = /(exit_code=|stdout:|stderr:|path=|status=success|status=failure)/i.test(normalized);
  return hasBashFence && (hasPlanLanguage || hasShellFlow) && !hasObservedOutput;
}

function looksLikeRetryableRuntimeOverload(message: string | null | undefined): boolean {
  const normalized = String(message || '').toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return normalized.includes('"type":"overloaded_error"')
    || normalized.includes('repeated 529 overloaded errors')
    || normalized.includes(' 529 ')
    || normalized.includes('failed (529)')
    || normalized.includes('当前服务集群负载较高')
    || normalized.includes('rate limit')
    || normalized.includes('429');
}

function looksLikeRecoverySessionDispose(message: string | null | undefined): boolean {
  const normalized = String(message || '').toLowerCase();
  if (!normalized.trim()) {
    return false;
  }
  return normalized.includes('dispose stale hosted session before auto-recovering request')
    || normalized.includes('dispose busy hosted session without matching blackboard running fact')
    || normalized.includes('runtime session stopped by supervisor')
    || normalized.includes('session disposed for recovery');
}

function deriveExecutorTerminalState(args: {
  status: 'done' | 'failed' | 'blocked';
  body: string;
}): {
  nextStatus: 'done' | 'failed' | 'blocked';
  blockedBy: BlockedBy | undefined;
} {
  if (args.status === 'done') {
    return {
      nextStatus: 'done',
      blockedBy: undefined,
    };
  }
  const message = args.body.trim() || 'worker failed';
  if (args.status === 'failed' && looksLikeRetryableRuntimeOverload(message)) {
    return {
      nextStatus: 'blocked',
      blockedBy: {
        kind: 'env_error',
        message,
        retryable: true,
      },
    };
  }
  if (args.status === 'failed' && looksLikeRecoverySessionDispose(message)) {
    return {
      nextStatus: 'blocked',
      blockedBy: {
        kind: 'env_error',
        message,
        retryable: true,
      },
    };
  }
  return {
    nextStatus: args.status,
    blockedBy: {
      kind: args.status === 'blocked' ? 'missing_input' : 'unknown',
      message,
      retryable: args.status !== 'failed',
    },
  };
}

function findFactForAgentRequest(args: {
  teamId: string;
  requestId: string;
  agentId: string;
  preferredSessionId: string | null;
}): { sessionId: string; fact: ReturnType<typeof getBlackboardStore>['get'] extends (...args: any[]) => infer T ? Exclude<T, null> : never } | null {
  const board = getBlackboardStore();
  const chatStore = getTeamChatStore();
  const candidateSessionIds = [
    args.preferredSessionId,
    ...chatStore.listSessions(args.teamId).map((session) => session.sessionId),
  ].filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

  const ranked = candidateSessionIds
    .flatMap((sessionId) => board.list(args.teamId, sessionId, {
      requestId: args.requestId,
      owner: args.agentId,
      includeArchive: true,
    }).map((fact) => ({ sessionId, fact })))
    .sort((left, right) => {
      const score = (item: { fact: { status: string; updatedAt: number } }) => {
        const statusScore =
          item.fact.status === 'running' ? 400
          : item.fact.status === 'pending' ? 300
          : item.fact.status === 'waiting_user' ? 200
          : item.fact.status === 'blocked' ? 100
          : item.fact.status === 'failed' ? 50
          : item.fact.status === 'done' ? 0
          : 0;
        return statusScore + Number(item.fact.updatedAt || 0);
      };
      return score(right) - score(left);
    });
  return ranked[0] || null;
}

function buildTaskEvidence(teamId: string, requestId: string, taskId: string | null, resolveChatSessionId: AgentResponseEventDeps['resolveChatSessionId'], sessionIdOverride?: string | null): Record<string, unknown> | null {
  if (!taskId) {
    return null;
  }
  const board = getBlackboardStore();
  const sessionId = sessionIdOverride || resolveChatSessionId(teamId, requestId);
  const fact = board.get(teamId, sessionId, taskId);
  if (!fact) {
    return null;
  }
  return {
    taskId: fact.id,
    requestId: fact.requestId,
    owner: fact.owner,
    status: fact.status,
    runId: fact.currentRunId,
    attempt: fact.attempt,
    requiredCapability: fact.requiredCapability,
    acceptanceCriteria: fact.acceptanceCriteria || [],
    evidenceRequirements: fact.evidenceRequirements || null,
    requiresTaskEvidence: requiresStructuredSourceEvidence(fact.evidenceRequirements),
    taskEvidenceSchema: requiresStructuredSourceEvidence(fact.evidenceRequirements)
      ? {
          version: 'task-evidence-v1',
          sources: {
            required: true,
            itemShape: ['title', 'url', 'publishedAt', 'snippet?', 'domain?'],
          },
        }
      : null,
    resultSummary: compactText(fact.result),
    resultRef: fact.resultRef || null,
    artifactsRoot: fact.executionScope.artifactsRoot || null,
    blockedReason: fact.blockedBy?.message || null,
    failureCount: fact.failureHistory.length,
    updatedAt: new Date(fact.updatedAt).toISOString(),
  };
}

function updateFactResult(
  teamId: string,
  requestId: string | null,
  agentId: string | null,
  body: string,
  resolveChatSessionId: AgentResponseEventDeps['resolveChatSessionId'],
  teamChatStore: AgentResponseEventDeps['teamChatStore'],
  pendingEvidence: Array<Record<string, unknown>> | undefined,
  taskEvidenceProvided: boolean,
  taskEvidenceDiagnostics: TaskEvidenceDiagnostics | null | undefined,
  status: 'done' | 'failed' | 'blocked',
): { taskId: string | null; sessionId: string | null; appliedStatus: 'done' | 'failed' | 'blocked' | null } {
  if (!requestId || !agentId) return { taskId: null, sessionId: null, appliedStatus: null };
  const board = getBlackboardStore();
  const preferredSessionId = resolveChatSessionId(teamId, requestId);
  const located = findFactForAgentRequest({
    teamId,
    requestId,
    agentId,
    preferredSessionId,
  });
  if (!located) return { taskId: null, sessionId: preferredSessionId, appliedStatus: null };
  const { sessionId: chatSessionId, fact } = located;
  const summaryPath = join(fact.executionScope.artifactsRoot, 'summary.md');
  if (status === 'done' && fact.evidenceRequirements?.requireSummaryArtifact && body.trim()) {
    try {
      mkdirSync(fact.executionScope.artifactsRoot, { recursive: true });
      writeFileSync(summaryPath, body.trim(), 'utf8');
    } catch {
      // Best-effort artifact persistence only; validation below will still report if missing.
    }
  }
  const inferredSummaryEvidence = (!taskEvidenceProvided || Boolean(taskEvidenceDiagnostics?.parseError)) && requiresStructuredSourceEvidence(fact.evidenceRequirements)
    ? inferTaskEvidenceFromSummary(summaryPath)
    : null;
  const resolveReviewableResultRef = (): string | undefined => {
    if (existsSync(summaryPath)) {
      return summaryPath;
    }
    if (fact.resultRef) {
      return fact.resultRef;
    }
    try {
      if (fact.executionScope.artifactsRoot && readdirSync(fact.executionScope.artifactsRoot).length > 0) {
        return fact.executionScope.artifactsRoot;
      }
    } catch {
      // ignore artifact inspection failures
    }
    return undefined;
  };
  const normalizedPendingEvidence = [
    ...((pendingEvidence || [])),
    ...(inferredSummaryEvidence ? [inferredSummaryEvidence as Record<string, unknown>] : []),
  ];
  const terminalState = deriveExecutorTerminalState({
    status,
    body,
  });
  let nextStatus = terminalState.nextStatus;
  let blockedBy: BlockedBy | undefined = terminalState.blockedBy;
  let result = status === 'done' ? body.trim() || 'completed' : undefined;

  if (status === 'done') {
    const validation = validateTaskCompletionEvidence({
      teamChatStore,
      teamId,
      chatSessionId,
      task: fact,
      pendingEvidence: normalizedPendingEvidence,
      taskEvidenceProvided: (taskEvidenceProvided && !taskEvidenceDiagnostics?.parseError) || Boolean(inferredSummaryEvidence),
      taskEvidenceDiagnostics,
      completionBody: body,
    });
    if (!validation.ok) {
      nextStatus = 'blocked';
      result = undefined;
      blockedBy = {
        kind: 'unknown',
        message: `任务缺少完成证据，拒绝标记 done：${validation.reasons.join('；')}`,
        retryable: true,
      };
    }
  }

  const updatedFact = board.write(teamId, chatSessionId, {
    id: fact.id,
    revision: fact.revision,
    status: nextStatus,
    result,
    resultRef: nextStatus === 'done'
      ? (
          resolveReviewableResultRef()
        )
      : undefined,
    blockedBy,
  });
  if (updatedFact?.status === 'done') {
    const sessionContext = getSessionContextStore().getCurrent(teamId, chatSessionId);
    const requestTasks = board.list(teamId, chatSessionId, {
      requestId,
      includeArchive: true,
    });
    try {
      indexRequestProjectArtifacts({
        teamId,
        requestId,
        projectId: sessionContext?.env?.['project.id'] || null,
        tasks: requestTasks,
      });
    } catch (err) {
      console.warn('[ProjectArtifacts] Failed to index task artifacts:', err);
    }
  }
  return { taskId: fact.id, sessionId: chatSessionId, appliedStatus: nextStatus };
}

function heartbeatRunningFact(
  teamId: string,
  requestId: string | null,
  agentId: string | null,
  resolveChatSessionId: AgentResponseEventDeps['resolveChatSessionId'],
): string | null {
  if (!requestId || !agentId) return null;
  const board = getBlackboardStore();
  const located = findFactForAgentRequest({
    teamId,
    requestId,
    agentId,
    preferredSessionId: resolveChatSessionId(teamId, requestId),
  });
  const chatSessionId = located?.sessionId || resolveChatSessionId(teamId, requestId);
  const fact = located?.fact && located.fact.status === 'running' ? located.fact : null;
  if (!fact) return null;
  const now = Date.now();
  board.write(teamId, chatSessionId, {
    id: fact.id,
    revision: fact.revision,
    lastHeartbeatAt: now,
    leaseUntil: extendLeaseWithoutShortening({
      existingLeaseUntil: fact.leaseUntil,
      now,
      leaseWindowMs: 5 * 60_000,
    }),
  });
  return fact.id;
}

function persistExecutorProposals(args: {
  teamId: string;
  requestId: string;
  chatSessionId: string;
  agentId: string;
  parentTaskId: string;
  proposals: ReturnType<typeof extractTaskProposalBlock>['proposals'];
}): {
  proposalIds: string[];
  decisionIds: string[];
  materializedTaskIds: string[];
  requiresCoordinatorDecision: boolean;
} {
  const board = getBlackboardStore();
  const proposalIds: string[] = [];
  const decisionIds: string[] = [];
  const materializedTaskIds: string[] = [];
  let requiresCoordinatorDecision = false;

  args.proposals.forEach((proposal, index) => {
    const proposalId = `${args.parentTaskId}:proposal:${index + 1}`;
    const created = board.propose(args.teamId, args.chatSessionId, {
      id: proposalId,
      revision: 0,
      requestId: args.requestId,
      parentTaskId: args.parentTaskId,
      proposerAgentId: args.agentId,
      kind: proposal.kind,
      payload: proposal.payload,
    });
    if (!created) {
      return;
    }
    proposalIds.push(created.id);
    if (isAutoApprovableProposalKind(created.kind)) {
      const latestDecision = latestDecisionForProposal(board.listDecisions(args.teamId, args.chatSessionId, {
        proposalId: created.id,
      }), created.id);
      if (latestDecision) {
        decisionIds.push(latestDecision.id);
      }
      const materialized = board.materializeApprovedProposal(args.teamId, args.chatSessionId, created.id);
      if (materialized) {
        materializedTaskIds.push(materialized.id);
      }
    } else {
      requiresCoordinatorDecision = true;
    }
  });

  return {
    proposalIds,
    decisionIds,
    materializedTaskIds,
    requiresCoordinatorDecision,
  };
}

function isCoordinator(args: {
  teamId: string;
  requestId: string | null;
  chatSessionId: string | null;
  agentId: string | null;
  resolveChatSessionId: AgentResponseEventDeps['resolveChatSessionId'];
}): boolean {
  if (!args.agentId) return false;
  const requestId = String(args.requestId || '').trim();
  if (requestId) {
    const sessionId = args.chatSessionId || args.resolveChatSessionId(args.teamId, requestId);
    if (hasAssignedSubstantiveRuntimeTask({
      teamId: args.teamId,
      requestId,
      chatSessionId: sessionId,
      agentId: args.agentId,
    })) {
      return false;
    }
    const resolvedCoordinator = getRequestStateStore().resolveCoordinatorForSession(
      args.teamId,
      requestId,
      sessionId,
      getTeamRegistry(args.teamId)?.getCoordinator?.() || null,
    );
    return resolvedCoordinator === args.agentId;
  }
  try {
    return getTeamRegistry(args.teamId)?.isCoordinator?.(args.agentId) === true;
  } catch {
    return false;
  }
}

function shouldBroadcastCoordinatorUserReply(args: {
  output: CoordinatorOutput | null;
  publishedFinal: boolean;
  requestState: string | null;
  changedTaskIds: string[];
  visibleBody: string;
}): boolean {
  if (!args.visibleBody.trim()) {
    return false;
  }
  if (args.publishedFinal) {
    return true;
  }
  const output = args.output;
  if (!output) {
    return false;
  }
  if (args.requestState === 'ready_for_final' || args.requestState === 'closed') {
    return true;
  }
  const hasProposals = (output.proposals?.length || 0) > 0;
  const hasDecisions = (output.decisions?.length || 0) > 0;
  const hasExecutableWork =
    hasProposals
    || hasDecisions
    || args.changedTaskIds.some((id) => !String(id || '').startsWith('runtime-'));
  if (hasExecutableWork) {
    return false;
  }
  return false;
}

export function createAgentResponseEventHandler(deps: AgentResponseEventDeps) {
  function broadcast(teamId: string, message: OutboundMessage): void {
    deps.getBroadcastCallback()?.(teamId, message);
  }

  function handleStream(response: AgentResponse, ctx: AgentResponseEventContext): boolean {
    if (!ctx.requestId || !ctx.localFrom) return true;
    const chatSessionId = deps.resolveChatSessionId(ctx.teamId, ctx.requestId);
    heartbeatRunningFact(ctx.teamId, ctx.requestId, ctx.localFrom, deps.resolveChatSessionId);
    const outboundType = response.type === 'runtime-tool-call'
      ? 'runtime-tool-call'
      : response.type === 'runtime-permission-request'
        ? 'runtime-permission-request'
        : 'agent-stream';
    broadcast(ctx.teamId, {
      type: outboundType,
      from: response.from,
      to: response.to,
      body: response.thinking || response.body,
      requestId: ctx.requestId || undefined,
      sessionKey: response.sessionKey,
      stale: ctx.isStale,
      sourceClientId: ctx.sourceClientId || undefined,
      isPrivate: ctx.isPrivate,
      timestamp: response.timestamp,
      evidence: {
        requestId: ctx.requestId,
        agentId: ctx.localFrom,
        sessionKey: response.sessionKey || null,
        eventType: outboundType,
      },
    });
    if (chatSessionId && (outboundType === 'runtime-tool-call' || outboundType === 'runtime-permission-request')) {
      deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
        agent: ctx.localFrom,
        text: response.thinking || response.body || '',
        tags: [outboundType, 'runtime-evidence'],
        requestId: ctx.requestId,
        sessionId: chatSessionId,
        timestamp: Date.parse(response.timestamp) || Date.now(),
        evidence: {
          requestId: ctx.requestId,
          agentId: ctx.localFrom,
          sessionKey: response.sessionKey || null,
          eventType: outboundType,
          detail: response.thinking || response.body || '',
        },
      });
    }
    return true;
  }

  function handleError(response: AgentResponse, ctx: AgentResponseEventContext): boolean {
    const errorText = String(response.error || response.body || 'Runtime failed').trim();
    const chatSessionId = ctx.requestId ? deps.resolveChatSessionId(ctx.teamId, ctx.requestId) : null;
    if (ctx.requestId && ctx.localFrom && chatSessionId) {
      const coordinatorMessage = isCoordinator({
        teamId: ctx.teamId,
        requestId: ctx.requestId,
        chatSessionId,
        agentId: ctx.localFrom,
        resolveChatSessionId: deps.resolveChatSessionId,
      });
      const updated = updateFactResult(ctx.teamId, ctx.requestId, ctx.localFrom, errorText, deps.resolveChatSessionId, deps.teamChatStore, undefined, false, null, 'failed');
      const evidence = updated?.taskId ? buildTaskEvidence(ctx.teamId, ctx.requestId, updated.taskId, deps.resolveChatSessionId, updated.sessionId) : null;
      deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
        agent: ctx.localFrom || 'system',
        text: `🚫 ${errorText}`,
        tags: ['error', 'task-failure'],
        requestId: ctx.requestId || null,
        sessionId: chatSessionId,
        timestamp: Date.parse(response.timestamp) || Date.now(),
        evidence,
      });
      broadcast(ctx.teamId, {
        type: 'agent-blocked',
        from: ctx.localFrom || response.from,
        to: response.to,
        body: `🚫 ${errorText}`,
        requestId: ctx.requestId || undefined,
        sessionKey: response.sessionKey,
        stale: ctx.isStale,
        sourceClientId: ctx.sourceClientId || undefined,
        isPrivate: ctx.isPrivate,
        timestamp: response.timestamp,
        evidence: evidence || undefined,
      });
    } else {
      deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
        agent: ctx.localFrom || 'system',
        text: `🚫 ${errorText}`,
        tags: ['error'],
        requestId: ctx.requestId || null,
        sessionId: chatSessionId,
        timestamp: Date.parse(response.timestamp) || Date.now(),
      });
      broadcast(ctx.teamId, {
        type: 'agent-blocked',
        from: ctx.localFrom || response.from,
        to: response.to,
        body: `🚫 ${errorText}`,
        requestId: ctx.requestId || undefined,
        sessionKey: response.sessionKey,
        stale: ctx.isStale,
        sourceClientId: ctx.sourceClientId || undefined,
        isPrivate: ctx.isPrivate,
        timestamp: response.timestamp,
      });
    }
    if (ctx.requestId && chatSessionId) {
      void triggerBlackboardDispatch({
        teamId: ctx.teamId,
        requestId: ctx.requestId,
        chatSessionId,
      });
    }
    return true;
  }

  async function handleFinal(response: AgentResponse, ctx: AgentResponseEventContext): Promise<boolean> {
    const rawBody = String(response.body || '').trim();
    const extractedTaskEvidence = extractTaskEvidenceBlock(rawBody);
    let taskEvidenceDiagnosticsForEvent: TaskEvidenceDiagnostics = extractedTaskEvidence.diagnostics;
    const extractedTaskProposals = extractTaskProposalBlock(extractedTaskEvidence.cleanBody);
    const body = extractedTaskProposals.cleanBody;
    const chatSessionId = ctx.requestId ? deps.resolveChatSessionId(ctx.teamId, ctx.requestId) : null;
    const coordinatorMessage = isCoordinator({
      teamId: ctx.teamId,
      requestId: ctx.requestId,
      chatSessionId,
      agentId: ctx.localFrom,
      resolveChatSessionId: deps.resolveChatSessionId,
    });

    if (coordinatorMessage && ctx.requestId && ctx.localFrom && chatSessionId) {
      const applied = await applyCoordinatorOutputToBlackboard({
        teamId: ctx.teamId,
        chatSessionId,
        requestId: ctx.requestId,
        coordinatorId: ctx.localFrom,
        body,
        sourceClientId: ctx.sourceClientId,
        isPrivate: ctx.isPrivate,
      });

      if (applied.blockedReason) {
        deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
          agent: ctx.localFrom,
          text: `协调者输出被拦截：${applied.blockedReason}`,
          tags: ['blocked'],
          fullContent: body,
          requestId: ctx.requestId,
          sessionId: chatSessionId,
          timestamp: Date.parse(response.timestamp) || Date.now(),
        });
        broadcast(ctx.teamId, {
          type: 'agent-blocked',
          from: response.from,
          to: response.to,
          body: `协调者输出被拦截：${applied.blockedReason}`,
          requestId: ctx.requestId,
          sessionKey: response.sessionKey,
          stale: ctx.isStale,
          sourceClientId: ctx.sourceClientId || undefined,
          isPrivate: ctx.isPrivate,
          timestamp: response.timestamp,
        });
        return true;
      }

      const visibleBody = applied.output
        ? formatCoordinatorOutputForDisplay(applied.output)
        : applied.cleanBody;
      if (!applied.publishedFinal && visibleBody.trim()) {
        const evidence = {
          eventType: 'coordinator-output',
          requestId: ctx.requestId,
          coordinatorId: ctx.localFrom,
          requestState: applied.requestState,
          changedTaskIds: applied.changedTaskIds,
          blockedReason: applied.blockedReason,
          diagnostics: applied.diagnostics || null,
          taskId: applied.changedTaskIds.find((id) => String(id || '').startsWith('coordinator:')) || null,
          runId: response.sessionKey || null,
        };
        deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
          agent: ctx.localFrom,
          text: visibleBody,
          tags: ['coordinator-output', 'coordination-evidence'],
          fullContent: body,
          requestId: ctx.requestId,
          sessionId: chatSessionId,
          timestamp: Date.parse(response.timestamp) || Date.now(),
          evidence,
        });
        broadcast(ctx.teamId, {
          type: shouldBroadcastCoordinatorUserReply({
            output: applied.output,
            publishedFinal: applied.publishedFinal,
            requestState: applied.requestState,
            changedTaskIds: applied.changedTaskIds,
            visibleBody,
          }) ? 'agent-reply' : 'agent-status',
          from: response.from,
          to: 'user',
          body: visibleBody,
          requestId: ctx.requestId,
          sessionKey: response.sessionKey,
          stale: ctx.isStale,
          sourceClientId: ctx.sourceClientId || undefined,
          isPrivate: ctx.isPrivate,
          timestamp: response.timestamp,
          evidence,
        });
      }
      return true;
    }

    let evidence: Record<string, unknown> | null = null;
    let proposalOutcome: ReturnType<typeof persistExecutorProposals> | null = null;
    let updatedTaskMeta: { taskId: string | null; sessionId: string | null; appliedStatus: 'done' | 'failed' | 'blocked' | null } | null = null;
    if (ctx.requestId && ctx.localFrom && chatSessionId) {
      const embeddedToolCallOnly = looksLikeEmbeddedToolCallResult(body);
      const plannedButUnexecuted = looksLikePlannedButUnexecutedShellWork(body);
      const blockedReason = embeddedToolCallOnly
        ? 'Executor returned provider-embedded tool-call text without executing tools through the runtime tool channel.'
        : plannedButUnexecuted
          ? 'Executor returned a shell plan in prose/code fences without executing tools through the runtime tool channel.'
          : body;
      const updated = updateFactResult(
        ctx.teamId,
        ctx.requestId,
        ctx.localFrom,
        blockedReason,
        deps.resolveChatSessionId,
        deps.teamChatStore,
        extractedTaskEvidence.payload ? [extractedTaskEvidence.payload as Record<string, unknown>] : undefined,
        extractedTaskEvidence.hasBlock,
        extractedTaskEvidence.diagnostics,
        embeddedToolCallOnly || plannedButUnexecuted ? 'blocked' : 'done',
      );
      updatedTaskMeta = updated;
      evidence = updated?.taskId ? buildTaskEvidence(ctx.teamId, ctx.requestId, updated.taskId, deps.resolveChatSessionId, updated.sessionId) : null;
      if (
        updated?.taskId
        && updated.sessionId
        && updated.appliedStatus === 'done'
        && extractedTaskProposals.proposals.length > 0
      ) {
        proposalOutcome = persistExecutorProposals({
          teamId: ctx.teamId,
          requestId: ctx.requestId,
          chatSessionId: updated.sessionId,
          agentId: ctx.localFrom,
          parentTaskId: updated.taskId,
          proposals: extractedTaskProposals.proposals,
        });
      }
      if (!extractedTaskEvidence.payload && evidence?.artifactsRoot && requiresStructuredSourceEvidence(evidence.evidenceRequirements as any)) {
        const inferredEvidence = inferTaskEvidenceFromSummary(String(evidence.artifactsRoot) + '/summary.md');
        if (inferredEvidence) {
          taskEvidenceDiagnosticsForEvent = {
            ...taskEvidenceDiagnosticsForEvent,
            fallbackUsed: 'summary.md',
            fallbackSourceCount: inferredEvidence.sources?.length || 0,
          };
          evidence = {
            ...evidence,
            ...inferredEvidence,
          };
        }
      }
      if (extractedTaskEvidence.diagnostics?.hasBlock) {
        evidence = {
          ...(evidence || {}),
          evidenceDiagnostics: {
            taskEvidence: taskEvidenceDiagnosticsForEvent,
          },
        };
      }
    }
    const mergedEvidence = extractedTaskEvidence.payload
      ? {
          ...(evidence || {}),
          ...extractedTaskEvidence.payload,
          proposals: proposalOutcome ? {
            proposalIds: proposalOutcome.proposalIds,
            decisionIds: proposalOutcome.decisionIds,
            materializedTaskIds: proposalOutcome.materializedTaskIds,
          } : undefined,
          diagnostics: {
            taskEvidence: taskEvidenceDiagnosticsForEvent,
            taskProposals: extractedTaskProposals.diagnostics,
          },
        }
      : {
          ...(evidence || {}),
          ...(proposalOutcome ? {
            proposals: {
              proposalIds: proposalOutcome.proposalIds,
              decisionIds: proposalOutcome.decisionIds,
              materializedTaskIds: proposalOutcome.materializedTaskIds,
            },
          } : {}),
          diagnostics: {
            taskEvidence: taskEvidenceDiagnosticsForEvent,
            taskProposals: extractedTaskProposals.diagnostics,
          },
        };
    deps.persistSharedChatMessage(deps.teamChatStore, ctx.teamId, {
      agent: ctx.localFrom || response.from || 'agent',
      text: body,
      tags: [
        (
          looksLikeEmbeddedToolCallResult(body)
          || looksLikePlannedButUnexecutedShellWork(body)
          || evidence?.status === 'blocked'
        ) ? 'task-failure' : 'task-result',
        'collaboration-evidence',
      ],
      requestId: ctx.requestId || null,
      sessionId: chatSessionId,
      timestamp: Date.parse(response.timestamp) || Date.now(),
      fullContent: rawBody,
      evidence: mergedEvidence,
    });
    broadcast(ctx.teamId, {
      type: 'agent-chat-final',
      from: response.from,
      to: response.to,
      body,
      requestId: ctx.requestId || undefined,
      sessionKey: response.sessionKey,
      stale: ctx.isStale,
      sourceClientId: ctx.sourceClientId || undefined,
      isPrivate: ctx.isPrivate,
      timestamp: response.timestamp,
      evidence: mergedEvidence || undefined,
    });
    if (ctx.requestId && chatSessionId) {
      const dispatchPlan = await triggerBlackboardDispatch({
        teamId: ctx.teamId,
        requestId: ctx.requestId,
        chatSessionId,
      });
      void dispatchPlan;
    }
    return true;
  }

  return {
    handleStream,
    handleThinking: handleStream,
    handleError,
    handleResult: handleFinal,
    handleFinal,
  };
}
