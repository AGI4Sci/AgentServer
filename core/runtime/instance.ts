/**
 * OpenTeam Instance - 实例 ID 管理
 * 
 * 用于隔离并发运行的多个 OpenTeam 项目。
 * 每个项目实例生成唯一的实例 ID，用于：
 * 1. 生成 OpenClaw sessionKey
 * 2. 隔离运行时缓存目录
 * 3. 防止消息混淆
 * 
 * 实例 ID 格式: {projectName}-{port}-{suffix}
 * 例如: my-app-3456-a1b2c3d4
 * 
 * 重要：实例 ID 会持久化到 .instance-id 文件，确保重启后保持一致。
 */

import { randomBytes } from 'crypto';
import { basename } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { resolveConfiguredServerPort } from '../../server/utils/openteam-config.js';

export class OpenTeamInstance {
  private readonly instanceId: string;
  private readonly projectName: string;
  private readonly port: string;
  
  constructor() {
    this.projectName = this.sanitizeProjectName(this.deriveProjectName());
    this.port = String(resolveConfiguredServerPort());
    this.instanceId = this.getOrCreateInstanceId();
    
    console.log(`[Instance] Instance ID: ${this.instanceId}`);
  }
  
  /**
   * 获取或创建实例 ID
   * 
   * 优先从持久化文件读取，确保重启后保持一致。
   */
  private getOrCreateInstanceId(): string {
    const instanceIdPath = this.getInstanceIdPath();
    
    // 尝试读取已存在的实例 ID
    if (existsSync(instanceIdPath)) {
      try {
        const savedId = readFileSync(instanceIdPath, 'utf-8').trim();
        if (savedId && savedId.startsWith(`${this.projectName}-${this.port}-`)) {
          console.log(`[Instance] Restored instance ID from ${instanceIdPath}`);
          return savedId;
        }
      } catch (e) {
        console.warn(`[Instance] Failed to read instance ID:`, e);
      }
    }
    
    // 创建新的实例 ID
    const suffix = randomBytes(4).toString('hex');
    const newId = `${this.projectName}-${this.port}-${suffix}`;
    
    // 持久化
    try {
      const dir = dirname(instanceIdPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(instanceIdPath, newId, 'utf-8');
      console.log(`[Instance] Saved instance ID to ${instanceIdPath}`);
    } catch (e) {
      console.warn(`[Instance] Failed to save instance ID:`, e);
    }
    
    return newId;
  }
  
  /**
   * 获取实例 ID 持久化文件路径
   */
  private getInstanceIdPath(): string {
    // 使用项目目录下的 .instance-id 文件
    const projectDir = process.env.OPENTEAM_DIR || process.cwd();
    return join(projectDir, '.instance-id');
  }
  
  /**
   * 获取实例 ID
   */
  getInstanceId(): string {
    return this.instanceId;
  }
  
  /**
   * 获取项目名称
   */
  getProjectName(): string {
    return this.projectName;
  }
  
  /**
   * 获取端口
   */
  getPort(): string {
    return this.port;
  }
  
  /**
   * 生成 OpenClaw sessionKey
   * 默认格式: agent:{instanceId}--{localAgentId}:main
   * 若提供 lane，则格式: agent:{instanceId}--{localAgentId}:{lane}
   * 
   * 例如: agent:my-app-3456-a1b2--pm-01:main
   */
  getSessionKey(localAgentId: string, lane: string = 'main'): string {
    const runtimeAgentId = this.getRuntimeAgentId(localAgentId);
    return `agent:${runtimeAgentId}:${lane}`;
  }
  
  /**
   * 获取运行时 Agent ID
   * 格式: {instanceId}--{localAgentId}
   * 
   * 例如: my-app-3456-a1b2--pm-01
   */
  getRuntimeAgentId(localAgentId: string): string {
    return `${this.instanceId}--${localAgentId}`;
  }
  
  /**
   * 从 sessionKey 解析本地 Agent ID
   * 
   * 支持两种格式：
   * - 格式 1 (我们生成): agent:{runtimeId}:main → agent:openteam-studio-3456-a1b2--pm-01:main
   * - 格式 2 (OpenClaw 返回): agent:main:{runtimeId} → agent:main:openteam-studio-3456-a1b2--pm-01
   * 
   * 输出: pm-01
   */
  parseLocalId(sessionKey: string): string | null {
    if (!sessionKey) return null;
    
    // 格式: agent:{part1}:{part2}
    const parts = sessionKey.split(':');
    if (parts.length < 3 || parts[0] !== 'agent') {
      // 旧格式兼容：agent:{runtimeId}（只有两部分）
      if (parts.length === 2 && parts[0] === 'agent') {
        const runtimeId = parts[1];
        const dashIndex = runtimeId.indexOf('--');
        if (dashIndex !== -1) {
          return runtimeId.slice(dashIndex + 2);
        }
        return runtimeId;
      }
      return null;
    }
    
    // 判断格式
    let runtimeId: string;
    if (parts[1] === 'main') {
      // 格式 2: agent:main:{runtimeId}
      runtimeId = parts[2];
    } else {
      // 格式 1: agent:{runtimeId}:main
      runtimeId = parts[1];
    }
    
    // 格式: {instanceId}--{localId}
    const dashIndex = runtimeId.indexOf('--');
    if (dashIndex === -1) {
      // 可能是旧格式（没有实例前缀）
      return runtimeId;
    }
    
    return runtimeId.slice(dashIndex + 2);
  }
  
  /**
   * 从 sessionKey 解析完整运行时 ID
   * 
   * 支持两种格式：
   * - 格式 1 (我们生成): agent:{runtimeId}:main
   * - 格式 2 (OpenClaw 返回): agent:main:{runtimeId}
   * 
   * 输出: my-app-3456-a1b2--pm-01
   */
  parseRuntimeId(sessionKey: string): string | null {
    if (!sessionKey) return null;
    
    const parts = sessionKey.split(':');
    if (parts.length < 3 || parts[0] !== 'agent') {
      // 旧格式兼容
      if (parts.length === 2 && parts[0] === 'agent') {
        return parts[1];
      }
      return null;
    }
    
    // 判断格式
    if (parts[1] === 'main') {
      // 格式 2: agent:main:{runtimeId}
      return parts[2];
    } else {
      // 格式 1: agent:{runtimeId}:main
      return parts[1];
    }
  }
  
  /**
   * 检查 sessionKey 是否属于当前实例
   */
  isLocalSession(sessionKey: string): boolean {
    const runtimeId = this.parseRuntimeId(sessionKey);
    if (!runtimeId) return false;
    
    // 检查是否以当前实例 ID 开头
    return runtimeId.startsWith(this.instanceId + '--');
  }
  
  // === 私有方法 ===
  
  /**
   * 推导项目名称
   */
  private deriveProjectName(): string {
    // 1. 环境变量优先
    if (process.env.OPENTEAM_PROJECT_NAME) {
      return process.env.OPENTEAM_PROJECT_NAME;
    }
    
    // 2. 从 OPENTEAM_DIR 推导
    if (process.env.OPENTEAM_DIR) {
      return basename(process.env.OPENTEAM_DIR);
    }
    
    // 3. 从当前工作目录推导
    return basename(process.cwd());
  }
  
  /**
   * 清理项目名称（只保留字母、数字、连字符）
   */
  private sanitizeProjectName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'openteam';
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: OpenTeamInstance | null = null;

/**
 * 获取 OpenTeam 实例（单例）
 */
export function getOpenTeamInstance(): OpenTeamInstance {
  if (!instance) {
    instance = new OpenTeamInstance();
  }
  return instance;
}

/**
 * 重置实例（用于测试）
 */
export function resetInstance(): void {
  instance = null;
}
