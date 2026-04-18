import {
  getBackendAdapter,
  initBackendAdapter,
} from './backend-adapter.js';
import type { BackendAdapter } from './backend-adapter.js';
import type { SoulConfig, SkillConfig, TeamContext } from '../types.js';
import type { TeamRegistry } from '../../team/registry.js';

export interface RuntimeWorkspaceAdapter {
  createAgent: BackendAdapter['createAgent'];
  deleteAgent: BackendAdapter['deleteAgent'];
  hasAgent: BackendAdapter['hasAgent'];
  listAgents: BackendAdapter['listAgents'];
  getAgentSessionStatus: BackendAdapter['getAgentSessionStatus'];
  syncSessionContextArtifacts: BackendAdapter['syncSessionContextArtifacts'];
  syncAgentWorkspace: (localId: string, soul: SoulConfig, skills: SkillConfig[]) => Promise<string>;
  syncAgentWorkspaceFromSoulStore: (localId: string, soul: unknown, team?: TeamContext) => Promise<string>;
  syncAgentWorkspaceWithRegistry: (
    localId: string,
    soul: unknown,
    registry: TeamRegistry,
    teamDir?: string,
  ) => Promise<string>;
}

function wrapAdapter(adapter: BackendAdapter): RuntimeWorkspaceAdapter {
  return {
    createAgent: adapter.createAgent.bind(adapter),
    deleteAgent: adapter.deleteAgent.bind(adapter),
    hasAgent: adapter.hasAgent.bind(adapter),
    listAgents: adapter.listAgents.bind(adapter),
    getAgentSessionStatus: adapter.getAgentSessionStatus.bind(adapter),
    syncSessionContextArtifacts: adapter.syncSessionContextArtifacts.bind(adapter),
    syncAgentWorkspace: adapter.syncConfig.bind(adapter),
    syncAgentWorkspaceFromSoulStore: adapter.syncFromSoulStore.bind(adapter),
    syncAgentWorkspaceWithRegistry: adapter.syncFromSoulStoreWithRegistry.bind(adapter),
  };
}

export function getRuntimeWorkspaceAdapter(): RuntimeWorkspaceAdapter {
  return wrapAdapter(getBackendAdapter());
}

export async function initRuntimeWorkspaceAdapter(): Promise<RuntimeWorkspaceAdapter> {
  return wrapAdapter(await initBackendAdapter());
}
