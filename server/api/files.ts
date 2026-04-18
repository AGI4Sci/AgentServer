/**
 * 文件操作 API 路由
 * /api/teams/:id/files/*
 * 
 * 文件存储策略：
 * 所有数据都在项目目录 teams/{teamId}/ 下
 */

import { IncomingMessage, ServerResponse } from 'http';
import { existsSync, mkdirSync, writeFileSync, readdirSync, rmSync, readFileSync, statSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { success, error, sendJson } from '../utils/response.js';
import { TEAMS_DIR } from '../utils/paths.js';
import { parseProjectMarkdown, hasStructuredTaskClosure, type ParsedProjectState, type ParsedProjectTask } from '../../core/harness/project-state.js';
import { getHarnessRunRecorder } from '../../core/harness/run-recorder.js';

/**
 * 获取 Team 目录
 */
function getTeamDir(teamId: string): string {
  return join(TEAMS_DIR, teamId);
}

function inferProjectIdFromFilePath(filePath: string): string | undefined {
  const normalized = filePath.replace(/^\/+/, '');
  const match = normalized.match(/^projects\/([^/]+)\/PROJECT\.md$/i);
  return match?.[1];
}

function inferProjectArtifactPath(filePath: string): { projectId: string; artifactPath: string } | null {
  const normalized = filePath.replace(/^\/+/, '');
  const match = normalized.match(/^projects\/([^/]+)\/(.+)$/i);
  if (!match) return null;
  if (/^PROJECT\.md$/i.test(match[2])) return null;
  return {
    projectId: match[1],
    artifactPath: match[2],
  };
}

function diffProjectTasks(before: ParsedProjectState, after: ParsedProjectState): Array<{
  task: ParsedProjectTask;
  previousStatus?: ParsedProjectTask['status'];
}> {
  const beforeById = new Map(before.tasks.map((task) => [task.id, task]));
  const changes: Array<{
    task: ParsedProjectTask;
    previousStatus?: ParsedProjectTask['status'];
  }> = [];

  for (const task of after.tasks) {
    const previous = beforeById.get(task.id);
    if (!previous) {
      changes.push({ task });
      continue;
    }

    if (
      previous.status !== task.status ||
      previous.assignee !== task.assignee ||
      previous.priority !== task.priority ||
      previous.title !== task.title
    ) {
      changes.push({ task, previousStatus: previous.status });
    }
  }

  return changes;
}

/**
 * 处理文件操作 API 请求
 */
export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _teamsDir: string
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  // GET /api/teams/:id/files - 获取文件列表
  const filesListMatch = url.match(/^\/api\/teams\/([^\/]+)\/files$/);
  if (filesListMatch && method === 'GET') {
    await handleGetTeamFiles(req, res, filesListMatch[1]);
    return true;
  }

  // 文件内容操作
  const fileMatch = url.match(/^\/api\/teams\/([^\/]+)\/files\/(.+)$/);
  if (fileMatch) {
    const teamId = fileMatch[1];
    const filePath = decodeURIComponent(fileMatch[2]);

    if (method === 'GET') {
      await handleGetFileContent(req, res, teamId, filePath);
      return true;
    }
    if (method === 'PUT') {
      await handleWriteFile(req, res, teamId, filePath);
      return true;
    }
    if (method === 'DELETE') {
      await handleDeleteFile(req, res, teamId, filePath);
      return true;
    }
  }

  // POST /api/teams/:id/rename - 重命名文件
  const renameMatch = url.match(/^\/api\/teams\/([^\/]+)\/rename$/);
  if (renameMatch && method === 'POST') {
    await handleRenameFile(req, res, renameMatch[1]);
    return true;
  }

  return false;
}

/**
 * GET /api/teams/:id/files - 获取 Team 的文件列表
 */
