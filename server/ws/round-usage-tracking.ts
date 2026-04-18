export type RoundUsageModule =
  | 'user_intake'
  | 'coordinator_planning'
  | 'dispatch_fanout'
  | 'worker_execution'
  | 'tool_execution'
  | 'coordinator_synthesis';

export interface RoundUsageModuleSummary {
  module: RoundUsageModule;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  dispatchCount: number;
  estimated: boolean;
}

export interface RoundUsageWorkerSummary {
  agentId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  estimated: boolean;
}

export interface RoundUsageToolSummary {
  agentId: string;
  toolName: string;
  count: number;
}

export interface RoundUsageSummary {
  requestId: string;
  startedAt: string;
  completedAt: string;
  wallClockMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  mostExpensiveModule: RoundUsageModule | null;
  slowestModule: RoundUsageModule | null;
  modules: RoundUsageModuleSummary[];
  workers: RoundUsageWorkerSummary[];
  tools: RoundUsageToolSummary[];
}

interface UsageMetadataLike {
  model?: string;
  tokens?: { input: number; output: number };
  duration?: number;
}

interface UsageCounter {
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  dispatchCount: number;
  estimated: boolean;
}

interface WorkerRunState {
  startedAt: number;
  inputTokensEstimate: number;
  model?: string | null;
}

interface WorkerAggregate extends UsageCounter {
  agentId: string;
  model?: string | null;
}

interface RequestUsageState {
  startedAt: number;
  lastUpdatedAt: number;
  modules: Record<RoundUsageModule, UsageCounter>;
  workers: Map<string, WorkerAggregate>;
  tools: Map<string, RoundUsageToolSummary>;
  activeWorkerRuns: Map<string, WorkerRunState>;
}

const MODULE_ORDER: RoundUsageModule[] = [
  'user_intake',
  'coordinator_planning',
  'dispatch_fanout',
  'worker_execution',
  'tool_execution',
  'coordinator_synthesis',
];

const requestUsageByKey = new Map<string, RequestUsageState>();

function requestKey(teamId: string, requestId: string): string {
  return `${teamId}:${requestId}`;
}

function createCounter(): UsageCounter {
  return {
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    llmCalls: 0,
    toolCalls: 0,
    dispatchCount: 0,
    estimated: false,
  };
}

function createState(now = Date.now()): RequestUsageState {
  return {
    startedAt: now,
    lastUpdatedAt: now,
    modules: {
      user_intake: createCounter(),
      coordinator_planning: createCounter(),
      dispatch_fanout: createCounter(),
      worker_execution: createCounter(),
      tool_execution: createCounter(),
      coordinator_synthesis: createCounter(),
    },
    workers: new Map(),
    tools: new Map(),
    activeWorkerRuns: new Map(),
  };
}

function getState(teamId: string, requestId: string, now = Date.now()): RequestUsageState {
  const key = requestKey(teamId, requestId);
  const existing = requestUsageByKey.get(key);
  if (existing) {
    existing.lastUpdatedAt = now;
    return existing;
  }
  const created = createState(now);
  requestUsageByKey.set(key, created);
  return created;
}

function estimateTokenCount(text: string): number {
  let cjk = 0;
  let latin = 0;
  for (const char of String(text || '')) {
    if (/\s/.test(char)) {
      continue;
    }
    if (/[\u3400-\u9fff\uf900-\ufaff]/.test(char)) {
      cjk += 1;
    } else {
      latin += 1;
    }
  }
  const estimated = cjk + Math.ceil(latin / 4);
  return estimated > 0 ? estimated : 0;
}

function applyUsage(
  counter: UsageCounter,
  inputTokens: number,
  outputTokens: number,
  durationMs: number,
  options?: {
    llmCalls?: number;
    toolCalls?: number;
    dispatchCount?: number;
    estimated?: boolean;
  },
): void {
  counter.inputTokens += Math.max(0, Math.round(inputTokens));
  counter.outputTokens += Math.max(0, Math.round(outputTokens));
  counter.durationMs += Math.max(0, Math.round(durationMs));
  counter.llmCalls += options?.llmCalls || 0;
  counter.toolCalls += options?.toolCalls || 0;
  counter.dispatchCount += options?.dispatchCount || 0;
  counter.estimated = counter.estimated || options?.estimated === true;
}

