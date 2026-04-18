import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  BACKEND_CATALOG,
  DEFAULT_BACKEND,
  isBackendType,
  normalizeBackendType,
} from '../../../core/runtime/backend-catalog.js';
import { error, sendJson, success } from '../../utils/response.js';
import { validateTeamId } from '../../utils/validation.js';
import { TeamRegistry, registerTeam } from '../../../core/team/registry.js';
import type { RuntimeType, TeamConfig } from '../../../core/team/types.js';
import { listConfiguredLlmEndpoints, loadOpenTeamConfig } from '../../utils/openteam-config.js';
import {
  createTeamConfig,
  createTeamManifest,
  ensureAgentExists,
  ensureTeamDirs,
  getManifestPath,
  getTeamConfigPath,
  getTeamDir,
  readManifest,
  readRequestBody,
  type TeamCreateRequest,
  type TeamUpdateRequest,
} from './shared.js';
import { TEAMS_DIR } from '../../utils/paths.js';
import type { TeamManifest } from '../../../core/types/index.js';
import { getLLMHealth } from '../llm.js';

function normalizeRuntimeConfig(runtime: TeamConfig['runtime'] | undefined): NonNullable<TeamConfig['runtime']> {
  if (!runtime) {
    return { backend: DEFAULT_BACKEND };
  }

  const backend = normalizeBackendType(runtime.backend ?? runtime.type, DEFAULT_BACKEND);
  const { type: _legacyType, ...rest } = runtime;
  return {
    ...rest,
    backend,
  };
}

type RuntimeHealth = {
  status: 'ok' | 'error' | 'unknown';
  endpoint: string | null;
  model?: string | null;
  message: string | null;
  fallbackUsed?: boolean;
  checkedCandidates?: Array<{ endpoint: string; model: string; ok: boolean; message: string | null }>;
  checkedAt: string;
};

async function probeRuntimeHealth(runtime: TeamConfig['runtime'] | undefined): Promise<RuntimeHealth> {
  const normalized = normalizeRuntimeConfig(runtime);
  const backend = normalized.backend ?? null;
  const config = loadOpenTeamConfig();
  const llmCandidates = listConfiguredLlmEndpoints(config);
  const primary = llmCandidates[0] ?? null;
  const endpoint = primary?.baseUrl?.trim() || null;
  const checkedAt = new Date().toISOString();

  if (backend !== 'codex' || !endpoint) {
    return {
      status: 'unknown',
      endpoint,
      model: primary?.model || null,
      message: endpoint ? null : 'No model endpoint configured',
      checkedAt,
    };
  }

  const health = await getLLMHealth({
    force: true,
    timeoutMs: 1_500,
    probeMode: 'models',
  });
  const checkedCandidates = (health.checkedCandidates ?? []).map((candidate) => ({
    endpoint: candidate.baseUrl,
    model: candidate.modelName,
    ok: candidate.ok,
    message: candidate.error ?? null,
  }));

  if (health.ok) {
    return {
      status: 'ok',
      endpoint: health.baseUrl,
      model: health.modelName,
      message: null,
      fallbackUsed: health.fallbackUsed,
      checkedCandidates,
      checkedAt: health.checkedAt ?? checkedAt,
    };
  }

  return {
    status: 'error',
    endpoint,
    model: primary?.model || null,
    message: health.error ?? checkedCandidates.at(-1)?.message ?? 'All configured model endpoints failed',
    fallbackUsed: health.fallbackUsed ?? false,
    checkedCandidates,
    checkedAt: health.checkedAt ?? checkedAt,
  };
}

