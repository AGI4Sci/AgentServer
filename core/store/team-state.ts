/**
 * OpenTeam Studio - Team State Manager
 * Team 运行时状态管理
 * 
 * Team 定义与项目数据存储在项目目录 teams/
 * Agent 定义从项目内 agents/ 加载
 */

import type { TeamDef, AgentDef, ProjectDef, TeamManifest, SoulConfig } from '../types/index.js';
import type { TeamConfig } from '../team/types.js';
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { parseSoulMd } from '../../server/utils/soul-parser.js';
import { TEAMS_DIR, AGENTS_DIR } from '../../server/utils/paths.js';

export class TeamStateManager {
  private teams: Map<string, TeamDef> = new Map();

  constructor() {
    this.ensureDirs();
  }

  /**
   * 确保目录存在
   */
  private ensureDirs(): void {
    if (!existsSync(AGENTS_DIR)) {
      mkdirSync(AGENTS_DIR, { recursive: true });
    }
    if (!existsSync(TEAMS_DIR)) {
      mkdirSync(TEAMS_DIR, { recursive: true });
    }
  }

  /**
   * 扫描并加载所有 Team
   * 
   * 目录结构：
   * teams/{teamId}/
   *   ├── manifest.json
   *   ├── team.config.json
   *   └── projects/         # 项目运行数据
   */
  async discoverTeams(): Promise<TeamDef[]> {
    this.ensureDirs();

    if (!existsSync(TEAMS_DIR)) {
      console.log(`[TeamState] Teams directory not found: ${TEAMS_DIR}`);
      return [];
    }

    const teamDirs = readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const teams: TeamDef[] = [];

    for (const teamId of teamDirs) {
      const teamConfigPath = join(TEAMS_DIR, teamId, 'team.config.json');
      const manifestPath = join(TEAMS_DIR, teamId, 'manifest.json');

      if (existsSync(teamConfigPath) || existsSync(manifestPath)) {
        try {
          const { manifest, agents } = existsSync(teamConfigPath)
            ? this.loadTeamFromConfig(teamConfigPath)
            : this.loadTeamFromManifest(manifestPath);

          const team: TeamDef = {
            id: manifest.id,
            name: manifest.name,
            type: manifest.type,
            icon: manifest.icon,
            description: manifest.description,
            manifest,
            agents,
            projects: this.loadProjects(teamId),
          };
          
          this.teams.set(teamId, team);
          teams.push(team);
          console.log(`[TeamState] Loaded team: ${team.name} (${teamId}) with ${agents.length} agents`);
        } catch (err) {
          console.error(`[TeamState] Failed to load team ${teamId}:`, err);
        }
      }
    }

    return teams;
  }

  private loadTeamFromManifest(manifestPath: string): { manifest: TeamManifest; agents: AgentDef[] } {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as TeamManifest;
    const agents = this.loadAgents(Array.isArray(manifest.agents) ? manifest.agents : []);
    return { manifest, agents };
  }

  private loadTeamFromConfig(teamConfigPath: string): { manifest: TeamManifest; agents: AgentDef[] } {
    const config = JSON.parse(readFileSync(teamConfigPath, 'utf-8')) as TeamConfig;
    const agentRefs = Array.isArray(config.members)
      ? config.members.map(member => ({
          id: member.id,
          role: member.roleName,
          name: member.name,
          model: member.model,
          skills: member.skills,
        }))
      : [];

    const manifest: TeamManifest = {
      id: config.id,
      name: config.name,
      type: 'ops',
      icon: '🧩',
      description: config.description || '',
      agents: agentRefs,
    };

    const agents = this.loadAgents(agentRefs);
    return { manifest, agents };
  }

  /**
   * 从 manifest 加载 agent 定义
   * 支持两种格式：
   * - 字符串: "pm-01" - 从项目内 agents/ 加载
   * - 对象: { id: "pm-01", role: "PM", ... } - 使用 manifest 中定义的配置
   */
  private loadAgents(agentDefs: Array<string | { id: string; role?: string; name?: string; model?: string; skills?: string[] }> | undefined): AgentDef[] {
    const agents: AgentDef[] = [];

    if (!Array.isArray(agentDefs) || agentDefs.length === 0) {
      return agents;
    }

    for (const agentDef of agentDefs) {
      // 支持字符串和对象两种格式
      const agentId = typeof agentDef === 'string' ? agentDef : agentDef.id;
      const manifestConfig = typeof agentDef === 'object' ? agentDef : null;
      
      // 尝试从项目内 agents/ 加载
      const loadedAgent = this.loadAgent(agentId);
      
      if (loadedAgent) {
        // 如果 manifest 中有配置，合并覆盖
        if (manifestConfig) {
          loadedAgent.role = manifestConfig.role || loadedAgent.role;
          loadedAgent.name = manifestConfig.name || loadedAgent.name;
          loadedAgent.model = manifestConfig.model || loadedAgent.model;
          loadedAgent.skills = manifestConfig.skills || loadedAgent.skills;
        }
        agents.push(loadedAgent);
      } else if (manifestConfig) {
        // 如果 agent 目录不存在，但 manifest 中有完整配置，创建虚拟 agent
        agents.push({
          id: agentId,
          teamId: '',
          role: manifestConfig.role || 'Agent',
          name: manifestConfig.name || agentId,
          soul: this.getDefaultSoulConfig(),
          skills: manifestConfig.skills || [],
          model: manifestConfig.model || 'claude-sonnet-4-6',
          status: 'idle',
        });
        console.log(`[TeamState] Created virtual agent from manifest: ${agentId}`);
      } else {
        console.warn(`[TeamState] Agent not found: ${agentId}`);
      }
    }

    return agents;
  }

