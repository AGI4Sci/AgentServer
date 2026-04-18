import { buildArchivedBlocksFromTaskFacts } from '../../core/runtime/coordinator-retrieval-types.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { getSessionStore } from '../../core/store/session-store.js';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';
import { getTeamRegistry } from '../../core/team/registry.js';
import { performRetrieval } from './retrieval-registry.js';
import { registerMemoryRecallProviders } from './memory-recall-provider.js';
import { registerWorkspaceSearchProviders } from './workspace-search-provider.js';

let providersInitialized = false;

function summarizeRetrievalHits(hits: Array<{
  source: string;
  title?: string;
  path?: string;
  snippet: string;
}>): string {
  return hits
    .slice(0, 5)
    .map((hit, index) => {
      const header = hit.path || hit.title || hit.source;
      const snippet = String(hit.snippet || '').replace(/\s+/g, ' ').trim();
      return `${index + 1}. ${header}: ${snippet.slice(0, 220)}`;
    })
    .join('\n');
}

function resolveRequestCwd(teamId: string, chatSessionId: string, requestId: string): string {
  const board = getBlackboardStore();
  const coordinatorTask = board.get(teamId, chatSessionId, `coordinator:${requestId}`);
  return coordinatorTask?.executionScope?.cwd || process.cwd();
}

export function initializeRetrievalProviders(): void {
  if (providersInitialized) {
    return;
  }
  providersInitialized = true;
  registerWorkspaceSearchProviders();
  registerMemoryRecallProviders({
    resolveContext: ({ teamId, requestId, chatSessionId }) => {
      const resolvedSessionId = String(chatSessionId || '').trim() || getTeamChatStore().getActiveSessionId(teamId);
      const board = getBlackboardStore();
      const facts = board.list(teamId, resolvedSessionId, {
        requestId,
        includeArchive: true,
      });
      const chatMessages = getTeamChatStore()
        .getHistory(teamId, resolvedSessionId)
        .messages
        .filter((message) => !requestId || message.requestId === requestId);
      const registry = getTeamRegistry(teamId);
      const recallEntries = (registry?.getMembers?.() || [])
        .flatMap((member) => getSessionStore().getHistoryForRecall(teamId, member.id, 12).map((message) => ({
          agentId: member.id,
          message,
        })));
      return {
        archivedBlocks: buildArchivedBlocksFromTaskFacts(facts),
        chatMessages,
        recallEntries,
      };
    },
  });
}

export async function performBlackboardRetrieval(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  query: string;
}): Promise<{
  found: boolean;
  taskId: string;
  goal: string;
  result?: string;
  failureReason?: string;
}> {
  initializeRetrievalProviders();

  const cwd = resolveRequestCwd(args.teamId, args.chatSessionId, args.requestId);
  const workspaceResult = await performRetrieval({
    mode: 'workspace_search',
    query: args.query,
    teamId: args.teamId,
    requestId: args.requestId,
    chatSessionId: args.chatSessionId,
    cwd,
    path: cwd,
    required: false,
    limit: 5,
  });
  if (workspaceResult.hits.length > 0) {
    return {
      found: true,
      taskId: `${args.requestId}:retrieval:workspace`,
      goal: `检索工作区上下文：${args.query}`,
      result: summarizeRetrievalHits(workspaceResult.hits),
    };
  }

  const memoryResult = await performRetrieval({
    mode: 'memory_recall',
    query: args.query,
    teamId: args.teamId,
    requestId: args.requestId,
    chatSessionId: args.chatSessionId,
    scope: 'session',
    required: false,
    limit: 5,
  });
  if (memoryResult.hits.length > 0) {
    return {
      found: true,
      taskId: `${args.requestId}:retrieval:memory`,
      goal: `回忆历史上下文：${args.query}`,
      result: summarizeRetrievalHits(memoryResult.hits),
    };
  }

  return {
    found: false,
    taskId: `${args.requestId}:retrieval:gap`,
    goal: `当前任务缺少可检索上下文，请补充线索或确认检索方向：${args.query}`,
    failureReason: workspaceResult.failureReason || memoryResult.failureReason || 'no_retrieval_hits',
  };
}
