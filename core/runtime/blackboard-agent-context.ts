import type { BlackboardStore } from '../store/blackboard-store.js';
import type { SoulStore } from '../store/soul-store.js';
import type { ExecutionScope, TaskFact } from './blackboard-types.js';
import { existsSync, readFileSync } from 'node:fs';

export interface BlackboardAgentContextDependency {
  taskId: string;
  owner: string | null;
  status: TaskFact['status'];
  result: string;
  resultRef?: string;
  artifactsRoot: string;
  summaryArtifactPath: string;
  summaryArtifactExcerpt?: string;
}

export interface BlackboardAgentContext {
  taskId: string;
  goal: string;
  executionScope: ExecutionScope;
  dependencies: BlackboardAgentContextDependency[];
  workspaceFacts: Record<string, string>;
}

const FACTS_FILENAME = 'facts.kv';
const MAX_SUMMARY_EXCERPT_CHARS = 600;

function normalizeFactKey(key: string): string {
  return String(key || '').trim();
}

function normalizeFactValue(value: string): string {
  return String(value || '').trim();
}

export function parseFactsKv(content: string): Record<string, string> {
  const lines = String(content || '').split('\n');
  const entries: Record<string, string> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = normalizeFactKey(line.slice(0, separatorIndex));
    const value = normalizeFactValue(line.slice(separatorIndex + 1));
    if (!key || !value) {
      continue;
    }
    entries[key] = value;
  }

  return entries;
}

export function stringifyFactsKv(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([key, value]) => [normalizeFactKey(key), normalizeFactValue(value)] as const)
    .filter(([key, value]) => key && value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export function getWorkspaceFacts(entries: Record<string, string>, workspaceId: string): Record<string, string> {
  const prefix = `${normalizeFactKey(workspaceId)}/`;
  if (!workspaceId) {
    return {};
  }

  return Object.entries(entries).reduce<Record<string, string>>((acc, [key, value]) => {
    if (!key.startsWith(prefix)) {
      return acc;
    }
    const scopedKey = key.slice(prefix.length).trim();
    if (!scopedKey) {
      return acc;
    }
    acc[scopedKey] = value;
    return acc;
  }, {});
}

export function readWorkspaceFacts(store: SoulStore, agentId: string, workspaceId: string): Record<string, string> {
  const file = store.getAgentMemoryFile(agentId, FACTS_FILENAME);
  if (!file) {
    return {};
  }
  return getWorkspaceFacts(parseFactsKv(file.content), workspaceId);
}

export function upsertWorkspaceFact(
  store: SoulStore,
  agentId: string,
  workspaceId: string,
  key: string,
  value: string,
): void {
  const scopedWorkspaceId = normalizeFactKey(workspaceId);
  const scopedKey = normalizeFactKey(key);
  const scopedValue = normalizeFactValue(value);
  if (!scopedWorkspaceId || !scopedKey || !scopedValue) {
    return;
  }

  const existing = store.getAgentMemoryFile(agentId, FACTS_FILENAME);
  const entries = parseFactsKv(existing?.content || '');
  entries[`${scopedWorkspaceId}/${scopedKey}`] = scopedValue;
  store.writeAgentMemory(agentId, FACTS_FILENAME, stringifyFactsKv(entries));
}

export function deriveBlackboardTaskDependencyHandoffs(
  board: BlackboardStore,
  teamId: string,
  chatSessionId: string,
  task: TaskFact,
): BlackboardAgentContextDependency[] {
  return task.requires
    .map((dependencyId) => board.get(teamId, chatSessionId, dependencyId))
    .filter((fact): fact is TaskFact => Boolean(fact && fact.status === 'done' && fact.result))
    .map((fact) => ({
      taskId: fact.id,
      owner: fact.owner,
      status: fact.status,
      result: fact.result!,
      resultRef: fact.resultRef || undefined,
      artifactsRoot: fact.executionScope.artifactsRoot,
      summaryArtifactPath: `${fact.executionScope.artifactsRoot}/summary.md`,
      summaryArtifactExcerpt: readSummaryArtifactExcerpt(`${fact.executionScope.artifactsRoot}/summary.md`),
    }));
}

function readSummaryArtifactExcerpt(path: string): string | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }
    const normalized = readFileSync(path, 'utf8').replace(/\s+/g, ' ').trim();
    if (!normalized) {
      return undefined;
    }
    return normalized.length > MAX_SUMMARY_EXCERPT_CHARS
      ? `${normalized.slice(0, MAX_SUMMARY_EXCERPT_CHARS - 3)}...`
      : normalized;
  } catch {
    return undefined;
  }
}

export function buildBlackboardAgentContext(args: {
  board: BlackboardStore;
  soulStore: SoulStore;
  teamId: string;
  chatSessionId: string;
  taskId: string;
  agentId: string;
}): BlackboardAgentContext | null {
  const task = args.board.get(args.teamId, args.chatSessionId, args.taskId);
  if (!task) {
    return null;
  }

  return {
    taskId: task.id,
    goal: task.goal,
    executionScope: task.executionScope,
    dependencies: deriveBlackboardTaskDependencyHandoffs(args.board, args.teamId, args.chatSessionId, task),
    workspaceFacts: readWorkspaceFacts(args.soulStore, args.agentId, task.executionScope.workspaceId),
  };
}
