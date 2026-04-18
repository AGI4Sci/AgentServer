/**
 * OpenTeam Studio - Team Initializer
 * 团队成员初始化管理
 * 
 * 职责：
 * 1. 检查团队成员初始化状态
 * 2. 批量初始化团队成员
 * 3. 管理 Agent Session 创建
 */

import type { TeamRegistry } from './registry.js';
import { getTeamRegistry } from './registry.js';
import { getRuntimeWorkspaceAdapter } from '../runtime/adapters/runtime-workspace-adapter.js';
import type { AgentSessionStatus, TeamMemberRuntime, TeamRuntimeState } from '../runtime/types.js';
import { type AgentSoul, getSoulStore } from '../store/soul-store.js';
import { getTeamRuntimeStateStore } from '../store/team-runtime-state-store.js';
import { readAgentRoleSoul } from './agent-role-soul.js';

// ============================================================================
// Types
// ============================================================================

/**
 * 团队初始化状态
 */
export interface TeamInitStatus {
  /** Team ID */
  teamId: string;
  
  /** Team 名称 */
  teamName: string;
  
  /** 总成员数 */
  totalMembers: number;
  
  /** 已初始化成员列表（本地 ID） */
  initializedMembers: string[];
  
  /** 未初始化成员列表（本地 ID） */
  uninitializedMembers: string[];
  
  /** 是否完全初始化 */
  isFullyInitialized: boolean;
  
  /** 成员详情 */
  members: MemberInitStatus[];
}

/**
 * 成员初始化状态
 */
export interface MemberInitStatus {
  /** 本地 ID */
  id: string;
  
  /** 角色名称（可选） */
  role?: string;
  
  /** 名称 */
  name?: string;
  
  /** 是否已初始化（配置已注入） */
  initialized: boolean;
  
  /** 错误信息（如果有） */
  error?: string;
  
  // === 新增：详细会话状态（#T051-1）===
  
  /** 配置状态：运行时目录是否存在 */
  configured?: boolean;
  
  /** 会话状态：是否有活跃 session */
  sessionReady?: boolean;
  
  /** 在线状态：是否在最近有响应 */
  online?: boolean;
  
  /** 运行时状态 */
  runtimeStatus?: 'idle' | 'working' | 'error' | 'offline';
  
  /** 状态详情 */
  statusDetail?: string;
}

/**
 * 初始化结果
 */
export interface InitResult {
  /** 成功初始化的成员 */
  success: string[];
  
  /** 初始化失败的成员 */
  failed: Array<{ id: string; error: string }>;
  
  /** 是否全部成功 */
  allSuccess: boolean;
}

function parseRuntimeSignalTimestamp(member: TeamMemberRuntime, stateUpdatedAt: string): number {
  return Math.max(
    Number.isFinite(Date.parse(member.lastHeartbeatAt || '')) ? Date.parse(member.lastHeartbeatAt || '') : 0,
    Number.isFinite(Date.parse(member.lastResultAt || '')) ? Date.parse(member.lastResultAt || '') : 0,
    Number.isFinite(Date.parse(stateUpdatedAt || '')) ? Date.parse(stateUpdatedAt || '') : 0,
  );
}

function runtimeActivityRank(member: TeamMemberRuntime): number {
  const lifecycleRank = ({
    active: 5,
    waiting_approval: 4,
    blocked: 4,
    paused: 3,
    idle: 2,
    retired: 1,
    failed: 1,
    spawning: 3,
  } as const)[member.lifecycle] ?? 0;
  const availabilityRank = ({
    busy: 5,
    active: 4,
    blocked: 3,
    idle: 2,
    offline: 1,
  } as const)[member.availability] ?? 0;
  return Math.max(lifecycleRank, availabilityRank);
}

export function mergeRuntimeMembersAcrossStates(states: TeamRuntimeState[]): Map<string, TeamMemberRuntime> {
  const merged = new Map<string, TeamMemberRuntime>();
  const meta = new Map<string, { signalTs: number; activityRank: number }>();

  for (const state of states) {
    for (const member of state.members) {
      const nextSignalTs = parseRuntimeSignalTimestamp(member, state.updatedAt);
      const nextActivityRank = runtimeActivityRank(member);
      const current = merged.get(member.agentId);
      const currentMeta = meta.get(member.agentId);

      if (!current || !currentMeta) {
        merged.set(member.agentId, member);
        meta.set(member.agentId, {
          signalTs: nextSignalTs,
          activityRank: nextActivityRank,
        });
        continue;
      }

      if (
        nextSignalTs > currentMeta.signalTs
        || (nextSignalTs === currentMeta.signalTs && nextActivityRank > currentMeta.activityRank)
      ) {
        merged.set(member.agentId, member);
        meta.set(member.agentId, {
          signalTs: nextSignalTs,
          activityRank: nextActivityRank,
        });
      }
    }
  }

  return merged;
}

