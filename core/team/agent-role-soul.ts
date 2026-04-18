import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { AGENTS_DIR } from '../../server/utils/paths.js';

export interface AgentRoleSoulPayload {
  id?: string;
  name?: string;
  role?: string;
  identity?: string;
  personality?: string;
  mission?: string;
  communication?: string;
  constraints?: string;
  traits?: string[];
  runtime?: {
    model?: string;
    temperature?: number;
    language?: string;
    skills?: string[];
  };
}

export function resolveAgentRoleSoulPath(agentId: string): string {
  return join(AGENTS_DIR, agentId, 'soul.json');
}

export function readAgentRoleSoul(agentId: string): AgentRoleSoulPayload | null {
  const soulPath = resolveAgentRoleSoulPath(agentId);
  if (!existsSync(soulPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(soulPath, 'utf-8')) as AgentRoleSoulPayload;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function renderAgentRoleSoulMarkdown(agentId: string): string {
  const soul = readAgentRoleSoul(agentId);
  if (!soul) {
    return '';
  }
  return [
    `# ${soul.name || agentId}`,
    soul.identity ? `## Identity\n${soul.identity}` : '',
    soul.personality ? `## Personality\n${soul.personality}` : '',
    soul.mission ? `## Mission\n${soul.mission}` : '',
    soul.communication ? `## Communication\n${soul.communication}` : '',
    soul.constraints ? `## Constraints\n${soul.constraints}` : '',
    Array.isArray(soul.traits) && soul.traits.length > 0
      ? `## Traits\n${soul.traits.map((trait) => `- ${trait}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n').trim();
}
