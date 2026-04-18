import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import type { IncomingMessage } from 'http';
import { TEAMS_DIR, AGENTS_DIR, PROJECT_ROOT } from '../../utils/paths.js';
import type { TeamManifest } from '../../../core/types/index.js';

export interface TeamCreateRequest {
  id: string;
  name: string;
  type: 'dev' | 'research' | 'business' | 'creative' | 'ops';
  icon: string;
  description: string;
  members: string[];
  template?: string;
}

export interface TeamUpdateRequest {
  name?: string;
  type?: 'dev' | 'research' | 'business' | 'creative' | 'ops';
  icon?: string;
  description?: string;
  members?: string[];
  template?: string;
  manifest?: Partial<TeamManifest>;
}

export function ensureTeamDirs(): void {
  if (!existsSync(TEAMS_DIR)) {
    mkdirSync(TEAMS_DIR, { recursive: true });
  }
}

export function getTeamDir(teamId: string): string {
  const directPath = join(TEAMS_DIR, teamId);
  const directConfigPath = join(directPath, 'team.config.json');
  const directManifestPath = join(directPath, 'manifest.json');
  if (
    existsSync(directPath)
    && (existsSync(directConfigPath) || existsSync(directManifestPath))
  ) {
    return directPath;
  }

  if (!existsSync(TEAMS_DIR)) {
    return directPath;
  }

  for (const entry of readdirSync(TEAMS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidateDir = join(TEAMS_DIR, entry.name);
    const configPath = join(candidateDir, 'team.config.json');
    const manifestPath = join(candidateDir, 'manifest.json');

    try {
      const configId = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, 'utf-8'))?.id
        : null;
      if (configId === teamId) {
        return candidateDir;
      }

      const manifestId = existsSync(manifestPath)
        ? JSON.parse(readFileSync(manifestPath, 'utf-8'))?.id
        : null;
      if (manifestId === teamId) {
        return candidateDir;
      }
    } catch {
      // Ignore malformed entries and keep scanning for a matching team id alias.
    }
  }

  return directPath;
}

export function getManifestPath(teamId: string): string {
  return join(getTeamDir(teamId), 'manifest.json');
}

export function getTeamSkillsDir(teamId: string): string {
  const skillFilePath = resolveSharedTeamSkillFilePath(teamId);
  if (skillFilePath) {
    return dirname(skillFilePath);
  }
  const sharedSkillDir = resolveSharedTeamSkillsDir(teamId);
  if (sharedSkillDir) {
    return sharedSkillDir;
  }
  const teamDir = getTeamDir(teamId);
  const toolsDir = join(teamDir, 'tools');
  if (existsSync(toolsDir)) {
    return toolsDir;
  }
  return join(teamDir, 'skills');
}

function resolveSharedTeamSkillsDir(teamId: string): string | null {
  const mapped = {
    'vibe-coding': join(PROJECT_ROOT, 'skills', 'vibe-coding-single'),
  } as const;
  const dir = mapped[teamId as keyof typeof mapped];
  return dir && existsSync(dir) ? dir : null;
}

export function getTeamSkillFilePath(teamId: string): string {
  const sharedFile = resolveSharedTeamSkillFilePath(teamId);
  if (sharedFile) {
    return sharedFile;
  }
  return join(getTeamSkillsDir(teamId), 'SKILL.md');
}

export function getTeamSkillDisplayPath(teamId: string): string {
  const sharedFile = resolveSharedTeamSkillFilePath(teamId);
  if (sharedFile) {
    return `skills/${teamId === 'vibe-coding' ? 'vibe-coding-single' : teamId}/SKILL.md`;
  }
  return `/api/teams/${teamId}/skill`;
}

function resolveSharedTeamSkillFilePath(teamId: string): string | null {
  const sharedDir = resolveSharedTeamSkillsDir(teamId);
  if (!sharedDir) {
    return null;
  }
  const file = join(sharedDir, 'SKILL.md');
  return existsSync(file) ? file : null;
}

export function getTeamDesignDir(teamId: string): string {
  return join(getTeamDir(teamId), 'design');
}

export function readManifest(teamId: string): TeamManifest | null {
  const manifestPath = getManifestPath(teamId);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, 'utf-8')) as TeamManifest;
}

export function getTeamConfigPath(teamId: string): string {
  return join(getTeamDir(teamId), 'team.config.json');
}

export function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function ensureAgentExists(agentId: string): boolean {
  return existsSync(join(AGENTS_DIR, agentId));
}

export function createTeamManifest(team: TeamCreateRequest): TeamManifest {
  return {
    id: team.id,
    name: team.name,
    type: team.type,
    icon: team.icon,
    description: team.description,
    template: team.template,
    agents: team.members,
    workflow: {
      phases: [
        { name: '分析', agent: team.members[0], output: 'PROJECT.md', tag: '#TODO' },
        { name: '开发', agents: team.members.slice(1), output: 'debug_{agent}.md', parallel: true },
        { name: '完成', agent: team.members[0], action: 'mark-done' },
      ],
      transitions: [
        { from: team.members[0], to: team.members.slice(1), trigger: 'mention' },
      ],
    },
    config: {
      defaultModel: 'claude-sonnet-4-6',
      tools: { dev: ['shell', 'files', 'github'] },
      filePatterns: { project: 'PROJECT.md', debug: 'debug_{agent}.md' },
    },
  };
}

export function createTeamConfig(team: TeamCreateRequest): {
  version: string;
  id: string;
  name: string;
  members: Array<{ id: string; roleType: string; roleName: string; model: string }>;
} {
  const members = team.members.map((id, index) => ({
    id,
    roleType: index === 0 ? 'coordinator' : 'executor',
    roleName: index === 0 ? 'PM' : 'Member',
    model: 'claude-sonnet-4-6',
  }));

  return {
    version: '2.0',
    id: team.id,
    name: team.name,
    members,
  };
}
