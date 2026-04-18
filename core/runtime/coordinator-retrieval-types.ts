import type { TaskFact } from './blackboard-types.js';

export interface ArchivedChatBlock {
  blockId: string;
  messageId?: string | null;
  agent: string;
  originalContent: string;
  summary: string;
  entities: string[];
  timestamp: string;
  archivedAt: string;
  source?: 'archived' | 'chat_history' | 'agent_recall';
  score?: number;
}

export type ArchivedRetrievalLayer =
  | 'entities_exact'
  | 'fulltext_keywords'
  | 'candidate_rerank';

export interface ArchivedRetrievalResult {
  scope?: 'session' | 'agent' | 'team' | 'path' | 'web';
  layer: ArchivedRetrievalLayer;
  blocks: ArchivedChatBlock[];
  failureReason?: string;
}

const ENTITY_PATH_REGEX = /(\/[A-Za-z0-9._~\-\/]+)/g;
const ENTITY_URL_REGEX = /https?:\/\/[^\s`"'，。；;）)\]]+/g;
const ENTITY_PORT_REGEX = /\b\d{2,5}\b/g;
const ENTITY_TASK_REGEX = /\b[A-Z]{1,4}\d{2,4}\b/g;
const ENTITY_AGENT_REGEX = /\b(?:user|system|pm-\d+|dev-\d+|reviewer-\d+|qa-\d+|research-[\w-]+|literature-reviewer-\d+|tool-executor-\d+)\b/g;

export function extractArchivedEntities(content: string): string[] {
  const entities = new Set<string>();
  for (const regex of [ENTITY_PATH_REGEX, ENTITY_URL_REGEX, ENTITY_PORT_REGEX, ENTITY_TASK_REGEX, ENTITY_AGENT_REGEX]) {
    for (const match of content.matchAll(regex)) {
      const value = match[0]?.trim();
      if (value) {
        entities.add(value);
      }
    }
  }
  return [...entities].slice(0, 32);
}

export function summarizeArchivedContent(content: string, maxChars = 280): string {
  const normalized = String(content || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}

export function toArchivedBlockFromTaskFact(fact: TaskFact): ArchivedChatBlock {
  const originalContent = String(fact.result || fact.goal || '').trim();
  const timestamp = new Date(fact.updatedAt || Date.now()).toISOString();
  return {
    blockId: `task-${fact.id}-rev-${fact.revision}`,
    messageId: null,
    agent: fact.owner || fact.requiredCapability || 'unknown',
    originalContent,
    summary: summarizeArchivedContent(originalContent || fact.goal),
    entities: extractArchivedEntities(`${fact.goal}\n${originalContent}`),
    timestamp,
    archivedAt: timestamp,
    source: 'archived',
  };
}

export function buildArchivedBlocksFromTaskFacts(facts: TaskFact[]): ArchivedChatBlock[] {
  return facts
    .filter((fact) => fact.status === 'done')
    .map(toArchivedBlockFromTaskFact)
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt));
}

export function buildActiveTaskContextEntries(facts: TaskFact[]): Array<{ text: string; fullContent: string }> {
  return facts
    .filter((fact) => fact.status !== 'done')
    .map((fact) => {
      const lines = [
        `taskId: ${fact.id}`,
        `status: ${fact.status}`,
        `capability: ${fact.requiredCapability}`,
        `goal: ${fact.goal}`,
      ];
      if (fact.blockedBy?.message) {
        lines.push(`blockedBy: ${fact.blockedBy.message}`);
      }
      return {
        text: `${fact.id} ${fact.status} ${fact.goal}`.trim(),
        fullContent: lines.join('\n'),
      };
    });
}
