/**
 * Soul Store - OpenTeam 独立的 Agent 配置存储
 * 
 * 所有 agent 配置存储在 OpenTeam 目录下：
 * - agents/roles/{id}/soul.json - Agent 配置
 * - agents/roles/{id}/memory/ - 记忆文件
 * 
 * Agent Runtime 只是执行引擎，不存储任何配置。
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, cpSync } from 'fs';
import { join } from 'path';
import type { SoulConfig, RuntimeConfig, SkillConfig } from '../runtime/types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * AgentSoul - OpenTeam 存储的完整 Agent 配置
 */
export interface AgentSoul {
  /** Agent ID */
  id: string;
  /** 显示名称 */
  name?: string;
  /** 角色 */
  role?: string;

  /** 运行时配置 */
  runtime?: RuntimeConfig;

  /** 身份定义 */
  identity: string;
  /** 个性 */
  personality: string;
  /** 使命 */
  mission: string;
  /** 沟通方式 */
  communication: string;
  /** 约束 */
  constraints: string;
  /** 特征标签 */
  traits: string[];
}

/**
 * AgentInfo - Agent 列表项
 */
export interface AgentInfo {
  id: string;
  name?: string;
  role?: string;
  path: string;
  soulPath: string;
  soul: AgentSoul | null;
}

/**
 * MemoryInfo - Memory 文件信息
 */
export interface MemoryInfo {
  filename: string;
  path: string;
  content: string;
  modifiedAt: Date;
  size: number;
}

// ============================================================================
// SoulStore
// ============================================================================

/**
 * SoulStore - Agent 配置存储
 * 
 * 单例模式，所有配置操作都通过此 store 进行。
 */
export class SoulStore {
  private agentsRootDir: string;
  private agentsDir: string;
  private skillsDir: string;
  private legacyAgentsDir: string;
  private legacySkillsDir: string;
  
  constructor(baseDir: string) {
    this.agentsRootDir = join(baseDir, 'agents');
    this.agentsDir = join(this.agentsRootDir, 'roles');
    this.skillsDir = join(this.agentsRootDir, 'skills');
    this.legacyAgentsDir = this.agentsRootDir;
    this.legacySkillsDir = join(baseDir, 'skills');
  }
  
  // === 初始化 ===
  
