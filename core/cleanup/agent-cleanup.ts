/**
 * Agent Cleanup - 安全清理 team runtime workspace 目录
 *
 * 清理规则：
 * 1. 只操作共享 team runtime workspace（runtime_supervisor/openteam-local/team-workspaces）
 *    并兼容旧的 openclaw/openteam-local/workspace-* 目录
 * 2. 只清理 workspace-{runtimeAgentId} 形式的目录
 * 3. 默认仅清理：
 *    - 不是当前 runtime transport 正在使用的 cwd
 *    - 超过保护期的旧目录
 *
 * 安全边界：
 * - 不动项目目录下的 agents（长期存储）
 * - 不动当前 runtime transport 正在使用的 cwd
 */

import { readdirSync, rmSync, existsSync, lstatSync, statSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getBackendStateDir, getSharedTeamRuntimeDir } from '../runtime/backend-paths.js';
import {
  DEFAULT_WORKSPACE_LEASE_TTL_MS,
  isProcessAlive,
  isWorkspaceLeaseFresh,
  readWorkspaceLease,
} from '../runtime/runtime-workspace-lease.js';

export interface CleanupResult {
  total: number;
  cleaned: number;
  retained: number;
  errors: string[];
  details: Array<{
    agentId: string;
    port: number | null;
    projectRunning: boolean;
    action: 'cleaned' | 'retained' | 'error';
    reason: string;
  }>;
}

export interface CleanupOptions {
  dryRun?: boolean;      // 只报告，不实际删除
  projectPrefix?: string; // 只清理特定项目前缀的 agent
  verbose?: boolean;
  minAgeMs?: number;     // 目录最小年龄，低于该值不清理
  leaseTtlMs?: number;
}

/**
 * 从 agent ID 解析端口号
 * 
 * 格式: {projectName}-{port}-{suffix}--{localAgentId}
 * 例如: openteam-studio-3456-62aedc70--dev-01
 *              端口^^^
 */