export async function handleListTeams(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    ensureTeamDirs();

    const teams: any[] = [];
    const teamDirs = readdirSync(TEAMS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const teamId of teamDirs) {
      const manifest = readManifest(teamId);
      if (!manifest) {
        continue;
      }
      const configPath = getTeamConfigPath(teamId);
      let members: any[] = [];

      if (existsSync(configPath)) {
        try {
          const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
          if (Array.isArray(teamConfig.members)) {
            members = teamConfig.members;
          }
        } catch (parseError) {
          console.warn(`[API] Failed to parse team.config.json for ${teamId}:`, parseError);
        }
      }

      if (members.length === 0 && Array.isArray(manifest.agents)) {
        members = manifest.agents;
      }

      let runtime: TeamConfig['runtime'] | undefined;
      if (existsSync(configPath)) {
        try {
          const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
          runtime = normalizeRuntimeConfig(teamConfig.runtime);
        } catch (parseError) {
          console.warn(`[API] Failed to parse team.config.json runtime for ${teamId}:`, parseError);
        }
      }

      teams.push({
        id: teamId,
        name: manifest.name || teamId,
        type: manifest.type || 'dev',
        icon: manifest.icon || '⬡',
        description: manifest.description || '',
        members,
        template: manifest.template,
        manifest,
        runtime,
        path: getTeamDir(teamId),
      });
    }

    sendJson(res, 200, success(teams));
  } catch (err) {
    console.error('[API] Failed to list teams:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleGetTeam(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const manifest = readManifest(teamId);
    if (!manifest) {
      sendJson(res, 404, error('Team not found'));
      return;
    }

    const configPath = getTeamConfigPath(teamId);
    let members: any[] = [];
    if (existsSync(configPath)) {
      try {
        const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (Array.isArray(teamConfig.members)) {
          members = teamConfig.members;
        }
      } catch (parseError) {
        console.warn(`[API] Failed to parse team.config.json for ${teamId}:`, parseError);
      }
    }

    if (members.length === 0 && Array.isArray(manifest.agents)) {
      members = manifest.agents;
    }

    let runtime: TeamConfig['runtime'] | undefined;
    if (existsSync(configPath)) {
      try {
        const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
        runtime = normalizeRuntimeConfig(teamConfig.runtime);
      } catch (parseError) {
        console.warn(`[API] Failed to parse team.config.json runtime for ${teamId}:`, parseError);
      }
    }

    const manifestWithMembers = { ...manifest, members };
    sendJson(res, 200, success({
      id: teamId,
      name: manifest.name || teamId,
      type: manifest.type || 'dev',
      icon: manifest.icon || '⬡',
      description: manifest.description || '',
      members,
      template: manifest.template,
      manifest: manifestWithMembers,
      runtime,
      path: getTeamDir(teamId),
    }));
  } catch (err) {
    console.error('[API] Failed to get team:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleCreateTeam(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    ensureTeamDirs();

    const teamRequest = JSON.parse(await readRequestBody(req)) as TeamCreateRequest;
    const validationError = validateTeamId(teamRequest.id);
    if (validationError) {
      sendJson(res, 400, error(validationError));
      return;
    }
    if (!teamRequest.name) {
      sendJson(res, 400, error('Team name is required'));
      return;
    }

    for (const agentId of teamRequest.members) {
      if (!ensureAgentExists(agentId)) {
        sendJson(res, 400, error(`Agent not found: ${agentId}`));
        return;
      }
    }

    const teamDir = getTeamDir(teamRequest.id);
    mkdirSync(teamDir, { recursive: true });
    mkdirSync(join(teamDir, 'projects'), { recursive: true });

    writeFileSync(join(teamDir, 'manifest.json'), JSON.stringify(createTeamManifest(teamRequest), null, 2), 'utf-8');
    writeFileSync(getTeamConfigPath(teamRequest.id), JSON.stringify(createTeamConfig(teamRequest), null, 2), 'utf-8');

    console.log(`[API] Created team: ${teamRequest.name} (${teamRequest.id})`);
    console.log(`[API] Team members: ${teamRequest.members.join(', ')}`);

    sendJson(res, 201, success({
      id: teamRequest.id,
      name: teamRequest.name,
      path: teamDir,
      members: teamRequest.members,
    }));
  } catch (err) {
    console.error('[API] Failed to create team:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleDeleteTeam(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const teamDir = getTeamDir(teamId);
    if (existsSync(teamDir)) {
      rmSync(teamDir, { recursive: true });
      console.log(`[API] Deleted team: ${teamId}`);
    }
    sendJson(res, 200, success({ id: teamId }));
  } catch (err) {
    console.error('[API] Failed to delete team:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleUpdateTeam(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const manifestPath = getManifestPath(teamId);
    if (!existsSync(manifestPath)) {
      sendJson(res, 404, error('Team not found'));
      return;
    }

    const teamRequest = JSON.parse(await readRequestBody(req)) as TeamUpdateRequest;
    if (teamRequest.members) {
      for (const agentId of teamRequest.members) {
        if (!ensureAgentExists(agentId)) {
          sendJson(res, 400, error(`Agent not found: ${agentId}`));
          return;
        }
      }
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as TeamManifest;
    if (teamRequest.name) manifest.name = teamRequest.name;
    if (teamRequest.type) manifest.type = teamRequest.type;
    if (teamRequest.icon) manifest.icon = teamRequest.icon;
    if (teamRequest.description) manifest.description = teamRequest.description;
    if (teamRequest.template) manifest.template = teamRequest.template;
    if (teamRequest.members) manifest.agents = teamRequest.members;

    if (teamRequest.manifest) {
      for (const [key, value] of Object.entries(teamRequest.manifest)) {
        (manifest as any)[key] = value;
      }
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    console.log(`[API] Updated team: ${teamId}`);

    sendJson(res, 200, success({
      id: teamId,
      name: manifest.name,
      members: manifest.agents,
      manifest,
    }));
  } catch (err) {
    console.error('[API] Failed to update team:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleGetTeamRuntime(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const configPath = getTeamConfigPath(teamId);
    if (!existsSync(configPath)) {
      sendJson(res, 404, error('Team config not found'));
      return;
    }

    const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
    const runtime = normalizeRuntimeConfig(teamConfig.runtime);
    sendJson(res, 200, success({
      teamId,
      runtime,
      health: await probeRuntimeHealth(runtime),
      availableBackends: BACKEND_CATALOG.map((item) => item.id),
      catalog: BACKEND_CATALOG,
    }));
  } catch (err) {
    console.error('[API] Failed to get team runtime:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleUpdateTeamRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const configPath = getTeamConfigPath(teamId);
    if (!existsSync(configPath)) {
      sendJson(res, 404, error('Team config not found'));
      return;
    }

    const body = JSON.parse(await readRequestBody(req)) as {
      backend?: RuntimeType;
      type?: RuntimeType;
      mode?: TeamConfig['runtime'] extends { mode?: infer T } ? T : never;
      tools?: TeamConfig['runtime'] extends { tools?: infer T } ? T : never;
    };

    const backend = body.backend ?? body.type;
    if (!isBackendType(backend)) {
      sendJson(res, 400, error('Invalid backend'));
      return;
    }

    const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
    const updatedConfig: TeamConfig = {
      ...teamConfig,
      runtime: {
        ...normalizeRuntimeConfig(teamConfig.runtime),
        ...(body.mode ? { mode: body.mode } : {}),
        ...(body.tools ? { tools: body.tools } : {}),
        backend,
      },
    };
    delete updatedConfig.runtime?.type;

    writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2), 'utf-8');
    registerTeam(TeamRegistry.fromFile(configPath));

    const runtime = normalizeRuntimeConfig(updatedConfig.runtime);
    sendJson(res, 200, success({
      teamId,
      runtime,
      health: await probeRuntimeHealth(runtime),
      availableBackends: BACKEND_CATALOG.map((item) => item.id),
      catalog: BACKEND_CATALOG,
    }));
  } catch (err) {
    console.error('[API] Failed to update team runtime:', err);
    sendJson(res, 500, error(String(err)));
  }
}
