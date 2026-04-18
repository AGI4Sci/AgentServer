import { randomUUID } from 'crypto';
import { getTeamRegistry } from '../team/registry.js';
import { getHarnessEventStore } from './events.js';
import { createTeamSnapshot, getHarnessBaselineForTeam, resolveScenarioIdByTeamId } from './scenario-baselines.js';
import { buildRunReview, deriveRunOutcome } from './run-reviewer.js';
import { getHarnessRunStore } from './run-store.js';
import type { HarnessEvent, HarnessPerf, HarnessRunRecord } from './types.js';
import type { ParsedProjectTask } from './project-state.js';
import { shouldAttachUserAcceptance } from './completion-signals.js';
import { loadOpenTeamConfig } from '../../server/utils/openteam-config.js';

function runKey(teamId: string, requestId: string): string {
  return `${teamId}:${requestId}`;
}

function preview(body: string, maxLength: number = 160): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(empty)';
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function inferTaskType(body: string): string {
  const normalized = body.toLowerCase();
  if (normalized.includes('bug') || normalized.includes('fix') || normalized.includes('报错')) return 'bugfix';
  if (normalized.includes('research') || normalized.includes('调研')) return 'research';
  if (normalized.includes('ppt') || normalized.includes('slide')) return 'ppt';
  return 'general';
}

export class HarnessRunRecorder {
  private activeRuns = new Map<string, HarnessRunRecord>();
  private readonly store = getHarnessRunStore();
  private readonly eventStore = getHarnessEventStore();
  private readonly abandonmentMs = Math.max(30_000, Math.trunc(loadOpenTeamConfig().runtime.harness.abandonmentMs));

  startRun(input: {
    teamId: string;
    requestId: string;
    targetAgentId: string;
    body: string;
    sourceClientId?: string;
    projectId?: string;
  }): HarnessRunRecord | null {
    const key = runKey(input.teamId, input.requestId);
    const existing = this.activeRuns.get(key);
    if (existing) {
      return existing;
    }

    const registry = getTeamRegistry(input.teamId);
    if (!registry) {
      console.warn(`[HarnessRunRecorder] Team not found, skip run start: ${input.teamId}`);
      return null;
    }

    const run: HarnessRunRecord = {
      runId: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
      teamId: input.teamId,
      scenarioId: resolveScenarioIdByTeamId(input.teamId),
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      taskType: inferTaskType(input.body),
      projectId: input.projectId,
      startedAt: new Date().toISOString(),
      teamSnapshot: createTeamSnapshot(registry),
      harnessSnapshot: getHarnessBaselineForTeam(input.teamId),
      events: [
        {
          type: 'run_started',
          timestamp: Date.now(),
          teamId: input.teamId,
          scenarioId: resolveScenarioIdByTeamId(input.teamId),
          requestId: input.requestId,
          sourceClientId: input.sourceClientId,
          agentId: input.targetAgentId,
          to: input.targetAgentId,
          taskType: inferTaskType(input.body),
          teamSnapshot: createTeamSnapshot(registry),
          harnessSnapshot: getHarnessBaselineForTeam(input.teamId),
          projectId: input.projectId,
        },
      ],
    };

    this.activeRuns.set(key, run);
    this.eventStore.append(this.toLedgerEvent(run, run.events[0])!);
    return run;
  }

  private getActiveRun(teamId: string, requestId?: string): HarnessRunRecord | null {
    if (!requestId) return null;
    return this.activeRuns.get(runKey(teamId, requestId)) || this.findStoredRun(teamId, requestId);
  }

  private findStoredRun(teamId: string, requestId: string): HarnessRunRecord | null {
    const run = this.store.findRunByRequest({ teamId, requestId, onlyActive: true });
    if (run) {
      this.activeRuns.set(runKey(teamId, requestId), run);
      return run;
    }
    return null;
  }

