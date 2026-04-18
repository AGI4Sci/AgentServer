/**
 * Agent API 路由
 * GET/POST/PUT/DELETE /api/agents
 * 
 * 所有 Agent 配置存储在 OpenTeam 目录下（agents/{id}/soul.json）。
 * Agent Runtime 只是执行引擎，不存储配置。
 * 
 * 配置注入流程：
 * 1. 用户修改配置 → 存储到 OpenTeam agents/{id}/soul.json
 * 2. 会话启动时 → 通过 Runtime Workspace Adapter 注入到共享 team runtime workspace
 */

import { IncomingMessage, ServerResponse } from 'http';
import { success, error, sendJson } from '../utils/response.js';
import { validateAgentId } from '../utils/validation.js';
import { getSoulStore } from '../../core/store/soul-store.js';
import { getRuntimeWorkspaceAdapter } from '../../core/runtime/adapters/runtime-workspace-adapter.js';
import type { AgentSoul } from '../../core/store/soul-store.js';

// ============================================================================
// Types
// ============================================================================

export interface AgentCreateRequest {
  id: string;
  name?: string;
  role?: string;
  identity?: string;
  personality?: string;
  mission?: string;
  communication?: string;
  constraints?: string;
  traits?: string[];
  runtime?: {
    model?: string;
    temperature?: number;
    language?: string;
    skills?: string[];
    heartbeatInterval?: string;
  };
}

// ============================================================================
// Route Handler
// ============================================================================

/**
 * 处理 Agent 相关 API 请求
 */
export async function handleAgentRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _teamsDir: string
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // GET /api/agents - 列出所有 Agent
  if (url === '/api/agents' && method === 'GET') {
    await handleListAgents(req, res);
    return true;
  }

  // GET /api/agents/:id - 获取单个 Agent
  const agentMatch = url.match(/^\/api\/agents\/([^\/]+)$/);
  if (agentMatch && method === 'GET') {
    await handleGetAgent(req, res, agentMatch[1]);
    return true;
  }

  // POST /api/agents - 创建 Agent
  if (url === '/api/agents' && method === 'POST') {
    await handleCreateAgent(req, res);
    return true;
  }

  // PUT /api/agents/:id - 更新 Agent
  if (agentMatch && method === 'PUT') {
    await handleUpdateAgent(req, res, agentMatch[1]);
    return true;
  }

  // DELETE /api/agents/:id - 删除 Agent
  if (agentMatch && method === 'DELETE') {
    await handleDeleteAgent(req, res, agentMatch[1]);
    return true;
  }

  // PUT /api/agents/:id/skills - 更新 Agent 的 Skills
  const skillsMatch = url.match(/^\/api\/agents\/([^\/]+)\/skills$/);
  if (skillsMatch && method === 'PUT') {
    await handleUpdateAgentSkills(req, res, skillsMatch[1]);
    return true;
  }

  // TODO-002: GET /api/agents/:id/skills - 获取 Agent 的 Skills
  if (skillsMatch && method === 'GET') {
    await handleGetAgentSkills(req, res, skillsMatch[1]);
    return true;
  }

  // POST /api/agents/:id/inject - 手动触发配置注入
  const injectMatch = url.match(/^\/api\/agents\/([^\/]+)\/inject$/);
  if (injectMatch && method === 'POST') {
    await handleInjectConfig(req, res, injectMatch[1]);
    return true;
  }

  return false;
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/agents - 列出所有 Agent（从 OpenTeam 目录）
 */
