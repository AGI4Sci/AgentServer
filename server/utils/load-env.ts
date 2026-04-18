import { OPENTEAM_CONFIG_PATH, applyOpenTeamConfigEnv } from './openteam-config.js';

export function loadProjectEnv(_projectRoot: string): { path: string; error?: Error } {
  try {
    applyOpenTeamConfigEnv({ overwrite: true });
    return { path: OPENTEAM_CONFIG_PATH };
  } catch (error) {
    return {
      path: OPENTEAM_CONFIG_PATH,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
