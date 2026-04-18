import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import type {
  RoundUsageModuleSummary,
  RoundUsageSummary,
  SessionUsageModuleAggregate,
  SessionUsageSummary,
} from '../types/index.js';
import { getTeamChatStore } from './team-chat-store.js';

interface PersistedSessionUsage {
  teamId: string;
  sessionId: string;
  updatedAt: string;
  requests: RoundUsageSummary[];
}

const DATA_DIR = join(process.cwd(), 'data', 'chat-usage');
const teamChatStore = getTeamChatStore();

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function emptyUsage(teamId: string, sessionId: string): PersistedSessionUsage {
  return {
    teamId,
    sessionId,
    updatedAt: new Date().toISOString(),
    requests: [],
  };
}

function clampNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function normalizeRoundUsage(summary: RoundUsageSummary): RoundUsageSummary {
  return {
    ...summary,
    totalInputTokens: clampNumber(summary.totalInputTokens),
    totalOutputTokens: clampNumber(summary.totalOutputTokens),
    totalTokens: clampNumber(summary.totalTokens),
    totalDurationMs: clampNumber(summary.totalDurationMs),
    wallClockMs: clampNumber(summary.wallClockMs),
    modules: Array.isArray(summary.modules) ? summary.modules.map((module) => ({
      ...module,
      inputTokens: clampNumber(module.inputTokens),
      outputTokens: clampNumber(module.outputTokens),
      totalTokens: clampNumber(module.totalTokens),
      durationMs: clampNumber(module.durationMs),
      llmCalls: clampNumber(module.llmCalls),
      toolCalls: clampNumber(module.toolCalls),
      dispatchCount: clampNumber(module.dispatchCount),
      estimated: module.estimated === true,
    })) : [],
    workers: Array.isArray(summary.workers) ? summary.workers.map((worker) => ({
      ...worker,
      inputTokens: clampNumber(worker.inputTokens),
      outputTokens: clampNumber(worker.outputTokens),
      totalTokens: clampNumber(worker.totalTokens),
      durationMs: clampNumber(worker.durationMs),
      llmCalls: clampNumber(worker.llmCalls),
      toolCalls: clampNumber(worker.toolCalls),
      estimated: worker.estimated === true,
    })) : [],
    tools: Array.isArray(summary.tools) ? summary.tools.map((tool) => ({
      agentId: String(tool.agentId || ''),
      toolName: String(tool.toolName || ''),
      count: clampNumber(tool.count),
    })) : [],
  };
}

function moduleAggregateFromRequests(
  requests: RoundUsageSummary[],
  moduleName: RoundUsageModuleSummary['module'],
): SessionUsageModuleAggregate {
  const perRequest = requests
    .map((request) => request.modules.find((module) => module.module === moduleName))
    .filter(Boolean) as RoundUsageModuleSummary[];
  const totalTokens = perRequest.reduce((sum, item) => sum + clampNumber(item.totalTokens), 0);
  const totalDurationMs = perRequest.reduce((sum, item) => sum + clampNumber(item.durationMs), 0);
  const requestCount = requests.length;
  return {
    module: moduleName,
    totalTokens,
    totalDurationMs,
    avgTokensPerRequest: requestCount > 0 ? totalTokens / requestCount : 0,
    avgDurationMsPerRequest: requestCount > 0 ? totalDurationMs / requestCount : 0,
    requestCount,
  };
}

function computeFastestGrowingModule(
  requests: RoundUsageSummary[],
  modules: SessionUsageModuleAggregate[],
): RoundUsageModuleSummary['module'] | null {
  if (requests.length < 2) {
    return null;
  }

  const windowSize = Math.min(3, Math.max(1, Math.floor(requests.length / 2)));
  const earlyWindow = requests.slice(0, windowSize);
  const lateWindow = requests.slice(-windowSize);

  let bestModule: RoundUsageModuleSummary['module'] | null = null;
  let bestDelta = 0;

  for (const module of modules) {
    const earlyAvg = earlyWindow.reduce((sum, request) => {
      const found = request.modules.find((item) => item.module === module.module);
      return sum + clampNumber(found?.totalTokens);
    }, 0) / windowSize;
    const lateAvg = lateWindow.reduce((sum, request) => {
      const found = request.modules.find((item) => item.module === module.module);
      return sum + clampNumber(found?.totalTokens);
    }, 0) / windowSize;
    const delta = lateAvg - earlyAvg;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestModule = module.module;
    }
  }

  return bestModule;
}

