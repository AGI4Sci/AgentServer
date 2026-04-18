import { join } from 'path';
import type { TaskFact } from './blackboard-types.js';
import { BlackboardStore } from '../store/blackboard-store.js';
import type { TeamApprovalRecord } from './types.js';

export interface WaitingUserTaskInput {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  taskId?: string;
  goal: string;
  createdBy: string;
  workspaceId?: string;
  cwd?: string;
  allowedRoots?: string[];
  artifactsRoot?: string;
  dependsOn?: string[];
}

interface ApprovalRequestMetadata {
  approvalId: string;
  kind: string;
  reason: string;
  options: string[];
}

interface ParsedApprovalDecision {
  status: TeamApprovalRecord['status'];
  decision?: string | null;
  note?: string | null;
}

const APPROVAL_TAG_OPEN = '[[APPROVAL_REQUEST]]';
const APPROVAL_TAG_CLOSE = '[[/APPROVAL_REQUEST]]';
const WAITING_USER_REPLY_RESULT_MAX_LENGTH = 2_000;

function normalizeTaskId(requestId: string, taskId: string | undefined): string {
  const normalized = String(taskId || '').trim();
  if (normalized) {
    return normalized;
  }
  return `${requestId}:waiting-user`;
}

function normalizeApprovalToken(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function compactApprovalNote(reply: string, matchedDecision?: string | null): string | null {
  const normalized = String(reply || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  if (matchedDecision && normalizeApprovalToken(normalized) === normalizeApprovalToken(matchedDecision)) {
    return null;
  }
  return normalized.slice(0, 120) || null;
}

export function buildApprovalRequestGoal(input: ApprovalRequestMetadata): string {
  const payload = JSON.stringify({
    approvalId: input.approvalId,
    kind: input.kind,
    reason: input.reason,
    options: input.options,
  });
  const lines = [
    `${APPROVAL_TAG_OPEN}${payload}${APPROVAL_TAG_CLOSE}`,
    input.reason.trim(),
  ];
  if (input.options.length > 0) {
    lines.push(`可选项: ${input.options.join(' / ')}`);
  }
  return lines.filter(Boolean).join('\n');
}

export function parseApprovalRequestGoal(goal: string | null | undefined): ApprovalRequestMetadata | null {
  const raw = String(goal || '').trim();
  if (!raw) {
    return null;
  }
  const match = raw.match(/\[\[APPROVAL_REQUEST\]\]([\s\S]*?)\[\[\/APPROVAL_REQUEST\]\]/i);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[1].trim()) as ApprovalRequestMetadata;
    const approvalId = String(parsed.approvalId || '').trim();
    const kind = String(parsed.kind || '').trim();
    const reason = String(parsed.reason || '').trim();
    const options = Array.isArray(parsed.options)
      ? parsed.options.map((item) => String(item || '').trim()).filter(Boolean)
      : [];
    if (!approvalId || !kind || !reason) {
      return null;
    }
    return { approvalId, kind, reason, options };
  } catch {
    return null;
  }
}

export function parseApprovalDecisionFromReply(
  userReply: string,
  approval: ApprovalRequestMetadata,
): ParsedApprovalDecision {
  const normalizedReply = normalizeApprovalToken(userReply);
  const normalizedOptions = approval.options.map((option) => ({
    raw: option,
    normalized: normalizeApprovalToken(option),
  }));
  const matchedOption = normalizedOptions.find((option) =>
    option.normalized
    && (normalizedReply === option.normalized || normalizedReply.includes(option.normalized)),
  );

  const approveWords = ['同意', '批准', '通过', '可以', '确认', 'approve', 'approved', 'yes', 'ok'];
  const rejectWords = ['拒绝', '不同意', '否决', '不可以', '取消', 'reject', 'rejected', 'deny', 'no'];
  const approved = approveWords.some((word) => normalizedReply.includes(normalizeApprovalToken(word)));
  const rejected = rejectWords.some((word) => normalizedReply.includes(normalizeApprovalToken(word)));

  if (rejected) {
    return {
      status: 'rejected',
      decision: matchedOption?.raw || 'rejected',
      note: compactApprovalNote(userReply, matchedOption?.raw || 'rejected'),
    };
  }
  if (approved) {
    return {
      status: 'approved',
      decision: matchedOption?.raw || 'approved',
      note: compactApprovalNote(userReply, matchedOption?.raw || 'approved'),
    };
  }
  if (matchedOption) {
    return {
      status: 'responded',
      decision: matchedOption.raw,
      note: compactApprovalNote(userReply, matchedOption.raw),
    };
  }
  return {
    status: 'responded',
    decision: null,
    note: compactApprovalNote(userReply, null),
  };
}

