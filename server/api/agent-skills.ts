/**
 * Agent Skills API 路由
 * 管理 OpenTeam 的 agent skills 目录（agents/skills）
 */

import { IncomingMessage, ServerResponse } from 'http';
import { readFile, writeFile, mkdir, rm, readdir, stat } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import { join, basename } from 'path';
import { getSoulStore } from '../../core/store/soul-store.js';

/**
 * 将 URL 中的 skillId（如 `scp/protein-properties-calculation`）解析为 `agents/skills/...` 下目录。
 * 仅支持一级嵌套（`namespace/tool`）或顶层 `tool`，拒绝 `..` 与过深路径。
 */
export function resolveAgentSkillDir(skillsDir: string, skillId: string): string | null {
  let decoded = skillId.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('..')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return null;
  const segOk = (s: string) => /^[a-z0-9][a-z0-9._-]*$/i.test(s);
  if (!segments.every(segOk)) return null;
  return join(skillsDir, ...segments);
}

export function normalizeSkillId(skillId: string): string | null {
  let decoded = skillId.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes('..')) return null;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return null;
  const segOk = (s: string) => /^[a-z0-9][a-z0-9._-]*$/i.test(s);
  if (!segments.every(segOk)) return null;
  return segments.join('/');
}

function isValidSkillId(id: string): boolean {
  let decoded = id.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return false;
  }
  if (!decoded || decoded.includes('..')) return false;
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return false;
  const segOk = (s: string) => /^[a-z0-9][a-z0-9._-]*$/i.test(s);
  return segments.every(segOk);
}

/**
 * 获取 Skills 目录路径（从 SoulStore 获取，无硬编码）
 */
function getSkillsDir(): string {
  const store = getSoulStore();
  return store.getSkillsDir();
}

async function pushSkillEntry(skills: any[], id: string, skillPath: string): Promise<void> {
  const skillMdPath = join(skillPath, 'SKILL.md');
  const skillInfo: any = {
    id,
    name: id,
    path: skillPath,
    hasSkillFile: existsSync(skillMdPath),
  };
  if (skillInfo.hasSkillFile) {
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      skillInfo.name = frontmatter.name || id;
      skillInfo.description = frontmatter.description || '';
      skillInfo.metadata = frontmatter.metadata || {};
    } catch (e) {
      console.warn(`[Skills] Failed to read ${id}/SKILL.md:`, e);
    }
  }
  skills.push(skillInfo);
}

/**
 * 列出所有 Skills
 * GET /api/agent-skills
 */
async function listSkills(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const skillsDir = getSkillsDir();

    if (!existsSync(skillsDir)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, skills: [] }));
      return;
    }

    const entries = await readdir(skillsDir);
    const skills: any[] = [];

    for (const entry of entries) {
      const skillPath = join(skillsDir, entry);

      try {
        const stats = await stat(skillPath);
        if (!stats.isDirectory()) continue;

        // T006：`agents/skills/scp/<toolId>/SKILL.md` 嵌套布局，列表中为 `scp/<toolId>`
        if (entry === 'scp') {
          const subEntries = await readdir(skillPath);
          for (const sub of subEntries) {
            const subPath = join(skillPath, sub);
            try {
              const subStats = await stat(subPath);
              if (!subStats.isDirectory()) continue;
              await pushSkillEntry(skills, `scp/${sub}`, subPath);
            } catch (e) {
              console.warn(`[Skills] Failed to read scp/${sub}:`, e);
            }
          }
          continue;
        }

        await pushSkillEntry(skills, entry, skillPath);
      } catch (e) {
        console.warn(`[Skills] Failed to read ${entry}:`, e);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, skills }));
  } catch (error) {
    console.error('[Skills API] Error listing skills:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to list skills' }));
  }
}

/**
 * 获取 Skill 详情
 * GET /api/agent-skills/:skillId
 */
async function getSkill(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  try {
    const normalizedSkillId = normalizeSkillId(skillId);
    const skillPath = resolveAgentSkillDir(getSkillsDir(), skillId);
    if (!skillPath || !normalizedSkillId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid skill id' }));
      return;
    }
    const skillMdPath = join(skillPath, 'SKILL.md');

    if (!existsSync(skillPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Skill not found' }));
      return;
    }

    if (!existsSync(skillMdPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'SKILL.md not found' }));
      return;
    }

    const content = await readFile(skillMdPath, 'utf-8');
    const frontmatter = parseFrontmatter(content);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      skill: {
        id: normalizedSkillId,
        name: frontmatter.name || normalizedSkillId,
        description: frontmatter.description || '',
        metadata: frontmatter.metadata || {},
        content,
        path: skillPath,
      }
    }));
  } catch (error) {
    console.error('[Skills API] Error getting skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to get skill' }));
  }
}

