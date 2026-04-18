/**
 * Agent Cleanup API
 * 
 * 清理 OpenClaw agents 目录下的残余文件
 * 
 * 端点：
 * - GET /api/cleanup/agents - 获取统计信息
 * - POST /api/cleanup/agents - 执行清理
 */

import { IncomingMessage, ServerResponse } from 'http';
import { cleanupAgents, getAgentStats, type CleanupOptions } from '../../core/cleanup/agent-cleanup.js';

export async function handleCleanupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  teamsDir: string
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  // GET /api/cleanup/agents - 获取统计信息
  if (url === '/api/cleanup/agents' && method === 'GET') {
    return handleGetStats(req, res);
  }

  // POST /api/cleanup/agents - 执行清理
  if (url === '/api/cleanup/agents' && method === 'POST') {
    return handleCleanup(req, res);
  }

  return false;
}

/**
 * GET /api/cleanup/agents
 * 获取 agent 目录统计信息
 */
async function handleGetStats(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const stats = getAgentStats();
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      ...stats,
      message: stats.orphaned.length > 0 
        ? `Found ${stats.orphaned.length} orphaned agent(s) that can be cleaned`
        : 'No orphaned agents found',
    }));
    
    return true;
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
    return true;
  }
}

/**
 * POST /api/cleanup/agents
 * 执行清理
 * 
 * Body:
 * - dryRun: boolean - 只报告，不实际删除（默认 true）
 * - projectPrefix: string - 只清理特定项目前缀的 agent
 */
async function handleCleanup(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        let options: CleanupOptions = { dryRun: true }; // 默认 dryRun
        
        if (body.trim()) {
          const data = JSON.parse(body);
          options = {
            dryRun: data.dryRun !== false, // 默认 true，除非明确设为 false
            projectPrefix: data.projectPrefix,
            verbose: true,
          };
        }

        const result = cleanupAgents(options);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          dryRun: options.dryRun,
          ...result,
          message: options.dryRun
            ? `Dry run: would clean ${result.cleaned} agent(s), retain ${result.retained}`
            : `Cleaned ${result.cleaned} agent(s), retained ${result.retained}`,
        }));
        
        resolve(true);
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
        resolve(true);
      }
    });
  });
}
