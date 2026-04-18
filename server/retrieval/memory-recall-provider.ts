import { BACKEND_IDS, type BackendType } from '../../core/runtime/backend-catalog.js';
import type {
  ArchivedChatBlock,
  ArchivedRetrievalLayer,
  ArchivedRetrievalResult,
} from '../../core/runtime/coordinator-retrieval-types.js';
import { retrieveCoordinatorContext, type AgentRecallEntry } from '../../core/runtime/coordinator-retrieval.js';
import type { TeamChatMessage } from '../../core/store/team-chat-store.js';
import type {
  RetrievalEvidenceHit,
  RetrievalProvider,
  RetrievalResult,
} from './retrieval-types.js';
import { resolveEffectiveRetrievalScope } from './retrieval-types.js';
import { registerRetrievalProvider } from './retrieval-registry.js';

function toEvidenceHit(block: ArchivedChatBlock, layer: ArchivedRetrievalLayer): RetrievalEvidenceHit {
  return {
    source: block.source || 'archived',
    snippet: block.summary,
    title: block.agent,
    score: block.score,
    metadata: {
      layer,
      blockId: block.blockId,
      messageId: block.messageId || null,
      agent: block.agent,
      originalContent: block.originalContent,
      summary: block.summary,
      entities: block.entities,
      timestamp: block.timestamp,
      archivedAt: block.archivedAt,
      source: block.source || 'archived',
      relativeTime: buildRelativeTimeLabel(block.archivedAt),
      absoluteTime: formatAbsoluteTime(block.archivedAt),
    },
  };
}

function formatAbsoluteTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return timestamp;
  }
  const date = new Date(parsed);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function buildRelativeTimeLabel(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return '时间未知';
  }
  const diffMs = Date.now() - parsed;
  const absMs = Math.abs(diffMs);
  const suffix = diffMs >= 0 ? '前' : '后';
  if (absMs < 60_000) {
    const seconds = Math.max(1, Math.round(absMs / 1000));
    return `${seconds}秒${suffix}`;
  }
  if (absMs < 3_600_000) {
    const minutes = Math.max(1, Math.round(absMs / 60_000));
    return `${minutes}分钟${suffix}`;
  }
  if (absMs < 86_400_000) {
    const hours = Math.max(1, Math.round(absMs / 3_600_000));
    return `${hours}小时${suffix}`;
  }
  const days = Math.max(1, Math.round(absMs / 86_400_000));
  return `${days}天${suffix}`;
}

function toArchivedBlock(hit: RetrievalEvidenceHit): ArchivedChatBlock {
  const metadata = hit.metadata || {};
  const entities = Array.isArray(metadata.entities)
    ? metadata.entities.filter((value): value is string => typeof value === 'string')
    : [];
  const originalContent = typeof metadata.originalContent === 'string'
    ? metadata.originalContent
    : hit.snippet;
  const summary = typeof metadata.summary === 'string'
    ? metadata.summary
    : hit.snippet;
  const source = metadata.source === 'chat_history' || metadata.source === 'agent_recall'
    ? metadata.source
    : 'archived';

  return {
    blockId: typeof metadata.blockId === 'string' ? metadata.blockId : `retrieval-${Date.now()}`,
    messageId: typeof metadata.messageId === 'string' ? metadata.messageId : null,
    agent: typeof metadata.agent === 'string' ? metadata.agent : (hit.title || 'unknown'),
    originalContent,
    summary,
    entities,
    timestamp: typeof metadata.timestamp === 'string' ? metadata.timestamp : new Date().toISOString(),
    archivedAt: typeof metadata.archivedAt === 'string' ? metadata.archivedAt : new Date().toISOString(),
    source,
    score: typeof hit.score === 'number' ? hit.score : undefined,
  };
}

export function adaptArchivedRetrievalResult(result: RetrievalResult): ArchivedRetrievalResult {
  const firstLayer = result.hits
    .map((hit) => hit.metadata?.layer)
    .find((layer): layer is ArchivedRetrievalLayer => (
      layer === 'entities_exact'
      || layer === 'fulltext_keywords'
      || layer === 'candidate_rerank'
    ));

  return {
    scope: result.scope,
    layer: firstLayer || 'candidate_rerank',
    blocks: result.hits.map(toArchivedBlock),
    failureReason: result.failureReason,
  };
}

export function createMemoryRecallProvider(args: {
  backend: BackendType;
  resolveContext: (request: {
    teamId: string;
    requestId?: string;
    chatSessionId?: string | null;
  }) => {
    archivedBlocks: ArchivedChatBlock[];
    chatMessages: TeamChatMessage[];
    recallEntries: AgentRecallEntry[];
  };
}): RetrievalProvider {
  return {
    backend: args.backend,
    supports(mode) {
      return mode === 'memory_recall';
    },
    async retrieve(request): Promise<RetrievalResult> {
      const scope = resolveEffectiveRetrievalScope(request);
      if (scope === 'agent' && !request.agentId?.trim()) {
        return {
          mode: request.mode,
          backend: args.backend,
          scope,
          query: request.query,
          hits: [],
          exhausted: true,
          shouldAskUser: Boolean(request.required),
          failureReason: 'retrieval_scope_requires_agent_id:agent',
        };
      }
      const context = args.resolveContext({
        teamId: request.teamId,
        requestId: request.requestId,
        chatSessionId: request.chatSessionId,
      });
      const scopedArchivedBlocks = scope === 'session' ? context.archivedBlocks : [];
      const scopedChatMessages = scope === 'session' ? context.chatMessages : [];
      const scopedRecallEntries = scope === 'agent'
        ? context.recallEntries.filter((entry) => entry.agentId === request.agentId)
        : scope === 'team'
          ? context.recallEntries
          : [];
      const archived = retrieveCoordinatorContext({
        query: request.query,
        archivedBlocks: scopedArchivedBlocks,
        chatMessages: scopedChatMessages,
        recallEntries: scopedRecallEntries,
        limit: request.limit,
      });

      return {
        mode: request.mode,
        backend: args.backend,
        scope,
        query: request.query,
        hits: archived.blocks.map((block) => {
          const hit = toEvidenceHit(block, archived.layer);
          return {
            ...hit,
            metadata: {
              ...hit.metadata,
              scope,
            },
          };
        }),
        exhausted: true,
        shouldAskUser: Boolean(request.required && archived.blocks.length === 0),
        failureReason: archived.failureReason,
      };
    },
  };
}

let memoryRecallProvidersRegistered = false;

export function registerMemoryRecallProviders(args: {
  resolveContext: (request: {
    teamId: string;
    requestId?: string;
    chatSessionId?: string | null;
  }) => {
    archivedBlocks: ArchivedChatBlock[];
    chatMessages: TeamChatMessage[];
    recallEntries: AgentRecallEntry[];
  };
}): void {
  if (memoryRecallProvidersRegistered) {
    return;
  }
  memoryRecallProvidersRegistered = true;
  for (const backend of BACKEND_IDS) {
    registerRetrievalProvider(createMemoryRecallProvider({
      backend,
      resolveContext: args.resolveContext,
    }));
  }
}
