import type { BlackboardStore } from './blackboard-store.js';
import { getBlackboardStore } from './blackboard-store.js';
import type { TaskFact } from '../runtime/blackboard-types.js';
import { resolveAgentArtifactsRoot } from '../runtime/agent-artifacts.js';
import type { TaskSpec, TaskState, TaskStatus } from '../runtime/types.js';

interface TaskOverlay {
  todos: string[];
  evidence: string[];
  replacementHistory: string[];
  updatedAt: string;
}

function overlayKey(teamId: string, chatSessionId: string, taskId: string): string {
  return `${teamId}:${chatSessionId}:${taskId}`;
}

function statusToFactStatus(status: TaskStatus): TaskFact['status'] {
  if (status === 'running') return 'running';
  if (status === 'blocked') return 'blocked';
  if (status === 'done' || status === 'verified') return 'done';
  if (status === 'failed' || status === 'timed_out' || status === 'stale') return 'failed';
  return 'pending';
}

function factStatusToTaskStatus(status: TaskFact['status']): TaskStatus {
  if (status === 'running') return 'running';
  if (status === 'blocked' || status === 'waiting_user') return 'blocked';
  if (status === 'failed') return 'failed';
  if (status === 'done') return 'done';
  return 'pending';
}

function defaultArtifactsRoot(teamId: string, chatSessionId: string, owner: string | null | undefined): string {
  void chatSessionId;
  return resolveAgentArtifactsRoot(owner, 'pending', { teamId });
}

export class TaskStateStore {
  private readonly overlays = new Map<string, TaskOverlay>();

  private readonly sessionsByTask = new Map<string, string>();

  constructor(private readonly board: Pick<BlackboardStore, 'get' | 'list' | 'write'> = getBlackboardStore()) {}

  private resolveChatSessionId(teamId: string, taskId: string, chatSessionId?: string | null): string | null {
    if (chatSessionId?.trim()) {
      this.sessionsByTask.set(`${teamId}:${taskId}`, chatSessionId);
      return chatSessionId;
    }
    return this.sessionsByTask.get(`${teamId}:${taskId}`) || null;
  }

  private overlay(teamId: string, chatSessionId: string, taskId: string): TaskOverlay {
    const key = overlayKey(teamId, chatSessionId, taskId);
    const existing = this.overlays.get(key);
    if (existing) {
      return existing;
    }
    const created: TaskOverlay = {
      todos: [],
      evidence: [],
      replacementHistory: [],
      updatedAt: new Date().toISOString(),
    };
    this.overlays.set(key, created);
    return created;
  }

  private toSpec(fact: TaskFact): TaskSpec {
    return {
      taskId: fact.id,
      requestId: fact.requestId,
      revision: fact.revision,
      owner: fact.owner || fact.createdBy,
      objective: fact.goal,
      meta: {
        requires: [...fact.requires],
        requiredCapability: fact.requiredCapability,
        executionScope: fact.executionScope,
        blackboardStatus: fact.status,
      },
      createdAt: new Date(fact.updatedAt).toISOString(),
      updatedAt: new Date(fact.updatedAt).toISOString(),
    };
  }

  private toState(teamId: string, chatSessionId: string, fact: TaskFact): TaskState {
    this.sessionsByTask.set(`${teamId}:${fact.id}`, chatSessionId);
    const overlay = this.overlay(teamId, chatSessionId, fact.id);
    return {
      taskId: fact.id,
      requestId: fact.requestId,
      owner: fact.owner || fact.createdBy,
      revision: fact.revision,
      status: factStatusToTaskStatus(fact.status),
      todos: [...overlay.todos],
      evidence: [...new Set([...overlay.evidence, fact.result || fact.blockedBy?.message || ''].filter(Boolean))],
      retryCount: Math.max(0, fact.attempt - 1),
      failureCount: fact.failureHistory.length,
      lastFailureStatus: fact.status === 'failed' ? 'failed' : fact.status === 'blocked' ? 'blocked' : null,
      lastFailureReason: fact.blockedBy?.message || null,
      lastFailureAt: fact.failureHistory.at(-1) ? new Date(fact.failureHistory.at(-1)!.at).toISOString() : null,
      replacementHistory: [...overlay.replacementHistory],
      updatedAt: overlay.updatedAt,
    };
  }

  listSpecsForSession(teamId: string, chatSessionId: string, requestId?: string | null): TaskSpec[] {
    return this.board.list(teamId, chatSessionId, {
      requestId: requestId || undefined,
      includeArchive: true,
    }).map((fact) => this.toSpec(fact));
  }

  listStatesForSession(teamId: string, chatSessionId: string, requestId?: string | null): TaskState[] {
    return this.board.list(teamId, chatSessionId, {
      requestId: requestId || undefined,
      includeArchive: true,
    }).map((fact) => this.toState(teamId, chatSessionId, fact));
  }

  listStates(teamId: string, requestId?: string | null, chatSessionId?: string | null): TaskState[] {
    if (!chatSessionId) {
      return [];
    }
    return this.listStatesForSession(teamId, chatSessionId, requestId);
  }