  private appendEvent(teamId: string, requestId: string | undefined, event: HarnessEvent): void {
    const run = this.getActiveRun(teamId, requestId);
    if (!run) return;
    run.events.push(event);
    const canonical = this.toLedgerEvent(run, event);
    if (canonical) {
      this.eventStore.append(canonical);
    }
  }

  private toLedgerEvent(run: HarnessRunRecord, event: HarnessEvent) {
    switch (event.type) {
      case 'run_started':
        return this.eventStore.buildRunStarted({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          targetAgentId: event.to,
          taskType: event.taskType || run.taskType,
          teamSnapshot: event.teamSnapshot || run.teamSnapshot,
          harnessSnapshot: event.harnessSnapshot || run.harnessSnapshot,
        });
      case 'message_delivered':
        return this.eventStore.buildMessageDelivered({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          from: event.from,
          to: event.to,
          relation: event.relation,
          messageId: event.messageId,
          inReplyToMessageId: event.inReplyToMessageId,
          body: event.bodyPreview,
          sessionRef: event.sessionRef,
          perf: event.perf,
        });
      case 'message_intercepted':
        return this.eventStore.buildMessageIntercepted({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          from: event.from,
          to: event.to,
          reason: event.reason,
          perf: event.perf,
        });
      case 'message_replied':
        return this.eventStore.buildMessageReplied({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          from: event.from,
          to: event.to,
          messageId: event.messageId,
          inReplyToMessageId: event.inReplyToMessageId,
          body: event.bodyPreview,
          sessionRef: event.sessionRef,
          perf: event.perf,
        });
      case 'project_state_changed':
        return this.eventStore.buildProjectStateChanged({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: event.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          counts: event.counts,
          taskIds: event.taskIds,
        });
      case 'task_status_updated':
        return this.eventStore.buildTaskStatusUpdated({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: event.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          taskId: event.taskId,
          title: event.title,
          status: event.status,
          previousStatus: event.previousStatus,
          assignee: event.assignee,
          priority: event.priority,
        });
      case 'artifact_created':
        return this.eventStore.buildArtifactCreated({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: event.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: event.sourceClientId || run.sourceClientId,
          agentId: event.agentId,
          artifactPath: event.artifactPath,
          artifactType: event.artifactType,
          title: event.title,
        });
      case 'run_completed':
        return this.eventStore.buildRunCompleted({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: run.sourceClientId,
          agentId: event.completedBy,
          result: event.result,
          completedBy: event.completedBy,
          reason: event.reason,
        });
      case 'completion_signal_updated':
        return this.eventStore.buildCompletionSignalUpdated({
          timestamp: event.timestamp,
          runId: run.runId,
          teamId: run.teamId,
          projectId: run.projectId,
          scenarioId: run.scenarioId,
          requestId: run.requestId,
          sourceClientId: run.sourceClientId,
          agentId: event.completedBy,
          result: event.result,
          completedBy: event.completedBy,
          reason: event.reason,
        });
      default:
        return null;
    }
  }

  recordProjectStateChanged(input: {
    teamId: string;
    projectId: string;
    counts: {
      todo: number;
      active: number;
      blocked: number;
      done: number;
    };
    taskIds: string[];
    sourceClientId?: string;
  }): void {
    const run = this.getLatestActiveRun(input.teamId, input.projectId);
    if (!run) return;

    this.appendEvent(run.teamId, run.requestId, {
      type: 'project_state_changed',
      timestamp: Date.now(),
      teamId: run.teamId,
      requestId: run.requestId,
      sourceClientId: input.sourceClientId || run.sourceClientId,
      agentId: 'system',
      projectId: input.projectId,
      counts: input.counts,
      taskIds: input.taskIds,
    });
  }

