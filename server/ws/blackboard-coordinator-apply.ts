import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { extractCoordinatorOutput, type CoordinatorDecision, type CoordinatorOutput, type CoordinatorOutputDiagnostics, type CoordinatorProposal } from '../../core/runtime/coordinator-context.js';
import { resolveBlackboardCoordinatorMode, validateBlackboardCoordinatorOutput } from '../../core/runtime/blackboard-coordinator.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../core/store/request-state-store.js';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';
import { evaluateDirectCoordinatorAnswerPolicy } from '../../core/runtime/request-completion-policy.js';
import {
  canMaterializeProposalDecision,
  latestDecisionForProposal,
} from '../../core/runtime/blackboard-proposals.js';
import { publishBlackboardFinalAnswer } from '../ws-handler.js';
import { triggerBlackboardDispatch } from './blackboard-runtime-loop.js';

export interface ApplyCoordinatorOutputResult {
  applied: boolean;
  output: CoordinatorOutput | null;
  cleanBody: string;
  blockedReason: string | null;
  publishedFinal: boolean;
  requestState: string | null;
  changedTaskIds: string[];
  diagnostics?: {
    coordinatorOutput?: CoordinatorOutputDiagnostics;
  };
}

export interface MaterializeCoordinatorFallbackResult {
  applied: boolean;
  reason: string;
  requestState: string | null;
  changedTaskIds: string[];
}

function dedupe(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeTaskReference(requestId: string, value: string | null | undefined): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.startsWith('coordinator:')) {
    const stripped = normalized.slice('coordinator:'.length).trim();
    if (stripped) {
      return normalizeTaskReference(requestId, stripped);
    }
  }
  if (normalized.startsWith('req:')) {
    return `${requestId}:${normalized.slice(4)}`;
  }
  return normalized;
}

function persistCoordinatorSummaryArtifact(artifactsRoot: string, content: string): string | null {
  const normalizedRoot = String(artifactsRoot || '').trim();
  const normalizedContent = String(content || '').trim();
  if (!normalizedRoot || !normalizedContent) {
    return null;
  }
  const summaryPath = join(normalizedRoot, 'summary.md');
  try {
    mkdirSync(normalizedRoot, { recursive: true });
    writeFileSync(summaryPath, `${normalizedContent}\n`, 'utf8');
    return summaryPath;
  } catch {
    return null;
  }
}

function markCoordinatorRoundDone(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
  result: string;
}): string | null {
  const board = getBlackboardStore();
  const existing = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  }).filter((task) =>
    task.requiredCapability === 'coordination'
    && (task.status === 'running' || task.status === 'pending' || task.owner === args.coordinatorId),
  ).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0]
    || board.get(args.teamId, args.chatSessionId, `coordinator:${args.requestId}`);
  if (!existing) {
    return null;
  }
  const result = args.result.trim() || 'coordinator round applied';
  const summaryPath = persistCoordinatorSummaryArtifact(existing.executionScope.artifactsRoot, result);
  const next = board.write(args.teamId, args.chatSessionId, {
    id: existing.id,
    revision: existing.revision,
    status: 'done',
    owner: existing.owner,
    currentRunId: existing.currentRunId,
    result,
    resultRef: summaryPath || undefined,
  });
  return next?.id || null;
}

function applyDecision(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
  decision: CoordinatorDecision;
}): string[] {
  const board = getBlackboardStore();
  const latestDecision = latestDecisionForProposal(
    board.listDecisions(args.teamId, args.chatSessionId, { requestId: args.requestId }),
    args.decision.proposalId,
  );
  if (
    latestDecision
    && canMaterializeProposalDecision(latestDecision)
    && (latestDecision.materializedTaskIds || []).length > 0
    && (args.decision.decision === 'approve' || args.decision.decision === 'amend')
  ) {
    return [];
  }
  const createdDecision = board.decide(args.teamId, args.chatSessionId, {
    id: `${args.decision.proposalId}:decision:${args.coordinatorId}:${Date.now()}`,
    revision: 0,
    requestId: args.requestId,
    proposalId: args.decision.proposalId,
    decision: args.decision.decision,
    decidedBy: args.coordinatorId,
    note: args.decision.note,
    amendedPayload: args.decision.amendedPayload,
  });
  if (!createdDecision) {
    return [];
  }
  const changed = [createdDecision.id];
  if (createdDecision.decision === 'approve' || createdDecision.decision === 'amend') {
    const materialized = board.materializeApprovedProposal(args.teamId, args.chatSessionId, args.decision.proposalId);
    if (materialized) {
      changed.push(materialized.id);
    }
  }
  return changed;
}

