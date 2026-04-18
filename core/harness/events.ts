import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../../server/utils/paths.js';
import type { HarnessPerf, HarnessScenarioId, HarnessSnapshot, TeamSnapshot } from './types.js';

const HARNESS_DATA_DIR = join(PROJECT_ROOT, 'data', 'harness');
const EVENTS_DIR = join(HARNESS_DATA_DIR, 'events');
const INDEX_DIR = join(HARNESS_DATA_DIR, 'index');
const RUN_ID_TO_DATES_PATH = join(INDEX_DIR, 'runId-to-dates.json');

export type HarnessLedgerEventType =
  | 'run_started'
  | 'message_delivered'
  | 'message_intercepted'
  | 'message_replied'
  | 'project_state_changed'
  | 'task_status_updated'
  | 'artifact_created'
  | 'run_completed'
  | 'completion_signal_updated';

export interface HarnessLedgerEvent {
  schemaVersion: '1.0';
  eventId: string;
  timestamp: number;
  runId: string;
  teamId: string;
  projectId?: string;
  scenarioId: HarnessScenarioId;
  requestId: string;
  sourceClientId?: string;
  type: HarnessLedgerEventType;
  agentId: string;
  from?: string;
  to?: string;
  relation?: 'delivery' | 'reply';
  messageId?: string;
  inReplyToMessageId?: string | null;
  bodyPreview?: string;
  sessionRef?: string;
  result?: 'completed' | 'abandoned';
  completedBy?: string;
  reason?: string;
  perf?: HarnessPerf;
  counts?: {
    todo: number;
    active: number;
    blocked: number;
    done: number;
  };
  taskIds?: string[];
  taskId?: string;
  title?: string;
  status?: 'todo' | 'active' | 'blocked' | 'done';
  previousStatus?: 'todo' | 'active' | 'blocked' | 'done';
  assignee?: string;
  priority?: string;
  artifactPath?: string;
  artifactType?: 'file';
  taskType?: string;
  teamSnapshot?: TeamSnapshot;
  harnessSnapshot?: HarnessSnapshot;
}

function ensureHarnessEventDirs(): void {
  [HARNESS_DATA_DIR, EVENTS_DIR, INDEX_DIR].forEach((dir) => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });
}

function toUtcDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function toEventDatePart(ts: number): string {
  return toUtcDate(ts).replace(/-/g, '');
}

function preview(body: string, maxLength: number = 120): string {
  const normalized = body.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(empty)';
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function safeReadIndex(): Record<string, string[]> {
  if (!existsSync(RUN_ID_TO_DATES_PATH)) {
    return {};
  }

  try {
    const content = readFileSync(RUN_ID_TO_DATES_PATH, 'utf-8');
    return JSON.parse(content) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function safeParseEventLine(content: string): HarnessLedgerEvent | null {
  try {
    return JSON.parse(content) as HarnessLedgerEvent;
  } catch {
    return null;
  }
}

function requireField<T>(value: T | undefined | null, field: string, type: HarnessLedgerEventType): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`[HarnessEventStore] Missing required field "${field}" for event type "${type}"`);
  }
  return value as T;
}