// ============================================================================
// TeamInitializer 类
// ============================================================================

/**
 * 团队初始化器
 */
export class TeamInitializer {
  private resolveMemberSoul(registry: TeamRegistry, memberId: string): AgentSoul | null {
    const soulStore = getSoulStore();
    const storedSoul = soulStore.getAgentSoul(memberId);
    if (storedSoul) {
      return storedSoul;
    }

    const roleSoul = readAgentRoleSoul(memberId);
    if (roleSoul) {
      const member = registry.getMember(memberId);
      return {
        id: memberId,
        name: roleSoul.name || member?.name || memberId,
        role: roleSoul.role || member?.roleName || member?.roleType || 'member',
        identity: roleSoul.identity || `你是 ${roleSoul.name || memberId}。`,
        personality: roleSoul.personality || '专业、可靠、注重协作',
        mission: roleSoul.mission || roleSoul.identity || '完成分配任务并同步进展。',
        communication: roleSoul.communication || '简洁明确，优先同步进展、阻塞和下一步。',
        constraints: roleSoul.constraints || '遵守团队协作规则。',
        traits: roleSoul.traits || [],
        runtime: {
          model: roleSoul.runtime?.model || undefined,
        },
      };
    }

    return null;
  }

  private mergeRuntimeSignals(
    base: AgentSessionStatus,
    runtimeMember: TeamMemberRuntime | undefined,
  ): AgentSessionStatus {
    if (!runtimeMember) {
      return base;
    }

    const recentTs = [runtimeMember.lastHeartbeatAt, runtimeMember.lastResultAt]
      .map((value) => {
        if (!value) {
          return null;
        }
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
      })
      .filter((value): value is number => value != null);
    const latestSignal = recentTs.length > 0 ? Math.max(...recentTs) : null;
    const now = Date.now();
    const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
    const recentlyActive = latestSignal != null && now - latestSignal < ACTIVE_THRESHOLD_MS;
    const hasRuntimeSession = runtimeMember.lifecycle !== 'idle' || runtimeMember.availability !== 'idle' || latestSignal != null;

    const merged: AgentSessionStatus = {
      ...base,
      sessionReady: base.sessionReady || hasRuntimeSession,
      online: base.online || recentlyActive,
      lastHeartbeat: base.lastHeartbeat ?? (runtimeMember.lastHeartbeatAt ? Date.parse(runtimeMember.lastHeartbeatAt) : undefined),
      lastResponse: base.lastResponse ?? (runtimeMember.lastResultAt ? Date.parse(runtimeMember.lastResultAt) : undefined),
    };

    if (runtimeMember.lifecycle === 'failed' || runtimeMember.availability === 'offline') {
      merged.runtimeStatus = 'error';
      merged.statusDetail = 'error';
      return merged;
    }

    if (runtimeMember.availability === 'busy' || runtimeMember.availability === 'active') {
      merged.runtimeStatus = 'working';
      merged.statusDetail = 'working';
      return merged;
    }

    if (merged.online) {
      merged.runtimeStatus = 'idle';
      merged.statusDetail = 'online';
      return merged;
    }

    if (merged.sessionReady) {
      merged.runtimeStatus = 'idle';
      merged.statusDetail = 'session_ready';
    }

    return merged;
  }

