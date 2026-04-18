function normalizeAgentServerIdentityPart(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function resolveHostedAgentServerId(teamId: string | null | undefined, agentId: string | null | undefined): string {
  const normalizedAgentId = normalizeAgentServerIdentityPart(String(agentId || 'agent'));
  const normalizedTeamId = normalizeAgentServerIdentityPart(String(teamId || ''));
  if (!normalizedTeamId) {
    return normalizedAgentId || 'agent';
  }
  return `team-${normalizedTeamId}-${normalizedAgentId || 'agent'}`;
}
