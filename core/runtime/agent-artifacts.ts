import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { resolveHostedAgentServerId } from './hosted-agent-server-id.js';
import {
  getAgentArtifactsStagingDir,
  getAgentManifestPath,
  getSessionRunArtifactsDir,
} from '../../server/agent_server/paths.js';

export interface ResolveAgentArtifactsRootOptions {
  teamId?: string | null;
}

interface AgentManifestSnapshot {
  activeSessionId?: string | null;
}

function readActiveSessionId(agentServerId: string): string | null {
  const manifestPath = getAgentManifestPath(agentServerId);
  if (!existsSync(manifestPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as AgentManifestSnapshot;
    const activeSessionId = String(parsed?.activeSessionId || '').trim();
    return activeSessionId || null;
  } catch {
    return null;
  }
}

/**
 * 长期 agent 的运行产物统一落在 `agent_server` 数据目录下。
 * `agents/roles/*` 只保留静态角色定义，不再承担 runtime run/artifact 真相源。
 */
export function resolveAgentArtifactsRoot(
  agentId: string | null | undefined,
  runId?: string | null,
  options?: ResolveAgentArtifactsRootOptions,
): string {
  const normalizedAgentId = String(agentId || 'system').trim() || 'system';
  const normalizedRunId = String(runId || 'pending').trim() || 'pending';
  const hostedAgentId = resolveHostedAgentServerId(options?.teamId || null, normalizedAgentId);
  const activeSessionId = readActiveSessionId(hostedAgentId);
  if (activeSessionId) {
    return getSessionRunArtifactsDir(hostedAgentId, activeSessionId, normalizedRunId);
  }
  return join(getAgentArtifactsStagingDir(hostedAgentId), normalizedRunId);
}