async function handleListAgents(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const store = getSoulStore();
    const agents = store.listAgents();
    
    sendJson(res, 200, success(agents));
  } catch (err) {
    console.error('[API] Failed to list agents:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * GET /api/agents/:id - 获取单个 Agent
 */
async function handleGetAgent(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();
    const info = store.getAgentInfo(agentId);
    
    if (!info) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }
    
    sendJson(res, 200, success(info));
  } catch (err) {
    console.error('[API] Failed to get agent:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/agents - 创建 Agent
 */
async function handleCreateAgent(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const request = JSON.parse(body) as AgentCreateRequest;

    const validationError = validateAgentId(request.id);
    if (validationError) {
      sendJson(res, 400, error(validationError));
      return;
    }

    const store = getSoulStore();
    
    if (store.hasAgent(request.id)) {
      sendJson(res, 409, error('Agent already exists'));
      return;
    }

    // 构建 soul 配置
    const soul: AgentSoul = {
      id: request.id,
      name: request.name || request.id,
      role: request.role || 'Agent',
      runtime: request.runtime || {
        model: 'claude-sonnet-4-6',
        temperature: 0.7,
        language: 'zh-CN',
        skills: [],
      },
      identity: request.identity || `我是 ${request.name || request.id}，一个 AI Agent。`,
      personality: request.personality || '专业、高效、协作。',
      mission: request.mission || '帮助用户完成任务。',
      communication: request.communication || '清晰简洁，结构化输出。',
      constraints: request.constraints || '不做超出职责范围的事。',
      traits: request.traits || ['团队协作', '专业高效'],
    };

    // 创建 agent
    const info = store.createAgent(request.id, soul);
    
    // 创建 runtime workspace（不存储配置，只准备团队运行时工作区）
    const adapter = getRuntimeWorkspaceAdapter();
    await adapter.createAgent(request.id);

    console.log(`[API] Created agent: ${request.id}`);
    sendJson(res, 201, success(info));
  } catch (err) {
    console.error('[API] Failed to create agent:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * PUT /api/agents/:id - 更新 Agent
 */
async function handleUpdateAgent(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();
    
    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    const body = await readBody(req);
    const request = JSON.parse(body) as Partial<AgentCreateRequest>;

    // 更新 soul
    const update: Partial<AgentSoul> = {};
    if (request.name !== undefined) update.name = request.name;
    if (request.role !== undefined) update.role = request.role;
    if (request.identity !== undefined) update.identity = request.identity;
    if (request.personality !== undefined) update.personality = request.personality;
    if (request.mission !== undefined) update.mission = request.mission;
    if (request.communication !== undefined) update.communication = request.communication;
    if (request.constraints !== undefined) update.constraints = request.constraints;
    if (request.traits !== undefined) update.traits = request.traits;
    if (request.runtime !== undefined) update.runtime = request.runtime;

    const info = store.updateAgentSoul(agentId, update);

    console.log(`[API] Updated agent: ${agentId}`);
    sendJson(res, 200, success(info));
  } catch (err) {
    console.error('[API] Failed to update agent:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * DELETE /api/agents/:id - 删除 Agent
 */
async function handleDeleteAgent(
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

    // 从 OpenTeam 删除
    store.deleteAgent(agentId);
    
    // 从 runtime workspace 删除
    const adapter = getRuntimeWorkspaceAdapter();
    await adapter.deleteAgent(agentId);

    console.log(`[API] Deleted agent: ${agentId}`);
    sendJson(res, 200, success({ id: agentId }));
  } catch (err) {
    console.error('[API] Failed to delete agent:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * PUT /api/agents/:id/skills - 更新 Agent 的 Skills
 */
async function handleUpdateAgentSkills(
  req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();

    if (!store.hasAgent(agentId)) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    const body = await readBody(req);
    const { skills } = JSON.parse(body);

    if (!Array.isArray(skills)) {
      sendJson(res, 400, error('skills must be an array'));
      return;
    }

    // 更新 OpenTeam 存储
    store.updateAgentSkills(agentId, skills);

    // 注入到 runtime workspace
    const soul = store.getAgentSoul(agentId);
    if (soul) {
      const adapter = getRuntimeWorkspaceAdapter();
      await adapter.syncAgentWorkspaceFromSoulStore(agentId, soul);
    }

    console.log(`[API] Updated skills for ${agentId}: ${skills.join(', ') || '(none)'}`);
    sendJson(res, 200, success({
      id: agentId,
      skills,
    }));
  } catch (err) {
    console.error('[API] Failed to update agent skills:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * GET /api/agents/:id/skills - 获取 Agent 的 Skills
 * TODO-002: 添加缺失的 GET 路由
 */
async function handleGetAgentSkills(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();
    const soul = store.getAgentSoul(agentId);

    if (!soul) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    const skills = soul.runtime?.skills || [];
    sendJson(res, 200, success({
      id: agentId,
      skills,
    }));
  } catch (err) {
    console.error('[API] Failed to get agent skills:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/agents/:id/inject - 手动触发配置注入到 runtime workspace
 * 
 * 注意：这个 API 使用简化的同步方式（不含 Team Context）。
 * 如需完整同步（包含 Member Profile 和 Team Context），请使用：
 * POST /api/team/:teamId/agents/:agentId/inject
 */
async function handleInjectConfig(
  _req: IncomingMessage,
  res: ServerResponse,
  agentId: string
): Promise<void> {
  try {
    const store = getSoulStore();
    const soul = store.getAgentSoul(agentId);
    
    if (!soul) {
      sendJson(res, 404, error('Agent not found'));
      return;
    }

    // 注入到 runtime workspace（简化版，不含 Team Context）
    // 警告：这会覆盖 SOUL.md，丢失 Member Profile 和 Team Context
    const adapter = getRuntimeWorkspaceAdapter();
    await adapter.syncAgentWorkspaceFromSoulStore(agentId, soul);

    console.log(`[API] Injected config for ${agentId} (simplified, no team context)`);
    sendJson(res, 200, success({
      id: agentId,
      injected: true,
      warning: 'This API uses simplified sync without team context. Use POST /api/team/:teamId/agents/:agentId/inject for full sync.',
    }));
  } catch (err) {
    console.error('[API] Failed to inject config:', err);
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
