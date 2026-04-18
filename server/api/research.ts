/**
 * Research Team API 路由
 * 
 * 提供文献综述和工具分析两种模式的 API 支持
 * 
 * 端点：
 * - GET  /api/team/research/bootstrap - 返回初始化数据
 * - POST /api/team/research/chat - 发送消息给 Agent
 * - GET  /api/team/research/evidence - 获取证据列表
 * - POST /api/team/research/evidence - 添加新证据
 * - GET  /api/team/research/evidence/:id - 获取证据详情
 * - PUT  /api/team/research/evidence/:id - 更新证据
 * - DELETE /api/team/research/evidence/:id - 删除证据
 * - GET  /api/team/research/mode - 获取当前模式
 * - PUT  /api/team/research/mode - 切换模式
 */

import { IncomingMessage, ServerResponse } from 'http';
import { success, error, sendJson } from '../utils/response.js';

// ============================================================================
// 类型定义
// ============================================================================

export type ResearchMode = 'literature_review' | 'tool_analysis';

export interface Evidence {
  id: string;
  title: string;
  source: string;        // 文献来源
  type: 'method' | 'conclusion' | 'limitation' | 'relation';
  content: string;       // 摘录内容
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface ResearchState {
  mode: ResearchMode;
  evidences: Map<string, Evidence>;
}

// ============================================================================
// 内存存储
// ============================================================================

// 研究状态（后续可改为文件持久化）
const researchState: ResearchState = {
  mode: 'literature_review',
  evidences: new Map(),
};

// 证据 ID 计数器
let evidenceIdCounter = 1;

// ============================================================================
// 路由处理
// ============================================================================

/**
 * 处理 Research Team API 请求
 */
export async function handleResearchRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  // Bootstrap
  if (url === '/api/team/research/bootstrap' && method === 'GET') {
    return await handleBootstrap(req, res);
  }

  // Chat
  if (url === '/api/team/research/chat' && method === 'POST') {
    return await handleChat(req, res);
  }

  // Mode
  if (url === '/api/team/research/mode' && method === 'GET') {
    return await handleGetMode(req, res);
  }
  if (url === '/api/team/research/mode' && method === 'PUT') {
    return await handleSetMode(req, res);
  }

  // Evidence collection
  if (url === '/api/team/research/evidence' && method === 'GET') {
    return await handleListEvidence(req, res);
  }
  if (url === '/api/team/research/evidence' && method === 'POST') {
    return await handleCreateEvidence(req, res);
  }

  // Evidence item
  const evidenceMatch = url.match(/^\/api\/team\/research\/evidence\/([^\/]+)$/);
  if (evidenceMatch) {
    const evidenceId = evidenceMatch[1];
    if (method === 'GET') {
      return await handleGetEvidence(req, res, evidenceId);
    }
    if (method === 'PUT') {
      return await handleUpdateEvidence(req, res, evidenceId);
    }
    if (method === 'DELETE') {
      return await handleDeleteEvidence(req, res, evidenceId);
    }
  }

  return false;
}

// ============================================================================
// Bootstrap
// ============================================================================

/**
 * GET /api/team/research/bootstrap
 * 返回初始化数据（证据列表、模式、成员状态）
 */
async function handleBootstrap(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    // 获取证据列表
    const evidences = Array.from(researchState.evidences.values());
    
    // 获取成员状态（基于 team.config.json）
    const members = [
      {
        id: 'research-lead-01',
        role: 'coordinator',
        roleName: 'Research Lead',
        status: 'idle',
        active: true,
      },
      {
        id: 'literature-reviewer-01',
        role: 'executor',
        roleName: 'Literature Reviewer',
        status: 'idle',
        active: true,
      },
      {
        id: 'tool-executor-01',
        role: 'executor',
        roleName: 'Tool Executor',
        status: 'idle',
        active: researchState.mode === 'tool_analysis',
      },
    ];

    sendJson(res, 200, success({
      mode: researchState.mode,
      evidences,
      members,
      supportedModes: ['literature_review', 'tool_analysis'],
    }));
  } catch (err) {
    console.error('[API] Bootstrap error:', err);
    sendJson(res, 500, error(String(err)));
  }
  
  return true;
}

// ============================================================================
// Chat
// ============================================================================