function getWorkerAggregate(state: RequestUsageState, agentId: string, model?: string | null): WorkerAggregate {
  const existing = state.workers.get(agentId);
  if (existing) {
    if (model && !existing.model) {
      existing.model = model;
    }
    return existing;
  }
  const created: WorkerAggregate = {
    agentId,
    model: model || null,
    ...createCounter(),
  };
  state.workers.set(agentId, created);
  return created;
}

function resolveUsage(
  body: string | undefined,
  metadata?: UsageMetadataLike,
): { inputTokens: number; outputTokens: number; durationMs: number; estimated: boolean } {
  const actualInput = metadata?.tokens?.input;
  const actualOutput = metadata?.tokens?.output;
  const estimatedOutput = estimateTokenCount(body || '');
  return {
    inputTokens: typeof actualInput === 'number' ? actualInput : 0,
    outputTokens: typeof actualOutput === 'number' ? actualOutput : estimatedOutput,
    durationMs: typeof metadata?.duration === 'number' ? metadata.duration : 0,
    estimated: typeof actualOutput !== 'number' || typeof actualInput !== 'number',
  };
}

export function noteRoundUserIntake(teamId: string, requestId: string, timestamp?: number): void {
  const state = getState(teamId, requestId, timestamp);
  applyUsage(state.modules.user_intake, 0, 0, 0, {});
}

export function noteCoordinatorPlanning(input: {
  teamId: string;
  requestId: string;
  body?: string;
  metadata?: UsageMetadataLike;
  dispatchCount?: number;
  timestamp?: number;
}): void {
  const state = getState(input.teamId, input.requestId, input.timestamp);
  const usage = resolveUsage(input.body, input.metadata);
  applyUsage(
    state.modules.coordinator_planning,
    usage.inputTokens,
    usage.outputTokens,
    usage.durationMs,
    {
      llmCalls: 1,
      estimated: usage.estimated,
    },
  );
  if ((input.dispatchCount || 0) > 0) {
    applyUsage(state.modules.dispatch_fanout, 0, 0, 0, {
      dispatchCount: input.dispatchCount,
    });
  }
}

export function noteCoordinatorSynthesis(input: {
  teamId: string;
  requestId: string;
  body?: string;
  metadata?: UsageMetadataLike;
  timestamp?: number;
}): void {
  const state = getState(input.teamId, input.requestId, input.timestamp);
  const usage = resolveUsage(input.body, input.metadata);
  applyUsage(
    state.modules.coordinator_synthesis,
    usage.inputTokens,
    usage.outputTokens,
    usage.durationMs,
    {
      llmCalls: 1,
      estimated: usage.estimated,
    },
  );
}

export function noteWorkerRunStarted(input: {
  teamId: string;
  requestId: string;
  agentId: string;
  promptText: string;
  model?: string | null;
  timestamp?: number;
}): void {
  const state = getState(input.teamId, input.requestId, input.timestamp);
  state.activeWorkerRuns.set(input.agentId, {
    startedAt: input.timestamp || Date.now(),
    inputTokensEstimate: estimateTokenCount(input.promptText),
    model: input.model || null,
  });
}

