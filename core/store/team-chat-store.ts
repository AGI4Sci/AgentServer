import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface TeamChatMessage {
  messageId: string;
  agent: string;
  text: string;
  time: string;
  tags?: string[];
  fullContent?: string | null;
  auditContent?: string | null;
  requestId?: string | null;
  timestamp: string;
}

export interface TeamPrivateChatMessage {
  messageId: string;
  sender: string;
  text: string;
  time: string;
  requestId?: string | null;
  timestamp: string;
}

export interface TeamChatSessionSummary {
  sessionId: string;
  title: string;
  preview: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  isActive: boolean;
}

interface TeamChatIndex {
  teamId: string;
  activeSessionId: string | null;
  sessions: TeamChatSessionSummary[];
}

export interface TeamChatHistory {
  teamId: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: TeamChatMessage[];
  privateChats: Record<string, TeamPrivateChatMessage[]>;
}

const DATA_DIR = join(process.cwd(), 'data', 'chat-history');
const MAX_MESSAGES = 500;

function fallbackMessageId(teamId: string, timestamp: string, index: number): string {
  return `msg-${teamId}-${timestamp || 'unknown'}-${index}`;
}

function createSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMessage(teamId: string, message: Partial<TeamChatMessage>, index: number): TeamChatMessage {
  const timestamp = typeof message.timestamp === 'string' ? message.timestamp : new Date(0).toISOString();
  return {
    messageId: typeof message.messageId === 'string' && message.messageId.trim()
      ? message.messageId
      : fallbackMessageId(teamId, timestamp, index),
    agent: String(message.agent || 'unknown'),
    text: String(message.text || ''),
    time: String(message.time || '00:00'),
    tags: Array.isArray(message.tags) ? message.tags : undefined,
    fullContent: message.fullContent || null,
    auditContent: message.auditContent || null,
    requestId: typeof message.requestId === 'string' ? message.requestId : null,
    timestamp,
  };
}

function normalizePrivateChatMessage(teamId: string, agentId: string, message: Partial<TeamPrivateChatMessage>, index: number): TeamPrivateChatMessage {
  const timestamp = typeof message.timestamp === 'string' ? message.timestamp : new Date(0).toISOString();
  return {
    messageId: typeof message.messageId === 'string' && message.messageId.trim()
      ? message.messageId
      : fallbackMessageId(`${teamId}-${agentId}-private`, timestamp, index),
    sender: String(message.sender || agentId || 'unknown'),
    text: String(message.text || ''),
    time: String(message.time || '00:00'),
    requestId: typeof message.requestId === 'string' ? message.requestId : null,
    timestamp,
  };
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function pickSessionPreview(messages: TeamChatMessage[]): string | null {
  const firstMeaningful = messages.find((message) => String(message.text || '').trim());
  if (!firstMeaningful) {
    return null;
  }

  const preview = String(firstMeaningful.text || '').trim().replace(/\s+/g, ' ');
  return preview.slice(0, 80) || null;
}

function buildSessionTitle(createdAt: string, preview: string | null): string {
  const dateLabel = new Date(createdAt).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return preview ? `${dateLabel} · ${preview.slice(0, 24)}` : `${dateLabel} · 新会话`;
}

function sortSessions(sessions: TeamChatSessionSummary[]): TeamChatSessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
}

export class TeamChatStore {
  private getLegacyPath(teamId: string): string {
    ensureDir(DATA_DIR);
    return join(DATA_DIR, `${teamId}.json`);
  }

  private getTeamDir(teamId: string): string {
    const teamDir = join(DATA_DIR, teamId);
    ensureDir(teamDir);
    return teamDir;
  }

  private getSessionsDir(teamId: string): string {
    const sessionsDir = join(this.getTeamDir(teamId), 'sessions');
    ensureDir(sessionsDir);
    return sessionsDir;
  }

  private getIndexPath(teamId: string): string {
    return join(this.getTeamDir(teamId), 'index.json');
  }

  private getSessionPath(teamId: string, sessionId: string): string {
    return join(this.getSessionsDir(teamId), `${sessionId}.json`);
  }

  private createEmptyHistory(teamId: string, sessionId: string, createdAt = new Date().toISOString()): TeamChatHistory {
    return {
      teamId,
      sessionId,
      createdAt,
      updatedAt: createdAt,
      messages: [],
      privateChats: {},
    };
  }