/**
 * POST /api/team/research/chat
 * 发送消息给 Agent
 * 
 * 请求体：
 * {
 *   "to": "research-lead-01" | "@research-lead-01",
 *   "body": "消息内容",
 *   "from": "user" (可选)
 * }
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { to, body: messageBody, from = 'user', sourceClientId, isPrivate, projectId } = data;
        const requestId = data.requestId || `research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        
        if (!to || !messageBody) {
          sendJson(res, 400, error('Missing to or body'));
          resolve(true);
          return;
        }
        
        // 解析目标 Agent（本地 ID）
        const localAgentId = to.startsWith('@') ? to.slice(1) : to;
        
        // 验证是否是有效的团队成员
        const validMembers = ['research-lead-01', 'literature-reviewer-01', 'tool-executor-01'];
        if (!validMembers.includes(localAgentId)) {
          sendJson(res, 400, error(`Invalid member: ${localAgentId}`));
          resolve(true);
          return;
        }
        
        // 检查 tool-executor-01 是否在当前模式下可用
        if (localAgentId === 'tool-executor-01' && researchState.mode !== 'tool_analysis') {
          sendJson(res, 400, error('Tool Executor is only available in tool_analysis mode'));
          resolve(true);
          return;
        }
        
        // 动态导入避免循环依赖
        const { handleMessageViaRouter } = await import('../ws-handler.js');
        
        // 通过 MessageRouter 投递消息
        await handleMessageViaRouter('research', {
          from,
          to: localAgentId,
          body: messageBody,
          requestId,
          sourceClientId,
          isPrivate,
          projectId,
        });
        
        sendJson(res, 200, success({
          message: 'Message sent via Router',
          to: localAgentId,
          requestId,
        }));
      } catch (err) {
        console.error('[API] Chat error:', err);
        sendJson(res, 500, error(String(err)));
      }
      resolve(true);
    });
  });
}

// ============================================================================
// Mode
// ============================================================================

/**
 * GET /api/team/research/mode
 * 获取当前模式
 */
async function handleGetMode(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  sendJson(res, 200, success({
    mode: researchState.mode,
    supportedModes: ['literature_review', 'tool_analysis'],
  }));
  return true;
}

/**
 * PUT /api/team/research/mode
 * 切换模式
 * 
 * 请求体：
 * {
 *   "mode": "literature_review" | "tool_analysis"
 * }
 */
async function handleSetMode(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { mode } = data;
        
        if (!mode) {
          sendJson(res, 400, error('Missing mode'));
          resolve(true);
          return;
        }
        
        if (mode !== 'literature_review' && mode !== 'tool_analysis') {
          sendJson(res, 400, error(`Invalid mode: ${mode}. Must be "literature_review" or "tool_analysis"`));
          resolve(true);
          return;
        }
        
        const previousMode = researchState.mode;
        researchState.mode = mode;
        
        console.log(`[Research] Mode changed: ${previousMode} -> ${mode}`);
        
        sendJson(res, 200, success({
          mode,
          previousMode,
          message: `Mode changed from ${previousMode} to ${mode}`,
        }));
      } catch (err) {
        console.error('[API] Set mode error:', err);
        sendJson(res, 500, error(String(err)));
      }
      resolve(true);
    });
  });
}

// ============================================================================
// Evidence CRUD
// ============================================================================

/**
 * GET /api/team/research/evidence
 * 获取证据列表
 * 
 * 查询参数：
 * - type: 按类型过滤 (method|conclusion|limitation|relation)
 * - tag: 按标签过滤
 */
async function handleListEvidence(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const typeFilter = url.searchParams.get('type') as Evidence['type'] | null;
    const tagFilter = url.searchParams.get('tag');
    
    let evidences = Array.from(researchState.evidences.values());
    
    // 按类型过滤
    if (typeFilter) {
      evidences = evidences.filter(e => e.type === typeFilter);
    }
    
    // 按标签过滤
    if (tagFilter) {
      evidences = evidences.filter(e => e.tags.includes(tagFilter));
    }
    
    // 按创建时间排序（最新在前）
    evidences.sort((a, b) => 
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    
    sendJson(res, 200, success({
      evidences,
      total: evidences.length,
    }));
  } catch (err) {
    console.error('[API] List evidence error:', err);
    sendJson(res, 500, error(String(err)));
  }
  
  return true;
}

/**
 * POST /api/team/research/evidence
 * 添加新证据
 * 
 * 请求体：
 * {
 *   "title": "证据标题",
 *   "source": "文献来源",
 *   "type": "method" | "conclusion" | "limitation" | "relation",
 *   "content": "摘录内容",
 *   "tags": ["tag1", "tag2"]
 * }
 */
