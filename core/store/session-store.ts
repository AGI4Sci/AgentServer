/**
 * Session Store - Session 存储管理
 * 
 * 职责：
 * 1. 存储对话历史到 agent 自己的目录
 * 2. 查询对话历史
 * 
 * 存储位置：{openteamDir}/agents/{agentId}/sessions/{date}.json
 * 
 * 这样的好处：
 * - 每个 agent 的数据在自己目录下，便于管理
 * - 可以和 memory 目录配合使用
 * - Backend 运行时可以同步这些数据
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { getConversationFactsStore } from './conversation-facts-store.js';

// ============================================================================
// Types
// ============================================================================

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: {
    model?: string;
    tokens?: number;
    source?: 'backend' | 'openteam';  // 消息来源标识
    chatSessionId?: string;
    compacted?: boolean;
    compactedFromCount?: number;
    compactedRetainedCount?: number;
    estimatedTokensBefore?: number;
  };
}

export interface SessionCompactionMeta {
  compactedAt: string;
  compactedFromCount: number;
  retainedCount: number;
  estimatedTokensBefore?: number;
  summaryPreview: string;
}

// #T051-16: 需要过滤的系统消息（心跳、静默确认等）
const SYSTEM_MESSAGES_TO_FILTER = [
  'HEARTBEAT_OK',
  'NO_REPLY',
  'NO',
];

// #T051-18: 超时/中断诊断模式（不应作为后续任务上下文）
const TIMEOUT_DIAGNOSIS_PATTERNS = [
  /previous model was (investigating|working) but timed out/i,
  /previous model timed out/i,
  /模型超时/i,
  /会话超时/i,
  /我已经完成了.*但.*超时/i,
  /上一轮.*超时/i,
];

const DIAGNOSTIC_NOISE_PATTERNS = [
  /跨\s*agent\s*通信受限/i,
  /session send visibility is restricted/i,
  /sessions\.visibility\s*=\s*all/i,
  /团队成员尚未启动/i,
  /未找到 session/i,
  /活跃 sessions/i,
];

const COMPACTION_TRIGGER_TOKENS = 160_000;
const COMPACTION_TARGET_RECENT_TOKENS = 60_000;
const COMPACTION_MIN_RECENT_MESSAGES = 12;
const COMPACTION_MAX_SUMMARY_PREVIEWS = 12;

/**
 * 检查消息是否应该被过滤（不写入 session 历史）
 * 
 * 设计原则：心跳信号不应污染业务 session 历史
 */
function shouldFilterMessage(content: string): boolean {
  const trimmed = content?.trim();
  if (!trimmed) return true;  // 空消息也过滤
  
  return SYSTEM_MESSAGES_TO_FILTER.includes(trimmed);
}

function isDiagnosticNoise(message: SessionMessage): boolean {
  if (!message || message.role === 'user') return false;
  const content = message.content || '';
  return DIAGNOSTIC_NOISE_PATTERNS.some(pattern => pattern.test(content));
}

/**
 * #T051-18: 检查消息是否是超时/中断诊断文本
 * 这些消息不应作为后续任务的有效上下文
 */
function isTimeoutDiagnosis(content: string): boolean {
  if (!content || typeof content !== 'string') return false;
  
  for (const pattern of TIMEOUT_DIAGNOSIS_PATTERNS) {
    if (pattern.test(content)) {
      return true;
    }
  }
  return false;
}

function isCompactionSummary(message: SessionMessage): boolean {
  return message.role === 'system' && /\[\[SESSION_COMPACTION\]\]/.test(message.content || '');
}

function estimateMessageTokens(message: SessionMessage): number {
  if (typeof message.metadata?.tokens === 'number' && message.metadata.tokens > 0) {
    return message.metadata.tokens;
  }
  const content = message.content || '';
  return Math.max(1, Math.ceil(content.length / 4) + 8);
}

