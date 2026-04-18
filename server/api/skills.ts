/**
 * Skills API 路由
 * 处理 Team Skill 的读写操作
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { getTeamSkillDisplayPath, getTeamSkillFilePath, getTeamSkillsDir } from './teams/shared.js';

/**
 * 读取 Skill 内容
 * GET /api/teams/:teamId/skill
 */
async function getSkill(req: IncomingMessage, res: ServerResponse, teamId: string): Promise<void> {
  try {
    const skillPath = getTeamSkillFilePath(teamId);
    
    if (!existsSync(skillPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Skill not found' }));
      return;
    }

    const content = await readFile(skillPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ok: true, 
      content,
      path: getTeamSkillDisplayPath(teamId),
    }));
  } catch (error) {
    console.error('[Skills API] Error reading skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to read skill' }));
  }
}

/**
 * 保存 Skill 内容
 * PUT /api/teams/:teamId/skill
 */
async function saveSkill(req: IncomingMessage, res: ServerResponse, teamId: string): Promise<void> {
  try {
    // 读取请求体
    const body = await readRequestBody(req);
    const { content } = JSON.parse(body);
    
    if (typeof content !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid content' }));
      return;
    }

    const skillDir = getTeamSkillsDir(teamId);
    const skillPath = getTeamSkillFilePath(teamId);

    // 确保 skills 目录存在
    if (!existsSync(skillDir)) {
      await mkdir(skillDir, { recursive: true });
    }

    // 保存文件
    await writeFile(skillPath, content, 'utf-8');
    
    console.log(`[Skills API] Saved skill for team: ${teamId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ok: true, 
      message: 'Skill saved successfully',
      path: getTeamSkillDisplayPath(teamId),
    }));
  } catch (error) {
    console.error('[Skills API] Error saving skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to save skill' }));
  }
}

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
 * 处理 Skills API 路由
 * @returns true 表示已处理，false 表示不匹配
 */
export async function handleSkillRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  teamsDir: string
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // 匹配 /api/teams/:teamId/skill
  const skillMatch = url.match(/^\/api\/teams\/([^/]+)\/skill$/);
  
  if (!skillMatch) {
    return false;
  }

  const teamId = skillMatch[1];

  if (method === 'GET') {
    await getSkill(req, res, teamId);
    return true;
  }

  if (method === 'PUT' || method === 'POST') {
    await saveSkill(req, res, teamId);
    return true;
  }

  return false;
}