async function handleCreateEvidence(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { title, source, type, content, tags = [] } = data;
        
        // 验证必填字段
        if (!title || !source || !type || !content) {
          sendJson(res, 400, error('Missing required fields: title, source, type, content'));
          resolve(true);
          return;
        }
        
        // 验证类型
        const validTypes: Evidence['type'][] = ['method', 'conclusion', 'limitation', 'relation'];
        if (!validTypes.includes(type)) {
          sendJson(res, 400, error(`Invalid type: ${type}. Must be one of: ${validTypes.join(', ')}`));
          resolve(true);
          return;
        }
        
        // 生成 ID
        const id = `ev-${Date.now()}-${evidenceIdCounter++}`;
        const now = new Date().toISOString();
        
        // 创建证据
        const evidence: Evidence = {
          id,
          title,
          source,
          type,
          content,
          tags: Array.isArray(tags) ? tags : [],
          createdAt: now,
          updatedAt: now,
        };
        
        // 存储
        researchState.evidences.set(id, evidence);
        
        console.log(`[Research] Created evidence: ${id} - ${title}`);
        
        sendJson(res, 201, success({
          evidence,
          message: 'Evidence created',
        }));
      } catch (err) {
        console.error('[API] Create evidence error:', err);
        sendJson(res, 500, error(String(err)));
      }
      resolve(true);
    });
  });
}

/**
 * GET /api/team/research/evidence/:id
 * 获取证据详情
 */
async function handleGetEvidence(
  _req: IncomingMessage,
  res: ServerResponse,
  evidenceId: string
): Promise<boolean> {
  try {
    const evidence = researchState.evidences.get(evidenceId);
    
    if (!evidence) {
      sendJson(res, 404, error(`Evidence not found: ${evidenceId}`));
      return true;
    }
    
    sendJson(res, 200, success({ evidence }));
  } catch (err) {
    console.error('[API] Get evidence error:', err);
    sendJson(res, 500, error(String(err)));
  }
  
  return true;
}

/**
 * PUT /api/team/research/evidence/:id
 * 更新证据
 * 
 * 请求体：
 * {
 *   "title": "新标题",
 *   "source": "新来源",
 *   "type": "新类型",
 *   "content": "新内容",
 *   "tags": ["new-tag"]
 * }
 */
async function handleUpdateEvidence(
  req: IncomingMessage,
  res: ServerResponse,
  evidenceId: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const evidence = researchState.evidences.get(evidenceId);
        
        if (!evidence) {
          sendJson(res, 404, error(`Evidence not found: ${evidenceId}`));
          resolve(true);
          return;
        }
        
        const data = JSON.parse(body);
        const { title, source, type, content, tags } = data;
        
        // 验证类型（如果提供）
        if (type) {
          const validTypes: Evidence['type'][] = ['method', 'conclusion', 'limitation', 'relation'];
          if (!validTypes.includes(type)) {
            sendJson(res, 400, error(`Invalid type: ${type}`));
            resolve(true);
            return;
          }
        }
        
        // 更新字段
        if (title) evidence.title = title;
        if (source) evidence.source = source;
        if (type) evidence.type = type;
        if (content) evidence.content = content;
        if (tags !== undefined) evidence.tags = Array.isArray(tags) ? tags : [];
        
        evidence.updatedAt = new Date().toISOString();
        
        console.log(`[Research] Updated evidence: ${evidenceId}`);
        
        sendJson(res, 200, success({
          evidence,
          message: 'Evidence updated',
        }));
      } catch (err) {
        console.error('[API] Update evidence error:', err);
        sendJson(res, 500, error(String(err)));
      }
      resolve(true);
    });
  });
}

/**
 * DELETE /api/team/research/evidence/:id
 * 删除证据
 */
async function handleDeleteEvidence(
  _req: IncomingMessage,
  res: ServerResponse,
  evidenceId: string
): Promise<boolean> {
  try {
    const evidence = researchState.evidences.get(evidenceId);
    
    if (!evidence) {
      sendJson(res, 404, error(`Evidence not found: ${evidenceId}`));
      return true;
    }
    
    researchState.evidences.delete(evidenceId);
    
    console.log(`[Research] Deleted evidence: ${evidenceId}`);
    
    sendJson(res, 200, success({
      id: evidenceId,
      message: 'Evidence deleted',
    }));
  } catch (err) {
    console.error('[API] Delete evidence error:', err);
    sendJson(res, 500, error(String(err)));
  }
  
  return true;
}