  recordTaskStatusUpdated(input: {
    teamId: string;
    projectId: string;
    task: ParsedProjectTask;
    previousStatus?: ParsedProjectTask['status'];
    sourceClientId?: string;
  }): void {
    const run = this.getLatestActiveRun(input.teamId, input.projectId);
    if (!run) return;

    this.appendEvent(run.teamId, run.requestId, {
      type: 'task_status_updated',
      timestamp: Date.now(),
      teamId: run.teamId,
      requestId: run.requestId,
      sourceClientId: input.sourceClientId || run.sourceClientId,
      agentId: 'system',
      projectId: input.projectId,
      taskId: input.task.id,
      title: input.task.title,
      status: input.task.status,
      previousStatus: input.previousStatus,
      assignee: input.task.assignee,
      priority: input.task.priority,
    });
  }

  recordArtifactCreated(input: {
    teamId: string;
    projectId: string;
    artifactPath: string;
    title: string;
    sourceClientId?: string;
  }): void {
    const run = this.getLatestActiveRun(input.teamId, input.projectId);
    if (!run) return;

    this.appendEvent(run.teamId, run.requestId, {
      type: 'artifact_created',
      timestamp: Date.now(),
      teamId: run.teamId,
      requestId: run.requestId,
      sourceClientId: input.sourceClientId || run.sourceClientId,
      agentId: 'system',
      projectId: input.projectId,
      artifactPath: input.artifactPath,
      artifactType: 'file',
      title: input.title,
    });
  }

  recordMessageDelivered(input: {
    teamId: string;
    requestId?: string;
    from: string;
    to: string;
    agentId: string;
    messageId: string;
    body: string;
    sourceClientId?: string;
    relation?: 'delivery' | 'reply';
    inReplyToMessageId?: string | null;
    sessionRef?: string;
    isPrivate?: boolean;
    perf?: HarnessPerf;
  }): void {
    this.appendEvent(input.teamId, input.requestId, {
      type: 'message_delivered',
      timestamp: Date.now(),
      teamId: input.teamId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      relation: input.relation || 'delivery',
      messageId: input.messageId,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      bodyPreview: preview(input.body),
      sessionRef: input.sessionRef,
      isPrivate: input.isPrivate,
      perf: input.perf,
    });
  }

  recordMessageIntercepted(input: {
    teamId: string;
    requestId?: string;
    from: string;
    to: string;
    agentId: string;
    reason: string;
    sourceClientId?: string;
    perf?: HarnessPerf;
  }): void {
    this.appendEvent(input.teamId, input.requestId, {
      type: 'message_intercepted',
      timestamp: Date.now(),
      teamId: input.teamId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      reason: preview(input.reason),
      perf: input.perf,
    });
  }

  recordMessageReplied(input: {
    teamId: string;
    requestId?: string;
    from: string;
    to: string;
    agentId: string;
    messageId: string;
    body: string;
    sourceClientId?: string;
    inReplyToMessageId?: string | null;
    sessionRef?: string;
    stale?: boolean;
    isPrivate?: boolean;
    perf?: HarnessPerf;
  }): void {
    this.appendEvent(input.teamId, input.requestId, {
      type: 'message_replied',
      timestamp: Date.now(),
      teamId: input.teamId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      relation: 'reply',
      messageId: input.messageId,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      bodyPreview: preview(input.body),
      sessionRef: input.sessionRef,
      stale: input.stale,
      isPrivate: input.isPrivate,
      perf: input.perf,
    });
  }

  completeRun(input: {
    teamId: string;
    requestId: string;
    completedBy: string;
    result?: 'completed' | 'abandoned';
    reason?: string;
  }): HarnessRunRecord | null {
    const key = runKey(input.teamId, input.requestId);
    const run = this.activeRuns.get(key) || this.findStoredRun(input.teamId, input.requestId);
    if (!run || run.finishedAt) {
      return run || null;
    }

    run.finishedAt = new Date().toISOString();
    run.events.push({
      type: 'run_completed',
      timestamp: Date.now(),
      teamId: input.teamId,
      requestId: input.requestId,
      result: input.result || 'completed',
      completedBy: input.completedBy,
      reason: input.reason,
    });
    this.eventStore.append(this.toLedgerEvent(run, run.events[run.events.length - 1])!);
    run.outcome = deriveRunOutcome(run);
    run.review = buildRunReview(run);

    this.activeRuns.delete(key);
    return run;
  }