function applyCoordinatorProposal(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
  proposal: CoordinatorProposal;
}): string[] {
  const board = getBlackboardStore();
  const coordinatorParentTask = board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    includeArchive: true,
  }).filter((task) =>
    task.requiredCapability === 'coordination' || task.id.startsWith('coordinator:'),
  ).sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))[0] || null;
  if (!coordinatorParentTask) {
    return [];
  }
  const normalizedTaskId = normalizeTaskReference(args.requestId, args.proposal.taskId);
  const normalizedRequires = dedupe((args.proposal.requires || []).map((taskId) =>
    normalizeTaskReference(args.requestId, taskId),
  ).filter(Boolean));
  const proposalId =
    String(args.proposal.proposalId || '').trim()
    || `${normalizedTaskId || `${args.requestId}:${args.proposal.kind}:${Date.now()}`}:proposal`;
  const taskId = normalizedTaskId || undefined;
  const existingProposal = board.listProposals(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
  }).find((proposal) => proposal.id === proposalId) || null;
  const createdProposal = existingProposal || board.propose(args.teamId, args.chatSessionId, {
    id: proposalId,
    revision: 0,
    requestId: args.requestId,
    parentTaskId: coordinatorParentTask.id,
    proposerAgentId: args.coordinatorId,
    kind: args.proposal.kind,
    payload: {
      taskId,
      goal: args.proposal.goal,
      requiredCapability: args.proposal.requiredCapability,
      suggestedAssignee: args.proposal.suggestedAssignee,
      requires: normalizedRequires,
      supersedesTaskId: normalizeTaskReference(args.requestId, args.proposal.supersedesTaskId),
      reason: args.proposal.reason,
      acceptanceCriteria: args.proposal.acceptanceCriteria,
      evidenceRequirements: args.proposal.evidenceRequirements,
      endpointHints: args.proposal.endpointHints,
      toolBindings: args.proposal.toolBindings,
      networkMode: args.proposal.networkMode,
      riskClass: args.proposal.riskClass,
      executionScope: {
        workspaceId: args.proposal.workspaceId,
        cwd: args.proposal.cwd,
        allowedRoots: args.proposal.allowedRoots,
        artifactsRoot: args.proposal.artifactsRoot,
        allowedTools: args.proposal.allowedTools,
      },
    },
  });
  if (!createdProposal) {
    return [];
  }
  void taskId;
  return [createdProposal.id];
}

function hasCoordinatorRuntimeToolEvidence(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
}): boolean {
  const history = getTeamChatStore().getHistory(args.teamId, args.chatSessionId);
  return history.messages.some((message) => {
    if (message.requestId !== args.requestId || message.agent !== args.coordinatorId) {
      return false;
    }
    const tags = new Set((message.tags || []).map((tag) => String(tag || '').trim()));
    const evidenceValue = (message as { evidence?: unknown }).evidence;
    const evidence = evidenceValue && typeof evidenceValue === 'object'
      ? evidenceValue as Record<string, unknown>
      : null;
    return tags.has('runtime-tool-call')
      || evidence?.eventType === 'runtime-tool-call';
  });
}