  private summarizeHistory(history: TeamChatHistory, isActive: boolean): TeamChatSessionSummary {
    const preview = pickSessionPreview(history.messages);
    return {
      sessionId: history.sessionId,
      title: buildSessionTitle(history.createdAt, preview),
      preview,
      createdAt: history.createdAt,
      updatedAt: history.updatedAt,
      messageCount: history.messages.length,
      isActive,
    };
  }

  private writeHistory(history: TeamChatHistory): void {
    const normalized: TeamChatHistory = {
      teamId: history.teamId,
      sessionId: history.sessionId,
      createdAt: history.createdAt,
      updatedAt: history.updatedAt,
      messages: history.messages.map((message, index) => normalizeMessage(history.teamId, message, index)),
      privateChats: Object.fromEntries(
        Object.entries(history.privateChats || {}).map(([agentId, messages]) => [
          agentId,
          Array.isArray(messages)
            ? messages.map((message, index) => normalizePrivateChatMessage(history.teamId, agentId, message, index))
            : [],
        ]),
      ),
    };
    const path = this.getSessionPath(history.teamId, history.sessionId);
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  }

  private writeIndex(teamId: string, index: TeamChatIndex): void {
    const normalizedSessions = index.sessions.map((session) => ({
      ...session,
      isActive: session.sessionId === index.activeSessionId,
    }));
    const payload: TeamChatIndex = {
      teamId,
      activeSessionId: index.activeSessionId,
      sessions: sortSessions(normalizedSessions),
    };
    const path = this.getIndexPath(teamId);
    const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  }

