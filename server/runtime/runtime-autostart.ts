import type { TeamRegistry } from '../../core/team/registry.js';
import type { MemberConfig } from '../../core/team/types.js';
import { resolveBackendModelSelection } from './backend-model-contract.js';
import { resolveRuntimeBackend } from './session-runner-registry.js';
import { supportsRuntimeSupervisor } from './team-worker-manager.js';
import { ensureSupervisorSession } from './supervisor-client.js';

function parseExplicitTeamAllowlist(value: string | undefined): Set<string> | null {
  if (!value || !value.trim()) {
    return null;
  }
  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function shouldPrewarmTeam(registry: TeamRegistry): boolean {
  const explicitTeams = parseExplicitTeamAllowlist(process.env.OPENTEAM_RUNTIME_AUTOSTART_TEAMS);
  if (explicitTeams) {
    return explicitTeams.has(registry.id);
  }
  if (process.env.OPENTEAM_RUNTIME_AUTOSTART_ALL_TEAMS === '1') {
    return true;
  }
  return registry.raw.runtime?.startup?.prewarmOnBoot === true;
}

function getTargetMembers(registry: TeamRegistry): MemberConfig[] {
  const configuredMembers = registry.raw.runtime?.startup?.members;
  const requestedMembers = Array.isArray(configuredMembers)
    ? new Set(
        configuredMembers
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean),
      )
    : null;
  return registry.getMembers().filter((member) => !requestedMembers || requestedMembers.has(member.id));
}

export async function prewarmConfiguredTeamRuntimes(registries: TeamRegistry[]): Promise<void> {
  const targetTeams = registries.filter((registry) => shouldPrewarmTeam(registry));
  for (const registry of targetTeams) {
    const runtime = resolveRuntimeBackend(registry.raw.runtime);
    if (!supportsRuntimeSupervisor(runtime)) {
      continue;
    }
    const members = getTargetMembers(registry);
    for (const member of members) {
      const modelSelection = resolveBackendModelSelection(runtime, member);
      await ensureSupervisorSession(runtime, {
        teamId: registry.id,
        agentId: member.id,
        cwd: registry.getTeamDir() || undefined,
        model: modelSelection.modelIdentifier ?? undefined,
        modelProvider: modelSelection.modelProvider ?? undefined,
        modelName: modelSelection.modelName ?? undefined,
        sessionMode: 'persistent',
        persistentKey: `team:${registry.id}:agent:${member.id}`,
        healthcheck: 'launch',
      });
    }
  }
}

export const __testing = {
  parseExplicitTeamAllowlist,
  shouldPrewarmTeam,
  getTargetMembers,
};
