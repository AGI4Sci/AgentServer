/**
 * Message Router - 消息路由中心
 *
 * 职责:
 * 1. 接收消息并验证硬规则
 * 2. 消息去重
 * 3. 解析 @mention（精确匹配）并路由消息
 * 4. 广播消息给 Dashboard
 *
 * 硬规则:
 * A. 执行者只能回复来源（to === replyTo）
 * B. 协调者只能发给 team 成员
 * C. Agent 发出的消息必须 @mention 目标（用户消息豁免）
 *
 * 设计文档: docs/communication_design_plan.md
 */

import { randomUUID } from 'crypto';
import type { AgentMessage, RouterConfig, SystemNotification } from './types.js';
import type { TeamRegistry } from '../team/registry.js';

// ============================================================================
// Types
// ============================================================================

export interface MessageRouterCallbacks {
  /** 广播消息到 Dashboard */
  broadcast: (message: AgentMessage) => void;
  /** work 平面广播 */
  broadcastWork?: (message: AgentMessage) => void;
  /** control 平面广播 */
  broadcastControl?: (message: AgentMessage) => void;
  /** 兼容旧调用的统一投递 */
  deliverToAgent: (agentId: string, message: AgentMessage) => Promise<void>;
  /** work 平面投递 */
  deliverWorkToAgent?: (agentId: string, message: AgentMessage) => Promise<void>;
  /** control 平面投递 */
  deliverControlToAgent?: (agentId: string, message: AgentMessage) => Promise<void>;
  /** 发送系统通知（拦截、错误等） */
  sendSystemNotification: (notification: SystemNotification) => void;
}

// ============================================================================
// MessageRouter
// ============================================================================

export class MessageRouter {
  private config: RouterConfig;
  private registry: TeamRegistry;
  private callbacks: MessageRouterCallbacks;

  // 消息去重
  private deliveredIds: Set<string> = new Set();

  // 最近消息（用于 replyTo 推断）
  private recentMessages: AgentMessage[] = [];
  private readonly MAX_RECENT = 50;

  constructor(registry: TeamRegistry, callbacks: MessageRouterCallbacks) {
    this.registry = registry;
    this.callbacks = callbacks;

    // 从 registry 推导 RouterConfig
    this.config = {
      coordinator: registry.getCoordinator(),
      members: registry.getMembers().map(m => m.id),
    };

    console.log(`[MessageRouter] Initialized for team: ${registry.name}`);
    console.log(`[MessageRouter] Coordinator: ${this.config.coordinator}`);
    console.log(`[MessageRouter] Members: ${this.config.members.join(', ')}`);
  }

  // === 核心方法 ===

  /**
   * 处理一条进入系统的消息。
   * 这是 MessageRouter 的唯一公开入口。
   */
  handleMessage(message: AgentMessage): void {
    // Step 1：补全缺失字段（向后兼容旧格式消息）
    const normalized = this.normalizeMessage(message);

    // Step 2：去重
    if (this.deliveredIds.has(normalized.id)) {
      console.log(`[Router] 重复消息，跳过：${normalized.id}`);
      return;
    }

    // Step 3：验证硬规则
    const validation = this.validateHardRules(normalized);
    if (!validation.valid) {
      this.sendBlockedNotification(normalized.from, normalized.to, validation.reason!);
      return;
    }

    // Step 4：投递
    if (normalized.messagePlane === 'control') {
      this.handleControlMessage(normalized);
    } else {
      this.handleWorkMessage(normalized);
    }

    // Step 5：记录
    this.deliveredIds.add(normalized.id);
    this.recentMessages.push(normalized);
    if (this.recentMessages.length > this.MAX_RECENT) {
      this.recentMessages.shift();
    }
  }

  handleWorkMessage(message: AgentMessage): void {
    this.deliver(message);
  }

  handleControlMessage(message: AgentMessage): void {
    this.deliver(message);
  }

  /**
   * 补全旧格式消息的缺失字段。
   * 新格式消息调用此方法无副作用。
   */
  private normalizeMessage(message: AgentMessage): AgentMessage {
    const normalized = { ...message };

    // 补全 id
    if (!normalized.id) {
      normalized.id = randomUUID();
    }

    // 补全 mentions（从 body 重新解析）
    if (!normalized.mentions || normalized.mentions.length === 0) {
      normalized.mentions = this.parseMentions(normalized.body);
    }

    // 补全 to（从 mentions 推断）
    // 如果 mentions 包含 'all'，设置 to = 'all'
    // 否则，如果 mentions 只有一个成员，设置 to = 该成员
    if (!normalized.to || normalized.to === 'user') {
      if (normalized.mentions.includes('all')) {
        normalized.to = 'all';
      } else if (normalized.mentions.length === 1) {
        normalized.to = normalized.mentions[0];
      }
    }

    // 补全执行者的 replyTo（向后兼容）
    if (
      normalized.from !== 'user' &&
      this.registry.isExecutor(normalized.from) &&
      !normalized.replyTo
    ) {
      const inferred = this.inferReplyTo(normalized.from);
      if (inferred) {
        console.warn(
          `[Router] 执行者 ${normalized.from} 消息缺少 replyTo，推断为 ${inferred}（请升级消息格式）`
        );
        normalized.replyTo = inferred;
      }
      // 推断失败时 replyTo 保持 null，后续硬规则 A 会拒绝
    }

    if (!normalized.messagePlane) {
      normalized.messagePlane = this.classifyMessagePlane(normalized);
    }

    return normalized;
  }