  upsertSpec(teamId: string, spec: TaskSpec, chatSessionId?: string | null): TaskSpec | null {
    const resolvedSessionId = this.resolveChatSessionId(teamId, spec.taskId, chatSessionId);
    if (!resolvedSessionId) {
      return null;
    }
    const existing = this.board.get(teamId, resolvedSessionId, spec.taskId);
    const next = this.board.write(teamId, resolvedSessionId, {
      id: spec.taskId,
      revision: existing?.revision || 0,
      requestId: spec.requestId,
      goal: spec.objective,
      requires: Array.isArray(spec.meta?.requires) ? spec.meta.requires as string[] : existing?.requires || [],
      requiredCapability: String(spec.meta?.requiredCapability || existing?.requiredCapability || 'general'),
      executionScope: (spec.meta?.executionScope as TaskFact['executionScope'] | undefined) || existing?.executionScope || {
        workspaceId: resolvedSessionId,
        cwd: process.cwd(),
        allowedRoots: [process.cwd()],
        artifactsRoot: defaultArtifactsRoot(teamId, resolvedSessionId, spec.owner),
      },
      status: existing?.status || 'pending',
      owner: existing?.owner || spec.owner || null,
      attempt: existing?.attempt || 0,
      createdBy: existing?.createdBy || spec.owner || 'system',
    });
    return next ? this.toSpec(next) : null;
  }

  upsertTaskState(teamId: string, state: TaskState, chatSessionId?: string | null): TaskState | null {
    const resolvedSessionId = this.resolveChatSessionId(teamId, state.taskId, chatSessionId);
    if (!resolvedSessionId) {
      return null;
    }
    const existing = this.board.get(teamId, resolvedSessionId, state.taskId);
    const next = this.board.write(teamId, resolvedSessionId, {
      id: state.taskId,
      revision: existing?.revision || 0,
      requestId: state.requestId,
      goal: existing?.goal || state.taskId,
      requires: existing?.requires || [],
      requiredCapability: existing?.requiredCapability || 'general',
      executionScope: existing?.executionScope || {
        workspaceId: resolvedSessionId,
        cwd: process.cwd(),
        allowedRoots: [process.cwd()],
        artifactsRoot: defaultArtifactsRoot(teamId, resolvedSessionId, state.owner),
      },
      status: statusToFactStatus(state.status),
      owner: state.owner || existing?.owner || null,
      attempt: existing?.attempt || 0,
      result: state.status === 'done' || state.status === 'verified' ? state.evidence.at(-1) || existing?.result || 'completed' : undefined,
      blockedBy: state.status === 'blocked' || state.status === 'failed' || state.status === 'timed_out'
        ? {
            kind: state.status === 'blocked' ? 'missing_input' : 'unknown',
            message: state.lastFailureReason || state.evidence.at(-1) || 'Task failed',
            retryable: state.status !== 'timed_out',
          }
        : undefined,
      createdBy: existing?.createdBy || state.owner || 'system',
    });
    if (!next) {
      return null;
    }
    const overlay = this.overlay(teamId, resolvedSessionId, state.taskId);
    overlay.todos = [...state.todos];
    overlay.evidence = [...state.evidence];
    overlay.replacementHistory = [...state.replacementHistory];
    overlay.updatedAt = state.updatedAt || new Date().toISOString();
    return this.toState(teamId, resolvedSessionId, next);
  }

  updateTaskStatus(teamId: string, taskId: string, status: TaskStatus, result?: string, chatSessionId?: string | null): TaskState | null {
    const resolvedSessionId = this.resolveChatSessionId(teamId, taskId, chatSessionId);
    if (!resolvedSessionId) {
      return null;
    }
    const existing = this.board.get(teamId, resolvedSessionId, taskId);
    if (!existing) {
      return null;
    }
    const next = this.board.write(teamId, resolvedSessionId, {
      id: taskId,
      revision: existing.revision,
      status: statusToFactStatus(status),
      result: status === 'done' || status === 'verified' ? result || existing.result || 'completed' : undefined,
      blockedBy: status === 'blocked' || status === 'failed' || status === 'timed_out'
        ? {
            kind: status === 'blocked' ? 'missing_input' : 'unknown',
            message: result || existing.blockedBy?.message || 'Task failed',
            retryable: status !== 'timed_out',
          }
        : undefined,
    });
    return next ? this.toState(teamId, resolvedSessionId, next) : null;
  }

  updateTaskDetails(teamId: string, taskId: string, patch: Partial<TaskState>, chatSessionId?: string | null): TaskState | null {
    const resolvedSessionId = this.resolveChatSessionId(teamId, taskId, chatSessionId);
    if (!resolvedSessionId) {
      return null;
    }
    const existing = this.board.get(teamId, resolvedSessionId, taskId);
    if (!existing) {
      return null;
    }
    const overlay = this.overlay(teamId, resolvedSessionId, taskId);
    if (Array.isArray(patch.todos)) overlay.todos = [...patch.todos];
    if (Array.isArray(patch.evidence)) overlay.evidence = [...patch.evidence];
    if (Array.isArray(patch.replacementHistory)) overlay.replacementHistory = [...patch.replacementHistory];
    overlay.updatedAt = patch.updatedAt || new Date().toISOString();
    return this.toState(teamId, resolvedSessionId, existing);
  }

  clear(teamId: string, chatSessionId?: string | null): void {
    for (const key of Array.from(this.overlays.keys())) {
      const [overlayTeamId, overlaySessionId] = key.split(':');
      if (overlayTeamId !== teamId) continue;
      if (chatSessionId && overlaySessionId !== chatSessionId) continue;
      this.overlays.delete(key);
    }
    for (const key of Array.from(this.sessionsByTask.keys())) {
      if (!key.startsWith(`${teamId}:`)) continue;
      this.sessionsByTask.delete(key);
    }
  }
}

let store: TaskStateStore | null = null;

export function getTaskStateStore(): TaskStateStore {
  if (!store) {
    store = new TaskStateStore();
  }
  return store;
}
