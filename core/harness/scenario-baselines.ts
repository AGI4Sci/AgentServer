import type {
  HarnessScenarioId,
  HarnessSnapshot,
  TeamSnapshot,
} from './types.js';
import type { TeamRegistry } from '../team/registry.js';

const HARNESS_BASELINES: Record<HarnessScenarioId, HarnessSnapshot> = {
  coding: {
    scenarioId: 'coding',
    shell: {
      defaultRightPanelTab: 'thinking',
      rightPanelTabs: ['thinking', 'observability', 'harness-insights'],
      topbarModules: [
        'connection-status',
        'session-mode',
        'coordinator-status',
        'team-summary',
        'coordination-summary',
        'task-summary',
        'active-agents',
      ],
      modals: ['task-summary-modal'],
    },
    conversation: {
      showCoordinatorOnly: false,
      filterInternalMessages: true,
      showSharedSessionAsStatus: true,
    },
    work: {
      adapterId: 'coding',
      primaryObject: 'tasks',
      secondaryObjects: ['artifacts'],
      summaryModules: ['task-summary'],
    },
  },
  research: {
    scenarioId: 'research',
    shell: {
      defaultRightPanelTab: 'thinking',
      rightPanelTabs: ['thinking', 'observability', 'harness-insights'],
      topbarModules: [
        'connection-status',
        'session-mode',
        'team-summary',
        'task-summary',
        'active-agents',
      ],
      modals: ['task-summary-modal'],
    },
    conversation: {
      showCoordinatorOnly: true,
      filterInternalMessages: true,
      showSharedSessionAsStatus: true,
    },
    work: {
      adapterId: 'research',
      primaryObject: 'evidence',
      summaryModules: ['task-summary'],
    },
  },
  ppt: {
    scenarioId: 'ppt',
    shell: {
      defaultRightPanelTab: 'thinking',
      rightPanelTabs: ['thinking', 'observability', 'harness-insights'],
      topbarModules: [
        'connection-status',
        'session-mode',
        'team-summary',
        'task-summary',
        'active-agents',
      ],
      modals: ['task-summary-modal'],
    },
    conversation: {
      showCoordinatorOnly: true,
      filterInternalMessages: true,
      showSharedSessionAsStatus: true,
    },
    work: {
      adapterId: 'ppt',
      primaryObject: 'slides',
      summaryModules: ['task-summary'],
    },
  },
};

export function resolveScenarioIdByTeamId(teamId: string): HarnessScenarioId {
  if (teamId === 'research') return 'research';
  if (teamId === 'ppt') return 'ppt';
  return 'coding';
}

export function getHarnessBaselineForTeam(teamId: string): HarnessSnapshot {
  const scenarioId = resolveScenarioIdByTeamId(teamId);
  return HARNESS_BASELINES[scenarioId];
}

export function createTeamSnapshot(registry: TeamRegistry): TeamSnapshot {
  return {
    id: registry.id,
    name: registry.name,
    coordinator: registry.getCoordinator(),
    members: registry.getMembers().map(member => ({
      id: member.id,
      roleType: member.roleType,
      roleName: member.roleName,
      name: member.name,
      model: member.model,
      skills: member.skills,
      required: member.required,
    })),
  };
}