async function handleGetTeamFiles(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<void> {
  try {
    const teamDir = getTeamDir(teamId);
    const projectsDir = join(teamDir, 'projects');
    
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        ok: true, 
        files: [], 
        projectsPath: projectsDir,
        source: 'empty',
      }));
      return;
    }

    const files: any[] = [];
    readDirRecursive(projectsDir, 'projects', files);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      ok: true, 
      files, 
      projectsPath: projectsDir,
      source: 'team',
    }));
  } catch (err) {
    console.error('[API] Failed to get team files:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * GET /api/teams/:id/files/* - 获取文件内容
 */
async function handleGetFileContent(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  filePath: string
): Promise<void> {
  try {
    const teamDir = getTeamDir(teamId);
    
    // 构建完整路径
    let fullPath = filePath.startsWith('projects/')
      ? join(teamDir, filePath)
      : join(teamDir, 'projects', filePath);
    
    // 安全检查
    if (!fullPath.startsWith(teamDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }
    
    if (existsSync(fullPath)) {
      const content = readFileSync(fullPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, content, path: filePath }));
      return;
    }
    
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'File not found' }));
  } catch (err) {
    console.error('[API] Failed to get file content:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * PUT /api/teams/:id/files/* - 创建/更新文件
 */
async function handleWriteFile(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  filePath: string
): Promise<void> {
  try {
    const teamDir = getTeamDir(teamId);
    
    // 确保 team 目录存在
    if (!existsSync(teamDir)) {
      mkdirSync(teamDir, { recursive: true });
    }
    
    let fullPath = filePath.startsWith('projects/')
      ? join(teamDir, filePath)
      : join(teamDir, 'projects', filePath);

    // 安全检查
    if (!fullPath.startsWith(teamDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }

    const body = await readBody(req);
    const { content = '', isDirectory = false } = JSON.parse(body);

    if (isDirectory) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`[API] Created directory: ${filePath}`);
    } else {
      const existedBeforeWrite = existsSync(fullPath);
      const previousContent =
        /(^|\/)PROJECT\.md$/i.test(filePath) && existsSync(fullPath)
          ? readFileSync(fullPath, 'utf-8')
          : '';
      const lastSlash = fullPath.lastIndexOf('/');
      if (lastSlash > 0) {
        const dir = fullPath.substring(0, lastSlash);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }
      writeFileSync(fullPath, content, 'utf-8');
      console.log(`[API] Wrote file: ${filePath}`);
      if (/(^|\/)PROJECT\.md$/i.test(filePath)) {
        const projectId = inferProjectIdFromFilePath(filePath);
        const previousState = parseProjectMarkdown(previousContent);
        const projectState = parseProjectMarkdown(content);
        if (projectId) {
          const recorder = getHarnessRunRecorder();
          recorder.recordProjectStateChanged({
            teamId,
            projectId,
            counts: projectState.counts,
            taskIds: projectState.tasks.map(task => task.id),
          });

          const changedTasks = diffProjectTasks(previousState, projectState);
          for (const change of changedTasks) {
            recorder.recordTaskStatusUpdated({
              teamId,
              projectId,
              task: change.task,
              previousStatus: change.previousStatus,
            });
          }
        }
        if (hasStructuredTaskClosure(projectState)) {
          const completedRun = getHarnessRunRecorder().completeLatestActiveRunForTeam({
            teamId,
            completedBy: 'system',
            reason: 'task_closure',
            projectId,
          });
          if (completedRun) {
            console.log(
              `[Harness] Completed run by task closure: ${completedRun.runId} (todo=${projectState.counts.todo}, active=${projectState.counts.active}, blocked=${projectState.counts.blocked}, done=${projectState.counts.done})`
            );
          }
        }
      } else if (!existedBeforeWrite) {
        const artifact = inferProjectArtifactPath(filePath);
        if (artifact) {
          getHarnessRunRecorder().recordArtifactCreated({
            teamId,
            projectId: artifact.projectId,
            artifactPath: artifact.artifactPath,
            title: artifact.artifactPath.split('/').pop() || artifact.artifactPath,
          });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: filePath, isDirectory }));
  } catch (err) {
    console.error('[API] Failed to write file:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * DELETE /api/teams/:id/files/* - 删除文件
 */
async function handleDeleteFile(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  filePath: string
): Promise<void> {
  try {
    const teamDir = getTeamDir(teamId);
    let fullPath = filePath.startsWith('projects/')
      ? join(teamDir, filePath)
      : join(teamDir, 'projects', filePath);

    // 安全检查
    if (!fullPath.startsWith(teamDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }

    if (existsSync(fullPath)) {
      const stats = statSync(fullPath);
      if (stats.isDirectory()) {
        rmSync(fullPath, { recursive: true });
      } else {
        rmSync(fullPath);
      }
      console.log(`[API] Deleted: ${filePath}`);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error('[API] Failed to delete file:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/teams/:id/rename - 重命名文件
 */
async function handleRenameFile(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<void> {
  try {
    const body = await readBody(req);
    const { oldPath, newName } = JSON.parse(body);

    const teamDir = getTeamDir(teamId);
    let fullOldPath = oldPath.startsWith('projects/')
      ? join(teamDir, oldPath)
      : join(teamDir, 'projects', oldPath);

    const parentDir = fullOldPath.substring(0, fullOldPath.lastIndexOf('/'));
    const fullNewPath = join(parentDir, newName);

    // 安全检查
    if (!fullOldPath.startsWith(teamDir) || !fullNewPath.startsWith(teamDir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
      return;
    }

    if (!existsSync(fullOldPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'File not found' }));
      return;
    }

    renameSync(fullOldPath, fullNewPath);
    console.log(`[API] Renamed: ${oldPath} -> ${newName}`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, newPath: oldPath.replace(/[^/]+$/, newName) }));
  } catch (err) {
    console.error('[API] Failed to rename file:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * 递归读取目录
 */
function readDirRecursive(dir: string, basePath: string, files: any[]) {
  if (!existsSync(dir)) return;
  
  const items = readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = join(dir, item.name);
    const relativePath = `${basePath}/${item.name}`;
    
    if (item.isDirectory()) {
      files.push({ name: item.name, path: relativePath, type: 'dir' });
      readDirRecursive(fullPath, relativePath, files);
    } else {
      files.push({
        name: item.name,
        path: relativePath,
        type: 'file',
        ext: item.name.split('.').pop() || '',
      });
    }
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
