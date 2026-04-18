import type { TeamRegistry } from '../../core/team/registry.js';
import { resolveTeamChatFastPath } from '../../config/chat-policies/teams/index.js';

export interface TeamChatFastPathResult {
  kind: string;
  replyBody: string;
  tags: string[];
}

export function matchTeamChatFastPath(input: {
  teamId: string;
  body: string;
  targetAgentId: string;
  registry?: TeamRegistry;
}): TeamChatFastPathResult | null {
  const members = input.registry?.getMembers() || [];
  const resolved = resolveTeamChatFastPath({
    teamId: input.teamId,
    body: input.body,
    targetAgentId: input.targetAgentId,
    members,
  });
  if (!resolved) {
    return null;
  }
  return {
    kind: resolved.kind,
    replyBody: resolved.replyBody,
    tags: resolved.tags || ['fast-path'],
  };
}
