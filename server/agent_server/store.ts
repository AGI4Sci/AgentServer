import { randomUUID } from 'crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import type {
  AgentClarificationRecord,
  AgentCompactionIntentRecord,
  AgentCompactionTagRecord,
  AgentConstraintRecord,
  AgentEvolutionProposal,
  AgentManifest,
  AgentGoalRecord,
  AgentRecoveryStatus,
  AgentRecoveryIssueRecord,
  AgentRunRecord,
  AgentSessionRecord,
  AgentTurnRecord,
  AgentWorkEntry,
} from './types.js';
import {
  AGENT_SERVER_AGENTS_DIR,
  AGENT_SERVER_EVOLUTION_PROPOSALS_DIR,
  getAgentClarificationPath,
  getAgentClarificationsDir,
  getAgentDir,
  getAgentManifestPath,
  getAgentMemoryDir,
  getAgentMemoryConstraintsPath,
  getAgentMemorySummaryPath,
  getAgentQueuePath,
  getEvolutionProposalPath,
  getAgentSessionsDir,
  getSessionCurrentPath,
  getSessionPersistentConstraintsPath,
  getSessionPersistentSummaryPath,
  getSessionMetaPath,
  getSessionPersistentDir,
  getSessionRecoveryIntentPath,
  getSessionRunsDir,
  getSessionWorkDir,
  getSessionWorkLogPath,
} from './paths.js';

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tempPath = join(dir, `.${Date.now().toString(36)}-${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) {
    return null;
  }
  const raw = await readFile(path, 'utf8');
  if (!raw.trim()) {
    return null;
  }
  return JSON.parse(raw) as T;
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const existing = existsSync(path) ? await readFile(path, 'utf8') : '';
  const next = `${existing}${JSON.stringify(value)}\n`;
  await writeFile(path, next, 'utf8');
}

async function readJsonLinesFile<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) {
    return [];
  }
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function nowIso(): string {
  return new Date().toISOString();
}

function constraintPriorityScore(priority?: AgentConstraintRecord['priority']): number {
  switch (priority) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default:
      return 0;
  }
}

function defaultConstraintFamily(key: string): string {
  if (key.startsWith('tool.')) {
    return 'tool.available';
  }
  if (key.startsWith('workspace.paths_recently_observed')) {
    return 'workspace.paths_recently_observed';
  }
  if (key.startsWith('workflow.')) {
    return 'workflow.current_plan';
  }
  return key.split('.').slice(0, 2).join('.');
}

function mergeConstraintRecords(
  older: AgentConstraintRecord,
  newer: AgentConstraintRecord,
): AgentConstraintRecord {
  return {
    ...older,
    ...newer,
    family: newer.family ?? older.family,
    familyMembers: [...new Set([...(older.familyMembers ?? [older.key]), ...(newer.familyMembers ?? [newer.key])])],
    priority: newer.priority ?? older.priority,
    durability: newer.durability ?? older.durability,
    evidence: [...new Set([...(older.evidence ?? []), ...(newer.evidence ?? [])])],
  };
}

function normalizeWorkEntry(raw: unknown): AgentWorkEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.kind === 'compaction' || value.kind === 'partial_compaction') {
    return value as unknown as AgentCompactionTagRecord;
  }
  if (typeof value.role === 'string' && typeof value.content === 'string' && typeof value.createdAt === 'string') {
    return {
      ...(value as unknown as AgentTurnRecord),
      kind: 'turn',
    };
  }
  return null;
}

function dedupeConstraints(items: AgentConstraintRecord[]): AgentConstraintRecord[] {
  const latestByKey = new Map<string, AgentConstraintRecord>();
  for (const item of items) {
    const normalized: AgentConstraintRecord = {
      ...item,
      family: item.family ?? defaultConstraintFamily(item.key),
      familyMembers: item.familyMembers ?? [item.key],
      priority: item.priority ?? 'medium',
      durability: item.durability ?? 'session',
      evidence: item.evidence ?? [],
    };
    const existing = latestByKey.get(normalized.key);
    if (!existing) {
      latestByKey.set(normalized.key, normalized);
      continue;
    }
    if (normalized.turn > existing.turn) {
      latestByKey.set(normalized.key, mergeConstraintRecords(existing, normalized));
      continue;
    }
    if (normalized.turn === existing.turn && constraintPriorityScore(normalized.priority) >= constraintPriorityScore(existing.priority)) {
      latestByKey.set(normalized.key, mergeConstraintRecords(existing, normalized));
      continue;
    }
    latestByKey.set(normalized.key, mergeConstraintRecords(normalized, existing));
  }
  return [...latestByKey.values()].sort((left, right) => (
    constraintPriorityScore(right.priority) - constraintPriorityScore(left.priority)
      || left.turn - right.turn
      || left.key.localeCompare(right.key)
  ));
}

export class AgentStore {
  async ensureDataRoot(): Promise<void> {
    await ensureDir(AGENT_SERVER_AGENTS_DIR);
    await ensureDir(AGENT_SERVER_EVOLUTION_PROPOSALS_DIR);
  }

  async listAgents(): Promise<AgentManifest[]> {
    await this.ensureDataRoot();
    const entries = await readdir(AGENT_SERVER_AGENTS_DIR, { withFileTypes: true });
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.getAgent(entry.name);
          } catch {
            return null;
          }
        }),
    );
    return manifests.filter((item): item is AgentManifest => Boolean(item));
  }

  async getAgent(agentId: string): Promise<AgentManifest | null> {
    return await readJsonFile<AgentManifest>(getAgentManifestPath(agentId));
  }

  async saveAgent(manifest: AgentManifest): Promise<void> {
    await writeJson(getAgentManifestPath(manifest.id), manifest);
  }

  async saveEvolutionProposal(proposal: AgentEvolutionProposal): Promise<void> {
    await writeJson(getEvolutionProposalPath(proposal.id), proposal);
  }

  async getEvolutionProposal(proposalId: string): Promise<AgentEvolutionProposal | null> {
    return await readJsonFile<AgentEvolutionProposal>(getEvolutionProposalPath(proposalId));
  }

  async listEvolutionProposals(): Promise<AgentEvolutionProposal[]> {
    await ensureDir(AGENT_SERVER_EVOLUTION_PROPOSALS_DIR);
    const entries = await readdir(AGENT_SERVER_EVOLUTION_PROPOSALS_DIR, { withFileTypes: true });
    const proposals = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.getEvolutionProposal(entry.name.replace(/\.json$/, ''))),
    );
    return proposals
      .filter((item): item is AgentEvolutionProposal => Boolean(item))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async saveClarification(record: AgentClarificationRecord): Promise<void> {
    await writeJson(getAgentClarificationPath(record.agentId, record.id), record);
  }

  async getClarification(agentId: string, clarificationId: string): Promise<AgentClarificationRecord | null> {
    return await readJsonFile<AgentClarificationRecord>(getAgentClarificationPath(agentId, clarificationId));
  }

  async listClarifications(agentId: string): Promise<AgentClarificationRecord[]> {
    const dir = getAgentClarificationsDir(agentId);
    if (!existsSync(dir)) {
      return [];
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const records = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => this.getClarification(agentId, entry.name.replace(/\.json$/, ''))),
    );
    return records
      .filter((item): item is AgentClarificationRecord => Boolean(item))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async createAgent(manifest: AgentManifest, session: AgentSessionRecord): Promise<void> {
    const agentDir = getAgentDir(manifest.id);
    await ensureDir(agentDir);
    await ensureDir(getAgentClarificationsDir(manifest.id));
    await ensureDir(getAgentMemoryDir(manifest.id));
    await ensureDir(getAgentSessionsDir(manifest.id));
    await this.saveAgent(manifest);
    await writeJson(getAgentQueuePath(manifest.id), []);
    await this.saveSession(session);
    await ensureDir(join(getSessionWorkDir(manifest.id, session.id), 'log'));
    await ensureDir(getSessionPersistentDir(manifest.id, session.id));
    await ensureDir(getSessionRunsDir(manifest.id, session.id));
  }

  async getSession(agentId: string, sessionId: string): Promise<AgentSessionRecord | null> {
    return await readJsonFile<AgentSessionRecord>(getSessionMetaPath(agentId, sessionId));
  }

  async getActiveSession(agentId: string): Promise<AgentSessionRecord | null> {
    const agent = await this.getAgent(agentId);
    if (!agent) {
      return null;
    }
    const pointed = await this.getSession(agentId, agent.activeSessionId);
    if (pointed?.status === 'active') {
      return pointed;
    }
    const sessions = await this.listSessions(agentId);
    return sessions
      .filter((session) => session.status === 'active')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null;
  }

  async saveSession(session: AgentSessionRecord): Promise<void> {
    await writeJson(getSessionMetaPath(session.agentId, session.id), session);
  }

  async replaceSessionRecoveryIssues(
    agentId: string,
    sessionId: string,
    issues: AgentRecoveryIssueRecord[],
    status: AgentRecoveryStatus = issues.length > 0 ? 'recovered' : 'clean',
  ): Promise<AgentSessionRecord | null> {
    const session = await this.getSession(agentId, sessionId);
    if (!session) {
      return null;
    }
    session.recovery = {
      status,
      lastRecoveredAt: nowIso(),
      issues,
    };
    session.updatedAt = nowIso();
    await this.saveSession(session);
    return session;
  }

  async acknowledgeSessionRecovery(
    agentId: string,
    sessionId: string,
    clearIssues: boolean,
  ): Promise<AgentSessionRecord | null> {
    const session = await this.getSession(agentId, sessionId);
    if (!session) {
      return null;
    }
    session.recovery = {
      status: clearIssues ? 'clean' : (session.recovery?.status ?? 'recovered'),
      lastRecoveredAt: session.recovery?.lastRecoveredAt,
      acknowledgedAt: nowIso(),
      issues: clearIssues ? [] : (session.recovery?.issues ?? []),
    };
    session.updatedAt = nowIso();
    await this.saveSession(session);
    return session;
  }

  async listSessions(agentId: string): Promise<AgentSessionRecord[]> {
    const sessionsDir = getAgentSessionsDir(agentId);
    if (!existsSync(sessionsDir)) {
      return [];
    }
    const entries = await readdir(sessionsDir, { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.getSession(agentId, entry.name)),
    );
    return sessions.filter((item): item is AgentSessionRecord => Boolean(item));
  }

  async appendTurn(agentId: string, sessionId: string, turn: AgentTurnRecord): Promise<void> {
    await appendJsonLine(getSessionWorkLogPath(agentId, sessionId), turn);
    await appendJsonLine(getSessionCurrentPath(agentId, sessionId), turn);
  }

  async listCurrentWork(agentId: string, sessionId: string): Promise<AgentWorkEntry[]> {
    const rawEntries = await readJsonLinesFile<unknown>(getSessionCurrentPath(agentId, sessionId));
    return rawEntries
      .map((entry) => normalizeWorkEntry(entry))
      .filter((entry): entry is AgentWorkEntry => Boolean(entry));
  }

  async saveCurrentWork(agentId: string, sessionId: string, entries: AgentWorkEntry[]): Promise<void> {
    const lines = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await ensureDir(dirname(getSessionCurrentPath(agentId, sessionId)));
    await writeFile(
      getSessionCurrentPath(agentId, sessionId),
      lines.length > 0 ? `${lines}\n` : '',
      'utf8',
    );
  }

  async clearSessionContext(
    agentId: string,
    sessionId: string,
    options: {
      clearTurns?: boolean;
      clearCurrentWork?: boolean;
      clearPersistent?: boolean;
      clearRecoveryIntent?: boolean;
    } = {},
  ): Promise<void> {
    if (options.clearTurns) {
      await rm(getSessionWorkLogPath(agentId, sessionId), { force: true });
    }
    if (options.clearCurrentWork) {
      await rm(getSessionCurrentPath(agentId, sessionId), { force: true });
    }
    if (options.clearPersistent) {
      await rm(getSessionPersistentSummaryPath(agentId, sessionId), { force: true });
      await rm(getSessionPersistentConstraintsPath(agentId, sessionId), { force: true });
    }
    if (options.clearRecoveryIntent) {
      await rm(getSessionRecoveryIntentPath(agentId, sessionId), { force: true });
    }
  }

  async saveRecoveryIntent(intent: AgentCompactionIntentRecord): Promise<void> {
    await writeJson(getSessionRecoveryIntentPath(intent.agentId, intent.sessionId), intent);
  }

  async getRecoveryIntent(agentId: string, sessionId: string): Promise<AgentCompactionIntentRecord | null> {
    return await readJsonFile<AgentCompactionIntentRecord>(getSessionRecoveryIntentPath(agentId, sessionId));
  }

  async clearRecoveryIntent(agentId: string, sessionId: string): Promise<void> {
    const path = getSessionRecoveryIntentPath(agentId, sessionId);
    if (!existsSync(path)) {
      return;
    }
    await rm(path, { force: true });
  }

  async listTurns(agentId: string, sessionId: string): Promise<AgentTurnRecord[]> {
    return await readJsonLinesFile<AgentTurnRecord>(getSessionWorkLogPath(agentId, sessionId));
  }

  async listRecentTurns(agentId: string, sessionId: string, limit = 12): Promise<AgentTurnRecord[]> {
    const turns = await this.listTurns(agentId, sessionId);
    return turns.slice(-limit);
  }

  async listTurnsRange(
    agentId: string,
    sessionId: string,
    startTurn?: number,
    endTurn?: number,
    limit?: number,
  ): Promise<AgentTurnRecord[]> {
    const turns = await this.listTurns(agentId, sessionId);
    const filtered = turns.filter((turn) => {
      const number = turn.turnNumber ?? 0;
      if (typeof startTurn === 'number' && number < startTurn) {
        return false;
      }
      if (typeof endTurn === 'number' && number > endTurn) {
        return false;
      }
      return true;
    });
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return filtered.slice(0, limit);
    }
    return filtered;
  }

  async saveRun(run: AgentRunRecord): Promise<void> {
    const runPath = join(getSessionRunsDir(run.agentId, run.sessionId), `${run.id}.json`);
    await writeJson(runPath, run);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const agents = await this.listAgents();
    for (const agent of agents) {
      const runs = await this.listRuns(agent.id);
      const run = runs.find((item) => item.id === runId);
      if (run) {
        return run;
      }
    }
    return null;
  }

  async listRuns(agentId: string, sessionId?: string): Promise<AgentRunRecord[]> {
    const sessionIds = sessionId
      ? [sessionId]
      : (await this.listSessions(agentId)).map((item) => item.id);
    const runs: AgentRunRecord[] = [];
    for (const id of sessionIds) {
      const runsDir = getSessionRunsDir(agentId, id);
      if (!existsSync(runsDir)) {
        continue;
      }
      const entries = await readdir(runsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue;
        }
        const item = await readJsonFile<AgentRunRecord>(join(runsDir, entry.name));
        if (item) {
          runs.push(item);
        }
      }
    }
    runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return runs;
  }

  async appendMemorySummary(agentId: string, value: string): Promise<void> {
    await appendJsonLine(getAgentMemorySummaryPath(agentId), {
      id: randomUUID(),
      value,
      createdAt: nowIso(),
    });
  }

  async appendPersistentSummary(agentId: string, sessionId: string, value: string): Promise<void> {
    await appendJsonLine(getSessionPersistentSummaryPath(agentId, sessionId), {
      id: randomUUID(),
      value,
      createdAt: nowIso(),
    });
  }

  async listMemorySummary(agentId: string): Promise<string[]> {
    const items = await readJsonLinesFile<{ value: string }>(getAgentMemorySummaryPath(agentId));
    return items.map((item) => item.value);
  }

  async replaceMemorySummary(agentId: string, values: string[]): Promise<void> {
    const entries = values.map((value) => ({
      id: randomUUID(),
      value,
      createdAt: nowIso(),
    }));
    const raw = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await ensureDir(dirname(getAgentMemorySummaryPath(agentId)));
    await writeFile(getAgentMemorySummaryPath(agentId), raw ? `${raw}\n` : '', 'utf8');
  }

  async listMemoryConstraints(agentId: string): Promise<AgentConstraintRecord[]> {
    const items = await readJsonLinesFile<AgentConstraintRecord>(getAgentMemoryConstraintsPath(agentId));
    return dedupeConstraints(items);
  }

  async appendMemoryConstraints(agentId: string, items: AgentConstraintRecord[]): Promise<void> {
    const merged = dedupeConstraints([
      ...(await this.listMemoryConstraints(agentId)),
      ...items,
    ]);
    await this.replaceMemoryConstraints(agentId, merged);
  }

  async replaceMemoryConstraints(agentId: string, items: AgentConstraintRecord[]): Promise<void> {
    const merged = dedupeConstraints(items);
    const raw = merged.map((entry) => JSON.stringify(entry)).join('\n');
    await ensureDir(dirname(getAgentMemoryConstraintsPath(agentId)));
    await writeFile(getAgentMemoryConstraintsPath(agentId), raw ? `${raw}\n` : '', 'utf8');
  }

  async listPendingGoals(agentId: string): Promise<AgentGoalRecord[]> {
    const queue = await readJsonFile<AgentGoalRecord[]>(getAgentQueuePath(agentId));
    return Array.isArray(queue) ? queue : [];
  }

  async savePendingGoals(agentId: string, goals: AgentGoalRecord[]): Promise<void> {
    await writeJson(getAgentQueuePath(agentId), goals);
  }

  async enqueueGoal(agentId: string, goal: AgentGoalRecord): Promise<void> {
    const current = await this.listPendingGoals(agentId);
    current.push(goal);
    await this.savePendingGoals(agentId, current);
  }

  async dequeueGoal(agentId: string): Promise<AgentGoalRecord | null> {
    const current = await this.listPendingGoals(agentId);
    if (current.length === 0) {
      return null;
    }
    const [head, ...rest] = current;
    await this.savePendingGoals(agentId, rest);
    return head;
  }

  async listPersistentSummary(agentId: string, sessionId: string): Promise<string[]> {
    const items = await readJsonLinesFile<{ value: string }>(
      getSessionPersistentSummaryPath(agentId, sessionId),
    );
    return items.map((item) => item.value);
  }

  async replacePersistentSummary(agentId: string, sessionId: string, values: string[]): Promise<void> {
    const entries = values.map((value) => ({
      id: randomUUID(),
      value,
      createdAt: nowIso(),
    }));
    const raw = entries.map((entry) => JSON.stringify(entry)).join('\n');
    await ensureDir(dirname(getSessionPersistentSummaryPath(agentId, sessionId)));
    await writeFile(getSessionPersistentSummaryPath(agentId, sessionId), raw ? `${raw}\n` : '', 'utf8');
  }

  async listPersistentConstraints(agentId: string, sessionId: string): Promise<AgentConstraintRecord[]> {
    const items = await readJsonLinesFile<AgentConstraintRecord>(
      getSessionPersistentConstraintsPath(agentId, sessionId),
    );
    return dedupeConstraints(items);
  }

  async appendPersistentConstraints(
    agentId: string,
    sessionId: string,
    items: AgentConstraintRecord[],
  ): Promise<void> {
    const merged = dedupeConstraints([
      ...(await this.listPersistentConstraints(agentId, sessionId)),
      ...items,
    ]);
    await this.replacePersistentConstraints(agentId, sessionId, merged);
  }

  async replacePersistentConstraints(
    agentId: string,
    sessionId: string,
    items: AgentConstraintRecord[],
  ): Promise<void> {
    const merged = dedupeConstraints(items);
    const raw = merged.map((entry) => JSON.stringify(entry)).join('\n');
    await ensureDir(dirname(getSessionPersistentConstraintsPath(agentId, sessionId)));
    await writeFile(getSessionPersistentConstraintsPath(agentId, sessionId), raw ? `${raw}\n` : '', 'utf8');
  }

  async validateWorkingDirectory(workingDirectory: string): Promise<void> {
    const info = await stat(workingDirectory);
    if (!info.isDirectory()) {
      throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
    }
  }

  createSessionRecord(agentId: string): AgentSessionRecord {
    const now = nowIso();
    return {
      id: `session-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      agentId,
      status: 'active',
      nextTurnNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
  }
}