export function validateLedgerEvent(event: HarnessLedgerEvent): void {
  requireField(event.schemaVersion, 'schemaVersion', event.type);
  requireField(event.eventId, 'eventId', event.type);
  requireField(event.timestamp, 'timestamp', event.type);
  requireField(event.runId, 'runId', event.type);
  requireField(event.teamId, 'teamId', event.type);
  requireField(event.scenarioId, 'scenarioId', event.type);
  requireField(event.requestId, 'requestId', event.type);
  requireField(event.agentId, 'agentId', event.type);

  switch (event.type) {
    case 'run_started':
      requireField(event.to, 'to', event.type);
      requireField(event.teamSnapshot, 'teamSnapshot', event.type);
      requireField(event.harnessSnapshot, 'harnessSnapshot', event.type);
      break;
    case 'message_delivered':
      requireField(event.from, 'from', event.type);
      requireField(event.to, 'to', event.type);
      requireField(event.relation, 'relation', event.type);
      requireField(event.messageId, 'messageId', event.type);
      requireField(event.bodyPreview, 'bodyPreview', event.type);
      break;
    case 'message_intercepted':
      requireField(event.from, 'from', event.type);
      requireField(event.to, 'to', event.type);
      requireField(event.reason, 'reason', event.type);
      break;
    case 'message_replied':
      requireField(event.from, 'from', event.type);
      requireField(event.to, 'to', event.type);
      requireField(event.messageId, 'messageId', event.type);
      requireField(event.bodyPreview, 'bodyPreview', event.type);
      break;
    case 'project_state_changed':
      requireField(event.projectId, 'projectId', event.type);
      requireField(event.counts, 'counts', event.type);
      requireField(event.taskIds, 'taskIds', event.type);
      break;
    case 'task_status_updated':
      requireField(event.projectId, 'projectId', event.type);
      requireField(event.taskId, 'taskId', event.type);
      requireField(event.title, 'title', event.type);
      requireField(event.status, 'status', event.type);
      break;
    case 'artifact_created':
      requireField(event.projectId, 'projectId', event.type);
      requireField(event.artifactPath, 'artifactPath', event.type);
      requireField(event.artifactType, 'artifactType', event.type);
      requireField(event.title, 'title', event.type);
      break;
    case 'run_completed':
    case 'completion_signal_updated':
      requireField(event.result, 'result', event.type);
      requireField(event.completedBy, 'completedBy', event.type);
      break;
  }
}

export class HarnessEventStore {
  private sequenceByDate = new Map<string, number>();

  constructor() {
    ensureHarnessEventDirs();
  }

  createEventId(timestamp: number): string {
    const datePart = toEventDatePart(timestamp);
    const next = this.getNextSequence(datePart);
    this.sequenceByDate.set(datePart, next);
    return `evt-${datePart}-${String(next).padStart(6, '0')}`;
  }

  append(event: HarnessLedgerEvent): void {
    ensureHarnessEventDirs();
    validateLedgerEvent(event);
    const date = toUtcDate(event.timestamp);
    const path = join(EVENTS_DIR, `${date}.jsonl`);
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf-8');
    this.recordRunDate(event.runId, date);
  }

  getRunDates(runId: string): string[] {
    const index = safeReadIndex();
    return index[runId] || [];
  }

  getIndexedRunIds(): string[] {
    return Object.keys(safeReadIndex()).sort();
  }

  removeIndexedRunId(runId: string): void {
    const index = safeReadIndex();
    if (!(runId in index)) {
      return;
    }
    delete index[runId];
    writeFileSync(RUN_ID_TO_DATES_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  }

  listEventsForDate(date: string): HarnessLedgerEvent[] {
    const path = join(EVENTS_DIR, `${date}.jsonl`);
    if (!existsSync(path)) {
      return [];
    }

    return readFileSync(path, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => safeParseEventLine(line))
      .filter((event): event is HarnessLedgerEvent => Boolean(event))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  listEventsForRun(runId: string): HarnessLedgerEvent[] {
    const dates = this.getRunDates(runId);
    if (dates.length === 0) {
      return [];
    }

    return dates
      .flatMap((date) => this.listEventsForDate(date))
      .filter((event) => event.runId === runId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  buildRunStarted(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    targetAgentId: string;
    taskType?: string;
    teamSnapshot?: TeamSnapshot;
    harnessSnapshot?: HarnessSnapshot;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'run_started',
      agentId: input.targetAgentId,
      to: input.targetAgentId,
      taskType: input.taskType,
      teamSnapshot: input.teamSnapshot,
      harnessSnapshot: input.harnessSnapshot,
    };
  }

  buildMessageDelivered(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    from: string;
    to: string;
    relation: 'delivery' | 'reply';
    messageId: string;
    inReplyToMessageId?: string | null;
    body: string;
    sessionRef?: string;
    perf?: HarnessPerf;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'message_delivered',
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      relation: input.relation,
      messageId: input.messageId,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      bodyPreview: preview(input.body),
      sessionRef: input.sessionRef,
      perf: input.perf,
    };
  }

  buildMessageIntercepted(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    from: string;
    to: string;
    reason: string;
    perf?: HarnessPerf;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'message_intercepted',
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      reason: preview(input.reason),
      perf: input.perf,
    };
  }

  buildMessageReplied(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    from: string;
    to: string;
    messageId: string;
    inReplyToMessageId?: string | null;
    body: string;
    sessionRef?: string;
    perf?: HarnessPerf;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'message_replied',
      agentId: input.agentId,
      from: input.from,
      to: input.to,
      relation: 'reply',
      messageId: input.messageId,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      bodyPreview: preview(input.body),
      sessionRef: input.sessionRef,
      perf: input.perf,
    };
  }

