import type { MemberConfig } from '../../../core/team/types.js';
import type { TeamChatFastPathMatchInput, TeamChatPolicy } from './types.js';

const memberIntroPatterns = [
  /让团队成员介绍自己/,
  /让团队成员自我介绍/,
  /请团队成员介绍自己/,
  /请大家自我介绍/,
  /团队成员.*介绍一下自己/,
  /介绍一下团队成员/,
  /介绍一下你们团队成员/,
];

function formatRole(member: MemberConfig): string {
  return member.roleName || (member.roleType === 'coordinator' ? 'Coordinator' : 'Executor');
}

function buildRosterReply(members: MemberConfig[]): string {
  const lines = ['团队成员如下：'];
  for (const member of members) {
    const name = member.name || member.id;
    lines.push(`- ${name}（${member.id}，${formatRole(member)}）`);
  }
  lines.push('如果你想让某位成员详细展开，我可以继续按成员分别介绍。');
  return lines.join('\n');
}

function isCoordinatorTarget(input: TeamChatFastPathMatchInput): boolean {
  return input.members.some((member) => member.id === input.targetAgentId && member.roleType === 'coordinator');
}

function hasIntroIntent(body: string): boolean {
  const text = String(body || '').trim();
  return memberIntroPatterns.some((pattern) => pattern.test(text));
}

export const vibeCodingTeamChatPolicy: TeamChatPolicy = {
  teamId: 'vibe-coding',
  conversation: {
    introCollectorWindowMs: 3000,
  },
  fastPaths: {
    memberIntro: {
      enabled: true,
      match(input) {
        return isCoordinatorTarget(input) && hasIntroIntent(input.body) && input.members.length > 0;
      },
      buildReply(input) {
        return {
          kind: 'member_intro',
          replyBody: buildRosterReply(input.members),
          tags: ['fast-path', 'intro', 'team-roster'],
        };
      },
    },
  },
};