/**
 * 创建新 Skill
 * POST /api/agent-skills
 */
async function createSkill(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { id, name, description, content } = JSON.parse(body);

    if (!id || !isValidSkillId(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'Invalid skill ID (use letters, numbers, hyphens; optional one level: namespace/tool-id)',
      }));
      return;
    }

    const skillsDir = getSkillsDir();
    const skillPath = resolveAgentSkillDir(skillsDir, id);
    if (!skillPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid skill id' }));
      return;
    }
    const skillMdPath = join(skillPath, 'SKILL.md');

    if (existsSync(skillPath)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Skill already exists' }));
      return;
    }

    // 创建 skill 目录
    await mkdir(skillPath, { recursive: true });

    // 生成默认内容（如果没有提供）
    const skillContent = content || generateDefaultSkillContent(id, name || id, description || '');

    // 写入 SKILL.md
    await writeFile(skillMdPath, skillContent, 'utf-8');

    console.log(`[Skills API] Created skill: ${id}`);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      skill: {
        id,
        name: name || id,
        description: description || '',
        path: skillPath,
      }
    }));
  } catch (error) {
    console.error('[Skills API] Error creating skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to create skill' }));
  }
}

/**
 * 更新 Skill
 * PUT /api/agent-skills/:skillId
 */