  /**
   * 验证三条硬规则。
   * 任何一条失败立即返回，不继续检查。
   *
   * 硬规则 A：执行者只能回复来源（to === replyTo）
   * 硬规则 A+：replyTo 必须是合法来源（#T051-4）
   * 硬规则 B：协调者只能发给 team 成员
   * 硬规则 C：Agent 发出的消息必须 @mention 目标（用户消息豁免）
   */
  private validateHardRules(
    message: AgentMessage
  ): { valid: boolean; reason?: string } {
    const { from, to, replyTo, mentions } = message;
    const fromRole = this.registry.getRoleType(from); // 用户返回 null

    // 硬规则 A：执行者只能回复来源
    if (fromRole === 'executor') {
      if (!replyTo) {
        return {
          valid: false,
          reason: `执行者 ${from} 发送消息缺少 replyTo，且无法推断回复来源`,
        };
      }
      if (to !== replyTo) {
        return {
          valid: false,
          reason: `执行者 ${from} 试图发给 ${to}，但只能回复来源 ${replyTo}`,
        };
      }
      
      // 硬规则 A+（#T051-4）：replyTo 必须是合法来源
      // 合法来源：user、协调者、或最近投递的发送者
      const coordinator = this.registry.getCoordinator();
      const validReplyTargets = new Set(['user', coordinator].filter(Boolean));
      
      // 检查最近消息中是否有发给该执行者的消息（投递来源）
      const recentDeliveryFrom = this.findRecentDeliverySource(from);
      if (recentDeliveryFrom) {
        validReplyTargets.add(recentDeliveryFrom);
      }
      
      if (!validReplyTargets.has(replyTo)) {
        return {
          valid: false,
          reason: `执行者 ${from} 的 replyTo=${replyTo} 不是合法来源，合法来源: ${[...validReplyTargets].join(', ')}`,
        };
      }
    }

    // 硬规则 B：协调者只能发给 team 成员
    if (fromRole === 'coordinator') {
      const validTargets = new Set([...this.config.members, 'user', 'all']);
      if (!validTargets.has(to)) {
        return {
          valid: false,
          reason: `协调者 ${from} 试图发给 ${to}，目标不在团队成员列表中`,
        };
      }
    }

    // 硬规则 C：Agent 发出的消息必须 @mention 目标
    // 豁免：
    // 1. 用户消息（from === 'user'）
    // 2. 广播（to === 'all'）
    // 3. 发给用户（to === 'user'）
    // 4. 执行者回复（fromRole === 'executor' && replyTo !== null && to === replyTo）
    //    服务端已有结构化的 replyTo 上下文，不强制要求正文重复 @mention
    const isExecutorReply =
      fromRole === 'executor' && replyTo !== null && to === replyTo;
    if (from !== 'user' && to !== 'all' && to !== 'user' && !isExecutorReply) {
      if (!mentions.includes(to)) {
        return {
          valid: false,
          reason: `${from} 发给 ${to} 的消息正文中没有 @${to}`,
        };
      }
    }

    return { valid: true };
  }
  
