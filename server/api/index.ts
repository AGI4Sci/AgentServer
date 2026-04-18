/**
 * API 路由入口
 * 分发到各个子模块处理
 */

import { IncomingMessage, ServerResponse } from 'http';
import { handleAgentRoutes } from './agents.js';
import { handleTeamRoutes } from './teams.js';
import { handleFileRoutes } from './files.js';
import { handleLLMRoutes } from './llm.js';
import { handleSkillRoutes } from './skills.js';
import { handleSessionRoutes } from './session.js';
import { handleAgentSkillsRoutes } from './agent-skills.js';
import { handleMemoryRoutes } from './memory.js';
import { handleTeamInitRoutes } from './team-init.js';
import { handleCleanupRoutes } from './cleanup.js';
import { handleHarnessRoutes } from './harness.js';
import { handleChatHistoryRoutes } from './chat-history.js';
import { handleResearchRoutes } from './research.js';
import { handleScpToolsRoutes } from './scp-tools.js';
import { handleRuntimeRoutes } from './runtime.js';
import { handleAgentServerRoutes } from './agent-server.js';
import { handleSkillRegistryRoutes } from './skill-registry.js';
import { handleWorkspaceRoutes } from './workspaces.js';
import { handleScmRoutes } from './scm.js';
import { handleEndpointRoutes } from './endpoints.js';
import { handleRemoteWorkspaceRoutes } from './remote-workspaces.js';

// 广播回调（由 server/index.ts 设置）
let broadcastCallback: ((teamId: string, message: any) => void) | null = null;

export function setBroadcastCallback(cb: (teamId: string, message: any) => void) {
  broadcastCallback = cb;
}

/**
 * 处理 API 请求
 * 按顺序尝试各个路由模块
 * @returns true 表示已处理，false 表示不匹配
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  teamsDir: string
): Promise<boolean> {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const method = req.method || 'GET';
  if (method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return true;
  }

  const url = req.url || '/';

  // 测试 API: 模拟 agent-intercept 消息
  if (url === '/api/test/agent-intercept' && method === 'POST') {
    return await handleTestAgentIntercept(req, res);
  }

  // 测试 API: 模拟 agent-blocked 消息
  if (url === '/api/test/agent-blocked' && method === 'POST') {
    return await handleTestAgentBlocked(req, res);
  }

  // 按优先级尝试各路由模块
  // cleanup 路由优先级最高
  if (await handleCleanupRoutes(req, res, teamsDir)) return true;
  if (await handleHarnessRoutes(req, res)) return true;
  if (await handleChatHistoryRoutes(req, res)) return true;
  if (await handleRuntimeRoutes(req, res)) return true;
  if (await handleAgentServerRoutes(req, res)) return true;
  if (await handleSkillRegistryRoutes(req, res)) return true;
  if (await handleEndpointRoutes(req, res)) return true;
  if (await handleRemoteWorkspaceRoutes(req, res)) return true;
  if (await handleWorkspaceRoutes(req, res)) return true;
  if (await handleScmRoutes(req, res)) return true;
  // research 路由：Research Team 专用 API（必须在 team-init 之前，避免 /api/team/:teamId/chat 提前匹配）
  if (await handleResearchRoutes(req, res)) return true;
  // scp-tools 路由：SCP Hub 工具调用 API
  if (await handleScpToolsRoutes(req, res)) return true;
  // team-init 路由：团队成员初始化
  if (await handleTeamInitRoutes(req, res, teamsDir)) return true;
  // files 路由需要放在 teams 之后检查，因为都匹配 /api/teams/:id
  // skills 路由需要放在 teams 之后检查，因为都匹配 /api/teams/:id
  // session 路由需要放在 agents 之后检查，因为都匹配 /api/agents/:id
  // memory 路由需要放在 agents 之后检查，因为都匹配 /api/agents/:id
  if (await handleAgentRoutes(req, res, teamsDir)) return true;
  if (await handleSessionRoutes(req, res, teamsDir)) return true;
  if (await handleMemoryRoutes(req, res)) return true;
  if (await handleLLMRoutes(req, res, teamsDir)) return true;
  if (await handleAgentSkillsRoutes(req, res)) return true;
  if (await handleSkillRoutes(req, res, teamsDir)) return true;
  if (await handleFileRoutes(req, res, teamsDir)) return true;
  if (await handleTeamRoutes(req, res, teamsDir)) return true;

  return false;
}

/**
 * 测试 API: 模拟 agent-intercept 消息
 */
async function handleTestAgentIntercept(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { from, to, body: msgBody, teamId = 'vibe-coding' } = data;

        if (!from || !to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing from or to' }));
          resolve(true);
          return;
        }

        // 广播 agent-intercept 消息
        if (broadcastCallback) {
          broadcastCallback(teamId, {
            type: 'agent-intercept',
            from,
            to,
            body: msgBody || `测试消息 from ${from} to ${to}`,
            timestamp: new Date().toISOString(),
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'agent-intercept sent' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
      resolve(true);
    });
  });
}

/**
 * 测试 API: 模拟 agent-blocked 消息
 */
async function handleTestAgentBlocked(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const { from, to, reason, teamId = 'vibe-coding' } = data;

        if (!from || !to) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing from or to' }));
          resolve(true);
          return;
        }

        // 广播 agent-blocked 消息
        if (broadcastCallback) {
          broadcastCallback(teamId, {
            type: 'agent-blocked',
            from,
            to,
            body: reason || `🚫 通信规则阻止: ${from} → ${to}`,
            timestamp: new Date().toISOString(),
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'agent-blocked sent' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
      resolve(true);
    });
  });
}

// 导出 LLM 相关函数供 ws-handler 使用
export { loadLLMConfig, getLLMConfig, getLLMHealth, primeLlmRuntimeFromHealth } from './llm.js';