  private readSessionHistory(teamId: string, sessionId: string): TeamChatHistory {
    const path = this.getSessionPath(teamId, sessionId);
    if (!existsSync(path)) {
      return this.createEmptyHistory(teamId, sessionId);
    }

    try {
      const content = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(content) as Partial<TeamChatHistory>;
      const messages = Array.isArray(parsed.messages)
        ? parsed.messages.map((message, index) => normalizeMessage(teamId, message, index))
        : [];
      const privateChats = parsed.privateChats && typeof parsed.privateChats === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.privateChats).map(([agentId, messages]) => [
              agentId,
              Array.isArray(messages)
                ? messages.map((message, index) => normalizePrivateChatMessage(teamId, agentId, message as Partial<TeamPrivateChatMessage>, index))
                : [],
            ]),
          )
        : {};
      const createdAt = typeof parsed.createdAt === 'string'
        ? parsed.createdAt
        : (messages[0]?.timestamp || new Date(0).toISOString());
      const updatedAt = typeof parsed.updatedAt === 'string'
        ? parsed.updatedAt
        : (messages[messages.length - 1]?.timestamp || createdAt);
      return {
        teamId,
        sessionId,
        createdAt,
        updatedAt,
        messages,
        privateChats,
      };
    } catch (error) {
      console.warn(`[TeamChatStore] Failed to read session history for ${teamId}/${sessionId}:`, error);
      return this.createEmptyHistory(teamId, sessionId);
    }
  }

  private migrateLegacyHistory(teamId: string): TeamChatIndex | null {
    const legacyPath = this.getLegacyPath(teamId);
    if (!existsSync(legacyPath)) {
      return null;
    }

    try {
      const content = readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<{ updatedAt: string; messages: TeamChatMessage[] }>;
      const sessionId = createSessionId();
      const messages = Array.isArray(parsed.messages)
        ? parsed.messages.map((message, index) => normalizeMessage(teamId, message, index))
        : [];
      const createdAt = messages[0]?.timestamp || parsed.updatedAt || new Date().toISOString();
      const history: TeamChatHistory = {
        teamId,
        sessionId,
        createdAt,
        updatedAt: parsed.updatedAt || messages[messages.length - 1]?.timestamp || createdAt,
        messages,
        privateChats: {},
      };
      this.writeHistory(history);
      rmSync(legacyPath, { force: true });

      const index: TeamChatIndex = {
        teamId,
        activeSessionId: sessionId,
        sessions: [this.summarizeHistory(history, true)],
      };
      this.writeIndex(teamId, index);
      return index;
    } catch (error) {
      console.warn(`[TeamChatStore] Failed to migrate legacy history for ${teamId}:`, error);
      return null;
    }
  }

  private readIndex(teamId: string): TeamChatIndex {
    const migrated = this.migrateLegacyHistory(teamId);
    if (migrated) {
      return migrated;
    }

    const path = this.getIndexPath(teamId);
    if (!existsSync(path)) {
      return {
        teamId,
        activeSessionId: null,
        sessions: [],
      };
    }

    try {
      const content = readFileSync(path, 'utf-8');
      if (!content.trim()) {
        return {
          teamId,
          activeSessionId: null,
          sessions: [],
        };
      }
      const parsed = JSON.parse(content) as Partial<TeamChatIndex>;
      const activeSessionId = typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : null;
      const sessions = Array.isArray(parsed.sessions)
        ? parsed.sessions
          .filter((session): session is TeamChatSessionSummary => Boolean(session?.sessionId))
          .map((session) => ({
            sessionId: session.sessionId,
            title: session.title || '历史会话',
            preview: session.preview || null,
            createdAt: session.createdAt || new Date(0).toISOString(),
            updatedAt: session.updatedAt || session.createdAt || new Date(0).toISOString(),
            messageCount: Number.isFinite(session.messageCount) ? session.messageCount : 0,
            isActive: session.sessionId === activeSessionId,
          }))
        : [];
      return {
        teamId,
        activeSessionId,
        sessions: sortSessions(sessions),
      };
    } catch (error) {
      console.warn(`[TeamChatStore] Failed to read history index for ${teamId}:`, error);
      return {
        teamId,
        activeSessionId: null,
        sessions: [],
      };
    }
  }

  private upsertSessionSummary(teamId: string, history: TeamChatHistory, activeSessionId: string): TeamChatIndex {
    const index = this.readIndex(teamId);
    const summary = this.summarizeHistory(history, history.sessionId === activeSessionId);
    const nextSessions = index.sessions.filter((session) => session.sessionId !== history.sessionId);
    nextSessions.push(summary);
    const nextIndex = {
      teamId,
      activeSessionId,
      sessions: nextSessions,
    };
    this.writeIndex(teamId, nextIndex);
    return this.readIndex(teamId);
  }

  ensureActiveSession(teamId: string): TeamChatSessionSummary {
    const existingIndex = this.readIndex(teamId);
    if (existingIndex.activeSessionId) {
      const activeSummary = existingIndex.sessions.find((session) => session.sessionId === existingIndex.activeSessionId);
      if (activeSummary) {
        return activeSummary;
      }
    }

    const sessionId = createSessionId();
    const history = this.createEmptyHistory(teamId, sessionId);
    this.writeHistory(history);
    const index: TeamChatIndex = {
      teamId,
      activeSessionId: sessionId,
      sessions: [this.summarizeHistory(history, true)],
    };
    this.writeIndex(teamId, index);
    return index.sessions[0];
  }

  getActiveSessionId(teamId: string): string {
    return this.ensureActiveSession(teamId).sessionId;
  }

  listSessions(teamId: string): TeamChatSessionSummary[] {
    const activeSessionId = this.getActiveSessionId(teamId);
    const index = this.readIndex(teamId);
    return sortSessions(index.sessions.map((session) => ({
      ...session,
      isActive: session.sessionId === activeSessionId,
    })));
  }

  getSessionSummary(teamId: string, sessionId: string): TeamChatSessionSummary | null {
    return this.listSessions(teamId).find((session) => session.sessionId === sessionId) || null;
  }

  getHistory(teamId: string, sessionId?: string | null): TeamChatHistory {
    const resolvedSessionId = sessionId || this.getActiveSessionId(teamId);
    const history = this.readSessionHistory(teamId, resolvedSessionId);
    if (!existsSync(this.getSessionPath(teamId, resolvedSessionId))) {
      this.writeHistory(history);
      this.upsertSessionSummary(teamId, history, this.getActiveSessionId(teamId));
    }
    return history;
  }

  appendMessage(teamId: string, message: TeamChatMessage, sessionId?: string | null): TeamChatHistory {
    const resolvedSessionId = sessionId || this.getActiveSessionId(teamId);
    const history = this.getHistory(teamId, resolvedSessionId);
    history.messages.push(normalizeMessage(teamId, message, history.messages.length));
    history.messages = history.messages.slice(-MAX_MESSAGES);
    history.updatedAt = new Date().toISOString();
    this.writeHistory(history);
    this.upsertSessionSummary(teamId, history, this.getActiveSessionId(teamId));
    return history;
  }

  appendPrivateMessage(
    teamId: string,
    agentId: string,
    message: Partial<TeamPrivateChatMessage>,
    sessionId?: string | null,
  ): TeamChatHistory {
    const resolvedSessionId = sessionId || this.getActiveSessionId(teamId);
    const history = this.getHistory(teamId, resolvedSessionId);
    const existing = Array.isArray(history.privateChats[agentId]) ? history.privateChats[agentId] : [];
    existing.push(normalizePrivateChatMessage(teamId, agentId, message, existing.length));
    history.privateChats[agentId] = existing.slice(-MAX_MESSAGES);
    history.updatedAt = new Date().toISOString();
    this.writeHistory(history);
    this.upsertSessionSummary(teamId, history, this.getActiveSessionId(teamId));
    return history;
  }

  appendOrReplaceLastMessage(
    teamId: string,
    message: TeamChatMessage,
    shouldReplace: (lastMessage: TeamChatMessage | null) => boolean,
    sessionId?: string | null,
  ): TeamChatHistory {
    const resolvedSessionId = sessionId || this.getActiveSessionId(teamId);
    const history = this.getHistory(teamId, resolvedSessionId);
    const lastMessage = history.messages.length > 0 ? history.messages[history.messages.length - 1] : null;
    const normalizedMessage = normalizeMessage(teamId, message, history.messages.length);
    if (shouldReplace(lastMessage)) {
      history.messages[history.messages.length - 1] = normalizedMessage;
    } else {
      history.messages.push(normalizedMessage);
    }
    history.messages = history.messages.slice(-MAX_MESSAGES);
    history.updatedAt = new Date().toISOString();
    this.writeHistory(history);
    this.upsertSessionSummary(teamId, history, this.getActiveSessionId(teamId));
    return history;
  }

  getMessageById(teamId: string, messageId: string, sessionId?: string | null): TeamChatMessage | null {
    if (!messageId) {
      return null;
    }
    return this.getHistory(teamId, sessionId).messages.find((message) => message.messageId === messageId) || null;
  }

  startNewSession(teamId: string): TeamChatSessionSummary {
    const sessionId = createSessionId();
    const history = this.createEmptyHistory(teamId, sessionId);
    this.writeHistory(history);
    const nextIndex = this.readIndex(teamId);
    nextIndex.activeSessionId = sessionId;
    nextIndex.sessions = nextIndex.sessions.filter((session) => session.sessionId !== sessionId);
    nextIndex.sessions.push(this.summarizeHistory(history, true));
    this.writeIndex(teamId, nextIndex);
    return this.ensureActiveSession(teamId);
  }

  selectSession(teamId: string, sessionId: string): TeamChatSessionSummary | null {
    const index = this.readIndex(teamId);
    if (!index.sessions.some((session) => session.sessionId === sessionId)) {
      return null;
    }
    index.activeSessionId = sessionId;
    this.writeIndex(teamId, index);
    return this.getSessionSummary(teamId, sessionId);
  }

  deleteSession(teamId: string, sessionId: string): { deleted: boolean; activeSessionId: string | null } {
    const index = this.readIndex(teamId);
    const existing = index.sessions.find((session) => session.sessionId === sessionId);
    if (!existing) {
      return { deleted: false, activeSessionId: index.activeSessionId };
    }

    const sessionPath = this.getSessionPath(teamId, sessionId);
    if (existsSync(sessionPath)) {
      rmSync(sessionPath, { force: true, maxRetries: 5, retryDelay: 20 });
    }

    const remainingSessions = index.sessions.filter((session) => session.sessionId !== sessionId);
    index.sessions = remainingSessions;

    if (index.activeSessionId === sessionId) {
      const nextActive = remainingSessions
        .slice()
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null;
      index.activeSessionId = nextActive?.sessionId || null;
    }

    if (!index.activeSessionId) {
      this.writeIndex(teamId, index);
      const ensured = this.ensureActiveSession(teamId);
      return { deleted: true, activeSessionId: ensured.sessionId };
    }

    this.writeIndex(teamId, index);
    return { deleted: true, activeSessionId: index.activeSessionId };
  }

  clearHistory(teamId: string): void {
    const teamDir = join(DATA_DIR, teamId);
    if (existsSync(teamDir)) {
      const sessionsDir = join(teamDir, 'sessions');
      if (existsSync(sessionsDir)) {
        rmSync(sessionsDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
      }
      rmSync(teamDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
    }
    const legacyPath = this.getLegacyPath(teamId);
    if (existsSync(legacyPath)) {
      rmSync(legacyPath, { force: true, maxRetries: 5, retryDelay: 20 });
    }
  }
}

let store: TeamChatStore | null = null;

export function getTeamChatStore(): TeamChatStore {
  if (!store) {
    store = new TeamChatStore();
  }
  return store;
}
