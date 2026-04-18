import type { MemberConfig } from '../../../core/team/types.js';
import { vibeCodingTeamChatPolicy } from './vibe-coding.js';
import type { TeamChatFastPathResolution, TeamChatPolicy } from './types.js';

const teamPolicies: Record<string, TeamChatPolicy> = {
  'vibe-coding': vibeCodingTeamChatPolicy,
};

export function resolveTeamChatPolicy(teamId?: string | null): TeamChatPolicy | null {
  if (!teamId) {
    return null;
  }
  return teamPolicies[teamId] || null;
}

export function resolveTeamChatFastPath(input: {
  teamId: string;
  body: string;
  targetAgentId: string;
  members: MemberConfig[];
}): TeamChatFastPathResolution | null {
  const policy = resolveTeamChatPolicy(input.teamId);
  if (!policy) {
    return null;
  }
  const memberIntro = policy.fastPaths.memberIntro;
  if (memberIntro?.enabled && memberIntro.match(input)) {
    return memberIntro.buildReply(input);
  }
  return null;
}

export { vibeCodingTeamChatPolicy };
export type { TeamChatPolicy, TeamChatFastPathDefinition, TeamChatFastPathMatchInput, TeamChatFastPathResolution } from './types.js';
