/**
 * Backend Adapter
 *
 * 遵循设计文档: docs/communication_design_plan.md
 *
 * 核心变化:
 * 1. 移除符号链接,改用直接复制
 * 2. 使用实例 ID 作为运行时 agent ID
 * 3. 每次调用 sendToAgent() 前同步配置
 * 4. 移除 tools.deny 相关逻辑(Team 隔离由 MessageRouter 负责)
 * 5. SOUL.md 生成使用 TeamRegistry.generateCommunicationConstraints()
 *
 * 数据流:
 * OpenTeam agents/{localId}/ → 同步配置 → runtime_supervisor/openteam-local/team-workspaces/workspace-{runtimeId}/
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { BaseAdapter } from './base-adapter.js';
import { getOpenTeamInstance } from '../instance.js';
import { ensureBackendStateDirs, ensureSharedTeamRuntimeDir, getBackendStateDir } from '../backend-paths.js';
import { writeWorkspaceLease } from '../runtime-workspace-lease.js';
import type {
  SoulConfig,
  SessionContext,
  SkillConfig,
  TeamContext,
  TeamMember,
} from '../types.js';
import type { TeamRegistry } from '../../team/registry.js';
import type { MemberConfig } from '../../team/types.js';
import { renderAgentRoleSoulMarkdown } from '../../team/agent-role-soul.js';
import { formatSessionContextSummary } from '../session-scope.js';

// ============================================================================
// Types
// ============================================================================

const OPENTEAM_RUNTIME_PROTOCOL_VERSION = '2026-03-30-router-v3';
const OPENTEAM_RUNTIME_STATE_FILE = '.openteam-runtime-state.json';

// ============================================================================
// Backend Adapter Implementation
// ============================================================================

export class BackendAdapter extends BaseAdapter {
  readonly name = 'openteam-backend';

  private runtimeWorkspaceDir: string;
  private legacyWorkspaceStateDir: string;
  private openteamAgentsDir: string;
  private openteamSharedSkillsDir: string;

  // Runtime transport client (injected)
  private transportClient: any = null;

  constructor() {
    super();
    ensureBackendStateDirs('runtime_supervisor', ['team-workspaces']);
    this.runtimeWorkspaceDir = ensureSharedTeamRuntimeDir();
    this.legacyWorkspaceStateDir = getBackendStateDir('openclaw');
    this.openteamAgentsDir = process.env.OPENTEAM_AGENTS_DIR ||
                              (process.env.OPENTEAM_DIR
                                ? join(process.env.OPENTEAM_DIR, 'agents', 'roles')
                                : join(process.cwd(), 'agents', 'roles'));
    this.openteamSharedSkillsDir = process.env.OPENTEAM_SKILLS_DIR ||
                                   (process.env.OPENTEAM_DIR
                                     ? join(process.env.OPENTEAM_DIR, 'agents', 'skills')
                                     : join(process.cwd(), 'agents', 'skills'));
  }

  /**
   * 设置运行时传输客户端
   */
  setTransportClient(client: any): void {
    this.transportClient = client;
  }

  // === 生命周期 ===

  async init(): Promise<void> {
    ensureBackendStateDirs('runtime_supervisor', ['team-workspaces']);
    console.log(`[BackendAdapter] Initialized, shared runtime dir: ${this.runtimeWorkspaceDir}`);
  }

  async shutdown(): Promise<void> {
    console.log('[BackendAdapter] Shutdown');
  }

  // === 配置同步(核心方法)===

  /**
   * 同步配置到共享 runtime workspace
   *
   * 每次调用 sendToAgent() 前执行:
   * 1. 复制 soul.json 到运行时目录
   * 2. 生成 SOUL.md
   * 3. 复制 memory 目录
   * 4. 准备 runtime workspace 引导文件
   *
   * @param localId 本地 agent ID(如 pm-01)
   * @param soul Agent 灵魂配置
   * @param skills Agent 技能列表
   * @returns 运行时 agent ID({instanceId}--{localId})
   */
  async syncConfig(localId: string, soul: SoulConfig, skills: SkillConfig[]): Promise<string> {
    const instance = getOpenTeamInstance();
    const runtimeId = instance.getRuntimeAgentId(localId);
    const runtimeDir = this.getRuntimeDir(runtimeId);

    // 1. 创建运行时目录
    if (!existsSync(runtimeDir)) {
      mkdirSync(runtimeDir, { recursive: true });
    }

    // 2. 复制 soul.json(如果存在)
    const sourceSoulPath = join(this.openteamAgentsDir, localId, 'soul.json');
    if (existsSync(sourceSoulPath)) {
      const targetSoulPath = join(runtimeDir, 'soul.json');
      cpSync(sourceSoulPath, targetSoulPath, { force: true });
    }

    // 3. 生成 SOUL.md（无 Team 上下文的简化版本）
    this.writeSoulMdSimple(runtimeDir, soul);

    // 4. 写入 AGENTS.md
    this.writeAgentsMd(runtimeDir, soul);

    // 5. 写入 USER.md
    this.writeUserMd(runtimeDir, soul);

    // 6. 写入 TOOLS.md
    const effectiveSkillIds = [...new Set(skills.map((skill) => skill.id).filter(Boolean))];
    this.writeToolsMd(runtimeDir, soul, effectiveSkillIds);

    // 7. 复制 memory 目录(如果存在)
    const sourceMemoryDir = join(this.openteamAgentsDir, localId, 'memory');
    if (existsSync(sourceMemoryDir)) {
      const targetMemoryDir = join(runtimeDir, 'memory');
      cpSync(sourceMemoryDir, targetMemoryDir, { recursive: true, force: true });
    }

    writeWorkspaceLease({
      runtimeDir,
      runtimeId,
      localAgentId: localId,
      teamId: soul.team?.teamId ?? null,
      backend: 'openteam',
    });

    console.log(`[BackendAdapter] Synced config for ${runtimeId} (local: ${localId})`);

    return runtimeId;
  }

  /**
   * 从 SoulStore 同步配置（便捷方法）
   */
  async syncFromSoulStore(localId: string, soul: any, team?: TeamContext): Promise<string> {
    const soulConfig: SoulConfig = {
      id: soul.id,
      name: soul.name,
      runtime: soul.runtime,
      identity: soul.identity,
      personality: soul.personality,
      mission: soul.mission,
      communication: soul.communication,
      constraints: soul.constraints,
      traits: soul.traits,
      team,
    };

    const skillIds = soul.runtime?.skills || [];
    const skills: SkillConfig[] = skillIds.map((id: string) => ({ id, name: id, description: '', type: 'prompt' }));

    return this.syncConfig(localId, soulConfig, skills);
  }

  /**
   * 使用 TeamRegistry 同步配置（推荐）
   * 遵循 Phase 5 设计：Member Profile + Team Context + 通信约束
   */
  async syncFromSoulStoreWithRegistry(
    localId: string, 
    soul: any, 
    registry: TeamRegistry,
    teamDir?: string
  ): Promise<string> {
    const soulConfig: SoulConfig = {
      id: soul.id,
      name: soul.name,
      runtime: soul.runtime,
      identity: soul.identity,
      personality: soul.personality,
      mission: soul.mission,
      communication: soul.communication,
      constraints: soul.constraints,
      traits: soul.traits,
      team: {
        teamId: registry.id,
        teamName: registry.name,
        members: registry.getMembers().map(m => ({
          id: m.id,
          role: m.roleName,
          name: m.name,
        })),
      },
    };

    const skillIds = soul.runtime?.skills || [];
    const skills: SkillConfig[] = skillIds.map((id: string) => ({ id, name: id, description: '', type: 'prompt' }));

    // 生成通信约束（使用 TeamRegistry）
    const communicationConstraints = registry.generateCommunicationConstraints(localId);
    
    return this.syncConfigWithConstraints(localId, soulConfig, skills, communicationConstraints, teamDir, registry);
  }

  /**
   * 同步配置（带通信约束）
   * 遵循 Phase 5 设计：三部分用 --- 分隔
   */
  private async syncConfigWithConstraints(
    localId: string, 
    soul: SoulConfig, 
    skills: SkillConfig[],
    communicationConstraints: string,
    teamDir?: string,
    registry?: TeamRegistry
  ): Promise<string> {
    const instance = getOpenTeamInstance();
    const runtimeId = instance.getRuntimeAgentId(localId);
    const runtimeDir = this.getRuntimeDir(runtimeId);

    // 1. 创建运行时目录
    if (!existsSync(runtimeDir)) {
      mkdirSync(runtimeDir, { recursive: true });
    }

    this.resetRuntimeStateIfNeeded(runtimeDir, localId);

    // 2. 生成 SOUL.md（使用 Phase 5 的三部分结构）
    this.writeSoulMdWithConstraints(runtimeDir, soul, communicationConstraints, teamDir, registry);

    // 3. 写入 AGENTS.md
    this.writeAgentsMd(runtimeDir, soul);

    // 4. 写入 USER.md
    this.writeUserMd(runtimeDir, soul);

    // 5. 写入 TOOLS.md
    const effectiveSkillIds = this.resolveEffectiveSkillIds(localId, soul, skills, registry);
    this.writeToolsMd(runtimeDir, soul, effectiveSkillIds);

    if (teamDir && registry) {
      this.syncTeamSkillWorkspace(runtimeDir, registry.id, teamDir);
    }

    console.log(`[BackendAdapter] Synced config for ${runtimeId} (local: ${localId}) with constraints`);

    return runtimeId;
  }

  // ==========================================================================
  // Phase 5: 文件加载方法
  // ==========================================================================

  /**
   * 加载成员的 Member Profile。
   * agents/roles/{agentId}/soul.json 是唯一真相源。
   */
  private loadMemberProfile(member: MemberConfig): string {
    const roleMarkdown = renderAgentRoleSoulMarkdown(member.id);
    if (roleMarkdown) {
      return roleMarkdown;
    }
    console.warn(`[Adapter] 成员 ${member.id} 未在 agents/roles/${member.id}/soul.json 中找到 persona 定义`);
    return '';
  }

  /**
   * 加载 Team Context 模板并填充占位符。
   * 文件固定为 team 目录下的 team.md。
   * 占位符格式：{id}、{name}、{role_in_team}、{team_name}
   */
  private loadTeamContext(
    member: MemberConfig,
    teamDir: string,
    teamName: string
  ): string {
    const filePath = resolve(teamDir, 'team.md');
    if (!existsSync(filePath)) {
      console.warn(`[Adapter] Team Context 文件不存在：${filePath}`);
      return '';
    }
    let content = readFileSync(filePath, 'utf-8');
    content = content
      .replace(/{id}/g, member.id)
      .replace(/{name}/g, member.name ?? member.id)
      .replace(/{role_in_team}/g, member.roleName ?? member.roleType)
      .replace(/{team_name}/g, teamName);
    return content;
  }

  // ==========================================================================
  // SOUL.md 生成
  // ==========================================================================

  /**
   * 写入 SOUL.md（简化版，无 Team 上下文）
   */
  private writeSoulMdSimple(runtimeDir: string, soul: SoulConfig): void {
    const soulPath = join(runtimeDir, 'SOUL.md');
    const content = this.generateSoulMdSimple(soul);
    writeFileSync(soulPath, content, 'utf-8');
  }

  /**
   * 写入 SOUL.md（带通信约束）
   * 遵循 Phase 5 设计：三部分用 --- 分隔
   */
  private writeSoulMdWithConstraints(
    runtimeDir: string, 
    soul: SoulConfig, 
    communicationConstraints: string,
    teamDir?: string,
    registry?: TeamRegistry
  ): void {
    const soulPath = join(runtimeDir, 'SOUL.md');
    const content = this.generateSoulMdWithConstraints(soul, communicationConstraints, teamDir, registry);
    writeFileSync(soulPath, content, 'utf-8');
  }

  /**
   * 生成简化版 SOUL.md 内容（无 Team 上下文）
   * 
   * 注意：这是备用方案，正常情况应该使用 generateSoulMdWithConstraints
   * 并提供 teamDir 和 registry 参数。
   */
  private generateSoulMdSimple(soul: SoulConfig): string {
    return `# ${soul.name || soul.id}

你是 ${soul.name || soul.id}。

你的 ID 是 ${soul.id}。

请通过 SOUL.md 配置文件定义你的身份、能力和使命。
`;
  }

  /**
   * 生成 SOUL.md 内容（Phase 5 设计）
   * 
   * 结构：Member Profile + Team Context + 动态通信约束
   * 三部分用 --- 分隔，通信约束在最后（优先级最高）
   *
   * 重要：
   * - 协调者：通信约束包含成员列表
   * - 执行者：通信约束不包含成员列表
   * 
   * 数据来源：
   * - Member Profile: agents/roles/{agent}/soul.json（唯一真相源）
   * - Team Context: teams/{team}/team.md（人类维护）
   * - 通信约束: TeamRegistry.generateCommunicationConstraints()（系统生成）
   */
  private generateSoulMdWithConstraints(
    soul: SoulConfig, 
    communicationConstraints: string,
    teamDir?: string,
    registry?: TeamRegistry
  ): string {
    // 加载 Member Profile 和 Team Context（如果有 teamDir 和 registry）
    let memberProfile = '';
    let teamContext = '';
    let teamSkillNote = '';
    
    if (teamDir && registry) {
      const member = registry.getMember(soul.id);
      if (member) {
        memberProfile = this.loadMemberProfile(member);
        teamContext = this.loadTeamContext(member, teamDir, registry.name);
      }

      teamSkillNote = [
        '# Team Skill 优先级',
        '',
        `- 团队本地协作规则文件位于 \`./skills/${registry.id}/SKILL.md\``,
        '- 如果存在同名的全局/共享 skill，必须以这里的本地文件为准',
        '- 禁止使用 `sessions_send`、`sessions_list`、手工拼接 `sessionKey` 等直连会话方式',
        '- 团队通信统一走群聊里的 `@mention` / Router 规则',
      ].join('\n');
    }

    // 组装三部分，用 --- 分隔（符合 Phase 5 设计）
    const parts: string[] = [];
    
    // Part 1: Member Profile（身份、能力、风格、使命、约束）
    if (memberProfile.trim()) {
      parts.push(memberProfile.trim());
    }
    
    // Part 2: Team Context（团队角色、职责）
    if (teamContext.trim()) {
      parts.push(teamContext.trim());
    }

    if (teamSkillNote.trim()) {
      parts.push(teamSkillNote.trim());
    }
    
    // Part 3: 动态通信约束（最后，优先级最高）
    parts.push(communicationConstraints.trim());

    return parts.join('\n\n---\n\n');
  }

  // === Agent 管理 ===

  /**
   * 创建 Agent(实现 BaseAdapter 接口)
   */
  async createAgent(localId: string, _options?: any): Promise<void> {
    // createAgent 不做任何事,配置通过 syncConfig 注入
    console.log(`[BackendAdapter] createAgent called for ${localId} (no-op, use syncConfig instead)`);
  }

  /**
   * 注入配置(实现 BaseAdapter 接口)
   * 简单调用 syncConfig
   */
  async injectConfig(localId: string, soul: SoulConfig, skills: SkillConfig[]): Promise<void> {
    await this.syncConfig(localId, soul, skills);
  }

  /**
   * 删除 Agent 运行时目录
   */
  async deleteAgent(localId: string): Promise<void> {
    const instance = getOpenTeamInstance();
    const runtimeId = instance.getRuntimeAgentId(localId);
    const runtimeDir = this.getRuntimeDir(runtimeId);
    const legacyRuntimeDir = this.getLegacyRuntimeDir(runtimeId);
    const hadRuntimeDir = existsSync(runtimeDir);
    const hadLegacyRuntimeDir = existsSync(legacyRuntimeDir);

    if (hadRuntimeDir) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
    if (hadLegacyRuntimeDir) {
      rmSync(legacyRuntimeDir, { recursive: true, force: true });
    }
    if (hadRuntimeDir || hadLegacyRuntimeDir) {
      console.log(`[BackendAdapter] Deleted agent: ${runtimeId}`);
    }
  }

  /**
   * 检查 Agent 是否存在
   */
  async hasAgent(localId: string): Promise<boolean> {
    const instance = getOpenTeamInstance();
    const runtimeId = instance.getRuntimeAgentId(localId);
    return existsSync(this.getRuntimeDir(runtimeId)) || existsSync(this.getLegacyRuntimeDir(runtimeId));
  }
  
  /**
   * 获取 Agent 详细会话状态（#T051-1）
   * 
   * 区分不同层级的状态：
   * - configured: 运行时目录是否存在
   * - sessionReady: 是否有活跃 session
   * - online: 是否有最近响应
   */
  async getAgentSessionStatus(localId: string): Promise<import('../types.js').AgentSessionStatus> {
    const instance = getOpenTeamInstance();
    const runtimeId = instance.getRuntimeAgentId(localId);
    const runtimeDir = this.getRuntimeDir(runtimeId);
    const legacyRuntimeDir = this.getLegacyRuntimeDir(runtimeId);
    
    // 基础状态
    const configured = existsSync(runtimeDir) || existsSync(legacyRuntimeDir);
    
    // 默认返回值
    const result: import('../types.js').AgentSessionStatus = {
      id: localId,
      configured,
      sessionReady: false,
      online: false,
      runtimeStatus: configured ? 'idle' : 'offline',
      statusDetail: configured ? 'configured_offline' : 'not_configured',
    };
    
    if (!configured) {
      return result;
    }
    
    // 尝试通过 Gateway 获取真实状态
    if (this.transportClient && this.transportClient.isConnected()) {
      try {
        // 查询 session 状态
        const sessionStatus = await this.transportClient.getSessionStatus(runtimeId);
        
        if (sessionStatus) {
          result.sessionReady = sessionStatus.active ?? false;
          result.online = sessionStatus.online ?? false;
          result.runtimeStatus = sessionStatus.status || 'idle';
          result.lastHeartbeat = sessionStatus.lastHeartbeat;
          result.lastResponse = sessionStatus.lastResponse;
          result.lastError = sessionStatus.lastError;
          
          // 计算详细状态
          if (result.lastError) {
            result.statusDetail = 'error';
          } else if (result.runtimeStatus === 'working') {
            result.statusDetail = 'working';
          } else if (result.online) {
            result.statusDetail = 'online';
          } else if (result.sessionReady) {
            result.statusDetail = 'session_ready';
          } else {
            result.statusDetail = 'configured_offline';
          }
        }
      } catch (error) {
        console.warn(`[BackendAdapter] Failed to get session status for ${runtimeId}:`, error);
        // Runtime transport 查询失败，回退到本地检查
      }
    }
    
    // 备选：检查最近心跳文件
    if (!result.online && configured) {
      const heartbeatFile = join(runtimeDir, '.heartbeat');
      if (existsSync(heartbeatFile)) {
        try {
          const heartbeatData = JSON.parse(readFileSync(heartbeatFile, 'utf-8'));
          const lastHeartbeat = heartbeatData.timestamp;
          const now = Date.now();
          const HEARTBEAT_THRESHOLD = 5 * 60 * 1000; // 5 分钟内有心跳视为在线
          
          result.lastHeartbeat = lastHeartbeat;
          
          if (lastHeartbeat && now - lastHeartbeat < HEARTBEAT_THRESHOLD) {
            result.online = true;
            result.statusDetail = 'online';
          }
        } catch {
          // 心跳文件格式错误，忽略
        }
      }
    }
    
    return result;
  }

  /**
   * 列出所有 Agent(运行时 ID)
   */
  async listAgents(): Promise<string[]> {
    if (!existsSync(this.runtimeWorkspaceDir)) {
      return [];
    }

    const { readdirSync, statSync } = await import('fs');

    return readdirSync(this.runtimeWorkspaceDir)
      .filter((name) => name.startsWith('workspace-'))
      .filter((name) => statSync(join(this.runtimeWorkspaceDir, name)).isDirectory())
      .map((name) => name.slice('workspace-'.length));
  }

  // === 通信 ===

  async sendMessage(to: string, message: string): Promise<void> {
    if (!this.transportClient) {
      throw new Error('Runtime transport client not set');
    }

    await this.transportClient.sendToAgent(to, message);
  }

  // === 状态 ===

  async getAgentStatus(id: string): Promise<'idle' | 'working' | 'error' | 'offline'> {
    const exists = await this.hasAgent(id);
    return exists ? 'idle' : 'offline';
  }

  isConnected(): boolean {
    return this.transportClient?.isConnected?.() ?? false;
  }

  /**
   * 将当前 SessionContext 同步到 runtime workspace，作为执行层和观察层共享的真相源。
   */
  syncSessionContextArtifacts(localId: string, sessionContext: SessionContext): void {
    const runtimeDir = this.getRuntimeDir(localId);
    if (!existsSync(runtimeDir)) {
      mkdirSync(runtimeDir, { recursive: true });
    }

    writeFileSync(
      join(runtimeDir, '.openteam-session-context.json'),
      JSON.stringify(sessionContext, null, 2) + '\n',
      'utf-8',
    );
    writeFileSync(
      join(runtimeDir, 'SESSION_CONTEXT.md'),
      formatSessionContextSummary(sessionContext) + '\n',
      'utf-8',
    );
    writeWorkspaceLease({
      runtimeDir,
      runtimeId: localId.includes('--') ? localId : getOpenTeamInstance().getRuntimeAgentId(localId),
      localAgentId: localId.includes('--') ? localId.split('--').slice(1).join('--') : localId,
      teamId: sessionContext.env['team.id'] || null,
      backend: 'openteam',
    });
  }

  // === 私有方法 ===

  private writeAgentsMd(runtimeDir: string, soul: SoulConfig): void {
    const agentsPath = join(runtimeDir, 'AGENTS.md');
    const content = [
      `# ${soul.name || 'Agent'} - Workspace`,
      '',
      `This is the runtime workspace for ${soul.name || 'Agent'}.`,
      '',
      '- Runtime notes live here (`SOUL.md`, `TOOLS.md`, `SESSION_CONTEXT.md`).',
      '- If `SESSION_CONTEXT.md` exists, treat its `exec.*` values as the active execution scope.',
    ].join('\n');
    writeFileSync(agentsPath, content, 'utf-8');
  }

  private writeUserMd(runtimeDir: string, soul: SoulConfig): void {
    const userPath = join(runtimeDir, 'USER.md');
    const content = `# USER.md - About Your Human\n\n- **Timezone:** Asia/Shanghai\n\n## Context\n\nUpdate this as you learn about the user.\n`;
    writeFileSync(userPath, content, 'utf-8');
  }

  private writeToolsMd(runtimeDir: string, soul: SoulConfig, skillIds: string[] = []): void {
    const toolsPath = join(runtimeDir, 'TOOLS.md');
    const skills = skillIds.length > 0 ? skillIds : (soul.runtime?.skills || []);
    const skillsSection = skills.length > 0
      ? skills.map((skillId) => {
          const summary = this.resolveSkillSummary(skillId);
          return summary
            ? `- ${skillId}: ${summary}`
            : `- ${skillId}`;
        }).join('\n')
      : '_No skills enabled_';
    const content = `# TOOLS.md - Local Notes\n\n## Enabled Skills\n\n${skillsSection}\n`;
    writeFileSync(toolsPath, content, 'utf-8');
  }

  private resolveSkillSummary(skillId: string): string | null {
    const skillPath = join(this.openteamSharedSkillsDir, skillId, 'SKILL.md');
    if (!existsSync(skillPath)) {
      return null;
    }
    try {
      const content = readFileSync(skillPath, 'utf-8');
      const descriptionMatch = content.match(/^description:\s*"?([^"\n]+)"?/m);
      if (descriptionMatch?.[1]) {
        return descriptionMatch[1].trim();
      }
      const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('#')) {
          return line.replace(/^#+\s*/, '').trim();
        }
      }
      for (const line of lines) {
        if (!line.startsWith('---') && !line.includes(':')) {
          return line.slice(0, 120);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private resolveEffectiveSkillIds(
    localId: string,
    soul: SoulConfig,
    skills: SkillConfig[],
    registry?: TeamRegistry
  ): string[] {
    const configured = new Set<string>();

    for (const skill of skills) {
      if (skill.id) configured.add(skill.id);
    }

    for (const skill of soul.runtime?.skills || []) {
      if (typeof skill === 'string' && skill.trim()) {
        configured.add(skill.trim());
      }
    }

    const memberSkills = registry?.getMember(localId)?.skills || [];
    for (const skill of memberSkills) {
      if (typeof skill === 'string' && skill.trim()) {
        configured.add(skill.trim());
      }
    }

    return [...configured];
  }

  private syncTeamSkillWorkspace(runtimeDir: string, teamId: string, teamDir: string): void {
    const sourceSkillsDir = existsSync(join(teamDir, 'tools'))
      ? join(teamDir, 'tools')
      : join(teamDir, 'skills');
    if (!existsSync(sourceSkillsDir)) {
      return;
    }

    const runtimeSkillsDir = join(runtimeDir, 'skills');
    const linkedTeamSkillDir = join(runtimeSkillsDir, teamId);

    mkdirSync(runtimeSkillsDir, { recursive: true });

    if (existsSync(linkedTeamSkillDir)) {
      const stat = lstatSync(linkedTeamSkillDir);
      if (stat.isSymbolicLink()) {
        unlinkSync(linkedTeamSkillDir);
      } else {
        rmSync(linkedTeamSkillDir, { recursive: true, force: true });
      }
    }

    // OpenClaw 会忽略逃逸到 workspace 外部的技能软链；这里直接复制以确保 workspace skill 生效。
    cpSync(sourceSkillsDir, linkedTeamSkillDir, { recursive: true, force: true });
  }

  private resetRuntimeStateIfNeeded(runtimeDir: string, localId: string): void {
    const statePath = join(runtimeDir, OPENTEAM_RUNTIME_STATE_FILE);
    let previousVersion: string | null = null;

    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (typeof state?.version === 'string') {
          previousVersion = state.version;
        }
      } catch (error) {
        console.warn(`[BackendAdapter] Failed to read runtime state for ${localId}:`, error);
      }
    }

    if (previousVersion === OPENTEAM_RUNTIME_PROTOCOL_VERSION) {
      return;
    }

    const sessionsDir = join(runtimeDir, 'sessions');
    if (existsSync(sessionsDir)) {
      rmSync(sessionsDir, { recursive: true, force: true });
      console.log(
        `[BackendAdapter] Reset runtime sessions for ${localId} ` +
        `(protocol ${previousVersion || 'none'} -> ${OPENTEAM_RUNTIME_PROTOCOL_VERSION})`
      );
    }

    writeFileSync(
      statePath,
      JSON.stringify(
        {
          version: OPENTEAM_RUNTIME_PROTOCOL_VERSION,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
  }

  private getRuntimeDir(localIdOrRuntimeId: string): string {
    const instance = getOpenTeamInstance();
    const runtimeId = localIdOrRuntimeId.includes('--')
      ? localIdOrRuntimeId
      : instance.getRuntimeAgentId(localIdOrRuntimeId);
    return join(this.runtimeWorkspaceDir, `workspace-${runtimeId}`);
  }

  private getLegacyRuntimeDir(localIdOrRuntimeId: string): string {
    const instance = getOpenTeamInstance();
    const runtimeId = localIdOrRuntimeId.includes('--')
      ? localIdOrRuntimeId
      : instance.getRuntimeAgentId(localIdOrRuntimeId);
    return join(this.legacyWorkspaceStateDir, `workspace-${runtimeId}`);
  }
}

// ============================================================================
// Factory
// ============================================================================

let adapterInstance: BackendAdapter | null = null;

export function getBackendAdapter(): BackendAdapter {
  if (!adapterInstance) {
    adapterInstance = new BackendAdapter();
  }
  return adapterInstance;
}

export async function initBackendAdapter(): Promise<BackendAdapter> {
  const adapter = getBackendAdapter();
  await adapter.init();
  return adapter;
}
