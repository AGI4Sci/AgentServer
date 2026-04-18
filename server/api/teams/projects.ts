import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { error, sendJson, success } from '../../utils/response.js';
import { ensureTeamDirs, getTeamDir, readRequestBody } from './shared.js';
import {
  appProjectSchema,
  appSchemaSchema,
  createDefaultAppProject,
  createDefaultAppSchema,
  createDefaultPreviewSession,
  previewSessionSchema,
} from '../../../core/schema/index.js';

function getProjectsDir(teamId: string): string {
  return join(getTeamDir(teamId), 'projects');
}

function getProjectDir(teamId: string, projectId: string): string {
  return join(getProjectsDir(teamId), projectId);
}

export function getProjectMetaPaths(teamId: string, projectId: string) {
  const projectDir = getProjectDir(teamId, projectId);
  return {
    projectDir,
    appProjectPath: join(projectDir, 'app-project.json'),
    appSchemaPath: join(projectDir, 'app-schema.json'),
    previewSessionPath: join(projectDir, 'preview-session.json'),
    projectMdPath: join(projectDir, 'PROJECT.md'),
  };
}

export function readStructuredProject(teamId: string, projectId: string) {
  const paths = getProjectMetaPaths(teamId, projectId);
  if (!existsSync(paths.projectDir)) {
    return null;
  }

  const fallbackStat = statSync(paths.projectDir);
  const project = existsSync(paths.appProjectPath)
    ? appProjectSchema.parse(JSON.parse(readFileSync(paths.appProjectPath, 'utf-8')))
    : createDefaultAppProject({
        id: projectId,
        teamId,
        name: projectId,
      });
  const schema = existsSync(paths.appSchemaPath)
    ? appSchemaSchema.parse(JSON.parse(readFileSync(paths.appSchemaPath, 'utf-8')))
    : createDefaultAppSchema(projectId, project.name);
  const previewSession = existsSync(paths.previewSessionPath)
    ? previewSessionSchema.parse(JSON.parse(readFileSync(paths.previewSessionPath, 'utf-8')))
    : createDefaultPreviewSession(projectId, teamId);

  return {
    ...project,
    path: paths.projectDir,
    createdAt: project.createdAt || fallbackStat.birthtime.toISOString(),
    updatedAt: project.updatedAt || fallbackStat.mtime.toISOString(),
    schema,
    previewSession,
    files: {
      appProject: existsSync(paths.appProjectPath) ? 'app-project.json' : null,
      appSchema: existsSync(paths.appSchemaPath) ? 'app-schema.json' : null,
      previewSession: existsSync(paths.previewSessionPath) ? 'preview-session.json' : null,
      projectMd: existsSync(paths.projectMdPath) ? 'PROJECT.md' : null,
    },
  };
}

function slugifyProjectName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function handleListProjects(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const projectsDir = getProjectsDir(teamId);
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true });
      sendJson(res, 200, success([]));
      return;
    }

    const projects = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readStructuredProject(teamId, entry.name))
      .filter(Boolean)
      .map((project) => ({
        id: project!.id,
        name: project!.name,
        description: project!.description,
        teamId: project!.teamId,
        path: project!.path,
        status: project!.status,
        schemaVersion: project!.schemaVersion,
        previewSessionId: project!.previewSessionId,
        createdAt: project!.createdAt,
        updatedAt: project!.updatedAt,
      }));

    sendJson(res, 200, success(projects));
  } catch (err) {
    console.error('[API] Failed to list projects:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleCreateProject(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const teamDir = getTeamDir(teamId);
    if (!existsSync(teamDir)) {
      sendJson(res, 404, error('Team not found'));
      return;
    }

    const { name } = JSON.parse(await readRequestBody(req));
    if (!name) {
      sendJson(res, 400, error('Project name is required'));
      return;
    }

    const projectsDir = getProjectsDir(teamId);
    if (!existsSync(projectsDir)) {
      mkdirSync(projectsDir, { recursive: true });
    }

    let projectId = slugifyProjectName(name) || `project-${Date.now()}`;
    if (existsSync(join(projectsDir, projectId))) {
      projectId = `${projectId}-${Date.now()}`;
    }

    const projectPath = join(projectsDir, projectId);
    mkdirSync(projectPath, { recursive: true });

    const projectMd = `# PROJECT.md — ${name}

## 项目概述

（项目描述）

---

## #ACTIVE 进行中

（暂无任务）

---

## #TODO 待开始

（暂无任务）

---

## #DONE 已完成

（暂无任务）

---

## #BLOCKED 阻塞

（暂无任务）
`;
    const appProject = createDefaultAppProject({
      id: projectId,
      teamId,
      name,
      description: `${name} App Studio project`,
    });
    const appSchema = createDefaultAppSchema(projectId, name);
    const previewSession = createDefaultPreviewSession(projectId, teamId);

    writeFileSync(join(projectPath, 'PROJECT.md'), projectMd, 'utf-8');
    writeFileSync(join(projectPath, 'app-project.json'), JSON.stringify(appProject, null, 2), 'utf-8');
    writeFileSync(join(projectPath, 'app-schema.json'), JSON.stringify(appSchema, null, 2), 'utf-8');
    writeFileSync(join(projectPath, 'preview-session.json'), JSON.stringify(previewSession, null, 2), 'utf-8');

    console.log(`[API] Created project: ${name} (${projectId}) in team ${teamId}`);
    sendJson(res, 201, success({
      id: projectId,
      name,
      teamId,
      path: projectPath,
      createdAt: new Date().toISOString(),
    }));
  } catch (err) {
    console.error('[API] Failed to create project:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleGetProject(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  projectId: string,
): Promise<void> {
  try {
    ensureTeamDirs();
    const project = readStructuredProject(teamId, projectId);
    if (!project) {
      sendJson(res, 404, error('Project not found'));
      return;
    }

    sendJson(res, 200, success(project));
  } catch (err) {
    console.error('[API] Failed to get project:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleDeleteProject(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  projectId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const projectPath = join(getProjectsDir(teamId), projectId);
    if (!existsSync(projectPath)) {
      sendJson(res, 404, error('Project not found'));
      return;
    }

    rmSync(projectPath, { recursive: true });
    console.log(`[API] Deleted project: ${projectId} in team ${teamId}`);
    sendJson(res, 200, success({ id: projectId, teamId }));
  } catch (err) {
    console.error('[API] Failed to delete project:', err);
    sendJson(res, 500, error(String(err)));
  }
}