export async function applyCoordinatorOutputToBlackboard(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorId: string;
  body: string;
  sourceClientId?: string | null;
  isPrivate?: boolean;
}): Promise<ApplyCoordinatorOutputResult> {
  const board = getBlackboardStore();
  const requestStore = getRequestStateStore();
  const extracted = extractCoordinatorOutput(args.body);
  const requestState = requestStore.getRequestForSession(args.teamId, args.requestId, args.chatSessionId);
  const snapshot = resolveBlackboardCoordinatorMode({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState,
  });
  const coordinatorRuntimeToolEvidence = hasCoordinatorRuntimeToolEvidence({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorId: args.coordinatorId,
  });
  const directCoordinatorPolicy = evaluateDirectCoordinatorAnswerPolicy({
    coordinatorMode: snapshot.mode,
    facts: snapshot.facts,
    proposals: snapshot.proposals,
    decisions: snapshot.decisions,
    output: extracted.output,
    hasCoordinatorRuntimeToolEvidence: coordinatorRuntimeToolEvidence,
    requestState,
  });
  const allowDirectCoordinatorFinal = directCoordinatorPolicy.canPublish;
  const validationBlockedReason = validateBlackboardCoordinatorOutput({
    snapshot,
    output: extracted.output,
    allowSummaryOnlyDecompose: allowDirectCoordinatorFinal,
  });
  const blockedReason = !extracted.output && extracted.diagnostics.parseError
    ? `COORDINATOR_OUTPUT JSON 解析失败：${extracted.diagnostics.parseError}`
    : validationBlockedReason;

  if (!extracted.output || blockedReason) {
    return {
      applied: false,
      output: extracted.output,
      cleanBody: extracted.cleanBody,
      blockedReason,
      publishedFinal: false,
      requestState: requestState?.state || null,
      changedTaskIds: [],
      diagnostics: {
        coordinatorOutput: extracted.diagnostics,
      },
    };
  }

  const changedTaskIds = new Set<string>();
  for (const marker of (extracted.output.proposals || []).flatMap((proposal) => applyCoordinatorProposal({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorId: args.coordinatorId,
    proposal,
  }))) {
    changedTaskIds.add(marker);
  }

  for (const decision of extracted.output.decisions || []) {
    for (const marker of applyDecision({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      coordinatorId: args.coordinatorId,
      decision,
    })) {
      changedTaskIds.add(marker);
    }
  }

  const coordinatorRoundTaskId = markCoordinatorRoundDone({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorId: args.coordinatorId,
    result: extracted.output.summary || extracted.output.userReply || extracted.cleanBody || 'coordinator round applied',
  });
  if (coordinatorRoundTaskId) {
    changedTaskIds.add(coordinatorRoundTaskId);
  }
  requestStore.syncTaskSnapshotForSession(args.teamId, args.requestId, args.chatSessionId);

  let publishedFinal = false;
  if (snapshot.mode === 'synthesize' || allowDirectCoordinatorFinal) {
    const published = publishBlackboardFinalAnswer({
      teamId: args.teamId,
      requestId: args.requestId,
      sessionId: args.chatSessionId,
      body: extracted.output.userReply || extracted.output.summary || extracted.cleanBody,
      from: args.coordinatorId,
      sourceClientId: args.sourceClientId || undefined,
      isPrivate: args.isPrivate,
      completionOverride: allowDirectCoordinatorFinal
        ? {
            mode: 'direct_coordinator_answer',
            reason: directCoordinatorPolicy.reason,
          }
        : undefined,
    });
    publishedFinal = published.published;
  }

  if (!publishedFinal) {
    await triggerBlackboardDispatch({
      teamId: args.teamId,
      requestId: args.requestId,
      chatSessionId: args.chatSessionId,
    });
  }

  return {
    applied: true,
    output: extracted.output,
    cleanBody: extracted.cleanBody,
    blockedReason: null,
    publishedFinal,
    requestState: requestStore.getRequestForSession(args.teamId, args.requestId, args.chatSessionId)?.state || null,
    changedTaskIds: Array.from(changedTaskIds),
    diagnostics: {
      coordinatorOutput: extracted.diagnostics,
    },
  };
}
