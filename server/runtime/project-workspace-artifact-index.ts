import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { createHash } from 'crypto';
import type { TaskFact } from '../../core/runtime/blackboard-types.js';
import { TEAMS_DIR } from '../utils/paths.js';

export interface ProjectWorkspaceArtifactIndexResult {
  indexed: boolean;
  reason: string;
  projectId?: string;
  projectDir?: string;
  projectMdPath?: string;
  requestResultsDir?: string;
  mirroredFiles: string[];
}

function safeSegment(value: string | null | undefined, fallback: string): string {
  const normalized = String(value || '').trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (normalized || fallback).slice(0, 96);
}

function hashId(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function compactText(value: string | null | undefined, max = 140): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function markdownLink(fromDir: string, targetPath: string, label: string): string {
  const rel = relative(fromDir, targetPath).split('/').map(encodeURIComponent).join('/');
  return `[${label}](./${rel})`;
}

function defaultProjectMd(projectId: string): string {
  return [
    `# PROJECT.md — ${projectId}`,
    '',
    '## 项目概述',
    '',
    '（项目描述）',
    '',
    '## 关键结果索引',
    '',
    '（暂无关键结果）',
    '',
    '---',
    '',
    '## #ACTIVE 进行中',
    '',
    '（暂无任务）',
    '',
    '---',
    '',
    '## #TODO 待开始',
    '',
    '（暂无任务）',
    '',
    '---',
    '',
    '## #DONE 已完成',
    '',
    '（暂无任务）',
    '',
    '---',
    '',
    '## #BLOCKED 阻塞',
    '',
    '（暂无任务）',
    '',
  ].join('\n');
}

function ensureProjectMd(projectMdPath: string, projectId: string): void {
  if (!existsSync(projectMdPath)) {
    writeFileSync(projectMdPath, defaultProjectMd(projectId), 'utf8');
  }
}

function ensureResultIndexSection(content: string): string {
  if (/^## 关键结果索引\s*$/m.test(content)) {
    return content;
  }
  const insertion = [
    '## 关键结果索引',
    '',
    '（暂无关键结果）',
    '',
    '---',
    '',
  ].join('\n');
  const activeMatch = content.match(/^## #ACTIVE 进行中\s*$/m);
  if (activeMatch?.index != null) {
    return `${content.slice(0, activeMatch.index)}${insertion}${content.slice(activeMatch.index)}`;
  }
  return `${content.replace(/\s*$/, '\n\n')}${insertion}`;
}

function replaceRequestBlock(content: string, requestId: string, block: string): string {
  const start = `<!-- openteam:request-artifacts:${requestId} -->`;
  const end = `<!-- /openteam:request-artifacts:${requestId} -->`;
  const nextBlock = `${start}\n${block.trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);
  if (pattern.test(content)) {
    return content.replace(pattern, nextBlock);
  }
  const section = /^## 关键结果索引\s*$/m.exec(content);
  if (!section || section.index == null) {
    return `${content.replace(/\s*$/, '\n\n')}${nextBlock}\n`;
  }
  const insertAt = section.index + section[0].length;
  const before = content.slice(0, insertAt);
  const after = content.slice(insertAt).replace(/\n（暂无关键结果）\n?/, '\n');
  return `${before}\n\n${nextBlock}${after.startsWith('\n') ? after : `\n${after}`}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function copyReadableArtifact(args: {
  sourcePath: string;
  requestResultsDir: string;
  task: Pick<TaskFact, 'id' | 'owner'>;
  kind: string;
}): string | null {
  const sourcePath = String(args.sourcePath || '').trim();
  if (!sourcePath || !existsSync(sourcePath)) {
    return null;
  }
  const stat = statSync(sourcePath);
  if (!stat.isFile() || stat.size > 2_000_000) {
    return null;
  }
  const ext = basename(sourcePath).includes('.') ? basename(sourcePath).replace(/^.*(\.[^.]+)$/, '$1') : '.md';
  if (!/^\.(md|markdown|txt|json)$/i.test(ext)) {
    return null;
  }
  const owner = safeSegment(args.task.owner || 'agent', 'agent');
  const fileName = `${owner}-${hashId(`${args.task.id}:${sourcePath}:${args.kind}`)}-${safeSegment(args.kind, 'artifact')}${ext}`;
  const targetPath = join(args.requestResultsDir, fileName);
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function candidateArtifactPaths(task: TaskFact): Array<{ path: string; kind: string }> {
  const root = String(task.executionScope.artifactsRoot || '').trim();
  const resultRef = String(task.resultRef || '').trim();
  const candidates: Array<{ path: string; kind: string }> = [];
  if (root) {
    candidates.push({ path: join(root, 'summary.md'), kind: 'summary' });
    candidates.push({ path: join(root, 'report.md'), kind: 'report' });
  }
  if (resultRef && existsSync(resultRef)) {
    const stat = statSync(resultRef);
    if (stat.isFile()) {
      candidates.push({ path: resultRef, kind: basename(resultRef).replace(/\.[^.]+$/, '') || 'result' });
    } else if (stat.isDirectory()) {
      candidates.push({ path: join(resultRef, 'summary.md'), kind: 'summary' });
      candidates.push({ path: join(resultRef, 'report.md'), kind: 'report' });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = resolve(candidate.path);
    if (seen.has(resolved)) {
      return false;
    }
    seen.add(resolved);
    return true;
  });
}

function inferProjectIdFromTasks(tasks: TaskFact[]): string | null {
  for (const task of tasks) {
    const cwd = String(task.executionScope.cwd || '').trim();
    const match = cwd.match(/\/teams\/[^/]+\/projects\/([^/]+)/);
    if (match?.[1]) {
      return match[1];
    }
  }
  for (const task of tasks) {
    const workspaceId = String(task.executionScope.workspaceId || '').trim();
    if (workspaceId && workspaceId !== 'local' && !workspaceId.includes(':') && !workspaceId.includes('/')) {
      return workspaceId;
    }
  }
  return null;
}

function resolveProjectDir(teamId: string, projectId: string): string | null {
  const safeProjectId = safeSegment(projectId, '');
  if (!safeProjectId || safeProjectId !== projectId) {
    return null;
  }
  const projectsRoot = resolve(TEAMS_DIR, teamId, 'projects');
  const projectDir = resolve(projectsRoot, safeProjectId);
  if (!projectDir.startsWith(`${projectsRoot}/`) && projectDir !== projectsRoot) {
    return null;
  }
  return projectDir;
}

export function indexRequestProjectArtifacts(args: {
  teamId: string;
  requestId: string;
  tasks: TaskFact[];
  projectId?: string | null;
  finalAnswer?: string | null;
  now?: Date;
}): ProjectWorkspaceArtifactIndexResult {
  const requestId = String(args.requestId || '').trim();
  const projectId = String(args.projectId || inferProjectIdFromTasks(args.tasks) || '').trim();
  if (!requestId) {
    return { indexed: false, reason: 'missing requestId', mirroredFiles: [] };
  }
  if (!projectId) {
    return { indexed: false, reason: 'missing projectId', mirroredFiles: [] };
  }
  const projectDir = resolveProjectDir(args.teamId, projectId);
  if (!projectDir) {
    return { indexed: false, reason: `unsafe projectId: ${projectId}`, projectId, mirroredFiles: [] };
  }

  const projectMdPath = join(projectDir, 'PROJECT.md');
  const requestResultsDir = join(projectDir, 'results', safeSegment(requestId, 'request'));
  mkdirSync(requestResultsDir, { recursive: true });
  ensureProjectMd(projectMdPath, projectId);

  const mirroredFiles: string[] = [];
  const taskLines: string[] = [];
  const sortedTasks = args.tasks
    .filter((task) => task.requestId === requestId)
    .filter((task) => task.status === 'done' || task.status === 'failed' || task.status === 'blocked')
    .sort((left, right) => left.id.localeCompare(right.id));

  for (const task of sortedTasks) {
    const links: string[] = [];
    for (const candidate of candidateArtifactPaths(task)) {
      const mirrored = copyReadableArtifact({
        sourcePath: candidate.path,
        requestResultsDir,
        task,
        kind: candidate.kind,
      });
      if (mirrored) {
        mirroredFiles.push(mirrored);
        links.push(markdownLink(projectDir, mirrored, candidate.kind));
      }
    }
    if (links.length === 0 && task.status === 'done' && String(task.result || '').trim()) {
      const owner = safeSegment(task.owner || 'agent', 'agent');
      const fallbackPath = join(requestResultsDir, `${owner}-${hashId(task.id)}-result.md`);
      writeFileSync(fallbackPath, `# ${task.id}\n\n${String(task.result).trim()}\n`, 'utf8');
      mirroredFiles.push(fallbackPath);
      links.push(markdownLink(projectDir, fallbackPath, 'result'));
    }
    const status = task.status === 'done' ? 'done' : task.status;
    const owner = String(task.owner || 'unassigned').trim() || 'unassigned';
    const note = compactText(task.result || task.blockedBy?.message || task.goal);
    taskLines.push(`- ${owner} \`${task.id}\`: ${status}${links.length ? `；${links.join(' / ')}` : ''}${note ? `；${note}` : ''}`);
  }

  let finalLink = '';
  if (String(args.finalAnswer || '').trim()) {
    const finalPath = join(requestResultsDir, 'final-answer.md');
    writeFileSync(finalPath, `# Final Answer — ${requestId}\n\n${String(args.finalAnswer).trim()}\n`, 'utf8');
    mirroredFiles.push(finalPath);
    finalLink = `- final: ${markdownLink(projectDir, finalPath, 'final-answer')}`;
  }

  const indexPath = join(requestResultsDir, 'index.md');
  const blockLines = [
    `### ${requestId}`,
    '',
    `- updatedAt: ${(args.now || new Date()).toISOString()}`,
    finalLink,
    ...taskLines,
  ].filter(Boolean);
  writeFileSync(indexPath, `# Request Results — ${requestId}\n\n${blockLines.join('\n')}\n`, 'utf8');
  mirroredFiles.push(indexPath);
  blockLines.splice(2, 0, `- index: ${markdownLink(projectDir, indexPath, 'results/index.md')}`);

  const existing = readFileSync(projectMdPath, 'utf8');
  const withSection = ensureResultIndexSection(existing);
  const next = replaceRequestBlock(withSection, requestId, blockLines.join('\n'));
  if (next !== existing) {
    writeFileSync(projectMdPath, next, 'utf8');
  }

  return {
    indexed: true,
    reason: 'indexed request artifacts into project workspace',
    projectId,
    projectDir,
    projectMdPath,
    requestResultsDir,
    mirroredFiles,
  };
}