function buildSessionSummary(sessionId: string, requests: RoundUsageSummary[]): SessionUsageSummary {
  const moduleNames: RoundUsageModuleSummary['module'][] = [
    'user_intake',
    'coordinator_planning',
    'dispatch_fanout',
    'worker_execution',
    'tool_execution',
    'coordinator_synthesis',
  ];
  const modules = moduleNames.map((moduleName) => moduleAggregateFromRequests(requests, moduleName));
  const totalTokens = requests.reduce((sum, request) => sum + clampNumber(request.totalTokens), 0);
  const totalDurationMs = requests.reduce((sum, request) => sum + clampNumber(request.totalDurationMs), 0);
  const requestCount = requests.length;
  const mostExpensiveModule = [...modules]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .find((item) => item.totalTokens > 0)?.module || null;

  return {
    sessionId,
    requestCount,
    totalTokens,
    totalDurationMs,
    avgTokensPerRequest: requestCount > 0 ? totalTokens / requestCount : 0,
    avgDurationMsPerRequest: requestCount > 0 ? totalDurationMs / requestCount : 0,
    mostExpensiveModule,
    fastestGrowingModule: computeFastestGrowingModule(requests, modules),
    modules,
  };
}

export class TeamUsageStore {
  private getTeamDir(teamId: string): string {
    const teamDir = join(DATA_DIR, teamId);
    ensureDir(teamDir);
    return teamDir;
  }

  private getPath(teamId: string, sessionId?: string | null): string {
    const resolvedSessionId = sessionId || teamChatStore.getActiveSessionId(teamId);
    return join(this.getTeamDir(teamId), `${resolvedSessionId}.json`);
  }

  private readUsage(teamId: string, sessionId?: string | null): PersistedSessionUsage {
    const resolvedSessionId = sessionId || teamChatStore.getActiveSessionId(teamId);
    const path = this.getPath(teamId, resolvedSessionId);
    if (!existsSync(path)) {
      return emptyUsage(teamId, resolvedSessionId);
    }

    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PersistedSessionUsage>;
      return {
        teamId,
        sessionId: String(parsed.sessionId || resolvedSessionId),
        updatedAt: String(parsed.updatedAt || new Date().toISOString()),
        requests: Array.isArray(parsed.requests) ? parsed.requests.map(normalizeRoundUsage) : [],
      };
    } catch (error) {
      console.warn(`[TeamUsageStore] Failed to read usage for ${teamId}/${resolvedSessionId}:`, error);
      return emptyUsage(teamId, resolvedSessionId);
    }
  }

  private writeUsage(teamId: string, usage: PersistedSessionUsage, sessionId?: string | null): void {
    const next = {
      ...usage,
      updatedAt: new Date().toISOString(),
      requests: usage.requests.map(normalizeRoundUsage),
    };
    writeFileSync(this.getPath(teamId, sessionId || usage.sessionId), `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  }

  upsertRequestUsage(teamId: string, sessionId: string, summary: RoundUsageSummary): RoundUsageSummary[] {
    const usage = this.readUsage(teamId, sessionId);
    const normalized = normalizeRoundUsage(summary);
    const existingIndex = usage.requests.findIndex((item) => item.requestId === normalized.requestId);
    if (existingIndex >= 0) {
      usage.requests[existingIndex] = normalized;
    } else {
      usage.requests.push(normalized);
    }
    usage.requests.sort((left, right) => String(left.completedAt || '').localeCompare(String(right.completedAt || '')));
    this.writeUsage(teamId, usage, sessionId);
    return usage.requests;
  }

  listRequestUsages(teamId: string, sessionId?: string | null): RoundUsageSummary[] {
    return this.readUsage(teamId, sessionId).requests;
  }

  getSessionSummary(teamId: string, sessionId?: string | null): SessionUsageSummary {
    const usage = this.readUsage(teamId, sessionId);
    return buildSessionSummary(usage.sessionId, usage.requests);
  }

  clearSession(teamId: string, sessionId?: string | null): void {
    const path = this.getPath(teamId, sessionId);
    if (existsSync(path)) {
      rmSync(path, { force: true });
    }
  }

  clearTeam(teamId: string): void {
    const teamDir = join(DATA_DIR, teamId);
    if (existsSync(teamDir)) {
      rmSync(teamDir, { recursive: true, force: true });
    }
  }
}

let store: TeamUsageStore | null = null;

export function getTeamUsageStore(): TeamUsageStore {
  if (!store) {
    store = new TeamUsageStore();
  }
  return store;
}
