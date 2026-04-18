/**
 * Base Adapter
 * 
 * Agent Runtime Adapter 基类
 * 
 * 提供通用的：
 * - 消息回调管理
 * - 工具策略检查
 * - Team 隔离检查
 */

import type {
  AgentRuntimeAdapter,
  SoulConfig,
  SkillConfig,
  CreateAgentOptions,
  MessageCallback,
  MessageMetadata,
  TeamContext,
} from '../types.js';

// ============================================================================
// Tool Policy
// ============================================================================

/**
 * ToolPolicy - 工具策略
 */
export interface ToolPolicy {
  /** 允许的工具列表（白名单） */
  allow?: string[];
  
  /** 禁止的工具列表（黑名单） */
  deny?: string[];
}

// ============================================================================
// Base Adapter
// ============================================================================

/**
 * BaseAdapter - Agent Runtime Adapter 基类
 * 
 * 所有 runtime adapter 都应该继承此类
 */
export abstract class BaseAdapter implements AgentRuntimeAdapter {
  abstract readonly name: string;
  
  protected config: any;
  protected teamContext: TeamContext | null = null;
  protected toolPolicy: ToolPolicy | null = null;
  protected messageCallbacks: MessageCallback[] = [];
  
  // === 生命周期（抽象方法）===
  
  abstract init(): Promise<void>;
  abstract shutdown(): Promise<void>;
  
  // === Agent 管理（抽象方法）===
  
  abstract createAgent(id: string, options?: CreateAgentOptions): Promise<void>;
  abstract deleteAgent(id: string): Promise<void>;
  abstract hasAgent(id: string): Promise<boolean>;
  abstract listAgents(): Promise<string[]>;
  
  // === 配置注入（抽象方法）===
  
  abstract injectConfig(id: string, soul: SoulConfig, skills: SkillConfig[]): Promise<void>;
  
  // === 消息交互（抽象方法）===
  
  abstract sendMessage(to: string, message: string): Promise<void>;
  abstract getAgentStatus(id: string): Promise<'idle' | 'working' | 'error' | 'offline'>;
  abstract isConnected(): boolean;
  
  // === 通用实现：消息回调 ===
  
  onMessage(callback: MessageCallback): void {
    this.messageCallbacks.push(callback);
  }
  
  offMessage(callback: MessageCallback): void {
    const index = this.messageCallbacks.indexOf(callback);
    if (index > -1) {
      this.messageCallbacks.splice(index, 1);
    }
  }
  
  /**
   * 触发消息回调
   */
  protected emitMessage(from: string, to: string | null, message: string, metadata?: MessageMetadata): void {
    this.messageCallbacks.forEach(cb => {
      try {
        cb(from, to, message, metadata);
      } catch (error) {
        console.error('[BaseAdapter] Message callback error:', error);
      }
    });
  }
  
  // === 通用实现：工具策略 ===
  
  /**
   * 设置工具策略
   */
  setToolPolicy(policy: ToolPolicy): void {
    this.toolPolicy = policy;
  }
  
  /**
   * 检查工具是否被允许
   */
  protected isToolAllowed(toolName: string): boolean {
    if (!this.toolPolicy) return true;
    
    // 白名单检查
    if (this.toolPolicy.allow && this.toolPolicy.allow.length > 0) {
      return this.toolPolicy.allow.includes(toolName);
    }
    
    // 黑名单检查
    if (this.toolPolicy.deny && this.toolPolicy.deny.length > 0) {
      return !this.toolPolicy.deny.includes(toolName);
    }
    
    return true;
  }
  
  // === 通用实现：Team 隔离 ===
  
  /**
   * 设置 Team 上下文
   */
  setTeamContext(context: TeamContext): void {
    this.teamContext = context;
  }
  
  /**
   * 清除 Team 上下文
   */
  clearTeamContext(): void {
    this.teamContext = null;
  }
  
  /**
   * 检查是否为 Team 成员
   */
  isTeamMember(agentId: string): boolean {
    if (!this.teamContext) return true;
    return this.teamContext.members.some(m => m.id === agentId);
  }
  
  /**
   * 获取 Team 成员列表
   */
  getTeamMembers(): string[] {
    if (!this.teamContext) return [];
    return this.teamContext.members.map(m => m.id);
  }
  
  /**
   * 检查是否允许 agent 间通信
   * 
   * @param from 发送者 agent ID
   * @param to 接收者 agent ID
   * @returns 是否允许
   */
  canCommunicate(from: string, to: string): boolean {
    // 如果没有 Team 上下文，允许所有通信
    if (!this.teamContext) return true;
    
    // 检查发送者和接收者是否都是 Team 成员
    return this.isTeamMember(from) && this.isTeamMember(to);
  }
  
  // === 通用实现：默认工具策略 ===
  
  /**
   * 获取默认的工具策略（禁用 sessions_send 和 sessions_list）
   * 用于实现 Team 隔离
   */
  protected getDefaultToolPolicy(): ToolPolicy {
    return {
      deny: ['sessions_send', 'sessions_list'],
    };
  }
  
  /**
   * 合并工具策略
   */
  protected mergeToolPolicy(base: ToolPolicy | undefined, override: ToolPolicy | undefined): ToolPolicy {
    const result: ToolPolicy = {
      allow: [...(base?.allow || []), ...(override?.allow || [])],
      deny: [...(base?.deny || []), ...(override?.deny || [])],
    };
    
    // 去重
    if (result.allow) {
      result.allow = [...new Set(result.allow)];
    }
    if (result.deny) {
      result.deny = [...new Set(result.deny)];
    }
    
    return result;
  }
}
