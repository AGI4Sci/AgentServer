/**
 * Memory API 路由
 * 管理 Agent 的 memory 文件（通过 SoulStore，无硬编码）
 */

import { IncomingMessage, ServerResponse } from 'http';
import { success, error, sendJson } from '../utils/response.js';
import { getSoulStore, type MemoryInfo } from '../../core/store/soul-store.js';

// ============================================================================
// Route Handler
// ============================================================================

/**
 * 处理 Memory API 请求
 */
export async function handleMemoryRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // GET /api/agents/:id/memory - 列出所有 memory 文件
  const listMatch = url.match(/^\/api\/agents\/([^/]+)\/memory$/);
  if (listMatch && method === 'GET') {
    await handleListMemory(req, res, listMatch[1]);
    return true;
  }

  // GET /api/agents/:id/memory/:filename - 获取单个 memory 文件
  const getMatch = url.match(/^\/api\/agents\/([^/]+)\/memory\/([^/]+)$/);
  if (getMatch && method === 'GET') {
    await handleGetMemory(req, res, getMatch[1], getMatch[2]);
    return true;
  }

  // PUT /api/agents/:id/memory/:filename - 更新/创建 memory 文件
  if (getMatch && method === 'PUT') {
    await handleWriteMemory(req, res, getMatch[1], getMatch[2]);
    return true;
  }

  // DELETE /api/agents/:id/memory/:filename - 删除 memory 文件
  if (getMatch && method === 'DELETE') {
    await handleDeleteMemory(req, res, getMatch[1], getMatch[2]);
    return true;
  }

  return false;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/agents/:id/memory - 列出所有 memory 文件
 */
async function handleListMemory(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();

    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    const memories = store.listAgentMemory(agentId);

    sendJson(res, 200, success({
      agentId,
      memories: memories.map(m => ({
        filename: m.filename,
        path: m.path,
        modifiedAt: m.modifiedAt.toISOString(),
        size: m.size,
        preview: m.content.slice(0, 200),
      })),
    }));
  } catch (err) {
    console.error('[API] Failed to list memory:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * GET /api/agents/:id/memory/:filename - 获取单个 memory 文件
 */
async function handleGetMemory(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  filename: string
): Promise<void> {
  try {
    const store = getSoulStore();

    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    // 安全检查：只允许 .md 文件
    if (!filename.endsWith('.md')) {
      sendJson(res, 400, error('Only .md files are allowed'));
      return;
    }

    // 防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/')) {
      sendJson(res, 400, error('Invalid filename'));
      return;
    }

    const memory = store.getAgentMemoryFile(agentId, filename);

    if (!memory) {
      sendJson(res, 404, error('Memory file not found'));
      return;
    }

    sendJson(res, 200, success({
      agentId,
      filename: memory.filename,
      path: memory.path,
      content: memory.content,
      modifiedAt: memory.modifiedAt.toISOString(),
      size: memory.size,
    }));
  } catch (err) {
    console.error('[API] Failed to get memory:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * PUT /api/agents/:id/memory/:filename - 更新/创建 memory 文件
 */
async function handleWriteMemory(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  filename: string
): Promise<void> {
  try {
    const store = getSoulStore();

    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    // 安全检查：只允许 .md 文件
    if (!filename.endsWith('.md')) {
      sendJson(res, 400, error('Only .md files are allowed'));
      return;
    }

    // 防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/')) {
      sendJson(res, 400, error('Invalid filename'));
      return;
    }

    const body = await readBody(req);
    const { content } = JSON.parse(body);

    if (typeof content !== 'string') {
      sendJson(res, 400, error('content must be a string'));
      return;
    }

    const memory = store.writeAgentMemory(agentId, filename, content);

    console.log(`[API] Wrote memory: ${agentId}/${filename}`);
    sendJson(res, 200, success({
      agentId,
      filename: memory.filename,
      path: memory.path,
      modifiedAt: memory.modifiedAt.toISOString(),
      size: memory.size,
    }));
  } catch (err) {
    console.error('[API] Failed to write memory:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * DELETE /api/agents/:id/memory/:filename - 删除 memory 文件
 */
async function handleDeleteMemory(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string,
  filename: string
): Promise<void> {
  try {
    const store = getSoulStore();

    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    // 安全检查：只允许 .md 文件
    if (!filename.endsWith('.md')) {
      sendJson(res, 400, error('Only .md files are allowed'));
      return;
    }

    // 防止路径遍历攻击
    if (filename.includes('..') || filename.includes('/')) {
      sendJson(res, 400, error('Invalid filename'));
      return;
    }

    const deleted = store.deleteAgentMemory(agentId, filename);

    if (!deleted) {
      sendJson(res, 404, error('Memory file not found'));
      return;
    }

    console.log(`[API] Deleted memory: ${agentId}/${filename}`);
    sendJson(res, 200, success({ agentId, filename, deleted: true }));
  } catch (err) {
    console.error('[API] Failed to delete memory:', err);
    sendJson(res, 500, error(String(err)));
  }
}

// ============================================================================
// Utils
// ============================================================================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
