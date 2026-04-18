/**
 * Session API 路由
 * 处理 Agent Session 准备请求
 */

import { IncomingMessage, ServerResponse } from 'http';
import { prepareAgentForTeam, switchAgentTeam } from '../utils/session-prepare.js';
import { TEAMS_DIR } from '../utils/paths.js';

/**
 * 读取请求体
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

/**
 * 准备 Agent Session
 * POST /api/agents/:agentId/prepare-session
 */
async function prepareSession(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { teamId } = JSON.parse(body);
    
    if (!teamId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing teamId' }));
      return;
    }

    const result = await prepareAgentForTeam(agentId, teamId, TEAMS_DIR);
    
    if (result.ok) {
      console.log(`[Session API] Prepared session for agent ${agentId} with team ${teamId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: `Session prepared for ${agentId} with team ${teamId}`,
        path: result.path
      }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
    }
  } catch (error) {
    console.error('[Session API] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to prepare session' }));
  }
}

/**
 * 切换 Agent Team
 * POST /api/agents/:agentId/switch-team
 */
async function switchTeam(req: IncomingMessage, res: ServerResponse, agentId: string): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { oldTeamId, newTeamId } = JSON.parse(body);
    
    if (!newTeamId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing newTeamId' }));
      return;
    }

    const result = await switchAgentTeam(agentId, newTeamId, TEAMS_DIR, oldTeamId);
    
    if (result.ok) {
      console.log(`[Session API] Switched team for agent ${agentId}: ${oldTeamId || 'none'} → ${newTeamId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: `Team switched for ${agentId}`
      }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: result.error }));
    }
  } catch (error) {
    console.error('[Session API] Error:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to switch team' }));
  }
}

/**
 * 处理 Session API 路由
 * @returns true 表示已处理，false 表示不匹配
 */
export async function handleSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  teamsDir: string
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // 匹配 /api/agents/:agentId/prepare-session
  const prepareMatch = url.match(/^\/api\/agents\/([^/]+)\/prepare-session$/);
  if (prepareMatch && (method === 'POST' || method === 'PUT')) {
    await prepareSession(req, res, prepareMatch[1]);
    return true;
  }

  // 匹配 /api/agents/:agentId/switch-team
  const switchMatch = url.match(/^\/api\/agents\/([^/]+)\/switch-team$/);
  if (switchMatch && (method === 'POST' || method === 'PUT')) {
    await switchTeam(req, res, switchMatch[1]);
    return true;
  }

  return false;
}
