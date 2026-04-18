import type { MemberConfig } from '../../../core/team/types.js';

export interface TeamChatFastPathMatchInput {
  body: string;
  targetAgentId: string;
  members: MemberConfig[];
}

export interface TeamChatFastPathResolution {
  kind: string;
  replyBody: string;
  tags?: string[];
}

export interface TeamChatFastPathDefinition {
  enabled: boolean;
  match(input: TeamChatFastPathMatchInput): boolean;
  buildReply(input: TeamChatFastPathMatchInput): TeamChatFastPathResolution;
}

export interface TeamChatPolicy {
  teamId: string;
  conversation: {
    introCollectorWindowMs: number;
  };
  fastPaths: {
    memberIntro?: TeamChatFastPathDefinition;
  };
}
