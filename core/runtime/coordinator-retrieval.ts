import type { ArchivedChatBlock, ArchivedRetrievalResult } from './coordinator-retrieval-types.js';
import type { TeamChatMessage } from '../store/team-chat-store.js';
import type { SessionMessage } from '../store/session-store.js';
import { loadOpenTeamConfig } from '../../server/utils/openteam-config.js';

export interface AgentRecallEntry {
  agentId: string;
  message: SessionMessage;
}

interface RankedRetrievedBlock extends ArchivedChatBlock {
  score: number;
}

function normalizeQueryTokens(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function extractEntities(content: string): string[] {
  const limit = loadOpenTeamConfig().retrieval.ranking.maxEntitiesPerBlock;
  const entities = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s`"'，。；;）)\]]+/g)) {
    entities.add(match[0]);
  }
  for (const match of content.matchAll(/(\/[A-Za-z0-9._~\-\/]+)/g)) {
    entities.add(match[0]);
  }
  for (const match of content.matchAll(/\b\d{2,5}\b/g)) {
    entities.add(match[0]);
  }
  for (const match of content.matchAll(/\b(?:user|system|pm-\d+|dev-\d+|reviewer-\d+|qa-\d+)\b/g)) {
    entities.add(match[0]);
  }
  return [...entities].slice(0, limit);
}

function summarize(content: string, max = 280): string {
  const maxChars = loadOpenTeamConfig().retrieval.ranking.summaryMaxChars;
  const normalized = content.replace(/\s+/g, ' ').trim();
  const effectiveMax = Math.max(16, maxChars || max);
  return normalized.length <= effectiveMax ? normalized : `${normalized.slice(0, effectiveMax - 3)}...`;
}

function scoreEntityMatch(block: ArchivedChatBlock, tokens: string[]): number {
  let score = 0;
  for (const token of tokens) {
    for (const entity of block.entities) {
      const normalized = entity.toLowerCase();
      if (normalized === token) {
        score += 8;
      } else if (normalized.includes(token)) {
        score += 5;
      }
    }
  }
  return score;
}

function scoreFulltextMatch(block: ArchivedChatBlock, tokens: string[]): number {
  let score = 0;
  const haystacks = [
    block.originalContent.toLowerCase(),
    block.summary.toLowerCase(),
    block.agent.toLowerCase(),
  ];
  for (const token of tokens) {
    for (const haystack of haystacks) {
      if (haystack.includes(token)) {
        score += haystack === block.originalContent.toLowerCase() ? 4 : 2;
      } else if (token.length >= 5) {
        const prefix = token.slice(0, Math.max(4, Math.floor(token.length * 0.7)));
        if (haystack.includes(prefix)) {
          score += 1;
        }
      }
    }
  }
  return score;
}

function rankBlocks(
  blocks: ArchivedChatBlock[],
  scorer: (block: ArchivedChatBlock, tokens: string[]) => number,
  tokens: string[],
  limit: number,
): RankedRetrievedBlock[] {
  return blocks
    .map((block) => ({ ...block, score: scorer(block, tokens) }))
    .filter((block) => block.score > 0)
    .sort((a, b) => b.score - a.score || b.archivedAt.localeCompare(a.archivedAt))
    .slice(0, limit);
}

function shouldShortCircuitEntity(matches: RankedRetrievedBlock[], tokens: string[]): boolean {
  if (matches.length === 0) return false;
  const topScore = matches[0].score;
  return topScore >= loadOpenTeamConfig().retrieval.ranking.entityMatchShortCircuitScore;
}

function shouldShortCircuitFulltext(matches: RankedRetrievedBlock[], tokens: string[]): boolean {
  if (matches.length === 0) return false;
  const topScore = matches[0].score;
  const config = loadOpenTeamConfig().retrieval.ranking;
  return topScore >= Math.max(config.fulltextShortCircuitMinScore, tokens.length * config.finalScoreThresholdPerToken)
    || matches.length >= config.fulltextShortCircuitMinHits;
}

function toChatHistoryBlocks(messages: TeamChatMessage[]): ArchivedChatBlock[] {
  return messages.map((message, index) => {
    const originalContent = message.fullContent || message.text || '';
    return {
      blockId: `chat-${message.timestamp || message.time}-${index}`,
      agent: message.agent,
      originalContent,
      summary: summarize(originalContent),
      entities: extractEntities(originalContent),
      timestamp: message.timestamp,
      archivedAt: message.timestamp,
      source: 'chat_history',
    };
  });
}

function toRecallBlocks(entries: AgentRecallEntry[]): ArchivedChatBlock[] {
  return entries.map((entry, index) => {
    const prefix = `[${entry.agentId}/${entry.message.role}]`;
    const originalContent = `${prefix} ${entry.message.content || ''}`.trim();
    return {
      blockId: `recall-${entry.agentId}-${entry.message.timestamp}-${index}`,
      agent: entry.agentId,
      originalContent,
      summary: summarize(originalContent),
      entities: extractEntities(originalContent),
      timestamp: entry.message.timestamp,
      archivedAt: entry.message.timestamp,
      source: 'agent_recall',
    };
  });
}

function dedupeBlocks(blocks: RankedRetrievedBlock[], limit: number): RankedRetrievedBlock[] {
  const seen = new Set<string>();
  const deduped: RankedRetrievedBlock[] = [];
  for (const block of blocks) {
    const key = `${block.source || 'archived'}::${block.agent}::${block.originalContent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(block);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

export function retrieveCoordinatorContext(input: {
  query: string;
  archivedBlocks: ArchivedChatBlock[];
  chatMessages: TeamChatMessage[];
  recallEntries: AgentRecallEntry[];
  limit?: number;
}): ArchivedRetrievalResult {
  const config = loadOpenTeamConfig().retrieval.ranking;
  const limit = input.limit || loadOpenTeamConfig().retrieval.coordinator.limit;
  const tokens = normalizeQueryTokens(input.query);
  if (tokens.length === 0) {
    return {
      layer: 'entities_exact',
      blocks: [],
      failureReason: 'empty_query',
    };
  }

  const archivedBlocks = input.archivedBlocks.map((block) => ({ ...block, source: block.source || 'archived' as const }));
  const entityMatches = rankBlocks(archivedBlocks, scoreEntityMatch, tokens, limit);
  if (shouldShortCircuitEntity(entityMatches, tokens)) {
    return {
      layer: 'entities_exact',
      blocks: entityMatches,
    };
  }

  const chatBlocks = toChatHistoryBlocks(input.chatMessages);
  const recallBlocks = toRecallBlocks(input.recallEntries);
  const fulltextCorpus = [...archivedBlocks, ...chatBlocks, ...recallBlocks];
  const fulltextMatches = rankBlocks(fulltextCorpus, scoreFulltextMatch, tokens, limit);
  if (shouldShortCircuitFulltext(fulltextMatches, tokens)) {
    return {
      layer: 'fulltext_keywords',
      blocks: fulltextMatches,
    };
  }

  const accumulated = dedupeBlocks(
    [...entityMatches, ...fulltextMatches],
    Math.max(limit * config.rerankPoolMultiplier, config.rerankPoolMinLimit),
  );
  const reranked = dedupeBlocks(
    accumulated
      .map((block) => ({
        ...block,
        score: block.score + scoreEntityMatch(block, tokens) + scoreFulltextMatch(block, tokens),
      }))
      .sort((a, b) => b.score - a.score || b.archivedAt.localeCompare(a.archivedAt)),
    limit,
  );

  if (
    reranked.length > 0
    && reranked[0].score >= Math.max(config.finalScoreThresholdBase, tokens.length * config.finalScoreThresholdPerToken)
  ) {
    return {
      layer: 'candidate_rerank',
      blocks: reranked,
    };
  }

  return {
    layer: 'candidate_rerank',
    blocks: [],
    failureReason: 'no_relevant_history_found',
  };
}