  /**
   * 初始化存储目录
   */
  init(): void {
    if (!existsSync(this.agentsRootDir)) {
      mkdirSync(this.agentsRootDir, { recursive: true });
    }
    if (!existsSync(this.agentsDir)) {
      mkdirSync(this.agentsDir, { recursive: true });
    }
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
    if (existsSync(this.legacyAgentsDir) && this.legacyAgentsDir !== this.agentsDir) {
      for (const entry of readdirSync(this.legacyAgentsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name === 'roles' || entry.name === 'skills') {
          continue;
        }

        const sourcePath = join(this.legacyAgentsDir, entry.name);
        const sourceSoulPath = join(sourcePath, 'soul.json');
        if (!existsSync(sourceSoulPath)) {
          continue;
        }

        const targetPath = join(this.agentsDir, entry.name);
        if (!existsSync(targetPath)) {
          cpSync(sourcePath, targetPath, { recursive: true, force: false });
        }
      }
    }
    if (existsSync(this.legacySkillsDir) && this.legacySkillsDir !== this.skillsDir) {
      for (const entry of readdirSync(this.legacySkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const sourcePath = join(this.legacySkillsDir, entry.name);
        const targetPath = join(this.skillsDir, entry.name);
        if (!existsSync(targetPath)) {
          cpSync(sourcePath, targetPath, { recursive: true, force: false });
        }
      }
    }
    console.log(`[SoulStore] Initialized, agents dir: ${this.agentsDir}`);
  }
  
  // === Agent 管理 ===
  
  /**
   * 列出所有 agents
   */
  listAgents(): AgentInfo[] {
    if (!existsSync(this.agentsDir)) {
      return [];
    }
    
    const agents: AgentInfo[] = [];
    const dirs = readdirSync(this.agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    
    for (const id of dirs) {
      const info = this.getAgentInfo(id);
      if (info) agents.push(info);
    }
    
    return agents;
  }
  
  /**
   * 获取 agent 信息
   */
  getAgentInfo(id: string): AgentInfo | null {
    const agentDir = join(this.agentsDir, id);
    const soulPath = join(agentDir, 'soul.json');
    
    if (!existsSync(agentDir)) {
      return null;
    }
    
    let soul: AgentSoul | null = null;
    if (existsSync(soulPath)) {
      try {
        const content = readFileSync(soulPath, 'utf-8');
        soul = JSON.parse(content);
      } catch (e) {
        console.error(`[SoulStore] Failed to parse soul.json for ${id}:`, e);
      }
    }
    
    return {
      id,
      name: soul?.name,
      role: soul?.role,
      path: agentDir,
      soulPath: existsSync(soulPath) ? soulPath : '',
      soul,
    };
  }
  
  /**
   * 获取 agent soul 配置
   */
  getAgentSoul(id: string): AgentSoul | null {
    const info = this.getAgentInfo(id);
    return info?.soul || null;
  }
  
  /**
   * 创建 agent
   */
  createAgent(id: string, soul: AgentSoul): AgentInfo {
    const agentDir = join(this.agentsDir, id);
    
    if (existsSync(agentDir)) {
      throw new Error(`Agent ${id} already exists`);
    }
    
    // 创建目录
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(agentDir, 'memory'), { recursive: true });
    
    // 写入 soul.json
    const soulPath = join(agentDir, 'soul.json');
    writeFileSync(soulPath, JSON.stringify(soul, null, 2) + '\n', 'utf-8');
    
    console.log(`[SoulStore] Created agent: ${id}`);
    
    return this.getAgentInfo(id)!;
  }
  
  /**
   * 更新 agent soul
   */
  updateAgentSoul(id: string, soul: Partial<AgentSoul>): AgentInfo | null {
    const agentDir = join(this.agentsDir, id);
    
    if (!existsSync(agentDir)) {
      throw new Error(`Agent ${id} not found`);
    }
    
    // 读取现有配置
    const existing = this.getAgentSoul(id) || this.getDefaultSoul(id);
    
    // 合并更新
    const updated: AgentSoul = {
      ...existing,
      ...soul,
      id, // 确保 id 不变
    };
    
    // 写入
    const soulPath = join(agentDir, 'soul.json');
    writeFileSync(soulPath, JSON.stringify(updated, null, 2) + '\n', 'utf-8');
    
    console.log(`[SoulStore] Updated agent: ${id}`);
    
    return this.getAgentInfo(id);
  }
  
  /**
   * 更新 agent skills
   */
  updateAgentSkills(id: string, skills: string[]): AgentInfo | null {
    const soul = this.getAgentSoul(id);
    if (!soul) {
      throw new Error(`Agent ${id} not found`);
    }
    
    return this.updateAgentSoul(id, {
      runtime: {
        ...soul.runtime,
        skills,
      },
    });
  }
  
  /**
   * 删除 agent
   */
  deleteAgent(id: string): boolean {
    const agentDir = join(this.agentsDir, id);
    
    if (!existsSync(agentDir)) {
      return false;
    }
    
    rmSync(agentDir, { recursive: true });
    console.log(`[SoulStore] Deleted agent: ${id}`);
    
    return true;
  }
  
  /**
   * 检查 agent 是否存在
   */
  hasAgent(id: string): boolean {
    return existsSync(join(this.agentsDir, id));
  }
  
  // === Skill 管理 ===

  /**
   * 列出所有 skills
   */
  listSkills(): Array<{ id: string; path: string }> {
    if (!existsSync(this.skillsDir)) {
      return [];
    }

    return readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => ({
        id: d.name,
        path: join(this.skillsDir, d.name),
      }));
  }