  buildRunCompleted(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    result: 'completed' | 'abandoned';
    completedBy: string;
    reason?: string;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'run_completed',
      agentId: input.agentId,
      result: input.result,
      completedBy: input.completedBy,
      reason: input.reason,
    };
  }

  buildCompletionSignalUpdated(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId?: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    result: 'completed' | 'abandoned';
    completedBy: string;
    reason?: string;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'completion_signal_updated',
      agentId: input.agentId,
      result: input.result,
      completedBy: input.completedBy,
      reason: input.reason,
    };
  }

  buildProjectStateChanged(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    counts: {
      todo: number;
      active: number;
      blocked: number;
      done: number;
    };
    taskIds: string[];
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'project_state_changed',
      agentId: input.agentId,
      counts: input.counts,
      taskIds: input.taskIds,
    };
  }

  buildTaskStatusUpdated(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    taskId: string;
    title: string;
    status: 'todo' | 'active' | 'blocked' | 'done';
    previousStatus?: 'todo' | 'active' | 'blocked' | 'done';
    assignee?: string;
    priority?: string;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'task_status_updated',
      agentId: input.agentId,
      taskId: input.taskId,
      title: input.title,
      status: input.status,
      previousStatus: input.previousStatus,
      assignee: input.assignee,
      priority: input.priority,
    };
  }

  buildArtifactCreated(input: {
    timestamp?: number;
    runId: string;
    teamId: string;
    projectId: string;
    scenarioId: HarnessScenarioId;
    requestId: string;
    sourceClientId?: string;
    agentId: string;
    artifactPath: string;
    artifactType: 'file';
    title: string;
  }): HarnessLedgerEvent {
    const timestamp = input.timestamp ?? Date.now();
    return {
      schemaVersion: '1.0',
      eventId: this.createEventId(timestamp),
      timestamp,
      runId: input.runId,
      teamId: input.teamId,
      projectId: input.projectId,
      scenarioId: input.scenarioId,
      requestId: input.requestId,
      sourceClientId: input.sourceClientId,
      type: 'artifact_created',
      agentId: input.agentId,
      artifactPath: input.artifactPath,
      artifactType: input.artifactType,
      title: input.title,
    };
  }

  private recordRunDate(runId: string, date: string): void {
    const index = safeReadIndex();
    const existingDates = new Set(index[runId] || []);
    if (existingDates.has(date)) {
      return;
    }

    existingDates.add(date);
    index[runId] = [...existingDates].sort();
    writeFileSync(RUN_ID_TO_DATES_PATH, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  }

  private getNextSequence(datePart: string): number {
    const cached = this.sequenceByDate.get(datePart);
    if (typeof cached === 'number') {
      return cached + 1;
    }

    const date = `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}`;
    const path = join(EVENTS_DIR, `${date}.jsonl`);
    if (!existsSync(path)) {
      return 1;
    }

    try {
      const lines = readFileSync(path, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const lastEvent = lines.length > 0 ? JSON.parse(lines[lines.length - 1]) as { eventId?: string } : null;
      const lastSequence = lastEvent?.eventId?.match(/-(\d{6})$/)?.[1];
      return lastSequence ? Number.parseInt(lastSequence, 10) + 1 : lines.length + 1;
    } catch {
      return 1;
    }
  }
}

let store: HarnessEventStore | null = null;

export function getHarnessEventStore(): HarnessEventStore {
  if (!store) {
    store = new HarnessEventStore();
  }
  return store;
}