  /**
   * 查找最近投递给该 agent 的消息来源（#T051-4）
   * 用于验证 replyTo 是否合法
   */
  private findRecentDeliverySource(agentId: string): string | null {
    // 倒序遍历，找到最近一条发给该 agent 的消息
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const msg = this.recentMessages[i];
      if (msg.to === agentId) {
        return msg.from;
      }
    }
    return null;
  }

  /**
   * 为缺少 replyTo 的旧格式执行者消息推断回复目标。
   * 向后兼容用，新消息不应依赖此方法。
   *
   * 推断规则：查找最近一条 to === agentId 的消息，取其 from 作为 replyTo。
   * 如果找不到，返回 null（调用方应拒绝该消息）。
   */
  private inferReplyTo(agentId: string): string | null {
    // 倒序遍历，找到最近一条发给该 agent 的消息
    for (let i = this.recentMessages.length - 1; i >= 0; i--) {
      const msg = this.recentMessages[i];
      if (msg.to === agentId) {
        return msg.from;
      }
    }
    return null;
  }

  /**
   * 解析消息正文中的 @mention，精确匹配，无模糊。
   * 无法匹配的 mention 静默忽略，不报错，不模糊推断。
   */
  private parseMentions(body: string): string[] {
    const mentionRegex = /@([\w-]+)/g;
    const mentions: string[] = [];
    let match;

    while ((match = mentionRegex.exec(body)) !== null) {
      const id = match[1];

      if (id === 'all') {
        if (!mentions.includes('all')) mentions.push('all');
        continue;
      }

      // 精确匹配：只接受完整成员 ID
      if (this.registry.isMember(id)) {
        if (!mentions.includes(id)) mentions.push(id);
      } else {
        // 静默忽略无法识别的 mention，不做任何推断
        console.log(`[Router] 忽略无法识别的 @mention：@${id}`);
      }
    }

    return mentions;
  }

  private classifyMessagePlane(message: AgentMessage): 'work' | 'control' {
    const text = String(message.body || '');
    if (
      message.from === 'system'
      || /\[\[(?:STATUS|DDL_REACHED|MEMBER_ACTION|TEAM_UPDATE|APPROVAL_REQUEST|APPROVAL_RESPONSE)\b/i.test(text)
    ) {
      return 'control';
    }
    return 'work';
  }

  /**
   * 投递消息到目标。
   * 
   * 关键改进：@all 消息展开时构造定向消息，设置正确的 to 和 replyTo
   */
  private deliver(message: AgentMessage): void {
    this.broadcastByPlane(message);

    if (message.to === 'all') {
      // @all：展开为多条定向消息
      // 注意：只有协调者可以发 @all，硬规则已保证这一点
      for (const memberId of this.config.members) {
        if (memberId !== message.from) {
          // 🆕 构造定向消息，设置正确的 to 和 replyTo
          const directedMessage: AgentMessage = {
            ...message,
            id: `${message.id}-${memberId}`, // 唯一 ID
            to: memberId,                     // 定向投递
            replyTo: message.from,            // 回复来源是发送者（协调者）
            // 保留原始 mentions（包含 'all'），用于前端展示
          };
          this.deliverByPlane(memberId, directedMessage);
        }
      }
      console.log(`[Router] @all 展开为 ${this.config.members.length - 1} 个定向消息`);
    } else if (message.to !== 'user') {
      // 定向投递（发给用户不需要投递到 agent）
      const directedMessage =
        this.registry.getRoleType(message.from) === 'coordinator' && !message.replyTo
          ? {
              ...message,
              replyTo: message.from,
            }
          : message;
      this.deliverByPlane(message.to, directedMessage);
    }
  }

  private deliverByPlane(agentId: string, message: AgentMessage): void {
    if (message.messagePlane === 'control') {
      const callback = this.callbacks.deliverControlToAgent || this.callbacks.deliverToAgent;
      void callback(agentId, message);
      return;
    }
    const callback = this.callbacks.deliverWorkToAgent || this.callbacks.deliverToAgent;
    void callback(agentId, message);
  }

  private broadcastByPlane(message: AgentMessage): void {
    if (message.messagePlane === 'control') {
      const callback = this.callbacks.broadcastControl || this.callbacks.broadcast;
      callback(message);
      return;
    }
    const callback = this.callbacks.broadcastWork || this.callbacks.broadcast;
    callback(message);
  }

  /**
   * 向 Dashboard 发送拦截通知。
   * 走系统通知通道，不混入消息流。
   */
  private sendBlockedNotification(from: string, to: string, reason: string): void {
    console.log(`[Router] 消息被阻止：${from} -> ${to}，原因：${reason}`);

    this.callbacks.sendSystemNotification({
      type: 'MESSAGE_BLOCKED',
      from,
      to,
      reason,
      timestamp: Date.now(),
    });
  }

  // === 工具方法 ===

  /**
   * 重置状态（用于测试）
   */
  reset(): void {
    this.deliveredIds.clear();
    this.recentMessages = [];
  }

  /**
   * 获取配置
   */
  getConfig(): RouterConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Factory
// ============================================================================

import { getTeamRegistry } from '../team/registry.js';

const routers = new Map<string, MessageRouter>();

/**
 * 创建或获取 MessageRouter 实例
 */
export function getMessageRouter(
  teamId: string,
  callbacks?: MessageRouterCallbacks
): MessageRouter {
  let router = routers.get(teamId);

  if (!router) {
    const registry = getTeamRegistry(teamId);
    if (!registry) {
      throw new Error(`[MessageRouter] Team not found: ${teamId}`);
    }

    // 默认回调（空操作）
    const defaultCallbacks: MessageRouterCallbacks = callbacks || {
      broadcast: () => {},
      deliverToAgent: async () => {},
      sendSystemNotification: () => {},
    };

    router = new MessageRouter(registry, defaultCallbacks);
    routers.set(teamId, router);
  }

  return router;
}

/**
 * 重置所有 Router（用于测试）
 */
export function resetMessageRouters(): void {
  routers.clear();
}