function preview(content: string, maxLength = 140): string {
  const normalized = (content || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

// ============================================================================
// SessionStore
// ============================================================================

export class SessionStore {
  private openteamDir: string;
  private agentsDir: string;
  private readonly conversationFactsStore = getConversationFactsStore();
  
  constructor() {
    this.openteamDir = process.env.OPENTEAM_DIR || process.cwd();
    this.agentsDir = join(this.openteamDir, 'agents');
    
    // 确保 agents 目录存在
    if (!existsSync(this.agentsDir)) {
      mkdirSync(this.agentsDir, { recursive: true });
    }
  }
  
  /**
   * 添加消息到 agent 的 session
   * 
   * @param teamId 团队 ID（暂时不使用，保留兼容）
   * @param agentId agent ID
   * @param message 消息
   * 
   * 改进（#T051-16）：
   * - 过滤 HEARTBEAT_OK、NO_REPLY、NO 等系统消息
   * - 心跳信号不应污染业务 session 历史
   */
  addRecallMessage(
    teamId: string,
    agentId: string,
    message: SessionMessage
  ): void {
    // #T051-16: 过滤心跳等系统消息
    if (shouldFilterMessage(message.content)) {
      console.log(`[SessionStore] Filtering system message for ${agentId}: ${message.content.slice(0, 20)}...`);
      return;
    }

    if (isDiagnosticNoise(message)) {
      console.log(`[SessionStore] Filtering diagnostic noise for ${agentId}`);
      return;
    }
    
    const sessionDir = this.getSessionDir(agentId);
    const today = new Date().toISOString().split('T')[0];
    const sessionFile = join(sessionDir, `${today}.json`);
    
    // 确保目录存在
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    
    // 读取现有 session 或创建新的
    let messages: SessionMessage[] = [];
    if (existsSync(sessionFile)) {
      try {
        const content = readFileSync(sessionFile, 'utf-8');
        messages = JSON.parse(content);
      } catch (e) {
        console.warn(`[SessionStore] Failed to read session file: ${sessionFile}`);
      }
    }
    
    // 添加消息
    messages.push(message);

    // 接近 context 上限时，先保 facts，再压缩旧叙事历史
    messages = this.compactHistoryIfNeeded(teamId, messages, message.metadata?.chatSessionId);
    
    // 写入文件
    writeFileSync(sessionFile, JSON.stringify(messages, null, 2), 'utf-8');
    
    console.log(`[SessionStore] Added message to agents/${agentId}/sessions/${today}.json`);
  }
  
  /**
   * 获取 session 历史
   * 
   * 改进（#T051-18）：
   * - 过滤超时/中断诊断文本，避免污染后续任务上下文
   */
  getHistoryForRecall(
    teamId: string,
    agentId: string,
    limit: number = 50
  ): SessionMessage[] {
    const sessionDir = this.getSessionDir(agentId);
    
    if (!existsSync(sessionDir)) {
      return [];
    }
    
    // 读取所有日期文件
    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();  // 最新的文件优先
    
    const messages: SessionMessage[] = [];
    
    for (const file of files) {
      const filePath = join(sessionDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const fileMessages: SessionMessage[] = JSON.parse(content);
        
        // 添加消息，直到达到限制
        for (let i = fileMessages.length - 1; i >= 0 && messages.length < limit; i--) {
          const msg = fileMessages[i];
          
          // #T051-18: 过滤超时诊断消息
          if (isTimeoutDiagnosis(msg.content)) {
            console.log(`[SessionStore] Filtering timeout diagnosis for ${agentId}`);
            continue;
          }

          if (isDiagnosticNoise(msg)) {
            console.log(`[SessionStore] Filtering diagnostic noise from history for ${agentId}`);
            continue;
          }
          
          messages.unshift(msg);
        }
        
        if (messages.length >= limit) break;
      } catch (e) {
        console.warn(`[SessionStore] Failed to read session file: ${filePath}`);
      }
    }
    
    return messages.slice(0, limit);
  }
  
  /**
   * 获取最近的对话
   */
  getRecentMessages(
    teamId: string,
    agentId: string,
    count: number = 10
  ): SessionMessage[] {
    return this.getHistoryForRecall(teamId, agentId, count);
  }
  
  /**
   * 清空 session
   */
  clearSession(teamId: string, agentId: string): void {
    const sessionDir = this.getSessionDir(agentId);
    
    if (existsSync(sessionDir)) {
      rmSync(sessionDir, { recursive: true });
      console.log(`[SessionStore] Cleared session: agents/${agentId}/sessions/`);
    }
  }
  
  // === 私有方法 ===
  
  private getSessionDir(agentId: string): string {
    return join(this.agentsDir, agentId, 'sessions');
  }

  getCompactionMetaForRecall(teamId: string, agentId: string): SessionCompactionMeta | null {
    const sessionDir = this.getSessionDir(agentId);
    if (!existsSync(sessionDir)) {
      return null;
    }

    const files = readdirSync(sessionDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    for (const file of files) {
      const filePath = join(sessionDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const fileMessages: SessionMessage[] = JSON.parse(content);
        for (let i = fileMessages.length - 1; i >= 0; i -= 1) {
          const message = fileMessages[i];
          if (!isCompactionSummary(message)) continue;
          const previewLine = (message.content || '')
            .split('\n')
            .find(line => line.startsWith('摘要说明:'));
          return {
            compactedAt: message.timestamp,
            compactedFromCount: message.metadata?.compactedFromCount || 0,
            retainedCount: message.metadata?.compactedRetainedCount || 0,
            estimatedTokensBefore: message.metadata?.estimatedTokensBefore,
            summaryPreview: previewLine ? previewLine.replace(/^摘要说明:\s*/, '') : preview(message.content || ''),
          };
        }
      } catch (e) {
        console.warn(`[SessionStore] Failed to read compaction meta: ${filePath}`);
      }
    }

    return null;
  }

  private compactHistoryIfNeeded(teamId: string, messages: SessionMessage[], chatSessionId?: string): SessionMessage[] {
    const withoutPriorCompaction = messages.filter(message => !isCompactionSummary(message));
    const totalTokens = withoutPriorCompaction.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
    if (totalTokens < COMPACTION_TRIGGER_TOKENS) {
      return messages;
    }

    let retainedTokens = 0;
    const retained: SessionMessage[] = [];
    for (let index = withoutPriorCompaction.length - 1; index >= 0; index -= 1) {
      const message = withoutPriorCompaction[index];
      retained.unshift(message);
      retainedTokens += estimateMessageTokens(message);
      if (retained.length >= COMPACTION_MIN_RECENT_MESSAGES && retainedTokens >= COMPACTION_TARGET_RECENT_TOKENS) {
        break;
      }
    }

    if (retained.length >= withoutPriorCompaction.length) {
      return withoutPriorCompaction;
    }

    const compacted = withoutPriorCompaction.slice(0, withoutPriorCompaction.length - retained.length);
    const summary = this.buildCompactionSummary(teamId, compacted, retained, totalTokens, chatSessionId);
    return [summary, ...retained];
  }

  private buildCompactionSummary(
    teamId: string,
    compacted: SessionMessage[],
    retained: SessionMessage[],
    totalTokens: number,
    chatSessionId?: string,
  ): SessionMessage {
    const resolvedSessionId = String(
      chatSessionId
      || retained.at(-1)?.metadata?.chatSessionId
      || compacted.at(-1)?.metadata?.chatSessionId
      || '',
    ).trim();
    const activeFacts = (resolvedSessionId
      ? this.conversationFactsStore.getActiveFactsForSession(teamId, resolvedSessionId)
      : [])
      .filter(entry => entry.stability !== 'ephemeral')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 12);
    const corrections = (resolvedSessionId
      ? this.conversationFactsStore.getFactTimelineForSession(teamId, resolvedSessionId)
      : [])
      .filter(entry => entry.operation === 'corrected' && entry.status === 'active')
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 6);

    const lines = [
      '[[SESSION_COMPACTION]]',
      `摘要说明: 旧历史接近 context 上限，已压缩 ${compacted.length} 条较早消息，保留 ${retained.length} 条最近原文消息。`,
      `估算 tokens: 压缩前约 ${totalTokens}，压缩后优先保留 facts 与最近对话。`,
    ];

    if (activeFacts.length > 0) {
      lines.push('当前有效事实:');
      for (const fact of activeFacts) {
        lines.push(`- ${fact.key} = ${fact.value} (${fact.source}/${fact.stability})`);
      }
    }

    if (corrections.length > 0) {
      lines.push('最近用户纠正:');
      for (const entry of corrections) {
        lines.push(`- ${entry.key} => ${entry.value} @ ${entry.updatedAt}`);
      }
    }

    lines.push('压缩叙事摘要:');
    const previews = compacted.slice(-COMPACTION_MAX_SUMMARY_PREVIEWS);
    for (const message of previews) {
      lines.push(`- ${message.role}: ${preview(message.content)}`);
    }
    lines.push('[[/SESSION_COMPACTION]]');

    return {
      role: 'system',
      content: lines.join('\n'),
      timestamp: new Date().toISOString(),
      metadata: {
        source: 'openteam',
        ...(resolvedSessionId ? { chatSessionId: resolvedSessionId } : {}),
        compacted: true,
        compactedFromCount: compacted.length,
        compactedRetainedCount: retained.length,
        estimatedTokensBefore: totalTokens,
      },
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let storeInstance: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!storeInstance) {
    storeInstance = new SessionStore();
  }
  return storeInstance;
}

export function resetSessionStore(): void {
  storeInstance = null;
}
