import { join } from 'path';
import { PROJECT_ROOT } from '../utils/paths.js';

export const AGENT_SERVER_ROOT = join(PROJECT_ROOT, 'server', 'agent_server');
export const AGENT_SERVER_DATA_DIR = process.env.AGENT_SERVER_DATA_DIR?.trim()
  || join(AGENT_SERVER_ROOT, 'data');
export const AGENT_SERVER_AGENTS_DIR = join(AGENT_SERVER_DATA_DIR, 'agents');
export const AGENT_SERVER_EVOLUTION_DIR = join(AGENT_SERVER_DATA_DIR, 'evolution');
export const AGENT_SERVER_EVOLUTION_PROPOSALS_DIR = join(AGENT_SERVER_EVOLUTION_DIR, 'proposals');

export function getAgentDir(agentId: string): string {
  return join(AGENT_SERVER_AGENTS_DIR, agentId);
}

export function getAgentManifestPath(agentId: string): string {
  return join(getAgentDir(agentId), 'agent.json');
}

export function getAgentMemoryDir(agentId: string): string {
  return join(getAgentDir(agentId), 'memory');
}

export function getAgentClarificationsDir(agentId: string): string {
  return join(getAgentDir(agentId), 'clarifications');
}

export function getAgentClarificationPath(agentId: string, clarificationId: string): string {
  return join(getAgentClarificationsDir(agentId), `${clarificationId}.json`);
}

export function getAgentQueuePath(agentId: string): string {
  return join(getAgentDir(agentId), 'queue.json');
}

export function getAgentSessionsDir(agentId: string): string {
  return join(getAgentDir(agentId), 'sessions');
}

export function getSessionDir(agentId: string, sessionId: string): string {
  return join(getAgentSessionsDir(agentId), sessionId);
}

export function getSessionMetaPath(agentId: string, sessionId: string): string {
  return join(getSessionDir(agentId, sessionId), 'session.json');
}

export function getSessionRunsDir(agentId: string, sessionId: string): string {
  return join(getSessionDir(agentId, sessionId), 'runs');
}

export function getSessionArtifactsDir(agentId: string, sessionId: string): string {
  return join(getSessionDir(agentId, sessionId), 'artifacts');
}

export function getSessionRunArtifactsDir(agentId: string, sessionId: string, runId: string): string {
  return join(getSessionArtifactsDir(agentId, sessionId), runId);
}

export function getAgentArtifactsStagingDir(agentId: string): string {
  return join(getAgentDir(agentId), 'artifacts');
}

export function getSessionPersistentDir(agentId: string, sessionId: string): string {
  return join(getSessionDir(agentId, sessionId), 'persistent');
}

export function getSessionPersistentSummaryPath(agentId: string, sessionId: string): string {
  return join(getSessionPersistentDir(agentId, sessionId), 'summary.jsonl');
}

export function getSessionPersistentConstraintsPath(agentId: string, sessionId: string): string {
  return join(getSessionPersistentDir(agentId, sessionId), 'constraints.jsonl');
}

export function getSessionWorkDir(agentId: string, sessionId: string): string {
  return join(getSessionDir(agentId, sessionId), 'work');
}

export function getSessionWorkLogPath(agentId: string, sessionId: string): string {
  return join(getSessionWorkDir(agentId, sessionId), 'log', 'turns.jsonl');
}

export function getSessionCurrentPath(agentId: string, sessionId: string): string {
  return join(getSessionWorkDir(agentId, sessionId), 'current.jsonl');
}

export function getSessionRecoveryIntentPath(agentId: string, sessionId: string): string {
  return join(getSessionWorkDir(agentId, sessionId), 'recovery-intent.json');
}

export function getAgentMemorySummaryPath(agentId: string): string {
  return join(getAgentMemoryDir(agentId), 'summary.jsonl');
}

export function getAgentMemoryConstraintsPath(agentId: string): string {
  return join(getAgentMemoryDir(agentId), 'constraints.jsonl');
}

export function getEvolutionProposalPath(proposalId: string): string {
  return join(AGENT_SERVER_EVOLUTION_PROPOSALS_DIR, `${proposalId}.json`);
}