  /**
   * 加载单个 agent（从项目内 agents/ 目录）
   */
  private loadAgent(agentId: string): AgentDef | undefined {
    const agentDir = join(AGENTS_DIR, agentId);
    
    if (!existsSync(agentDir)) {
      return undefined;
    }

    const soulPath = join(agentDir, 'SOUL.md');
    let soulConfig = this.loadSoulConfig(soulPath);

    return {
      id: agentId,
      teamId: '',  // Agent 可以属于多个 team，这里不绑定
      role: soulConfig?.role || 'Agent',
      name: soulConfig?.name || agentId,
      soul: soulConfig || this.getDefaultSoulConfig(),
      skills: [],  // TODO: 从 agent 配置读取
      model: soulConfig?.model || 'claude-sonnet-4-6',
      status: 'idle',
    };
  }

  /**
   * 加载项目列表
   */
  private loadProjects(teamId: string): ProjectDef[] {
    const projectsDir = join(TEAMS_DIR, teamId, 'projects');
    
    if (!existsSync(projectsDir)) {
      return [];
    }

    const projects: ProjectDef[] = [];
    const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const projectId of projectDirs) {
      projects.push({
        id: projectId,
        name: projectId,  // TODO: 从项目配置读取
        teamId,
        path: join(projectsDir, projectId),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return projects;
  }

  /**
   * 获取 Team
   */
  getTeam(teamId: string): TeamDef | undefined {
    return this.teams.get(teamId);
  }

  /**
   * 获取所有 Team
   */
  getAllTeams(): TeamDef[] {
    return Array.from(this.teams.values());
  }

  /**
   * 获取 Agent 定义（从项目内 agents 目录）
   */
  getAgent(_teamId: string, agentId: string): AgentDef | undefined {
    return this.loadAgent(agentId);
  }

  /**
   * 获取 Team 所有 Agent
   * 直接返回已加载的 agents，而不是重新加载
   */
  getTeamAgents(teamId: string): AgentDef[] {
    const team = this.teams.get(teamId);
    if (!team) return [];

    // 返回已加载的 agents
    return team.agents;
  }

  /**
   * 创建项目
   */
  createProject(teamId: string, name: string): ProjectDef {
    const team = this.teams.get(teamId);
    if (!team) throw new Error(`Team not found: ${teamId}`);

    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const projectPath = join(TEAMS_DIR, teamId, 'projects', projectId);
    
    mkdirSync(projectPath, { recursive: true });

    const project: ProjectDef = {
      id: projectId,
      name,
      teamId,
      path: projectPath,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    team.projects.push(project);
    return project;
  }

  /**
   * 获取 Team 项目列表
   */
  getTeamProjects(teamId: string): ProjectDef[] {
    const team = this.teams.get(teamId);
    return team?.projects || [];
  }

  /**
   * 加载 SOUL.md 配置
   */
  private loadSoulConfig(soulPath: string): SoulConfig | undefined {
    if (!existsSync(soulPath)) {
      return undefined;
    }

    try {
      const content = readFileSync(soulPath, 'utf-8');
      return parseSoulMd(content);
    } catch {
      return undefined;
    }
  }

  /**
   * 默认 SOUL 配置
   */
  private getDefaultSoulConfig(): SoulConfig {
    return {
      identity: '我是一个 AI 助手',
      personality: '专业、友好、高效',
      mission: '帮助用户完成任务',
      communication: '清晰简洁',
      constraints: '不做超出职责范围的事',
      traits: [],
      language: 'zh-CN',
      temperature: 0.7,
    };
  }

  /**
   * 获取数据目录路径
   */
  static getTeamsDir(): string {
    return TEAMS_DIR;
  }

  static getAgentsDir(): string {
    return AGENTS_DIR;
  }
}

// 单例
let teamStateManager: TeamStateManager | null = null;

export function getTeamStateManager(): TeamStateManager {
  if (!teamStateManager) {
    teamStateManager = new TeamStateManager();
  }
  return teamStateManager;
}
