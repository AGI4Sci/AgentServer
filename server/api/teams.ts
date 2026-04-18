/**
 * Team API 路由
 * GET/POST/PUT/DELETE /api/teams
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { BACKEND_CATALOG } from '../../core/runtime/backend-catalog.js';
import { handleGetTeamDesign, handleSaveTeamDesign } from './teams/design.js';
import { handleGetTeamBlackboard, handleGetTeamBlackboardRequestExplain } from './teams/blackboard.js';
import { handleBlackboardStubRoutes } from './teams/blackboard-stubs.js';
import { handleGetMembers, handleUpdateMembers } from './teams/members.js';
import { handleBuildProjectPreview } from './teams/previews.js';
import { handleCreateProject, handleDeleteProject, handleGetProject, handleListProjects } from './teams/projects.js';
import {
  handleCreateTeam,
  handleDeleteTeam,
  handleGetTeam,
  handleGetTeamRuntime,
  handleListTeams,
  handleUpdateTeam,
  handleUpdateTeamRuntime,
} from './teams/team-crud.js';
import { handleGetTeamStatus } from './teams/status.js';

export async function handleTeamRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _teamsDir: string,
): Promise<boolean> {
  const url = req.url || '/';
  const method = req.method || 'GET';

  if (url === '/api/backends' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      data: {
        defaultBackend: BACKEND_CATALOG[0]?.id || 'claude-code',
        backends: BACKEND_CATALOG,
      },
    }));
    return true;
  }

  if (url === '/api/teams' && method === 'GET') {
    await handleListTeams(req, res);
    return true;
  }

  if (url === '/api/teams' && method === 'POST') {
    await handleCreateTeam(req, res);
    return true;
  }

  const projectsMatch = url.match(/^\/api\/teams\/([^\/]+)\/projects$/);
  if (projectsMatch) {
    const teamId = projectsMatch[1];
    if (method === 'GET') {
      await handleListProjects(req, res, teamId);
      return true;
    }
    if (method === 'POST') {
      await handleCreateProject(req, res, teamId);
      return true;
    }
  }

  const projectDeleteMatch = url.match(/^\/api\/teams\/([^\/]+)\/projects\/([^\/]+)$/);
  if (projectDeleteMatch) {
    const [, teamId, projectId] = projectDeleteMatch;
    if (method === 'GET') {
      await handleGetProject(req, res, teamId, projectId);
      return true;
    }
    if (method === 'DELETE') {
      await handleDeleteProject(req, res, teamId, projectId);
      return true;
    }
  }

  const previewMatch = url.match(/^\/api\/teams\/([^\/]+)\/projects\/([^\/]+)\/preview$/);
  if (previewMatch && method === 'POST') {
    const [, teamId, projectId] = previewMatch;
    await handleBuildProjectPreview(req, res, teamId, projectId);
    return true;
  }

  const statusMatch = url.match(/^\/api\/teams\/([^\/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    await handleGetTeamStatus(req, res, statusMatch[1]);
    return true;
  }

  if (await handleBlackboardStubRoutes(req, res, url, method)) {
    return true;
  }

  const blackboardExplainMatch = url.match(/^\/api\/teams\/([^\/]+)\/blackboard\/requests\/([^\/]+)\/explain(?:\?|$)/);
  if (blackboardExplainMatch && method === 'GET') {
    await handleGetTeamBlackboardRequestExplain(
      req,
      res,
      blackboardExplainMatch[1],
      decodeURIComponent(blackboardExplainMatch[2]),
    );
    return true;
  }

  const blackboardMatch = url.match(/^\/api\/teams\/([^\/]+)\/blackboard(?:\?|$)/);
  if (blackboardMatch && method === 'GET') {
    await handleGetTeamBlackboard(req, res, blackboardMatch[1]);
    return true;
  }

  const membersMatch = url.match(/^\/api\/teams\/([^\/]+)\/members$/);
  if (membersMatch) {
    const teamId = membersMatch[1];
    if (method === 'GET') {
      await handleGetMembers(req, res, teamId);
      return true;
    }
    if (method === 'PUT') {
      await handleUpdateMembers(req, res, teamId);
      return true;
    }
  }

  const designMatch = url.match(/^\/api\/teams\/([^\/]+)\/design$/);
  if (designMatch) {
    const teamId = designMatch[1];
    if (method === 'GET') {
      await handleGetTeamDesign(req, res, teamId);
      return true;
    }
    if (method === 'PUT' || method === 'POST') {
      await handleSaveTeamDesign(req, res, teamId);
      return true;
    }
  }

  const runtimeMatch = url.match(/^\/api\/teams\/([^\/]+)\/runtime$/);
  if (runtimeMatch) {
    const teamId = runtimeMatch[1];
    if (method === 'GET') {
      await handleGetTeamRuntime(req, res, teamId);
      return true;
    }
    if (method === 'PUT') {
      await handleUpdateTeamRuntime(req, res, teamId);
      return true;
    }
  }

  const teamMatch = url.match(/^\/api\/teams\/([^\/]+)$/);
  if (teamMatch) {
    const teamId = teamMatch[1];
    if (method === 'DELETE') {
      await handleDeleteTeam(req, res, teamId);
      return true;
    }
    if (method === 'PUT') {
      await handleUpdateTeam(req, res, teamId);
      return true;
    }
    if (method === 'GET') {
      await handleGetTeam(req, res, teamId);
      return true;
    }
  }

  return false;
}
