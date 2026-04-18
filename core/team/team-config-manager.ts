import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { TEAMS_DIR } from '../../server/utils/paths.js';
import type { MemberConfig, TeamConfig } from './types.js';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resolveTeamDir(teamId: string): string | null {
  const directPath = join(TEAMS_DIR, teamId);
  const directConfigPath = join(directPath, 'team.config.json');
  if (existsSync(directConfigPath)) {
    return directPath;
  }

  if (!existsSync(TEAMS_DIR)) {
    return null;
  }

  for (const entry of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateDir = join(TEAMS_DIR, entry.name);
    const configPath = join(candidateDir, 'team.config.json');
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
      if (config.id === teamId) {
        return candidateDir;
      }
    } catch {
      // Ignore malformed configs while scanning.
    }
  }

  return null;
}

export function resolveTeamConfigPath(teamId: string): string | null {
  const teamDir = resolveTeamDir(teamId);
  return teamDir ? join(teamDir, 'team.config.json') : null;
}

export function readTeamConfig(teamId: string): TeamConfig | null {
  const configPath = resolveTeamConfigPath(teamId);
  if (!configPath || !existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf-8')) as TeamConfig;
}

export function writeTeamConfig(teamId: string, config: TeamConfig): void {
  const configPath = resolveTeamConfigPath(teamId);
  if (!configPath) {
    throw new Error(`Team config not found for ${teamId}`);
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function writeTeamMembers(teamId: string, members: MemberConfig[]): TeamConfig {
  const config = readTeamConfig(teamId);
  if (!config) {
    throw new Error(`Team config not found for ${teamId}`);
  }
  const coordinators = members.filter((member) => member.roleType === 'coordinator');
  if (coordinators.length !== 1) {
    throw new Error(`Team ${teamId} must have exactly one coordinator`);
  }
  const next: TeamConfig = {
    ...clone(config),
    version: config.version || '2.0',
    members: clone(members),
  };
  writeTeamConfig(teamId, next);
  const teamDir = resolveTeamDir(teamId);
  if (teamDir) {
    const manifestPath = join(teamDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
        manifest.agents = members.map((member) => member.id);
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
      } catch {
        // Keep team.config.json as source of truth even if manifest sync fails.
      }
    }
  }
  return next;
}