export function parsePortFromAgentId(agentId: string): number | null {
  // 匹配格式: {name}-{port}-{suffix}--{localId}
  const match = agentId.match(/-(\d{4,5})-[a-f0-9]+--/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * 检测端口是否有进程监听
 */
export function isPortListening(port: number): boolean {
  try {
    // macOS 上 lsof 可能不在 PATH 中，尝试多个路径
    const lsofPaths = ['lsof', '/usr/sbin/lsof', '/usr/local/sbin/lsof'];
    let result = '';
    
    for (const lsofPath of lsofPaths) {
      try {
        result = execSync(`${lsofPath} -i :${port} -t -sTCP:LISTEN 2>/dev/null`, {
          encoding: 'utf-8',
          timeout: 5000,
        }).trim();
        break; // 成功则跳出
      } catch {
        // 尝试下一个路径
        continue;
      }
    }
    
    return result.length > 0;
  } catch {
    // 所有路径都失败
    return false;
  }
}

/**
 * 获取共享 runtime workspace 根目录
 */
export function getSharedRuntimeWorkspaceDir(): string {
  return getSharedTeamRuntimeDir();
}

export function getLegacyRuntimeWorkspaceDir(): string {
  return getBackendStateDir('openclaw');
}

function getRuntimeTransportPort(): number {
  return 18789;
}

function getListeningPid(port: number): number | null {
  try {
    const output = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN -n -P 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    if (!output) {
      return null;
    }

    const first = output.split('\n')[0]?.trim();
    if (!first) {
      return null;
    }

    const pid = Number.parseInt(first, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function getProcessCwd(pid: number): string | null {
  try {
    const output = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();

    const cwdLine = output
      .split('\n')
      .find((line) => line.startsWith('n'));

    return cwdLine ? cwdLine.slice(1) : null;
  } catch {
    return null;
  }
}

function getRuntimeTransportCwd(): string | null {
  const transportPid = getListeningPid(getRuntimeTransportPort());
  if (!transportPid) {
    return null;
  }
  return getProcessCwd(transportPid);
}

/**
 * 扫描并清理 agent 目录
 */
export function cleanupAgents(options: CleanupOptions = {}): CleanupResult {
  const {
    dryRun = false,
    projectPrefix,
    verbose = false,
    minAgeMs = 6 * 60 * 60 * 1000,
    leaseTtlMs = DEFAULT_WORKSPACE_LEASE_TTL_MS,
  } = options;
  
  const result: CleanupResult = {
    total: 0,
    cleaned: 0,
    retained: 0,
    errors: [],
    details: [],
  };
  
  const runtimeTransportCwd = getRuntimeTransportCwd();
  const agentsDirs = [getSharedRuntimeWorkspaceDir(), getLegacyRuntimeWorkspaceDir()];

  for (const agentsDir of agentsDirs) {
    if (!existsSync(agentsDir)) {
      continue;
    }

    let entries;
    try {
      entries = readdirSync(agentsDir, { withFileTypes: true });
    } catch (err) {
      result.errors.push(`Failed to read agents directory ${agentsDir}: ${err}`);
      continue;
    }

    for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    const workspaceName = entry.name;
    if (!workspaceName.startsWith('workspace-')) {
      continue;
    }
    const agentId = workspaceName.slice('workspace-'.length);
    
    // 如果指定了项目前缀，只处理匹配的
    if (projectPrefix && !agentId.startsWith(projectPrefix)) {
      continue;
    }
    
    // 排除系统 agent（main, debug-single 等）
    if (!agentId.includes('--')) {
      // 单段名称，可能是系统 agent，跳过
      continue;
    }
    
    result.total++;
    
    const agentPath = join(agentsDir, workspaceName);
    const port = parsePortFromAgentId(agentId);
    const runtimeTransportUsingDir = Boolean(
      runtimeTransportCwd && (runtimeTransportCwd === agentPath || runtimeTransportCwd.startsWith(agentPath + '/'))
    );
    const lease = readWorkspaceLease(agentPath);
    const freshLease = isWorkspaceLeaseFresh(lease, leaseTtlMs);
    const liveLeaseOwner = lease ? isProcessAlive(lease.pid) : false;

    let ageMs: number;
    try {
      ageMs = Date.now() - statSync(agentPath).mtimeMs;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missingWorkspace = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      result.retained++;
      result.details.push({
        agentId,
        port,
        projectRunning: port === null ? false : isPortListening(port),
        action: 'retained',
        reason: `Workspace vanished before cleanup: ${message}`,
      });

      if (verbose && !missingWorkspace) {
        console.warn(`[Cleanup] Skip ${agentId}: workspace vanished before cleanup`);
      }
      continue;
    }
    
    // 无法解析端口的 agent（可能是旧格式），保守起见保留
    if (port === null) {
      result.retained++;
      result.details.push({
        agentId,
        port: null,
        projectRunning: false,
        action: 'retained',
        reason: 'Cannot parse port from agent ID',
      });
      continue;
    }

    if (runtimeTransportUsingDir) {
      result.retained++;
      result.details.push({
        agentId,
        port,
        projectRunning: true,
        action: 'retained',
        reason: 'Runtime transport cwd is inside this workspace',
      });
      continue;
    }

    if (freshLease && liveLeaseOwner) {
      result.retained++;
      result.details.push({
        agentId,
        port,
        projectRunning: true,
        action: 'retained',
        reason: `Fresh workspace lease held by pid ${lease?.pid}`,
      });
      continue;
    }

    if (ageMs < minAgeMs) {
      result.retained++;
      result.details.push({
        agentId,
        port,
        projectRunning: isPortListening(port),
        action: 'retained',
        reason: `Younger than protection window (${Math.round(minAgeMs / 60000)} min)`,
      });
      continue;
    }
    
    const projectRunning = isPortListening(port);
    const cleanReason = lease && !liveLeaseOwner
      ? `Expired workspace lease from dead pid ${lease.pid}`
      : projectRunning
        ? `Unreferenced stale workspace while port ${port} is in use`
        : `Port ${port} is not in use`;

    if (dryRun) {
      result.details.push({
        agentId,
        port,
        projectRunning,
        action: 'cleaned',
        reason: `${cleanReason} (dry run)`,
      });

      if (verbose) {
        console.log(`[Cleanup] Would clean ${agentId} (${cleanReason})`);
      }
    } else {
      try {
        rmSync(agentPath, { recursive: true, force: true });
        result.cleaned++;
        result.details.push({
          agentId,
          port,
          projectRunning,
          action: 'cleaned',
          reason: cleanReason,
        });

        if (verbose) {
          console.log(`[Cleanup] Cleaned ${agentId} (${cleanReason})`);
        }
      } catch (err) {
        result.errors.push(`Failed to clean ${agentId}: ${err}`);
        result.details.push({
          agentId,
          port,
          projectRunning,
          action: 'error',
          reason: `Failed to clean: ${err}`,
        });
      }
    }
    }
  }
  
  return result;
}

export function runSafeAgentGc(options: CleanupOptions = {}): CleanupResult {
  return cleanupAgents(options);
}

/**
 * 获取 agent 目录统计信息
 */
export function getAgentStats(): {
  total: number;
  byProject: Record<string, number>;
  orphaned: string[];
} {
  const agentsDir = getSharedRuntimeWorkspaceDir();
  const legacyAgentsDir = getLegacyRuntimeWorkspaceDir();

  if (!existsSync(agentsDir) && !existsSync(legacyAgentsDir)) {
    return { total: 0, byProject: {}, orphaned: [] };
  }

  const entries = [
    ...(existsSync(agentsDir) ? readdirSync(agentsDir, { withFileTypes: true }) : []),
    ...(existsSync(legacyAgentsDir) ? readdirSync(legacyAgentsDir, { withFileTypes: true }) : []),
  ];
  const byProject: Record<string, number> = {};
  const orphaned: string[] = [];
  
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    
    if (!entry.name.startsWith('workspace-')) {
      continue;
    }
    const agentId = entry.name.slice('workspace-'.length);
    
    // 解析项目前缀（第一个 -- 之前的部分，去掉最后的 --{localId}）
    const dashIndex = agentId.indexOf('--');
    if (dashIndex === -1) {
      // 单段名称，可能是系统 agent
      continue;
    }
    
    const instanceId = agentId.slice(0, dashIndex);
    // instanceId 格式: {project}-{port}-{suffix}
    // 提取项目名（去掉端口和后缀）
    const portMatch = instanceId.match(/^(.+)-(\d{4,5})-[a-f0-9]+$/);
    
    if (portMatch) {
      const projectName = portMatch[1];
      byProject[projectName] = (byProject[projectName] || 0) + 1;
      
      // 检查是否是孤儿（端口无进程）
      const port = parseInt(portMatch[2], 10);
      if (!isPortListening(port)) {
        orphaned.push(agentId);
      }
    }
  }
  
  return {
    total: entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('workspace-') && entry.name.includes('--')).length,
    byProject,
    orphaned,
  };
}