  // === Memory 管理 ===

  /**
   * 获取 agent memory 目录
   */
  getAgentMemoryDir(id: string): string {
    return join(this.agentsDir, id, 'memory');
  }

  /**
   * 列出 agent 的所有 memory 文件
   */
  listAgentMemory(id: string): MemoryInfo[] {
    const memoryDir = this.getAgentMemoryDir(id);

    if (!existsSync(memoryDir)) {
      return [];
    }

    const files = readdirSync(memoryDir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => b.localeCompare(a)); // 按日期倒序

    return files.map(filename => {
      const filePath = join(memoryDir, filename);
      const stats = statSync(filePath);
      let content = '';

      try {
        content = readFileSync(filePath, 'utf-8');
      } catch (e) {
        console.error(`[SoulStore] Failed to read memory file ${filename}:`, e);
      }

      return {
        filename,
        path: filePath,
        content,
        modifiedAt: stats.mtime,
        size: stats.size,
      };
    });
  }

  /**
   * 获取单个 memory 文件
   */
  getAgentMemoryFile(id: string, filename: string): MemoryInfo | null {
    const filePath = join(this.getAgentMemoryDir(id), filename);

    if (!existsSync(filePath)) {
      return null;
    }

    const stats = statSync(filePath);

    return {
      filename,
      path: filePath,
      content: readFileSync(filePath, 'utf-8'),
      modifiedAt: stats.mtime,
      size: stats.size,
    };
  }

  /**
   * 写入 memory 文件
   */
  writeAgentMemory(id: string, filename: string, content: string): MemoryInfo {
    const memoryDir = this.getAgentMemoryDir(id);

    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    const filePath = join(memoryDir, filename);
    writeFileSync(filePath, content, 'utf-8');

    console.log(`[SoulStore] Wrote memory file: ${id}/${filename}`);

    return this.getAgentMemoryFile(id, filename)!;
  }

  /**
   * 删除 memory 文件
   */
  deleteAgentMemory(id: string, filename: string): boolean {
    const filePath = join(this.getAgentMemoryDir(id), filename);

    if (!existsSync(filePath)) {
      return false;
    }

    rmSync(filePath);
    console.log(`[SoulStore] Deleted memory file: ${id}/${filename}`);
    return true;
  }
  
  // === 工具方法 ===
  
  /**
   * 获取默认 soul 配置
   */
  getDefaultSoul(id: string): AgentSoul {
    return {
      id,
      name: id,
      role: 'Agent',
      runtime: {
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        language: 'zh-CN',
        skills: [],
      },
      identity: `我是 ${id}，一个 AI Agent。`,
      personality: '专业、高效、协作。',
      mission: '帮助用户完成任务。',
      communication: '清晰简洁，结构化输出。',
      constraints: '不做超出职责范围的事。',
      traits: ['团队协作', '专业高效'],
    };
  }
  
  /**
   * 获取 agents/roles 目录
   */
  getAgentsDir(): string {
    return this.agentsDir;
  }
  
  /**
   * 获取 skills 目录
   */
  getSkillsDir(): string {
    return this.skillsDir;
  }
}

// ============================================================================
// Singleton
// ============================================================================

let storeInstance: SoulStore | null = null;

/**
 * 获取 SoulStore 实例
 */
export function getSoulStore(): SoulStore {
  if (!storeInstance) {
    // 默认使用 OpenTeam 项目根目录
    const baseDir = process.env.OPENTEAM_DIR || process.cwd();
    storeInstance = new SoulStore(baseDir);
    storeInstance.init();
  }
  return storeInstance;
}

/**
 * 初始化 SoulStore
 */
export function initSoulStore(baseDir: string): SoulStore {
  storeInstance = new SoulStore(baseDir);
  storeInstance.init();
  return storeInstance;
}