  /**
   * 检查团队初始化状态
   * 
   * 改进（#T051-1）：
   * - 使用 getAgentSessionStatus 获取详细状态
   * - 区分 configured/sessionReady/online 不同层级
   * - 避免"已配置但离线"被误报为"已初始化"
   * 
   * @param teamId Team ID
   * @returns 初始化状态
   */
  async checkInitStatus(teamId: string): Promise<TeamInitStatus> {
    const registry = getTeamRegistry(teamId);
    
    if (!registry) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const members = registry.getMembers();
    const adapter = getRuntimeWorkspaceAdapter();
    const runtimeStates = getTeamRuntimeStateStore().listStates(teamId);
    const runtimeMembers = mergeRuntimeMembersAcrossStates(runtimeStates);
    
    const memberStatuses: MemberInitStatus[] = [];
    const initializedMembers: string[] = [];
    const uninitializedMembers: string[] = [];
    
    for (const member of members) {
      try {
        // 使用新的详细状态查询（#T051-1）
        const sessionStatus = this.mergeRuntimeSignals(
          await adapter.getAgentSessionStatus(member.id),
          runtimeMembers.get(member.id),
        );
        
        const memberStatus: MemberInitStatus = {
          id: member.id,
          role: member.roleName,
          name: member.name,
          // initialized 保持向后兼容：configured 为 true 即视为已初始化
          initialized: sessionStatus.configured,
          // 新增详细状态字段
          configured: sessionStatus.configured,
          sessionReady: sessionStatus.sessionReady,
          online: sessionStatus.online,
          runtimeStatus: sessionStatus.runtimeStatus,
          statusDetail: sessionStatus.statusDetail,
        };
        
        memberStatuses.push(memberStatus);
        
        if (sessionStatus.configured) {
          initializedMembers.push(member.id);
        } else {
          uninitializedMembers.push(member.id);
        }
      } catch (error) {
        // 检查失败，视为未初始化
        memberStatuses.push({
          id: member.id,
          role: member.roleName,
          name: member.name,
          initialized: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        uninitializedMembers.push(member.id);
      }
    }
    
    return {
      teamId: registry.id,
      teamName: registry.name,
      totalMembers: members.length,
      initializedMembers,
      uninitializedMembers,
      isFullyInitialized: uninitializedMembers.length === 0,
      members: memberStatuses,
    };
  }
  
  /**
   * 初始化团队所有成员
   * 
   * @param teamId Team ID
   * @param options 初始化选项
   * @returns 初始化结果
   */
  async initializeAll(
    teamId: string,
    options?: {
      /** 只初始化指定的成员 */
      members?: string[];
      /** 是否发送初始消息 */
      sendInitialMessage?: boolean;
    }
  ): Promise<InitResult> {
    const registry = getTeamRegistry(teamId);
    
    if (!registry) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const allMembers = registry.getMembers();
    const targetMembers = options?.members
      ? allMembers.filter(m => options.members!.includes(m.id))
      : allMembers;
    
    const success: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    
    for (const member of targetMembers) {
      try {
        await this.initializeMember(teamId, member.id);
        success.push(member.id);
        console.log(`[TeamInitializer] Initialized: ${member.id}`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        failed.push({ id: member.id, error: errorMsg });
        console.error(`[TeamInitializer] Failed to initialize ${member.id}:`, errorMsg);
      }
    }
    
    return {
      success,
      failed,
      allSuccess: failed.length === 0,
    };
  }
  
  /**
   * 初始化单个成员
   * 
   * @param teamId Team ID
   * @param memberId 成员本地 ID
   */
  async initializeMember(teamId: string, memberId: string): Promise<void> {
    const registry = getTeamRegistry(teamId);
    
    if (!registry) {
      throw new Error(`Team not found: ${teamId}`);
    }
    
    const member = registry.getMember(memberId);
    if (!member) {
      throw new Error(`Member not found: ${memberId}`);
    }
    
    const adapter = getRuntimeWorkspaceAdapter();
    
    // 1. 获取 Soul 配置
    const soul = this.resolveMemberSoul(registry, memberId);
    
    if (!soul) {
      throw new Error(`Soul not found for member: ${memberId}`);
    }
    
    // 2. 创建或更新 Agent
    const hasAgent = await adapter.hasAgent(memberId);
    
    if (!hasAgent) {
      await adapter.createAgent(memberId);
      console.log(`[TeamInitializer] Created agent: ${memberId}`);
    }
    
    // 3. 准备 runtime workspace。
    // 运行时 workspace 现在按 session 执行，不再维护预注册 agents.list。
    await adapter.syncAgentWorkspaceFromSoulStore(memberId, soul, {
      teamId: registry.id,
      teamName: registry.name,
      members: registry.getMembers().map((teamMember) => ({
        id: teamMember.id,
        role: teamMember.roleName,
        name: teamMember.name,
      })),
    });
    console.log(`[TeamInitializer] Injected config for: ${memberId}`);
  }
  
  /**
   * 快速检查：团队成员是否已初始化
   * 
   * @param teamId Team ID
   * @returns 是否需要初始化
   */
  async needsInitialization(teamId: string): Promise<boolean> {
    const status = await this.checkInitStatus(teamId);
    return !status.isFullyInitialized;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let initializerInstance: TeamInitializer | null = null;

/**
 * 获取团队初始化器单例
 */
export function getTeamInitializer(): TeamInitializer {
  if (!initializerInstance) {
    initializerInstance = new TeamInitializer();
  }
  return initializerInstance;
}

/**
 * 重置初始化器（用于测试）
 */
export function resetTeamInitializer(): void {
  initializerInstance = null;
}
