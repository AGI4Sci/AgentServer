import type { TeamChatMessage, TeamChatStore } from '../../core/store/team-chat-store.js';

export interface PersistSharedChatMessageInput {
  agent: string;
  text: string;
  tags?: string[];
  fullContent?: string | null;
  auditContent?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  timestamp?: number;
  evidence?: Record<string, unknown> | null;
  replaceLatestIf?: (lastMessage: TeamChatMessage | null) => boolean;
}

export function persistSharedChatMessage(
  teamChatStore: TeamChatStore,
  teamId: string,
  input: PersistSharedChatMessageInput,
): TeamChatMessage {
  const timestamp = new Date(input.timestamp || Date.now());
  const chatMessage = {
    messageId: `msg-${teamId}-${timestamp.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    agent: input.agent,
    text: input.text,
    tags: input.tags,
    fullContent: input.fullContent || null,
    auditContent: input.auditContent || (input.evidence ? JSON.stringify(input.evidence) : null),
    requestId: input.requestId || null,
    time: timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    timestamp: timestamp.toISOString(),
  };

  if (input.replaceLatestIf) {
    teamChatStore.appendOrReplaceLastMessage(teamId, chatMessage, input.replaceLatestIf, input.sessionId);
  } else {
    teamChatStore.appendMessage(teamId, chatMessage, input.sessionId);
  }

  return chatMessage;
}
