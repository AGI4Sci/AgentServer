import type { HarnessLedgerEvent } from './events.js';
import { getHarnessEventStore } from './events.js';
import { buildRunReview, deriveRunOutcome } from './run-reviewer.js';
import type { HarnessEvent, HarnessRunRecord, RunReview } from './types.js';

export function inferTaskTypeFromEvents(events: HarnessEvent[]): string {
  const firstUserMessage = events.find(
    (event): event is Extract<HarnessEvent, { type: 'message_delivered' }> =>
      event.type === 'message_delivered' && event.from === 'user'
  );
  const normalized = firstUserMessage?.bodyPreview?.toLowerCase() || '';
  if (normalized.includes('bug') || normalized.includes('fix') || normalized.includes('报错')) return 'bugfix';
  if (normalized.includes('research') || normalized.includes('调研')) return 'research';
  if (normalized.includes('ppt') || normalized.includes('slide')) return 'ppt';
  return 'general';
}

export function toHarnessEvent(event: HarnessLedgerEvent): HarnessEvent {
  switch (event.type) {
    case 'run_started':
      return {
        type: 'run_started',
        timestamp: event.timestamp,
        teamId: event.teamId,
        scenarioId: event.scenarioId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        to: event.to || event.agentId,
        taskType: event.taskType,
        teamSnapshot: event.teamSnapshot,
        harnessSnapshot: event.harnessSnapshot,
        projectId: event.projectId,
      };
    case 'message_delivered':
      return {
        type: 'message_delivered',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        from: event.from || 'unknown',
        to: event.to || 'unknown',
        relation: event.relation || 'delivery',
        messageId: event.messageId || event.eventId,
        inReplyToMessageId: event.inReplyToMessageId,
        bodyPreview: event.bodyPreview || '',
        sessionRef: event.sessionRef,
        perf: event.perf,
      };
    case 'message_intercepted':
      return {
        type: 'message_intercepted',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        from: event.from || 'unknown',
        to: event.to || 'unknown',
        reason: event.reason || '',
        perf: event.perf,
      };
    case 'message_replied':
      return {
        type: 'message_replied',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        from: event.from || 'unknown',
        to: event.to || 'unknown',
        relation: 'reply',
        messageId: event.messageId || event.eventId,
        inReplyToMessageId: event.inReplyToMessageId,
        bodyPreview: event.bodyPreview || '',
        sessionRef: event.sessionRef,
        perf: event.perf,
      };
    case 'project_state_changed':
      return {
        type: 'project_state_changed',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        projectId: event.projectId || 'unknown',
        counts: event.counts || { todo: 0, active: 0, blocked: 0, done: 0 },
        taskIds: event.taskIds || [],
      };
    case 'task_status_updated':
      return {
        type: 'task_status_updated',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        projectId: event.projectId || 'unknown',
        taskId: event.taskId || event.eventId,
        title: event.title || '',
        status: event.status || 'todo',
        previousStatus: event.previousStatus,
        assignee: event.assignee,
        priority: event.priority,
      };
    case 'artifact_created':
      return {
        type: 'artifact_created',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        sourceClientId: event.sourceClientId,
        agentId: event.agentId,
        projectId: event.projectId || 'unknown',
        artifactPath: event.artifactPath || '',
        artifactType: event.artifactType || 'file',
        title: event.title || event.artifactPath || '',
      };
    case 'run_completed':
      return {
        type: 'run_completed',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        result: event.result || 'completed',
        completedBy: event.completedBy || event.agentId,
        reason: event.reason,
      };
    case 'completion_signal_updated':
      return {
        type: 'completion_signal_updated',
        timestamp: event.timestamp,
        teamId: event.teamId,
        requestId: event.requestId,
        result: event.result || 'completed',
        completedBy: event.completedBy || event.agentId,
        reason: event.reason,
      };
  }
}

export function rebuildRunFromLedgerEvents(events: HarnessLedgerEvent[]): HarnessRunRecord {
  if (events.length === 0) {
    throw new Error('No events provided for rebuild');
  }

  const first = events[0];
  const runEvents = events.map(toHarnessEvent);
  const completedEvent = [...runEvents].reverse().find(
    (event): event is Extract<HarnessEvent, { type: 'run_completed' }> => event.type === 'run_completed'
  );
  const startEvent = runEvents[0]?.type === 'run_started' ? runEvents[0] : null;
  if (!startEvent) {
    throw new Error(`Missing run_started event for ${first.runId}`);
  }
  if (!startEvent.teamSnapshot || !startEvent.harnessSnapshot) {
    throw new Error(`run_started is missing teamSnapshot or harnessSnapshot for ${first.runId}`);
  }

  const run: HarnessRunRecord = {
    runId: first.runId,
    teamId: first.teamId,
    scenarioId: first.scenarioId,
    requestId: first.requestId,
    sourceClientId: first.sourceClientId,
    taskType:
      startEvent.taskType ||
      first.taskType ||
      inferTaskTypeFromEvents(runEvents) ||
      'general',
    projectId: startEvent.projectId || first.projectId,
    startedAt: new Date(first.timestamp).toISOString(),
    finishedAt: completedEvent ? new Date(completedEvent.timestamp).toISOString() : undefined,
    teamSnapshot: startEvent.teamSnapshot,
    harnessSnapshot: startEvent.harnessSnapshot,
    events: runEvents,
  };

  run.outcome = deriveRunOutcome(run);
  run.review = buildRunReview(run);
  return run;
}

export function rebuildRun(runId: string): HarnessRunRecord {
  const eventStore = getHarnessEventStore();
  const events = eventStore.listEventsForRun(runId);
  if (events.length === 0) {
    throw new Error(`No events found for run ${runId}`);
  }
  return rebuildRunFromLedgerEvents(events);
}

export function rebuildReview(runId: string): RunReview {
  return rebuildRun(runId).review!;
}
