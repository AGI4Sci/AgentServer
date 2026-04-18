import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { reloadTeamRegistry } from '../../../core/team/registry.js';
import { getSoulStore } from '../../../core/store/soul-store.js';
import { error, sendJson, success } from '../../utils/response.js';
import {
  ensureTeamDirs,
  getManifestPath,
  getTeamConfigPath,
  readRequestBody,
} from './shared.js';

export async function handleGetMembers(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const configPath = getTeamConfigPath(teamId);
    if (!existsSync(configPath)) {
      sendJson(res, 200, success({
        version: '2.0',
        members: [],
        coordinator: null,
      }));
      return;
    }

    const teamConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    const registeredAgents = getSoulStore().listAgents();
    const registeredById = new Map(registeredAgents.map((agent) => [agent.id, agent]));

    const filteredMembers = (Array.isArray(teamConfig.members) ? teamConfig.members : [])
      .filter((member: any) => typeof member?.id === 'string' && registeredById.has(member.id))
      .map((member: any) => {
        const registered = registeredById.get(member.id);
        const soul = registered?.soul;
        const runtime = soul?.runtime;
        return {
          ...member,
          name: member.name || soul?.name || member.id,
          roleName: member.roleName || soul?.role || (member.roleType === 'coordinator' ? 'Coordinator' : 'Executor'),
          skills: Array.isArray(member.skills)
            ? member.skills
            : (Array.isArray(runtime?.skills) ? runtime.skills : []),
        };
      });

    const coordinator = filteredMembers.find((member: any) => member.roleType === 'coordinator');

    sendJson(res, 200, success({
      version: teamConfig.version || '2.0',
      members: filteredMembers,
      coordinator: coordinator?.id || null,
    }));
  } catch (err) {
    console.error('[API] Failed to get members:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleUpdateMembers(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    ensureTeamDirs();

    const configPath = getTeamConfigPath(teamId);
    const manifestPath = getManifestPath(teamId);

    let teamConfig: any = {};
    if (existsSync(configPath)) {
      teamConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    }

    const { members } = JSON.parse(await readRequestBody(req));
    if (!Array.isArray(members)) {
      sendJson(res, 400, error('members must be an array'));
      return;
    }

    const coordinators = members.filter((member: any) => member.roleType === 'coordinator');
    if (coordinators.length === 0) {
      sendJson(res, 400, error('Team must have exactly one coordinator'));
      return;
    }
    if (coordinators.length > 1) {
      sendJson(res, 400, error(`Team can only have one coordinator, found ${coordinators.length}`));
      return;
    }

    teamConfig.version = '2.0';
    teamConfig.id = teamConfig.id || teamId;
    teamConfig.name = teamConfig.name || teamId;
    teamConfig.members = members;
    delete teamConfig.entry;
    delete teamConfig.communication;

    writeFileSync(configPath, JSON.stringify(teamConfig, null, 2), 'utf-8');

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      manifest.agents = members.map((member: any) => member.id);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
    }

    reloadTeamRegistry(teamId);

    console.log(`[API] Updated members for ${teamId}: ${members.length} members, coordinator: ${coordinators[0].id}`);
    sendJson(res, 200, success({
      version: '2.0',
      members,
      coordinator: coordinators[0].id,
    }));
  } catch (err) {
    console.error('[API] Failed to update members:', err);
    sendJson(res, 500, error(String(err)));
  }
}