  getRunByRequest(teamId: string, requestId: string): HarnessRunRecord | null {
    return this.activeRuns.get(runKey(teamId, requestId)) || this.findStoredRun(teamId, requestId);
  }

  getLatestActiveRun(teamId: string, projectId?: string): HarnessRunRecord | null {
    const activeRuns = [...this.activeRuns.values()]
      .filter(run => run.teamId === teamId && !run.finishedAt && (!projectId || run.projectId === projectId))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return activeRuns[0] || null;
  }

  completeLatestActiveRunForTeam(input: {
    teamId: string;
    completedBy: string;
    reason: 'coordinator_explicit' | 'user_accepted' | 'task_closure';
    projectId?: string;
  }): HarnessRunRecord | null {
    const run = this.getLatestActiveRun(input.teamId, input.projectId);
    if (!run) return null;
    return this.completeRun({
      teamId: run.teamId,
      requestId: run.requestId,
      completedBy: input.completedBy,
      result: 'completed',
      reason: input.reason,
    });
  }

  markUserAccepted(teamId: string, body: string, projectId?: string): HarnessRunRecord | null {
    const activeRun = this.getLatestActiveRun(teamId, projectId);
    if (activeRun) {
      const completed = this.completeLatestActiveRunForTeam({
        teamId,
        completedBy: 'user',
        reason: 'user_accepted',
        projectId,
      });
      if (completed?.outcome) {
        completed.outcome.artifactAccepted = true;
        completed.outcome.userSatisfied = true;
        completed.review = buildRunReview(completed);
      }
      return completed;
    }

    const recentFinished = this.store
      .findRecentFinishedRuns({ teamId, projectId, limit: 20 })
      .find(run => run.finishedAt && (!projectId || run.projectId === projectId) && shouldAttachUserAcceptance(run));

    if (!recentFinished || !recentFinished.outcome) {
      return null;
    }

    recentFinished.events.push({
      type: 'completion_signal_updated',
      timestamp: Date.now(),
      teamId: recentFinished.teamId,
      requestId: recentFinished.requestId,
      result: 'completed',
      completedBy: 'user',
      reason: 'user_accepted',
    });
    this.eventStore.append(this.toLedgerEvent(recentFinished, recentFinished.events[recentFinished.events.length - 1])!);
    recentFinished.outcome.artifactAccepted = true;
    recentFinished.outcome.userSatisfied = true;
    recentFinished.outcome.completionSignal = 'user_accepted';
    recentFinished.review = buildRunReview(recentFinished);
    return recentFinished;
  }

  sweepAbandonedRuns(now = Date.now()): HarnessRunRecord[] {
    const abandoned: HarnessRunRecord[] = [];

    for (const [key, run] of this.activeRuns.entries()) {
      if (run.finishedAt) {
        this.activeRuns.delete(key);
        continue;
      }

      const lastEvent = run.events[run.events.length - 1];
      const lastTimestamp = lastEvent?.timestamp || Date.parse(run.startedAt);
      if (now - lastTimestamp < this.abandonmentMs) {
        continue;
      }

      const completed = this.completeRun({
        teamId: run.teamId,
        requestId: run.requestId,
        completedBy: 'system',
        result: 'abandoned',
        reason: `No activity for ${Math.round(this.abandonmentMs / 60000)}m`,
      });
      if (completed) {
        abandoned.push(completed);
      }
    }

    return abandoned;
  }
}

let recorder: HarnessRunRecorder | null = null;

export function getHarnessRunRecorder(): HarnessRunRecorder {
  if (!recorder) {
    recorder = new HarnessRunRecorder();
  }
  return recorder;
}
