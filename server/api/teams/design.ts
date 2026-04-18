import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import { join } from 'path';
import { error, sendJson, success } from '../../utils/response.js';
import { getTeamDesignDir, readRequestBody } from './shared.js';

function getDesignPath(teamId: string): string {
  return join(getTeamDesignDir(teamId), 'team-design.json');
}

export async function handleGetTeamDesign(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    const designPath = getDesignPath(teamId);
    if (!existsSync(designPath)) {
      sendJson(res, 200, success({
        snapshot: null,
        path: `teams/${teamId}/design/team-design.json`,
      }));
      return;
    }

    const snapshot = JSON.parse(readFileSync(designPath, 'utf-8'));
    sendJson(res, 200, success({
      snapshot,
      path: `teams/${teamId}/design/team-design.json`,
    }));
  } catch (err) {
    console.error('[API] Failed to get team design:', err);
    sendJson(res, 500, error(String(err)));
  }
}

export async function handleSaveTeamDesign(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<void> {
  try {
    const { snapshot } = JSON.parse(await readRequestBody(req));
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      sendJson(res, 400, error('snapshot must be an object'));
      return;
    }

    const designDir = getTeamDesignDir(teamId);
    const designPath = getDesignPath(teamId);

    if (!existsSync(designDir)) {
      mkdirSync(designDir, { recursive: true });
    }

    writeFileSync(designPath, JSON.stringify(snapshot, null, 2), 'utf-8');

    sendJson(res, 200, success({
      snapshot,
      path: `teams/${teamId}/design/team-design.json`,
    }));
  } catch (err) {
    console.error('[API] Failed to save team design:', err);
    sendJson(res, 500, error(String(err)));
  }
}