async function updateSkill(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  try {
    const body = await readRequestBody(req);
    const { name, description, content, metadata } = JSON.parse(body);

    const skillPath = resolveAgentSkillDir(getSkillsDir(), skillId);
    if (!skillPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid skill id' }));
      return;
    }
    const skillMdPath = join(skillPath, 'SKILL.md');

    if (!existsSync(skillPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Skill not found' }));
      return;
    }

    // 如果提供了新内容，直接写入
    if (content) {
      await writeFile(skillMdPath, content, 'utf-8');
    } else {
      // 否则只更新 frontmatter
      let existingContent = '';
      if (existsSync(skillMdPath)) {
        existingContent = await readFile(skillMdPath, 'utf-8');
      }

      const frontmatter = parseFrontmatter(existingContent);
      const updatedFrontmatter = {
        name: name || frontmatter.name || skillId,
        description: description !== undefined ? description : frontmatter.description,
        metadata: metadata || frontmatter.metadata || {},
      };

      const updatedContent = updateFrontmatter(existingContent, updatedFrontmatter);
      await writeFile(skillMdPath, updatedContent, 'utf-8');
    }

    console.log(`[Skills API] Updated skill: ${skillId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Skill updated successfully' }));
  } catch (error) {
    console.error('[Skills API] Error updating skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to update skill' }));
  }
}

/**
 * 删除 Skill
 * DELETE /api/agent-skills/:skillId
 */
async function deleteSkill(req: IncomingMessage, res: ServerResponse, skillId: string): Promise<void> {
  try {
    const skillPath = resolveAgentSkillDir(getSkillsDir(), skillId);
    if (!skillPath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid skill id' }));
      return;
    }

    if (!existsSync(skillPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Skill not found' }));
      return;
    }

    // 删除整个 skill 目录
    await rm(skillPath, { recursive: true, force: true });

    console.log(`[Skills API] Deleted skill: ${skillId}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Skill deleted successfully' }));
  } catch (error) {
    console.error('[Skills API] Error deleting skill:', error);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Failed to delete skill' }));
  }
}

/**
 * 解析 Frontmatter
 */
function parseFrontmatter(content: string): any {
  const frontmatter: any = {};
  
  if (!content || !content.startsWith('---')) {
    return frontmatter;
  }

  try {
    const endIndex = content.indexOf('---', 3);
    if (endIndex === -1) return frontmatter;

    const frontmatterText = content.substring(3, endIndex).trim();
    const lines = frontmatterText.split('\n');

    let currentKey = '';
    let currentValue: any = '';
    let inMultiline = false;
    let multilineKey = '';

    for (const line of lines) {
      // 处理多行值
      if (inMultiline) {
        if (line.trim() === '') {
          if (multilineKey === 'description') {
            frontmatter[multilineKey] = currentValue.trim();
          }
          inMultiline = false;
          multilineKey = '';
        } else {
          currentValue += line + '\n';
        }
        continue;
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const key = line.substring(0, colonIndex).trim();
      let value = line.substring(colonIndex + 1).trim();

      // 处理描述字段（可能是多行）
      if (key === 'description' && value.startsWith('"') && !value.endsWith('"')) {
        multilineKey = key;
        currentValue = value.substring(1) + '\n';
        inMultiline = true;
        continue;
      }

      // 处理简单值
      let parsedValue: any = value;
      if (value.startsWith('"') && value.endsWith('"')) {
        parsedValue = value.substring(1, value.length - 1);
      } else if (value === 'true') {
        parsedValue = true;
      } else if (value === 'false') {
        parsedValue = false;
      } else if (!isNaN(Number(value))) {
        parsedValue = Number(value);
      }

      // 处理嵌套对象
      if (line.startsWith('  ')) {
        if (currentKey) {
          if (!frontmatter[currentKey]) {
            frontmatter[currentKey] = {};
          }
          const subKey = key;
          frontmatter[currentKey][subKey] = parsedValue;
        }
      } else {
        currentKey = key;
        frontmatter[key] = parsedValue;
      }
    }

    return frontmatter;
  } catch (e) {
    console.warn('[Skills] Failed to parse frontmatter:', e);
    return frontmatter;
  }
}

/**
 * 更新 Frontmatter
 */
function updateFrontmatter(content: string, updates: any): string {
  let body = content;
  
  // 如果没有 frontmatter，添加一个
  if (!content || !content.startsWith('---')) {
    const newFrontmatter = [
      '---',
      `name: ${updates.name || 'skill'}`,
      updates.description ? `description: "${updates.description}"` : '',
      '---',
      '',
    ].filter(Boolean).join('\n');
    
    return newFrontmatter + (content || '');
  }

  // 更新现有 frontmatter
  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) return content;

  const frontmatter = parseFrontmatter(content);
  const merged = { ...frontmatter, ...updates };

  const newFrontmatter = [
    '---',
    `name: ${merged.name || 'skill'}`,
    merged.description ? `description: "${merged.description}"` : '',
    merged.metadata ? `metadata:\n  ${JSON.stringify(merged.metadata, null, 2).split('\n').join('\n  ')}` : '',
    '---',
  ].filter(Boolean).join('\n');

  const bodyContent = content.substring(endIndex + 3).trim();
  return newFrontmatter + '\n\n' + bodyContent;
}

/**
 * 生成默认 Skill 内容
 */
function generateDefaultSkillContent(id: string, name: string, description: string): string {
  return `---
name: ${name}
description: "${description || 'A new skill for OpenTeam agent workflows'}"
metadata:
  openteam:
    emoji: 🔧
    requires: {}
---

# ${name} Skill

${description || 'Describe what this skill does.'}

## When to Use

✅ **USE this skill when:**

- [Add use cases here]

## When NOT to Use

❌ **DON'T use this skill when:**

- [Add anti-patterns here]

## Usage

[Add usage instructions here]

## Configuration

[Add configuration details if needed]
`;
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
 * 处理 Agent Skills API 路由
 * @returns true 表示已处理，false 表示不匹配
 */
export async function handleAgentSkillsRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = req.url || '/';
  const urlPath = url.split('?')[0] || '/';
  const method = req.method || 'GET';

  // 列出所有 skills（兼容旧路径 /api/openclaw/skills）
  if ((urlPath === '/api/agent-skills' || urlPath === '/api/openclaw/skills') && method === 'GET') {
    await listSkills(req, res);
    return true;
  }

  // 创建新 skill（兼容旧路径 /api/openclaw/skills）
  if ((urlPath === '/api/agent-skills' || urlPath === '/api/openclaw/skills') && method === 'POST') {
    await createSkill(req, res);
    return true;
  }

  // 单个 skill 操作：`scp/tool-id` 等多段路径（兼容旧路径 /api/openclaw/skills/:id）
  const skillMatch =
    urlPath.match(/^\/api\/agent-skills\/(.+)$/) || urlPath.match(/^\/api\/openclaw\/skills\/(.+)$/);
  if (skillMatch) {
    const skillId = skillMatch[1];

    if (method === 'GET') {
      await getSkill(req, res, skillId);
      return true;
    }

    if (method === 'PUT' || method === 'PATCH') {
      await updateSkill(req, res, skillId);
      return true;
    }

    if (method === 'DELETE') {
      await deleteSkill(req, res, skillId);
      return true;
    }
  }

  return false;
}