export function buildApprovalResponseResult(input: {
  approval: ApprovalRequestMetadata;
  reply: string;
}): string {
  const decision = parseApprovalDecisionFromReply(input.reply, input.approval);
  const payload = {
    type: 'approval_response',
    approvalId: input.approval.approvalId,
    kind: input.approval.kind,
    status: decision.status,
    decision: decision.decision || null,
    note: decision.note || null,
  };
  return JSON.stringify(payload);
}

export function parseApprovalResponseResult(result: string | null | undefined): {
  approvalId: string;
  kind?: string | null;
  status: TeamApprovalRecord['status'];
  decision?: string | null;
  note?: string | null;
} | null {
  const raw = String(result || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as {
      type?: string;
      approvalId?: string;
      kind?: string;
      status?: TeamApprovalRecord['status'];
      decision?: string | null;
      note?: string | null;
    };
    if (parsed.type !== 'approval_response' || !String(parsed.approvalId || '').trim()) {
      return null;
    }
    return {
      approvalId: String(parsed.approvalId).trim(),
      kind: parsed.kind ? String(parsed.kind).trim() : null,
      status: parsed.status || 'responded',
      decision: parsed.decision ? String(parsed.decision).trim() : null,
      note: parsed.note ? String(parsed.note).trim() : null,
    };
  } catch {
    return null;
  }
}

function defaultExecutionScope(input: WaitingUserTaskInput, taskId: string): TaskFact['executionScope'] {
  const cwd = String(input.cwd || process.cwd()).trim();
  const allowedRoots = Array.isArray(input.allowedRoots) && input.allowedRoots.length > 0
    ? [...new Set(input.allowedRoots.map(item => String(item || '').trim()).filter(Boolean))]
    : [cwd];
  return {
    workspaceId: String(input.workspaceId || `${input.teamId}:${input.chatSessionId}:user`).trim(),
    cwd,
    allowedRoots,
    artifactsRoot: String(input.artifactsRoot || join(process.cwd(), 'data', 'artifacts', input.teamId, input.chatSessionId, taskId)).trim(),
  };
}

export function upsertWaitingUserTask(board: BlackboardStore, input: WaitingUserTaskInput): TaskFact | null {
  const taskId = normalizeTaskId(input.requestId, input.taskId);
  const existing = board.get(input.teamId, input.chatSessionId, taskId);

  if (existing?.status === 'waiting_user') {
    return existing;
  }

  if (existing) {
    return board.write(input.teamId, input.chatSessionId, {
      id: existing.id,
      revision: existing.revision,
      status: 'waiting_user',
      owner: 'user',
      currentRunId: null,
      goal: input.goal,
      requires: input.dependsOn || existing.requires,
      requiredCapability: 'user-input',
      executionScope: defaultExecutionScope(input, taskId),
      blockedBy: undefined,
      result: undefined,
    });
  }

  return board.write(input.teamId, input.chatSessionId, {
    id: taskId,
    revision: 0,
    requestId: input.requestId,
    goal: input.goal,
    requires: input.dependsOn || [],
    requiredCapability: 'user-input',
    executionScope: defaultExecutionScope(input, taskId),
    status: 'waiting_user',
    owner: 'user',
    currentRunId: null,
    attempt: 0,
    failureHistory: [],
    createdBy: input.createdBy,
  });
}

export function resolveWaitingUserTasks(
  board: BlackboardStore,
  input: {
    teamId: string;
    chatSessionId: string;
    requestId: string;
    userReply: string;
    limit?: number;
  },
): TaskFact[] {
  const waitingTasks = board
    .list(input.teamId, input.chatSessionId, {
      requestId: input.requestId,
      status: 'waiting_user',
    })
    .sort((a, b) => Number(a.updatedAt || 0) - Number(b.updatedAt || 0));

  const limit = Math.max(1, input.limit || 1);
  const resolved: TaskFact[] = [];
  for (const task of waitingTasks.slice(0, limit)) {
    const approval = parseApprovalRequestGoal(task.goal);
    const result = approval
      ? buildApprovalResponseResult({
          approval,
          reply: input.userReply,
        })
      : String(input.userReply || '').trim().slice(0, WAITING_USER_REPLY_RESULT_MAX_LENGTH);
    const next = board.write(input.teamId, input.chatSessionId, {
      id: task.id,
      revision: task.revision,
      status: 'done',
      owner: 'user',
      result,
    });
    if (next) {
      resolved.push(next);
    }
  }
  return resolved;
}