export function noteWorkerRunFinished(input: {
  teamId: string;
  requestId: string;
  agentId: string;
  outputText: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string | null;
  estimated?: boolean;
  timestamp?: number;
}): void {
  const state = getState(input.teamId, input.requestId, input.timestamp);
  const activeRun = state.activeWorkerRuns.get(input.agentId);
  const inputTokens = typeof input.inputTokens === 'number'
    ? input.inputTokens
    : (activeRun?.inputTokensEstimate || 0);
  const outputTokens = typeof input.outputTokens === 'number'
    ? input.outputTokens
    : estimateTokenCount(input.outputText);
  const durationMs = typeof input.durationMs === 'number'
    ? input.durationMs
    : Math.max(0, (input.timestamp || Date.now()) - (activeRun?.startedAt || state.startedAt));
  const estimated = input.estimated !== false;
  applyUsage(
    state.modules.worker_execution,
    inputTokens,
    outputTokens,
    durationMs,
    {
      llmCalls: 1,
      estimated,
    },
  );
  const worker = getWorkerAggregate(state, input.agentId, input.model || activeRun?.model || null);
  applyUsage(worker, inputTokens, outputTokens, durationMs, {
    llmCalls: 1,
    estimated,
  });
  state.activeWorkerRuns.delete(input.agentId);
}

export function noteRuntimeToolCall(input: {
  teamId: string;
  requestId: string;
  agentId: string;
  toolName: string;
  timestamp?: number;
}): void {
  const state = getState(input.teamId, input.requestId, input.timestamp);
  applyUsage(state.modules.tool_execution, 0, 0, 0, {
    toolCalls: 1,
  });
  const worker = getWorkerAggregate(state, input.agentId);
  applyUsage(worker, 0, 0, 0, {
    toolCalls: 1,
  });
  const key = `${input.agentId}:${input.toolName}`;
  const existing = state.tools.get(key);
  if (existing) {
    existing.count += 1;
    return;
  }
  state.tools.set(key, {
    agentId: input.agentId,
    toolName: input.toolName,
    count: 1,
  });
}

export function finalizeRoundUsage(teamId: string, requestId: string, timestamp?: number): RoundUsageSummary | null {
  const key = requestKey(teamId, requestId);
  const state = requestUsageByKey.get(key);
  if (!state) {
    return null;
  }
  const completedAt = timestamp || Date.now();
  const modules = MODULE_ORDER.map((module) => {
    const counter = state.modules[module];
    return {
      module,
      inputTokens: counter.inputTokens,
      outputTokens: counter.outputTokens,
      totalTokens: counter.inputTokens + counter.outputTokens,
      durationMs: counter.durationMs,
      llmCalls: counter.llmCalls,
      toolCalls: counter.toolCalls,
      dispatchCount: counter.dispatchCount,
      estimated: counter.estimated,
    } satisfies RoundUsageModuleSummary;
  });
  const workers = Array.from(state.workers.values()).map((worker) => ({
    agentId: worker.agentId,
    model: worker.model,
    inputTokens: worker.inputTokens,
    outputTokens: worker.outputTokens,
    totalTokens: worker.inputTokens + worker.outputTokens,
    durationMs: worker.durationMs,
    llmCalls: worker.llmCalls,
    toolCalls: worker.toolCalls,
    estimated: worker.estimated,
  })).sort((a, b) => b.totalTokens - a.totalTokens || b.durationMs - a.durationMs);
  const tools = Array.from(state.tools.values()).sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName));
  const totalInputTokens = modules.reduce((sum, item) => sum + item.inputTokens, 0);
  const totalOutputTokens = modules.reduce((sum, item) => sum + item.outputTokens, 0);
  const totalDurationMs = modules.reduce((sum, item) => sum + item.durationMs, 0);
  const mostExpensiveModule = [...modules]
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .find((item) => item.totalTokens > 0)?.module || null;
  const slowestModule = [...modules]
    .sort((a, b) => b.durationMs - a.durationMs)
    .find((item) => item.durationMs > 0)?.module || null;
  requestUsageByKey.delete(key);
  return {
    requestId,
    startedAt: new Date(state.startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    wallClockMs: Math.max(0, completedAt - state.startedAt),
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalDurationMs,
    mostExpensiveModule,
    slowestModule,
    modules,
    workers,
    tools,
  };
}

export function clearRoundUsage(teamId: string, requestId: string): void {
  requestUsageByKey.delete(requestKey(teamId, requestId));
}
