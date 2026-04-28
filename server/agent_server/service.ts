import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { readdir, stat } from 'fs/promises';
import { promisify } from 'util';
import { basename, join, resolve, relative } from 'path';
import {
  DEFAULT_BACKEND,
  getBackendDescriptor,
  isBackendEnabled,
  normalizeBackendType,
} from '../../core/runtime/backend-catalog.js';
import type { AgentBackendId, BackendType } from '../../core/runtime/backend-catalog.js';
import type { SessionOutput, SessionStreamEvent } from '../runtime/session-types.js';
import { mergeModelProviderUsage } from '../runtime/model-provider-usage.js';
import { runSessionViaSupervisor } from '../runtime/supervisor-session-runner.js';
import {
  createAgentBackendAdapter,
  hasAgentBackendAdapter,
} from '../runtime/agent-backend-adapter-registry.js';
import { listConfiguredLlmEndpoints, loadOpenTeamConfig } from '../utils/openteam-config.js';
import { AgentStore } from './store.js';
import type {
  AutonomousAgentPolicy,
  AutonomousAgentRecoveryAction,
  AutonomousAgentRunRequest,
  AutonomousAgentRunResult,
  AgentClarificationRecord,
  AgentCompactionIntentRecord,
  AgentContextSnapshot,
  AgentContextRef,
  AgentCompactionTagRecord,
  AgentConstraintRecord,
  ConstraintDurability,
  ConstraintPriority,
  AgentEvolutionProposal,
  AgentGoalRecord,
  AgentGoalRequest,
  AgentOperationalGuidance,
  AgentOperationalGuidanceItem,
  AgentManifest,
  AgentMessageContextPolicy,
  AgentMessageRequest,
  AgentServerRunRequest,
  AgentServerRunResult,
  AgentRunStreamOptions,
  AgentRecoveryIssueRecord,
  AgentRetrievalHit,
  AgentRetrievalLayerResult,
  AgentRetrievalRequest,
  AgentRetrievalResult,
  AgentRunRecord,
  AgentRunOrchestratorLedger,
  AgentRunStageType,
  AgentRunStageRecord,
  AgentRunStageOwnership,
  AgentRunStagePlan,
  BackendHandoffPacket,
  BackendSessionRef,
  BackendStageResult,
  CanonicalSessionContextSnapshot,
  StageBoundaryVerification,
  TestRunSummary,
  StageSummary,
  AgentSessionRecord,
  AgentTurnRecord,
  AgentTurnLogQuery,
  AgentAutonomyRequest,
  AgentRecoverySnapshot,
  AgentWorkBudgetSnapshot,
  AgentMemoryBudgetSnapshot,
  AgentPersistentBudgetSnapshot,
  AgentTokenCostDelta,
  AgentTokenEconomicsSnapshot,
  AgentCurrentWorkRequest,
  PersistentBudgetPreview,
  PersistentBudgetCandidate,
  PersistentRecoveryDecisionSnapshot,
  PersistentRecoverySemanticSuggestion,
  PersistentRecoveryStrategy,
  AppendMemoryConstraintsRequest,
  AppendMemorySummaryRequest,
  AppendPersistentConstraintsRequest,
  AppendPersistentSummaryRequest,
  EnsureAutonomousAgentRequest,
  FinalizeMemoryStrategy,
  AgentWorkEntry,
  AgentWorkLayout,
  AgentWorkLayoutSegment,
  WorkspaceFacts,
  CompactPreviewResult,
  CompactPreviewCandidate,
  CompactDecisionSnapshot,
  CompactSemanticSuggestion,
  AgentWorkspaceSearchRequest,
  AgentWorkspaceSearchResult,
  ClearMemoryRequest,
  CompactAgentRequest,
  CreateAgentEvolutionProposalRequest,
  CreateAgentRequest,
  CreateSessionRequest,
  FinalizeSessionCandidate,
  FinalizeDecisionSnapshot,
  FinalizeSessionPreview,
  FinalizeSessionRequest,
  FinalizeSemanticSuggestion,
  ApplyPersistentBudgetRequest,
  AcknowledgeRecoveryRequest,
  ReplaceCurrentWorkRequest,
  ResolveClarificationRequest,
  ReviveAgentRequest,
  ResetPersistentRequest,
  UpdateAgentEvolutionProposalStatusRequest,
} from './types.js';
import { getSessionRunArtifactsDir } from './paths.js';
import {
  buildRuleBasedOrchestratorLedger,
  buildStageHandoffPacket,
  executeMultiStagePlan,
  type RuleBasedStagePlanKind,
} from './orchestrator.js';

const DEFAULT_RUNTIME_TEAM_ID = 'agent-server';
const DEFAULT_SYSTEM_PROMPT = [
  '你是一个长期存在的自主工作 agent。',
  '你有稳定身份、稳定工作目录，并持续积累 session 内 persistent context 与跨 session memory。',
  '当你不确定外部状态时，应先检索或读取工作目录中的事实，而不是凭空假设。',
].join('\n');
const DEFAULT_AUTONOMY = {
  enabled: false,
  intervalMs: 60_000,
  autoReflect: false,
  maxConsecutiveErrors: 3,
} as const;
const DEFAULT_RUN_TASK_CONTEXT_POLICY = {
  includeCurrentWork: false,
  includeRecentTurns: false,
  includePersistent: false,
  includeMemory: false,
  persistRunSummary: false,
  persistExtractedConstraints: false,
} as const;
const DEFAULT_AUTONOMOUS_AGENT_POLICY = {
  autoRevive: true,
  autoPersistentRecovery: true,
  allowPersistentReset: true,
  resetReusesMemorySeed: true,
  clearCurrentWorkOnReset: false,
  resumeAutonomyAfterRecovery: false,
} as const;
const APPROX_CONTEXT_TOKENS = 20_000;
const WORK_RATIO_SOFT_THRESHOLD = 0.6;
const WORK_RATIO_HARD_THRESHOLD = 0.85;
const CACHE_HIT_PRICE_FACTOR = 0.1;
const MIN_PARTIAL_COST_SAVINGS_PER_TURN = 120;
const MIN_PARTIAL_COST_SAVINGS_RATIO = 0.08;
const MIN_PARTIAL_SEMANTIC_OPPORTUNITY_SCORE = 12;
const MIN_STABLE_WORK_TURNS = 2;
const MIN_DYNAMIC_COMPRESS_TURNS = 4;
const RELAXED_MIN_DYNAMIC_COMPRESS_TURNS = 2;
const STRONG_SEMANTIC_BOUNDARY_SCORE = 8;
const VERY_STRONG_SEMANTIC_BOUNDARY_SCORE = 10;
const MICRO_DYNAMIC_COMPRESS_TURNS = 1;
const LIVE_DYNAMIC_TAIL_TURNS = 2;
const PERSISTENT_MAX_APPROX_TOKENS = 10_000;
const PERSISTENT_SUMMARY_SOFT_APPROX_TOKENS = 4_000;
const PERSISTENT_SUMMARY_HARD_APPROX_TOKENS = 6_000;
const PERSISTENT_CONSTRAINT_SOFT_APPROX_TOKENS = 6_000;
const PERSISTENT_CONSTRAINT_HARD_APPROX_TOKENS = 10_000;
const MEMORY_MAX_APPROX_TOKENS = 20_000;
const MEMORY_SUMMARY_SOFT_APPROX_TOKENS = 8_000;
const MEMORY_SUMMARY_HARD_APPROX_TOKENS = 12_000;
const MEMORY_CONSTRAINT_SOFT_APPROX_TOKENS = 10_000;
const MEMORY_CONSTRAINT_HARD_APPROX_TOKENS = 16_000;
const execFileAsync = promisify(execFile);
const WORKSPACE_PRIORITY_TERMS = [
  'file', 'files', 'path', 'paths', 'directory', 'folder', 'readme', 'package', 'tsconfig',
  'code', 'source', 'workspace', 'grep', 'glob', 'search', 'find', 'json', 'yaml', 'toml',
  '文件', '目录', '路径', '代码', '配置', '搜索', '查找', '工作区', '仓库',
];
const HISTORY_PRIORITY_TERMS = [
  'history', 'previous', 'memory', 'persistent', 'summary', 'constraint', 'decision', 'approved',
  'release', 'date', 'why', 'when', 'clarification', 'session', 'turn', 'archive',
  '历史', '之前', '记忆', '摘要', '约束', '决策', '批准', '发布时间', '澄清', '会话', '归档',
];
const STABLE_SIGNAL_TERMS = [
  'done', 'completed', 'implemented', 'created', 'updated', 'verified', 'confirmed', 'found',
  'fixed', 'resolved', 'finished', 'successfully', 'located', 'checked', 'decision', 'checkpoint', 'summary',
  '已完成', '完成', '已实现', '实现了', '已创建', '已更新', '已验证', '确认', '已确认', '发现了', '已修复', '已解决', '成功',
  '决策', '决定', '阶段结论', '阶段性结论', '检查完成', '总结',
];
const HIGH_VALUE_SUMMARY_TERMS = [
  'decision', 'decided', 'approved', 'resolved', 'root cause', 'plan', 'milestone', 'final',
  'schema', 'contract', 'constraint', 'interface', 'api', 'path', 'file', 'directory',
  '决策', '决定', '批准', '结论', '根因', '方案', '里程碑', '最终', '约束', '接口', '路径', '文件', '目录',
];
const LOW_VALUE_SUMMARY_TERMS = [
  'yes', 'no', 'checked', 'verified', 'confirmed', 'exists', 'does not exist',
  'list dir', 'tool available', 'continue', 'next step',
  '是', '否', '检查了', '已验证', '已确认', '存在', '不存在', '下一步',
];
const HIGH_VALUE_CONSTRAINT_TERMS = [
  'must', 'required', 'forbidden', 'schema', 'api', 'path', 'directory', 'contract',
  '必须', '禁止', '约束', '接口', '路径', '目录', '协议',
];
const UNSETTLED_SIGNAL_TERMS = [
  'todo', 'next', 'follow up', 'continue', 'need', 'needs', 'pending', 'waiting',
  'not sure', 'unknown', 'unclear', 'question', 'ask human', 'clarification',
  '待办', '下一步', '继续', '需要', '待确认', '等待', '不确定', '未知', '不清楚', '问题', '澄清',
];
const RETRIEVAL_STOPWORDS = new Set([
  'what',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'when',
  'where',
  'which',
  'who',
  'why',
  'how',
  'the',
  'this',
  'that',
  'these',
  'those',
  'with',
  'from',
  'than',
  'then',
  'into',
  'onto',
  'about',
  'approved',
  'release',
  'date',
  'project',
  'history',
  'memory',
  'persistent',
  'summary',
  'constraint',
  'constraints',
  'session',
  'turn',
  'turns',
  'archive',
  'archived',
  'please',
  'there',
  'their',
  'have',
  'has',
  'had',
  'does',
  'did',
  'done',
  'yes',
  'no',
  'will',
  'would',
  'should',
  'could',
  'until',
  'explicitly',
  'current',
  'directory',
  'working',
  'workspace',
  'file',
  'files',
  'path',
  'paths',
  'folder',
  'folders',
  'artifact',
  'artifacts',
  'directory',
  'directories',
  'missing',
  'user',
  'assistant',
  'system',
]);

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeNameFromDirectory(workingDirectory: string): string {
  const trimmed = workingDirectory.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'agent';
}

function excerpt(text: string, maxLength = 280): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function resolveAgentMessageContextPolicy(policy?: AgentMessageContextPolicy | null): Required<AgentMessageContextPolicy> {
  return {
    includeCurrentWork: policy?.includeCurrentWork !== false,
    includeRecentTurns: policy?.includeRecentTurns !== false,
    includePersistent: policy?.includePersistent !== false,
    includeMemory: policy?.includeMemory !== false,
    persistRunSummary: policy?.persistRunSummary !== false,
    persistExtractedConstraints: policy?.persistExtractedConstraints !== false,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathIsInside(child: string, parent: string): boolean {
  const childPath = resolve(child);
  const parentPath = resolve(parent);
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && rel !== '..');
}

function containsSemanticTerm(text: string, term: string): boolean {
  if (!/[A-Za-z]/.test(term)) {
    return text.includes(term);
  }
  const normalized = escapeRegExp(term.trim()).replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${normalized}\\b`, 'i').test(text);
}

function containsAnySemanticTerm(text: string, terms: string[]): boolean {
  return terms.some((term) => containsSemanticTerm(text, term));
}

function renderSummaryBlock(title: string, values: string[]): string {
  if (values.length === 0) {
    return `${title}:\n- (empty)`;
  }
  return `${title}:\n${values.map((item) => `- ${item}`).join('\n')}`;
}

function isRetryableNativeSessionHistoryError(errorText: string | undefined): boolean {
  if (!errorText) return false;
  return /tool_use_id.*tool_result|tool_result.*corresponding.*tool_use|unexpected [`']?tool_use_id[`']?/i.test(errorText)
    && /Bedrock|Anthropic|ValidationException|invalid_request_error|InvokeModel/i.test(errorText);
}

export function shouldRouteModelEndpointThroughSupervisor(
  runtimeModel: Pick<AgentMessageRequest, 'model' | 'modelProvider' | 'modelName' | 'llmEndpoint'> | undefined,
): boolean {
  const endpoint = runtimeModel?.llmEndpoint;
  const baseUrl = typeof endpoint?.baseUrl === 'string' ? endpoint.baseUrl.trim() : '';
  const endpointModel = typeof endpoint?.modelName === 'string' ? endpoint.modelName.trim() : '';
  const requestModel = typeof runtimeModel?.modelName === 'string' ? runtimeModel.modelName.trim() : '';
  if (!baseUrl || (!endpointModel && !requestModel)) {
    return false;
  }
  const provider = String(endpoint?.provider || runtimeModel?.modelProvider || '').trim().toLowerCase();
  return provider !== 'codex-chatgpt' && provider !== 'chatgpt';
}

function renderLegacySupervisorContext(
  executionContext: string,
  handoffPacket: BackendHandoffPacket,
): string {
  return [
    executionContext,
    '',
    'AgentServer handoff packet:',
    JSON.stringify(handoffPacket, null, 2),
  ].join('\n');
}

function outputFromAdapterStageResult(
  stageResult: BackendStageResult | undefined,
  streamedText: string,
): SessionOutput {
  if (stageResult?.status === 'failed' || stageResult?.status === 'timeout' || stageResult?.status === 'cancelled') {
    return {
      success: false,
      error: stageResult.finalText || stageResult.handoffSummary || `stage ${stageResult.status}`,
      usage: stageResult.usage,
    };
  }
  return {
    success: true,
    result: stageResult?.finalText || streamedText.trim() || stageResult?.handoffSummary || '',
    usage: stageResult?.usage,
  };
}

function resolveOrchestratorRequest(metadata?: Record<string, unknown>): {
  mode: 'single_stage' | 'multi_stage';
  planKind?: RuleBasedStagePlanKind;
  failureStrategy?: AgentRunOrchestratorLedger['policy']['failureStrategy'];
  maxRetries?: number;
  fallbackBackend?: AgentBackendId;
} {
  const value = metadata?.orchestrator;
  if (!value || typeof value !== 'object') {
    return { mode: 'single_stage' };
  }
  const config = value as Record<string, unknown>;
  const mode = config.mode === 'multi_stage' ? 'multi_stage' : 'single_stage';
  const planKind = typeof config.planKind === 'string' && isRuleBasedStagePlanKind(config.planKind)
    ? config.planKind
    : undefined;
  const failureStrategy = typeof config.failureStrategy === 'string' && isFailureStrategy(config.failureStrategy)
    ? config.failureStrategy
    : undefined;
  const maxRetries = typeof config.maxRetries === 'number' && Number.isFinite(config.maxRetries)
    ? Math.max(0, Math.floor(config.maxRetries))
    : undefined;
  const fallbackBackend = typeof config.fallbackBackend === 'string'
    ? config.fallbackBackend as AgentBackendId
    : undefined;
  return {
    mode,
    planKind,
    failureStrategy,
    maxRetries,
    fallbackBackend,
  };
}

function isRuleBasedStagePlanKind(value: string): value is RuleBasedStagePlanKind {
  return value === 'implement-only'
    || value === 'implement-review'
    || value === 'diagnose-implement-verify';
}

function isFailureStrategy(value: string): value is AgentRunOrchestratorLedger['policy']['failureStrategy'] {
  return value === 'fail_run'
    || value === 'retry_stage'
    || value === 'fallback_backend'
    || value === 'continue_with_warnings';
}

function inferArtifactKind(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.json')) {
    return 'json';
  }
  if (normalized.endsWith('.md') || normalized.endsWith('.txt')) {
    return 'text';
  }
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(normalized)) {
    return 'image';
  }
  if (/\.(log|out|err)$/.test(normalized)) {
    return 'log';
  }
  return 'file';
}

function renderTurnsBlock(turns: { role: string; content: string; createdAt: string }[]): string {
  if (turns.length === 0) {
    return 'Recent turns:\n- (empty)';
  }
  return [
    'Recent turns:',
    ...turns.map((turn) => `- [${turn.createdAt}] ${turn.role}: ${excerpt(turn.content, 800)}`),
  ].join('\n');
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPersistentBudgetExceededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('persistent/') && message.includes('hard budget');
}

function normalizeWorkEntryTurn(entry: AgentWorkEntry): entry is AgentWorkEntry & { kind?: 'turn' } {
  return entry.kind !== 'compaction' && entry.kind !== 'partial_compaction';
}

function scoreTextMatch(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 1;
  }
  const normalized = text.toLowerCase();
  return terms.reduce((score, term) => score + (normalized.includes(term) ? 1 : 0), 0);
}

function scoreHit(text: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }
  const normalized = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      score += term.length >= 4 ? 3 : 2;
      if (/[./_-]/.test(term) || /\d/.test(term) || term.length >= 10) {
        score += 3;
      }
    }
  }
  return score;
}

function archivedRefs(value?: string | string[]): string[] {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
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

function selectRelevantItems<T>(
  items: T[],
  terms: string[],
  toText: (item: T) => string,
  fallbackCount: number,
): T[] {
  if (items.length === 0) {
    return [];
  }
  if (terms.length === 0) {
    return items.slice(-fallbackCount);
  }

  const ranked = items
    .map((item, index) => ({
      item,
      index,
      score: scoreTextMatch(toText(item), terms),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(-fallbackCount)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.item);

  return ranked.length > 0 ? ranked : items.slice(-fallbackCount);
}

function focusTerms(focus?: string): string[] {
  if (!focus) {
    return [];
  }
  return [...new Set(
    focus
      .toLowerCase()
      .split(/[^a-z0-9_\-\u4e00-\u9fff]+/i)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2)
      .filter((item) => {
        if (/^[a-z]+$/i.test(item)) {
          return item.length >= 4;
        }
        return true;
      })
      .filter((item) => !RETRIEVAL_STOPWORDS.has(item)),
  )];
}

function renderConstraintsBlock(title: string, values: AgentConstraintRecord[]): string {
  if (values.length === 0) {
    return `${title}:\n- (empty)`;
  }
  return [
    `${title}:`,
    ...values.map((item) => (
      `- [${item.type}/${item.priority ?? 'medium'}/${item.durability ?? 'session'}] ${item.family ?? item.key} @turn_${item.turn}: ${item.desc}${(item.familyMembers?.length ?? 0) > 1 ? ` | members=${item.familyMembers?.join(', ')}` : ''}${(item.evidence?.length ?? 0) > 0 ? ` | evidence=${item.evidence?.join('; ')}` : ''}`
    )),
  ].join('\n');
}

function renderWorkBlock(entries: AgentWorkEntry[]): string {
  if (entries.length === 0) {
    return 'Current work:\n- (empty)';
  }
  return [
    'Current work:',
    ...entries.map((entry) => {
      if (entry.kind === 'compaction' || entry.kind === 'partial_compaction') {
        return `- [${entry.kind}] ${entry.turns} | tools=${entry.tools.join(', ') || '(none)'} | ${entry.summary.join(' ')}`;
      }
      if (normalizeWorkEntryTurn(entry)) {
        return `- [turn_${entry.turnNumber ?? '?'}] ${entry.role}: ${excerpt(entry.content, 240)}`;
      }
      return '- [unknown] (unrenderable work entry)';
    }),
  ].join('\n');
}

function renderWorkLayoutBlock(layout: AgentWorkLayout): string {
  return [
    'Work layout:',
    `- strategy=${layout.strategy}`,
    `- safety_point=${layout.safetyPointReached ? `yes@turn_${layout.safetyPointTurn ?? '?'}` : 'no'}`,
    `- stable_boundary=${layout.stableBoundaryTurn ? `turn_${layout.stableBoundaryTurn}` : '(none)'}`,
    ...layout.segments.map((segment) => (
      `- [${segment.kind}] ${segment.source} ${segment.turnRange ? `turn_${segment.turnRange.start}-turn_${segment.turnRange.end}` : '(no-range)'} entries=${segment.entryCount}${segment.note ? ` | ${segment.note}` : ''}`
    )),
    ...(layout.boundaryCandidates ?? []).map((candidate) => (
      `- boundary_candidate: turn_${candidate.turnNumber} score=${candidate.score}${candidate.selected ? ' [selected]' : ''} | ${candidate.signals.join('; ') || 'no strong signals'} | ${candidate.excerpt}`
    )),
    ...layout.rationale.map((item) => `- rationale: ${item}`),
  ].join('\n');
}

function renderWorkBudgetBlock(snapshot: AgentWorkBudgetSnapshot): string {
  return [
    'Work budget:',
    `- status=${snapshot.status}`,
    `- work_ratio=${snapshot.workRatio.toFixed(3)} (soft=${snapshot.softThreshold}, hard=${snapshot.hardThreshold})`,
    `- approx_tokens: context=${snapshot.approxContextTokens} prefix=${snapshot.approxPrefixTokens} current_work=${snapshot.approxCurrentWorkTokens} remaining=${snapshot.approxRemainingTokens}`,
    `- token_economics: cache_eligible=${snapshot.tokenEconomics.approxCacheEligibleTokens} uncached=${snapshot.tokenEconomics.approxUncachedTokens} effective_per_turn=${snapshot.tokenEconomics.effectivePerTurnCostUnits} (cache_hit_factor=${snapshot.tokenEconomics.cacheHitPriceFactor})`,
    ...snapshot.tokenEconomics.rationale.map((item) => `- economics: ${item}`),
    ...snapshot.rationale.map((item) => `- rationale: ${item}`),
  ].join('\n');
}

function renderPersistentBudgetBlock(snapshot: AgentPersistentBudgetSnapshot): string {
  return [
    'Persistent budget:',
    `- status=${snapshot.status}`,
    `- approx_tokens: summary=${snapshot.approxSummaryTokens} constraints=${snapshot.approxConstraintTokens} total=${snapshot.approxTotalTokens}`,
    `- limits: summary_soft=${snapshot.summarySoftLimit} summary_hard=${snapshot.summaryHardLimit} constraint_soft=${snapshot.constraintSoftLimit} constraint_hard=${snapshot.constraintHardLimit} total_hard=${snapshot.totalHardLimit}`,
    `- token_economics: cache_eligible=${snapshot.tokenEconomics.approxCacheEligibleTokens} uncached=${snapshot.tokenEconomics.approxUncachedTokens} effective_per_turn=${snapshot.tokenEconomics.effectivePerTurnCostUnits} (cache_hit_factor=${snapshot.tokenEconomics.cacheHitPriceFactor})`,
    ...snapshot.tokenEconomics.rationale.map((item) => `- economics: ${item}`),
    ...snapshot.rationale.map((item) => `- rationale: ${item}`),
  ].join('\n');
}

function renderMemoryBudgetBlock(snapshot: AgentMemoryBudgetSnapshot): string {
  return [
    'Memory budget:',
    `- status=${snapshot.status}`,
    `- approx_tokens: summary=${snapshot.approxSummaryTokens} constraints=${snapshot.approxConstraintTokens} total=${snapshot.approxTotalTokens}`,
    `- limits: summary_soft=${snapshot.summarySoftLimit} summary_hard=${snapshot.summaryHardLimit} constraint_soft=${snapshot.constraintSoftLimit} constraint_hard=${snapshot.constraintHardLimit} total_hard=${snapshot.totalHardLimit}`,
    `- token_economics: cache_eligible=${snapshot.tokenEconomics.approxCacheEligibleTokens} uncached=${snapshot.tokenEconomics.approxUncachedTokens} effective_per_turn=${snapshot.tokenEconomics.effectivePerTurnCostUnits} (cache_hit_factor=${snapshot.tokenEconomics.cacheHitPriceFactor})`,
    ...snapshot.tokenEconomics.rationale.map((item) => `- economics: ${item}`),
    ...snapshot.rationale.map((item) => `- rationale: ${item}`),
  ].join('\n');
}

function renderRecoveryIssuesBlock(issues: AgentRecoveryIssueRecord[]): string {
  if (issues.length === 0) {
    return 'Recovery issues:\n- (none)';
  }
  return [
    'Recovery issues:',
    ...issues.map((issue) => `- [${issue.kind}] ${issue.detail}`),
  ].join('\n');
}

function renderOperationalGuidanceBlock(guidance: AgentOperationalGuidance): string {
  if (guidance.items.length === 0) {
    return '';
  }
  return [
    'Operational guidance:',
    ...guidance.summary.map((item) => `- ${item}`),
    ...guidance.items.map((item) => `- [${item.area}/${item.urgency}] ${item.recommendedAction}${item.estimatedSavingsPerFutureTurn ? ` | est_savings_per_turn=${item.estimatedSavingsPerFutureTurn}` : ''}: ${item.rationale.join(' | ')}`),
  ].join('\n');
}

function dedupeConstraints(items: AgentConstraintRecord[]): AgentConstraintRecord[] {
  const priorityScore = (priority?: ConstraintPriority): number => {
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
  };
  const merge = (older: AgentConstraintRecord, newer: AgentConstraintRecord): AgentConstraintRecord => ({
    ...older,
    ...newer,
    family: newer.family ?? older.family ?? defaultConstraintFamily(newer.key),
    familyMembers: [...new Set([...(older.familyMembers ?? [older.key]), ...(newer.familyMembers ?? [newer.key])])],
    priority: newer.priority ?? older.priority ?? 'medium',
    durability: newer.durability ?? older.durability ?? 'session',
    evidence: [...new Set([...(older.evidence ?? []), ...(newer.evidence ?? [])])],
  });
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
      latestByKey.set(normalized.key, merge(existing, normalized));
      continue;
    }
    if (normalized.turn === existing.turn && priorityScore(normalized.priority) >= priorityScore(existing.priority)) {
      latestByKey.set(normalized.key, merge(existing, normalized));
      continue;
    }
    latestByKey.set(normalized.key, merge(normalized, existing));
  }
  return [...latestByKey.values()].sort((left, right) => (
    priorityScore(right.priority) - priorityScore(left.priority)
      || left.turn - right.turn
      || left.key.localeCompare(right.key)
  ));
}

export class AgentServerService {
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private readonly agentOperationChains = new Map<string, Promise<void>>();

  constructor(
    private readonly store = new AgentStore(),
    private readonly options: {
      evaluateRun?: (input: {
        run: AgentRunRecord;
        contextSnapshot: AgentContextSnapshot;
        output: SessionOutput;
      }) => Promise<AgentRunRecord['evaluation'] | null> | AgentRunRecord['evaluation'] | null;
    } = {},
  ) {}

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.initializationPromise) {
      this.initializationPromise = this.recoverAllAgents().finally(() => {
        this.initialized = true;
        this.initializationPromise = null;
      });
    }
    await this.initializationPromise;
  }

  async listAgents(): Promise<AgentManifest[]> {
    await this.ensureInitialized();
    const agents = await this.store.listAgents();
    const out: AgentManifest[] = [];
    for (const agent of agents) {
      out.push(await this.getAgent(agent.id));
    }
    return out;
  }

  async getAgent(agentId: string): Promise<AgentManifest> {
    await this.ensureInitialized();
    let agent = await this.store.getAgent(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const activeSession = await this.store.getActiveSession(agentId);
    if (!activeSession || activeSession.id !== agent.activeSessionId) {
      await this.recoverAgentEnvelope(agent);
      agent = await this.store.getAgent(agentId);
      if (!agent) {
        throw new Error(`Agent not found after recovery: ${agentId}`);
      }
    }
    const hydrated: AgentManifest = {
      ...agent,
      autonomy: {
        enabled: agent.autonomy?.enabled ?? DEFAULT_AUTONOMY.enabled,
        intervalMs: agent.autonomy?.intervalMs ?? DEFAULT_AUTONOMY.intervalMs,
        autoReflect: agent.autonomy?.autoReflect ?? DEFAULT_AUTONOMY.autoReflect,
        maxConsecutiveErrors: agent.autonomy?.maxConsecutiveErrors ?? DEFAULT_AUTONOMY.maxConsecutiveErrors,
      },
      runtime: {
        isRunning: agent.runtime?.isRunning ?? false,
        pendingGoalCount: agent.runtime?.pendingGoalCount ?? 0,
        currentRunId: agent.runtime?.currentRunId,
        pendingClarificationId: agent.runtime?.pendingClarificationId,
        consecutiveErrors: agent.runtime?.consecutiveErrors ?? 0,
        lastTickAt: agent.runtime?.lastTickAt,
        lastRunAt: agent.runtime?.lastRunAt,
        lastError: agent.runtime?.lastError,
      },
    };
    if (JSON.stringify(agent) !== JSON.stringify(hydrated)) {
      await this.store.saveAgent(hydrated);
    }
    return hydrated;
  }

  async createAgent(input: CreateAgentRequest): Promise<AgentManifest> {
    await this.ensureInitialized();
    const workingDirectory = input.workingDirectory?.trim();
    if (!workingDirectory) {
      throw new Error('workingDirectory is required');
    }
    await this.store.validateWorkingDirectory(workingDirectory);

    const id = String(input.id || `agent-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`).trim();
    if (!id) {
      throw new Error('agent id cannot be empty');
    }

    const existing = await this.store.getAgent(id);
    if (existing) {
      throw new Error(`Agent already exists: ${id}`);
    }

    const session = this.store.createSessionRecord(id);
    const now = nowIso();
    const manifest: AgentManifest = {
      id,
      name: String(input.name || normalizeNameFromDirectory(workingDirectory)).trim() || id,
      backend: normalizeBackendType(input.backend, DEFAULT_BACKEND),
      workingDirectory,
      runtimeTeamId: String(input.runtimeTeamId || DEFAULT_RUNTIME_TEAM_ID).trim() || DEFAULT_RUNTIME_TEAM_ID,
      runtimeAgentId: String(input.runtimeAgentId || id).trim() || id,
      runtimePersistentKey: `agent-server:${id}`,
      systemPrompt: String(input.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim(),
      status: 'active',
      autonomy: {
        enabled: input.autonomy?.enabled ?? DEFAULT_AUTONOMY.enabled,
        intervalMs: Math.max(5_000, Number(input.autonomy?.intervalMs ?? DEFAULT_AUTONOMY.intervalMs)),
        autoReflect: input.autonomy?.autoReflect ?? DEFAULT_AUTONOMY.autoReflect,
        maxConsecutiveErrors: Math.max(
          1,
          Number(input.autonomy?.maxConsecutiveErrors ?? DEFAULT_AUTONOMY.maxConsecutiveErrors),
        ),
      },
      runtime: {
        isRunning: false,
        pendingGoalCount: 0,
        consecutiveErrors: 0,
      },
      activeSessionId: session.id,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.createAgent(manifest, session);
    if (input.initialMemorySummary?.trim()) {
      await this.store.appendMemorySummary(id, input.initialMemorySummary.trim());
    }
    if (input.initialGoal?.trim()) {
      await this.enqueueGoal(id, { goal: input.initialGoal.trim() });
      return await this.getAgent(id);
    }
    return manifest;
  }

  async ensureAutonomousAgent(input: EnsureAutonomousAgentRequest): Promise<AgentManifest> {
    const { agent } = await this.ensureAutonomousAgentInternal(input);
    return agent;
  }

  async runAutonomousTask(
    request: AutonomousAgentRunRequest,
    stream?: AgentRunStreamOptions,
  ): Promise<AutonomousAgentRunResult> {
    const recoveryActions: AutonomousAgentRecoveryAction[] = [];
    const policy = this.resolveAutonomousAgentPolicy(request.policy ?? request.agent.policy);
    let prepared = await this.ensureAutonomousAgentInternal(request.agent, recoveryActions);
    prepared.agent = await this.prepareAutonomousAgent(prepared.agent.id, policy, recoveryActions);

    let retried = false;
    let run: AgentRunRecord;
    try {
      run = await this.sendMessage(prepared.agent.id, request.message, stream);
    } catch (error) {
      if (!isPersistentBudgetExceededError(error) || (!policy.autoPersistentRecovery && !policy.allowPersistentReset)) {
        throw error;
      }
      retried = true;
      const recovered = await this.prepareAutonomousAgent(prepared.agent.id, policy, recoveryActions);
      run = await this.sendMessage(recovered.id, request.message, stream);
    }

    return {
      agent: await this.getAgent(prepared.agent.id),
      run,
      recoveryActions,
      retried,
    };
  }

  async runTask(
    request: AgentServerRunRequest,
    stream?: AgentRunStreamOptions,
  ): Promise<AgentServerRunResult> {
    const text = String(request.input?.text || '').trim();
    if (!text) {
      throw new Error('input.text is required');
    }
    const workingDirectory = String(
      request.agent?.workingDirectory
        || request.agent?.workspace
        || request.runtime?.cwd
        || '',
    ).trim();
    if (!workingDirectory) {
      throw new Error('agent.workspace or agent.workingDirectory is required');
    }
    const workspacePolicy = loadOpenTeamConfig().runtime.workspace;
    if (workspacePolicy.mode === 'client') {
      throw new Error([
        'Server-side workspace tools are disabled because runtime.workspace.mode is "client".',
        'Configure a worker route for this workspace, run AgentServer near the workspace, or sync/mount the workspace to the server before calling runTask.',
      ].join(' '));
    }
    if (workspacePolicy.mode === 'hybrid') {
      throw new Error([
        'runtime.workspace.mode "hybrid" requires a client-side worker/tool router, which is not implemented yet.',
        'Use mode "server" for server-side workspaces or keep routing as a route-plan only until worker executors are implemented.',
      ].join(' '));
    }
    if (workspacePolicy.serverAllowedRoots.length > 0) {
      const allowed = workspacePolicy.serverAllowedRoots.some((root) => pathIsInside(workingDirectory, root));
      if (!allowed) {
        throw new Error([
          `Workspace is outside runtime.workspace.serverAllowedRoots: ${workingDirectory}`,
          `Allowed roots: ${workspacePolicy.serverAllowedRoots.join(', ')}`,
        ].join(' '));
      }
    }

    const metadata = {
      ...(request.metadata ?? {}),
      ...(request.input?.metadata ? { input: request.input.metadata } : {}),
      ...(request.runtime?.metadata ? { runtime: request.runtime.metadata } : {}),
      ...(request.agent?.metadata ? { agent: request.agent.metadata } : {}),
    };
    const backend = normalizeBackendType(request.runtime?.backend ?? request.agent?.backend, DEFAULT_BACKEND);
    if (!isBackendEnabled(backend)) {
      throw new Error(`Backend is disabled by AGENT_SERVER_ENABLED_BACKENDS: ${backend}`);
    }
    const result = await this.runAutonomousTask({
      agent: {
        id: request.agent?.id,
        name: request.agent?.name,
        backend,
        workingDirectory,
        runtimeTeamId: request.agent?.runtimeTeamId,
        runtimeAgentId: request.agent?.runtimeAgentId,
        systemPrompt: request.agent?.systemPrompt,
        initialMemorySummary: request.agent?.initialMemorySummary,
        autonomy: request.agent?.autonomy,
        reconcileExisting: request.agent?.reconcileExisting,
        policy: request.agent?.policy,
        metadata: request.agent?.metadata,
      },
      message: {
        message: text,
        model: request.runtime?.model,
        modelProvider: request.runtime?.modelProvider,
        modelName: request.runtime?.modelName,
        llmEndpoint: request.runtime?.llmEndpoint,
        localDevPolicy: request.runtime?.localDevPolicy,
        contextPolicy: request.contextPolicy ?? DEFAULT_RUN_TASK_CONTEXT_POLICY,
        metadata,
      },
      policy: request.policy ?? request.agent?.policy,
    }, stream);

    return {
      ...result,
      metadata,
    };
  }

  async createEvolutionProposal(request: CreateAgentEvolutionProposalRequest): Promise<AgentEvolutionProposal> {
    await this.ensureInitialized();
    const title = String(request.title || '').trim();
    if (!title) {
      throw new Error('proposal title is required');
    }
    const rollbackPlan = String(request.rollbackPlan || '').trim();
    if (!rollbackPlan) {
      throw new Error('proposal rollbackPlan is required');
    }
    const now = nowIso();
    const status = request.status === 'draft' ? 'draft' : 'proposed';
    const proposal: AgentEvolutionProposal = {
      id: `proposal-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      type: request.type,
      title,
      evidence: request.evidence ?? [],
      expectedImpact: request.expectedImpact,
      risk: request.risk,
      rollbackPlan,
      status,
      metadata: request.metadata,
      history: [
        {
          status,
          actor: request.actor,
          note: request.note,
          createdAt: now,
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveEvolutionProposal(proposal);
    return proposal;
  }

  async listEvolutionProposals(): Promise<AgentEvolutionProposal[]> {
    await this.ensureInitialized();
    return await this.store.listEvolutionProposals();
  }

  async getEvolutionProposal(proposalId: string): Promise<AgentEvolutionProposal> {
    await this.ensureInitialized();
    const proposal = await this.store.getEvolutionProposal(String(proposalId || '').trim());
    if (!proposal) {
      throw new Error(`Evolution proposal not found: ${proposalId}`);
    }
    return proposal;
  }

  async approveEvolutionProposal(
    proposalId: string,
    request: UpdateAgentEvolutionProposalStatusRequest = {},
  ): Promise<AgentEvolutionProposal> {
    return await this.transitionEvolutionProposal(proposalId, 'approved', request);
  }

  async rejectEvolutionProposal(
    proposalId: string,
    request: UpdateAgentEvolutionProposalStatusRequest = {},
  ): Promise<AgentEvolutionProposal> {
    return await this.transitionEvolutionProposal(proposalId, 'rejected', request);
  }

  async applyEvolutionProposal(
    proposalId: string,
    request: UpdateAgentEvolutionProposalStatusRequest = {},
  ): Promise<AgentEvolutionProposal> {
    const proposal = await this.getEvolutionProposal(proposalId);
    if (proposal.status !== 'approved') {
      throw new Error('evolution proposal must be approved before apply');
    }
    return await this.transitionEvolutionProposal(proposalId, 'applied', request);
  }

  async rollbackEvolutionProposal(
    proposalId: string,
    request: UpdateAgentEvolutionProposalStatusRequest = {},
  ): Promise<AgentEvolutionProposal> {
    const proposal = await this.getEvolutionProposal(proposalId);
    if (proposal.status !== 'applied') {
      throw new Error('only applied evolution proposals can be rolled back');
    }
    return await this.transitionEvolutionProposal(proposalId, 'rolled_back', request);
  }

  async startNewSession(agentId: string, request: CreateSessionRequest = {}): Promise<AgentSessionRecord> {
    const agent = await this.getAgent(agentId);
    const currentSession = await this.store.getActiveSession(agentId);
    if (currentSession) {
      const resolvedStrategy = request.strategy ?? await this.resolveFinalizeStrategy(
        agentId,
        currentSession.id,
        request.carryOverSummary,
        request.promotePersistentToMemory ?? true,
      );
      if (request.promotePersistentToMemory) {
        await this.promoteSessionPersistentToMemory(
          agentId,
          currentSession.id,
          request.carryOverSummary,
          resolvedStrategy,
        );
      }
      currentSession.status = 'archived';
      currentSession.endedAt = nowIso();
      currentSession.updatedAt = currentSession.endedAt;
      await this.store.saveSession(currentSession);
      if (request.discardArchivedSessionContext) {
        await this.store.clearSessionContext(agentId, currentSession.id, {
          clearTurns: true,
          clearCurrentWork: true,
          clearPersistent: true,
          clearRecoveryIntent: true,
        });
      }
    }

    const nextSession = this.store.createSessionRecord(agentId);
    await this.store.saveSession(nextSession);
    if (request.seedPersistentFromMemory !== false) {
      await this.seedSessionPersistentFromMemory(agentId, nextSession.id);
    }
    agent.activeSessionId = nextSession.id;
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);

    if (request.carryOverSummary?.trim() && !request.promotePersistentToMemory) {
      await this.store.appendMemorySummary(agentId, request.carryOverSummary.trim());
    }
    return nextSession;
  }

  async finalizeSession(agentId: string, request: FinalizeSessionRequest = {}): Promise<AgentSessionRecord> {
    return await this.startNewSession(agentId, {
      carryOverSummary: request.carryOverSummary,
      promotePersistentToMemory: request.promotePersistentToMemory ?? true,
      strategy: request.strategy,
      seedPersistentFromMemory: request.seedPersistentFromMemory,
      discardArchivedSessionContext: request.discardArchivedSessionContext,
    });
  }

  async previewFinalizeSession(
    agentId: string,
    request: FinalizeSessionRequest = {},
  ): Promise<FinalizeSessionPreview> {
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    const promotePersistentToMemory = request.promotePersistentToMemory ?? true;
    const memorySummaryBefore = await this.store.listMemorySummary(agentId);
    const memoryConstraintsBefore = await this.store.listMemoryConstraints(agentId);
    const persistentSummary = await this.store.listPersistentSummary(agentId, session.id);
    const persistentConstraints = await this.store.listPersistentConstraints(agentId, session.id);
    const memoryBudgetBefore = this.computeMemoryBudgetSnapshot(
      memorySummaryBefore,
      memoryConstraintsBefore,
    );
    const candidates = this.buildFinalizeSessionCandidates(
      memorySummaryBefore,
      memoryConstraintsBefore,
      persistentSummary,
      persistentConstraints,
      request.carryOverSummary,
      promotePersistentToMemory,
    );
    const heuristicStrategy = this.buildFinalizeHeuristicStrategy(candidates);
    const semanticSuggestion = await this.analyzeFinalizeSemantics(
      memoryBudgetBefore,
      candidates,
      request.carryOverSummary,
      promotePersistentToMemory,
      heuristicStrategy,
    );
    const decision = this.resolveFinalizeDecision(heuristicStrategy, semanticSuggestion);
    const currentStrategy = request.strategy ?? decision.resolvedStrategy;
    const rationale = [
      promotePersistentToMemory
        ? 'Finalizing this session will promote the current persistent summary/constraints into cross-session memory before opening the next session.'
        : 'Finalizing this session will not promote the current persistent state into memory; only the optional carry-over summary will survive.',
      request.carryOverSummary?.trim()
        ? 'A human-provided carry-over summary will also be appended during finalize.'
        : 'No additional human carry-over summary is provided for this finalize.',
      request.seedPersistentFromMemory === false
        ? 'The next session will start with an empty persistent layer instead of seeding from cross-session memory.'
        : 'The next session will seed its persistent layer from the resulting cross-session memory snapshot.',
      request.discardArchivedSessionContext
        ? 'The archived session turn log, current work, and persistent context will be scrubbed after finalize.'
        : 'The archived session context will remain on disk for later inspection unless explicitly scrubbed.',
      `Current preview strategy is ${currentStrategy}; compare candidates before deciding how much of persistent state should be promoted into cross-session memory.`,
    ];
    return {
      agentId,
      sessionId: session.id,
      promotePersistentToMemory,
      currentStrategy,
      carryOverSummary: request.carryOverSummary?.trim() || undefined,
      memoryBudgetBefore,
      memorySummaryCountBefore: memorySummaryBefore.length,
      memoryConstraintCountBefore: memoryConstraintsBefore.length,
      decision,
      semanticSuggestion,
      candidates,
      rationale,
    };
  }

  async clearMemory(agentId: string, request: ClearMemoryRequest): Promise<AgentManifest> {
    const agent = await this.getAgent(agentId);
    if (!request.confirm) {
      throw new Error('clear memory requires confirm=true');
    }
    await this.store.replaceMemorySummary(agentId, []);
    await this.store.replaceMemoryConstraints(agentId, []);
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return agent;
  }

  async resetPersistent(agentId: string, request: ResetPersistentRequest): Promise<AgentContextSnapshot> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    if (!request.confirm) {
      throw new Error('reset persistent requires confirm=true');
    }
    await this.store.replacePersistentSummary(agentId, session.id, []);
    await this.store.replacePersistentConstraints(agentId, session.id, []);
    if (request.clearCurrentWork) {
      await this.store.saveCurrentWork(agentId, session.id, []);
    }
    if (request.reseedFromMemory) {
      await this.seedSessionPersistentFromMemory(agentId, session.id);
    }
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return await this.getContextSnapshot(agentId);
  }

  async getContextSnapshot(agentId: string): Promise<AgentContextSnapshot> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    await this.assertPersistentBudget(agent, session);
    const memorySummaryEntries = await this.store.listMemorySummary(agentId);
    const memoryConstraintEntries = await this.store.listMemoryConstraints(agentId);
    const memoryBudget = this.computeMemoryBudgetSnapshot(
      memorySummaryEntries,
      memoryConstraintEntries,
    );
    const persistentSummaryEntries = await this.store.listPersistentSummary(agentId, session.id);
    const persistentConstraintEntries = await this.store.listPersistentConstraints(agentId, session.id);
    const persistentBudget = this.computePersistentBudgetSnapshot(
      persistentSummaryEntries,
      persistentConstraintEntries,
    );
    const recentTurns = await this.store.listRecentTurns(agentId, session.id);
    const currentWorkEntries = await this.store.listCurrentWork(agentId, session.id);
    const runs = await this.store.listRuns(agentId, session.id);
    const workLayout = this.inspectWorkLayout(currentWorkEntries);
    const workBudget = this.computeWorkBudgetSnapshot(
      agent.systemPrompt,
      memorySummaryEntries,
      memoryConstraintEntries,
      persistentSummaryEntries,
      persistentConstraintEntries,
      currentWorkEntries,
    );
    const pendingGoals = await this.store.listPendingGoals(agentId);
    const pendingClarification = await this.getPendingClarification(agentId);
    const recoveryIssues = session.recovery?.issues ?? [];
    const operationalGuidance = this.buildOperationalGuidance(
      workLayout,
      workBudget,
      currentWorkEntries,
      runs,
      memorySummaryEntries,
      memoryConstraintEntries,
      persistentSummaryEntries,
      persistentConstraintEntries,
    );
    const assembledContext = this.assembleContext(
      agent,
      session,
      memorySummaryEntries,
      memoryConstraintEntries,
      persistentSummaryEntries,
      persistentConstraintEntries,
      recentTurns,
      currentWorkEntries,
      workLayout,
      workBudget,
      persistentBudget,
      memoryBudget,
      operationalGuidance,
      recoveryIssues,
      pendingGoals,
      pendingClarification,
    );
    return {
      agent,
      session,
      assembledContext,
      pendingClarification,
      operationalGuidance,
      workLayout,
      workBudget,
      persistentBudget,
      memoryBudget,
      recoveryIssues,
      memorySummaryEntries,
      memoryConstraintEntries,
      persistentSummaryEntries,
      persistentConstraintEntries,
      recentTurns,
      currentWorkEntries,
      pendingGoals,
    };
  }

  async getRecoverySnapshot(agentId: string): Promise<AgentRecoverySnapshot> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    return {
      agentId,
      sessionId: session.id,
      status: session.recovery?.status ?? 'clean',
      issues: session.recovery?.issues ?? [],
      lastRecoveredAt: session.recovery?.lastRecoveredAt,
      acknowledgedAt: session.recovery?.acknowledgedAt,
    };
  }

  async acknowledgeRecovery(agentId: string, request: AcknowledgeRecoveryRequest = {}): Promise<AgentRecoverySnapshot> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    const nextSession = await this.store.acknowledgeSessionRecovery(
      agentId,
      session.id,
      request.clearIssues ?? true,
    );
    if (!nextSession) {
      throw new Error(`Session not found: ${session.id}`);
    }
    if ((nextSession.recovery?.status ?? 'clean') === 'clean' && agent.status === 'waiting_user') {
      agent.status = 'active';
      if (typeof request.resumeAutonomy === 'boolean') {
        agent.autonomy.enabled = request.resumeAutonomy;
      }
      if (agent.runtime.lastError?.toLowerCase().includes('recovery')) {
        agent.runtime.lastError = undefined;
      }
      agent.updatedAt = nowIso();
      await this.store.saveAgent(agent);
    }
    return {
      agentId,
      sessionId: nextSession.id,
      status: nextSession.recovery?.status ?? 'clean',
      issues: nextSession.recovery?.issues ?? [],
      lastRecoveredAt: nextSession.recovery?.lastRecoveredAt,
      acknowledgedAt: nextSession.recovery?.acknowledgedAt,
    };
  }

  async previewPersistentBudgetRecovery(agentId: string): Promise<PersistentBudgetPreview> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    const persistentSummary = await this.store.listPersistentSummary(agent.id, session.id);
    const persistentConstraints = await this.store.listPersistentConstraints(agent.id, session.id);
    const candidates = this.buildPersistentBudgetCandidates(persistentSummary, persistentConstraints);
    const heuristicStrategy = this.buildPersistentRecoveryHeuristicStrategy(candidates);
    const semanticSuggestion = await this.analyzePersistentRecoverySemantics(
      persistentSummary,
      persistentConstraints,
      candidates,
      heuristicStrategy,
    );
    const decision = this.resolvePersistentRecoveryDecision(heuristicStrategy, semanticSuggestion);
    return {
      agentId,
      sessionId: session.id,
      currentStrategy: decision.resolvedStrategy,
      decision,
      semanticSuggestion,
      candidates,
    };
  }

  async applyPersistentBudgetRecovery(
    agentId: string,
    request: ApplyPersistentBudgetRequest,
  ): Promise<PersistentBudgetPreview> {
    if (!request.confirm) {
      throw new Error('apply persistent budget recovery requires confirm=true');
    }
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    const persistentSummary = await this.store.listPersistentSummary(agent.id, session.id);
    const persistentConstraints = await this.store.listPersistentConstraints(agent.id, session.id);
    const strategy = request.strategy ?? await this.resolvePersistentRecoveryStrategy(agentId, session.id);
    const plan = this.planPersistentBudgetRecovery(persistentSummary, persistentConstraints, strategy);
    await this.store.replacePersistentSummary(agent.id, session.id, plan.keptSummary);
    await this.store.replacePersistentConstraints(agent.id, session.id, plan.keptConstraints);
    const preview = await this.previewPersistentBudgetRecovery(agentId);
    const chosen = preview.candidates.find((candidate) => candidate.strategy === strategy);
    const status = chosen?.statusAfterApply ?? 'needs_human';
    const issues = status === 'clean'
      ? []
      : [
        this.createRecoveryIssue(
          'persistent_budget_exceeded',
          `persistent still exceeds budget after ${strategy} slimming; human cleanup is still required.`,
          'critical',
        ),
      ];
    await this.store.replaceSessionRecoveryIssues(agent.id, session.id, issues, status);
    if (status === 'clean') {
      if (agent.status === 'waiting_user') {
        agent.status = 'active';
      }
      if (typeof request.resumeAutonomy === 'boolean') {
        agent.autonomy.enabled = request.resumeAutonomy;
      }
      if (agent.runtime.lastError?.toLowerCase().includes('persistent/ exceeded')) {
        agent.runtime.lastError = undefined;
      }
    } else {
      agent.status = 'waiting_user';
      agent.autonomy.enabled = false;
      agent.runtime.lastError = 'persistent/ still exceeds the configured token budget after automatic slimming.';
    }
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return {
      ...preview,
      currentStrategy: strategy,
    };
  }

  private buildFinalizeSessionCandidates(
    memorySummaryBefore: string[],
    memoryConstraintsBefore: AgentConstraintRecord[],
    persistentSummary: string[],
    persistentConstraints: AgentConstraintRecord[],
    carryOverSummary: string | undefined,
    promotePersistentToMemory: boolean,
  ): FinalizeSessionCandidate[] {
    const memoryBudgetBefore = this.computeMemoryBudgetSnapshot(
      memorySummaryBefore,
      memoryConstraintsBefore,
    );
    return (['conservative', 'balanced', 'aggressive'] as const).map((strategy) => {
      const plan = this.planFinalizeMemoryPromotion(
        memorySummaryBefore,
        memoryConstraintsBefore,
        persistentSummary,
        persistentConstraints,
        carryOverSummary,
        promotePersistentToMemory,
        strategy,
      );
      const nextSessionSeedSummary = plan.memorySummaryAfter.slice(-24);
      const nextSessionSeedConstraints = this.semanticMergeConstraintFamilies(
        plan.memoryConstraintsAfter,
        'session',
      );
      const memoryBudgetAfter = this.computeMemoryBudgetSnapshot(
        plan.memorySummaryAfter,
        plan.memoryConstraintsAfter,
      );
      const nextSessionSeedBudget = this.computePersistentBudgetSnapshot(
        nextSessionSeedSummary,
        nextSessionSeedConstraints,
      );
      const costDelta = this.buildTokenCostDelta(
        memoryBudgetBefore.tokenEconomics.effectivePerTurnCostUnits,
        memoryBudgetAfter.tokenEconomics.effectivePerTurnCostUnits,
        0,
        [
          'Finalize changes cross-session memory at a session boundary, so the main token benefit is lower cached-prefix cost on future turns rather than a large one-time rewrite penalty.',
          `The next session seed is estimated at ${nextSessionSeedBudget.tokenEconomics.effectivePerTurnCostUnits} effective cost units per turn.`,
        ],
      );
      return {
        strategy,
        description: strategy === 'conservative'
          ? 'Promote nearly all current persistent state into memory.'
          : strategy === 'balanced'
            ? 'Promote the most valuable subset of current persistent state into memory.'
            : 'Only keep a compact high-value core from the current session in memory.',
        memoryBudgetAfter,
        nextSessionSeedBudget,
        costDelta,
        promotedHighValueSummaryCount: plan.promotedSummary.filter((value, index) => (
          this.isHighValueSummary(value, index, plan.promotedSummary.length)
        )).length,
        promotedCriticalConstraintCount: this.countCriticalConstraints(plan.promotedConstraints),
        promotedStableConstraintCount: this.countStableConstraints(plan.promotedConstraints),
        promotedSummaryCount: plan.promotedSummary.length,
        promotedConstraintCount: plan.promotedConstraints.length,
        promotedSummarySamples: plan.promotedSummary.slice(-5).map((item) => excerpt(item, 120)),
        promotedConstraintKeys: plan.promotedConstraints.slice(0, 8).map((item) => item.key),
        nextSessionSeedSummaryCount: nextSessionSeedSummary.length,
        nextSessionSeedConstraintCount: nextSessionSeedConstraints.length,
        nextSessionSeedSummarySamples: nextSessionSeedSummary.slice(-5).map((item) => excerpt(item, 120)),
        nextSessionSeedConstraintKeys: nextSessionSeedConstraints.slice(0, 8).map((item) => item.key),
        rationale: plan.rationale,
      };
    });
  }

  private buildOperationalGuidance(
    workLayout: AgentWorkLayout,
    workBudget: AgentWorkBudgetSnapshot,
    currentWorkEntries: AgentWorkEntry[],
    runs: AgentRunRecord[],
    memorySummaryBefore: string[],
    memoryConstraintsBefore: AgentConstraintRecord[],
    persistentSummary: string[],
    persistentConstraints: AgentConstraintRecord[],
  ): AgentOperationalGuidance {
    const items: AgentOperationalGuidanceItem[] = [];

    const partialPlan = this.planPartialCompaction(currentWorkEntries, runs);
    const partialSemanticOpportunity = this.estimatePartialSemanticOpportunity(partialPlan);
    const partialCostDelta = partialPlan
      ? this.buildCompactionCostDelta(workBudget.approxPrefixTokens, currentWorkEntries, 'partial', partialPlan)
      : undefined;
    const fullCostDelta = this.buildCompactionCostDelta(workBudget.approxPrefixTokens, currentWorkEntries, 'full');
    const compactionBudgetRecommendedMode: CompactDecisionSnapshot['budgetRecommendedMode'] = (
      workBudget.status === 'hard_threshold_reached'
        ? 'full'
        : partialPlan && workLayout.safetyPointReached && (
          workBudget.status !== 'healthy'
          || Boolean(
            partialCostDelta
            && partialCostDelta.estimatedSavingsPerFutureTurn >= MIN_PARTIAL_COST_SAVINGS_PER_TURN
            && partialCostDelta.estimatedSavingsRatio >= MIN_PARTIAL_COST_SAVINGS_RATIO
          )
          || partialSemanticOpportunity.score >= MIN_PARTIAL_SEMANTIC_OPPORTUNITY_SCORE
        )
          ? 'partial'
          : 'none'
    );
    const compactionDecision = this.resolveCompactionDecision(
      workLayout,
      workBudget,
      partialPlan,
      null,
      compactionBudgetRecommendedMode,
    );
    items.push({
      area: 'compaction',
      recommendedAction: compactionDecision.resolvedMode === 'none'
        ? 'keep current work live'
        : compactionDecision.resolvedMode === 'full'
          ? 'consider full compaction'
          : 'consider partial compaction',
      urgency: compactionDecision.resolvedMode === 'full'
        ? 'high'
        : compactionDecision.resolvedMode === 'partial'
          ? 'medium'
          : 'low',
      estimatedSavingsPerFutureTurn: compactionDecision.resolvedMode === 'full'
        ? fullCostDelta?.estimatedSavingsPerFutureTurn
        : compactionDecision.resolvedMode === 'partial'
          ? partialCostDelta?.estimatedSavingsPerFutureTurn
          : undefined,
      rationale: [
        ...compactionDecision.rationale,
        ...(compactionDecision.resolvedMode === 'full' && fullCostDelta
          ? [`estimated future savings per turn: ${fullCostDelta.estimatedSavingsPerFutureTurn} effective token cost units`]
          : []),
        ...(compactionDecision.resolvedMode === 'partial' && partialCostDelta
          ? [`estimated future savings per turn: ${partialCostDelta.estimatedSavingsPerFutureTurn} effective token cost units`]
          : []),
      ],
    });

    const finalizeCandidates = this.buildFinalizeSessionCandidates(
      memorySummaryBefore,
      memoryConstraintsBefore,
      persistentSummary,
      persistentConstraints,
      undefined,
      true,
    );
    const finalizeHeuristic = this.buildFinalizeHeuristicStrategy(finalizeCandidates);
    const finalizeDecision = this.resolveFinalizeDecision(finalizeHeuristic, null);
    items.push({
      area: 'session_finalize',
      recommendedAction: `prefer ${finalizeDecision.resolvedStrategy} finalize strategy when ending this session`,
      urgency: finalizeDecision.resolvedStrategy === 'conservative' ? 'low' : 'medium',
      estimatedSavingsPerFutureTurn: finalizeCandidates.find((candidate) => candidate.strategy === finalizeDecision.resolvedStrategy)?.costDelta.estimatedSavingsPerFutureTurn,
      rationale: [
        ...finalizeDecision.rationale,
        `estimated future savings per turn: ${finalizeCandidates.find((candidate) => candidate.strategy === finalizeDecision.resolvedStrategy)?.costDelta.estimatedSavingsPerFutureTurn ?? 0} effective token cost units`,
      ],
    });

    const persistentCandidates = this.buildPersistentBudgetCandidates(persistentSummary, persistentConstraints);
    const persistentHeuristic = this.buildPersistentRecoveryHeuristicStrategy(persistentCandidates);
    const persistentDecision = this.resolvePersistentRecoveryDecision(persistentHeuristic, null);
    const persistentNeedsAction = persistentCandidates.some((candidate) => candidate.statusAfterApply === 'clean')
      && this.computePersistentBudgetSnapshot(persistentSummary, persistentConstraints).status !== 'healthy';
    items.push({
      area: 'persistent_recovery',
      recommendedAction: persistentNeedsAction
        ? `prefer ${persistentDecision.resolvedStrategy} persistent slimming if current session remains over budget`
        : 'no immediate persistent slimming is required',
      urgency: persistentNeedsAction ? 'medium' : 'low',
      estimatedSavingsPerFutureTurn: persistentCandidates.find((candidate) => candidate.strategy === persistentDecision.resolvedStrategy)?.costDelta.estimatedSavingsPerFutureTurn,
      rationale: [
        ...persistentDecision.rationale,
        `estimated future savings per turn: ${persistentCandidates.find((candidate) => candidate.strategy === persistentDecision.resolvedStrategy)?.costDelta.estimatedSavingsPerFutureTurn ?? 0} effective token cost units`,
      ],
    });

    const summary = items.map((item) => `${item.area}: ${item.recommendedAction}`);
    return { summary, items };
  }

  private buildFinalizeHeuristicStrategy(candidates: FinalizeSessionCandidate[]): FinalizeMemoryStrategy {
    const healthyCandidates = candidates.filter((candidate) => (
      candidate.memoryBudgetAfter.status === 'healthy'
      && candidate.nextSessionSeedBudget.status === 'healthy'
    ));
    if (healthyCandidates.length > 0) {
      return healthyCandidates
        .sort((left, right) => (
          right.costDelta.estimatedSavingsPerFutureTurn - left.costDelta.estimatedSavingsPerFutureTurn
          || right.costDelta.estimatedSavingsRatio - left.costDelta.estimatedSavingsRatio
          || (left.strategy === 'conservative' ? -1 : left.strategy === 'balanced' ? 0 : 1)
        ))[0]?.strategy ?? 'conservative';
    }
    return candidates
      .slice()
      .sort((left, right) => (
        right.costDelta.estimatedSavingsPerFutureTurn - left.costDelta.estimatedSavingsPerFutureTurn
        || right.costDelta.estimatedSavingsRatio - left.costDelta.estimatedSavingsRatio
      ))[0]?.strategy ?? 'conservative';
  }

  private resolveFinalizeDecision(
    heuristicStrategy: FinalizeMemoryStrategy,
    semanticSuggestion?: FinalizeSemanticSuggestion | null,
  ): FinalizeDecisionSnapshot {
    const semanticRecommendedStrategy = semanticSuggestion?.recommendedStrategy ?? heuristicStrategy;
    if (semanticSuggestion?.provider === 'llm') {
      return {
        heuristicStrategy,
        semanticRecommendedStrategy,
        resolvedStrategy: semanticRecommendedStrategy,
        source: 'semantic',
        rationale: [
          `Semantic finalize analysis recommends ${semanticRecommendedStrategy} as the best memory promotion strategy for this session.`,
        ],
      };
    }
    return {
      heuristicStrategy,
      semanticRecommendedStrategy,
      resolvedStrategy: heuristicStrategy,
      source: 'heuristic',
      rationale: [
        `Finalize strategy falls back to the heuristic recommendation: ${heuristicStrategy}.`,
      ],
    };
  }

  private async resolveFinalizeStrategy(
    agentId: string,
    sessionId: string,
    carryOverSummary: string | undefined,
    promotePersistentToMemory: boolean,
  ): Promise<FinalizeMemoryStrategy> {
    const memorySummaryBefore = await this.store.listMemorySummary(agentId);
    const memoryConstraintsBefore = await this.store.listMemoryConstraints(agentId);
    const persistentSummary = await this.store.listPersistentSummary(agentId, sessionId);
    const persistentConstraints = await this.store.listPersistentConstraints(agentId, sessionId);
    const memoryBudgetBefore = this.computeMemoryBudgetSnapshot(
      memorySummaryBefore,
      memoryConstraintsBefore,
    );
    const candidates = this.buildFinalizeSessionCandidates(
      memorySummaryBefore,
      memoryConstraintsBefore,
      persistentSummary,
      persistentConstraints,
      carryOverSummary,
      promotePersistentToMemory,
    );
    const heuristicStrategy = this.buildFinalizeHeuristicStrategy(candidates);
    const semanticSuggestion = await this.analyzeFinalizeSemantics(
      memoryBudgetBefore,
      candidates,
      carryOverSummary,
      promotePersistentToMemory,
      heuristicStrategy,
    );
    return this.resolveFinalizeDecision(heuristicStrategy, semanticSuggestion).resolvedStrategy;
  }

  private async analyzePersistentRecoverySemantics(
    persistentSummary: string[],
    persistentConstraints: AgentConstraintRecord[],
    candidates: PersistentBudgetCandidate[],
    heuristicStrategy: PersistentRecoveryStrategy,
  ): Promise<PersistentRecoverySemanticSuggestion> {
    const fallback = (): PersistentRecoverySemanticSuggestion => ({
      available: true,
      provider: 'heuristic',
      recommendedStrategy: heuristicStrategy,
      confidence: 'medium',
      rationale: [
        'semantic persistent recovery analysis fell back to the current heuristic strategy',
        `persistent_summary_count=${persistentSummary.length}, persistent_constraint_count=${persistentConstraints.length}`,
      ],
    });
    try {
      const config = loadOpenTeamConfig();
      const baseUrl = String(config.llm.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(config.llm.model || '').trim();
      if (!baseUrl || !model) {
        return {
          ...fallback(),
          available: false,
          provider: 'unavailable',
          rationale: ['LLM config is missing baseUrl or model, so semantic persistent recovery analysis is unavailable'],
        };
      }
      const prompt = [
        'You are a persistent-context slimming analyst for a long-running agent.',
        'Choose the best slimming strategy for the current persistent layer.',
        'Return JSON only.',
        'Output schema example: {"recommendedStrategy":"balanced","confidence":"medium","rationale":["reason 1","reason 2"]}',
        'recommendedStrategy must be one of: conservative, balanced, aggressive.',
        'confidence must be one of: low, medium, high.',
        'Always include at least two short rationale strings.',
        'Prefer strategies that keep critical/stable constraints, get back to clean budget status when possible, and lower long-run effective token cost without over-pruning high-value persistent facts.',
        '',
        `heuristic_strategy=${heuristicStrategy}`,
        `persistent_summary_count=${persistentSummary.length}`,
        `persistent_constraint_count=${persistentConstraints.length}`,
        `critical_constraint_keys=${persistentConstraints
          .filter((item) => item.priority === 'critical')
          .slice(0, 8)
          .map((item) => item.key)
          .join(', ') || 'none'}`,
        `stable_constraint_keys=${persistentConstraints
          .filter((item) => item.durability === 'stable')
          .slice(0, 8)
          .map((item) => item.key)
          .join(', ') || 'none'}`,
        `summary_samples=${persistentSummary.slice(-4).map((item) => excerpt(item, 120)).join(' | ') || 'none'}`,
        `constraint_keys=${persistentConstraints.slice(0, 8).map((item) => item.key).join(', ') || 'none'}`,
        '',
        'Candidates:',
        ...candidates.map((candidate) => (
          [
            `- strategy=${candidate.strategy}`,
            `  before=${candidate.beforeApproxTokens} after=${candidate.afterApproxTokens} budget=${candidate.budgetApproxTokens}`,
            `  status_after_apply=${candidate.statusAfterApply}`,
            `  kept_summary=${candidate.keptSummaryCount} kept_constraints=${candidate.keptConstraintCount}`,
            `  cost_delta=savings_per_turn:${candidate.costDelta.estimatedSavingsPerFutureTurn} ratio:${candidate.costDelta.estimatedSavingsRatio} rewrite:${candidate.costDelta.oneTimeRewriteCostUnits} break_even:${candidate.costDelta.estimatedBreakEvenTurns ?? 'n/a'}`,
            `  value_metrics=high_value_summary:${candidate.keptHighValueSummaryCount} critical_constraints:${candidate.keptCriticalConstraintCount} stable_constraints:${candidate.keptStableConstraintCount}`,
            `  kept_constraint_keys=${candidate.keptConstraintKeys.join(', ') || 'none'}`,
            `  dropped_constraint_keys=${candidate.droppedConstraintKeys.join(', ') || 'none'}`,
            `  kept_summary_samples=${candidate.keptSummarySamples.join(' | ') || 'none'}`,
            `  dropped_summary_samples=${candidate.droppedSummarySamples.join(' | ') || 'none'}`,
            `  reasoning=${candidate.reasoning.join(' | ')}`,
          ].join('\n')
        )),
      ].join('\n');

      const parsed = await this.requestSemanticJson<{
        recommendedStrategy?: PersistentRecoveryStrategy;
        confidence?: PersistentRecoverySemanticSuggestion['confidence'];
        rationale?: string[];
      }>(prompt);
      if (!parsed) {
        return fallback();
      }
      const recommendedStrategy = parsed.recommendedStrategy === 'conservative'
        || parsed.recommendedStrategy === 'balanced'
        || parsed.recommendedStrategy === 'aggressive'
        ? parsed.recommendedStrategy
        : heuristicStrategy;
      if (
        recommendedStrategy === heuristicStrategy
        && (!Array.isArray(parsed.rationale) || parsed.rationale.length === 0)
      ) {
        return fallback();
      }
      return {
        available: true,
        provider: 'llm',
        recommendedStrategy,
        confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : 'medium',
        rationale: Array.isArray(parsed.rationale) && parsed.rationale.length > 0
          ? parsed.rationale.map((item) => String(item))
          : fallback().rationale,
      };
    } catch {
      return fallback();
    }
  }

  async listRuns(agentId: string): Promise<AgentRunRecord[]> {
    await this.getAgent(agentId);
    return await this.store.listRuns(agentId);
  }

  async getRun(runId: string): Promise<AgentRunRecord> {
    const normalizedRunId = String(runId || '').trim();
    if (!normalizedRunId) {
      throw new Error('runId is required');
    }
    const run = await this.store.getRun(normalizedRunId);
    if (!run) {
      throw new Error(`Run not found: ${normalizedRunId}`);
    }
    return run;
  }

  async getCurrentWork(agentId: string, request: AgentCurrentWorkRequest = {}): Promise<AgentWorkEntry[]> {
    const agent = await this.getAgent(agentId);
    const sessionId = request.sessionId || agent.activeSessionId;
    const session = await this.store.getSession(agentId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return await this.store.listCurrentWork(agentId, sessionId);
  }

  async replaceCurrentWork(agentId: string, request: ReplaceCurrentWorkRequest): Promise<AgentWorkEntry[]> {
    return await this.serializeAgentOperation(agentId, async () => {
      const agent = await this.getAgent(agentId);
      const sessionId = request.sessionId || agent.activeSessionId;
      const session = await this.store.getSession(agentId, sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await this.store.saveCurrentWork(agentId, sessionId, request.entries);
      if (typeof request.nextTurnNumber === 'number' && Number.isFinite(request.nextTurnNumber)) {
        session.nextTurnNumber = request.nextTurnNumber;
        session.updatedAt = nowIso();
        await this.store.saveSession(session);
      }
      return await this.store.listCurrentWork(agentId, sessionId);
    });
  }

  async appendMemorySummary(agentId: string, request: AppendMemorySummaryRequest): Promise<string[]> {
    return await this.serializeAgentOperation(agentId, async () => {
      await this.getAgent(agentId);
      await this.store.appendMemorySummary(agentId, request.value);
      return await this.store.listMemorySummary(agentId);
    });
  }

  async appendPersistentSummary(agentId: string, request: AppendPersistentSummaryRequest): Promise<string[]> {
    return await this.serializeAgentOperation(agentId, async () => {
      const agent = await this.getAgent(agentId);
      const sessionId = request.sessionId || agent.activeSessionId;
      const session = await this.store.getSession(agentId, sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await this.store.appendPersistentSummary(agentId, sessionId, request.value);
      return await this.store.listPersistentSummary(agentId, sessionId);
    });
  }

  async appendMemoryConstraints(
    agentId: string,
    request: AppendMemoryConstraintsRequest,
  ): Promise<AgentConstraintRecord[]> {
    return await this.serializeAgentOperation(agentId, async () => {
      await this.getAgent(agentId);
      await this.store.appendMemoryConstraints(agentId, request.items);
      return await this.store.listMemoryConstraints(agentId);
    });
  }

  async appendPersistentConstraints(
    agentId: string,
    request: AppendPersistentConstraintsRequest,
  ): Promise<AgentConstraintRecord[]> {
    return await this.serializeAgentOperation(agentId, async () => {
      const agent = await this.getAgent(agentId);
      const sessionId = request.sessionId || agent.activeSessionId;
      const session = await this.store.getSession(agentId, sessionId);
      if (!session) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      await this.store.appendPersistentConstraints(agentId, sessionId, request.items);
      return await this.store.listPersistentConstraints(agentId, sessionId);
    });
  }

  async reviveAgent(agentId: string, request: ReviveAgentRequest = {}): Promise<AgentManifest> {
    return await this.serializeAgentOperation(agentId, async () => {
      const agent = await this.getAgent(agentId);
      if (agent.status === 'error') {
        agent.status = 'active';
      }
      agent.runtime.isRunning = false;
      agent.runtime.currentRunId = undefined;
      if (request.resetConsecutiveErrors !== false) {
        agent.runtime.consecutiveErrors = 0;
      }
      if (request.clearLastError !== false) {
        agent.runtime.lastError = undefined;
      }
      if (request.resumeAutonomy && agent.autonomy.enabled) {
        agent.status = 'active';
      }
      agent.updatedAt = nowIso();
      await this.store.saveAgent(agent);
      return agent;
    });
  }

  async getTurns(agentId: string, query: AgentTurnLogQuery = {}): Promise<AgentTurnRecord[]> {
    const agent = await this.getAgent(agentId);
    const sessionId = query.sessionId || agent.activeSessionId;
    const session = await this.store.getSession(agentId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return await this.store.listTurnsRange(
      agentId,
      sessionId,
      query.startTurn,
      query.endTurn,
      query.limit,
    );
  }

  async retrieveContext(agentId: string, request: AgentRetrievalRequest): Promise<AgentRetrievalResult> {
    const query = String(request.query || '').trim();
    if (!query) {
      throw new Error('query is required');
    }
    const contextSnapshot = await this.getContextSnapshot(agentId);
    const sessionId = request.sessionId || contextSnapshot.session.id;
    const session = sessionId === contextSnapshot.session.id
      ? contextSnapshot.session
      : await this.store.getSession(agentId, sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const terms = focusTerms(query);
    const maxItems = Math.max(1, Math.min(20, Math.floor(request.maxItemsPerLayer ?? 5)));
    const planner = this.planRetrieval(query, request.includeWorkspaceSearch);
    const optimizeForTokenEconomics = request.optimizeForTokenEconomics !== false;
    const economicsRationale: string[] = [];
    const orderedLayers = optimizeForTokenEconomics
      && request.includeWorkspaceSearch !== true
      && planner.queryKind === 'mixed'
      && planner.usedWorkspaceSearch
      ? [
        'current_compaction_constraints',
        'current_compaction_summary',
        'current_partial_summary',
        'workspace_files',
        'workspace_content',
        'turn_log',
        'persistent_constraints',
        'persistent_summary',
        'memory_constraints',
        'memory_summary',
      ] satisfies AgentRetrievalHit['layer'][]
      : planner.orderedLayers;
    if (orderedLayers !== planner.orderedLayers) {
      economicsRationale.push(
        'Reordered balanced retrieval to inspect current partial summaries before workspace search, preserving stable-prefix reuse when history already answers the mixed query.',
      );
    }
    const currentWorkEntries = sessionId === contextSnapshot.session.id
      ? contextSnapshot.currentWorkEntries
      : await this.store.listCurrentWork(agentId, sessionId);
    const persistentConstraints = sessionId === contextSnapshot.session.id
      ? contextSnapshot.persistentConstraintEntries
      : await this.store.listPersistentConstraints(agentId, sessionId);
    const persistentSummary = sessionId === contextSnapshot.session.id
      ? contextSnapshot.persistentSummaryEntries
      : await this.store.listPersistentSummary(agentId, sessionId);
    const memoryConstraints = contextSnapshot.memoryConstraintEntries;
    const persistentConstraintPool = this.semanticMergeConstraintFamilies(persistentConstraints, 'session');
    const memoryConstraintPool = this.semanticMergeConstraintFamilies(memoryConstraints, 'memory');
    const memorySummary = contextSnapshot.memorySummaryEntries;
    const compactionEntries = currentWorkEntries.filter((entry): entry is AgentCompactionTagRecord => entry.kind === 'compaction');
    const partialEntries = currentWorkEntries.filter((entry): entry is AgentCompactionTagRecord => entry.kind === 'partial_compaction');
    let workspaceSearchPromise: Promise<AgentWorkspaceSearchResult | null> | null = null;
    let workspaceSearchExecuted = false;
    const getWorkspaceSearch = async (): Promise<AgentWorkspaceSearchResult | null> => {
      if (!planner.usedWorkspaceSearch) {
        return null;
      }
      if (!workspaceSearchPromise) {
        workspaceSearchExecuted = true;
        const workspaceMaxResults = optimizeForTokenEconomics
          && request.includeWorkspaceSearch !== true
          && planner.queryKind === 'mixed'
          && (evidenceQuality === 'weak' || evidenceQuality === 'moderate')
          ? Math.max(2, Math.min(3, maxItems))
          : Math.max(4, maxItems);
        if (workspaceMaxResults < Math.max(4, maxItems)) {
          economicsRationale.push(
            `Workspace search result count was capped at ${workspaceMaxResults} because mixed-query history evidence was already ${evidenceQuality}.`,
          );
        }
        workspaceSearchPromise = this.searchWorkspace(agentId, {
          query,
          mode: 'both',
          fileGlob: request.fileGlob,
          maxResults: workspaceMaxResults,
        });
      }
      return await workspaceSearchPromise;
    };

    let archivedTurnsPromise: Promise<{
      turns: AgentTurnRecord[];
      ranges: Array<{ source: string; start: number; end: number }>;
    }> | null = null;
    const getArchivedTurns = async () => {
      if (!archivedTurnsPromise) {
        archivedTurnsPromise = this.buildTurnLogCandidates(
          agentId,
          sessionId,
          currentWorkEntries,
          request.maxArchivedRangesToReopen ?? this.defaultArchivedRangeBudget(planner.strategy),
        );
      }
      return await archivedTurnsPromise;
    };

    const layerProviders = new Map<AgentRetrievalHit['layer'], () => Promise<AgentRetrievalHit[]>>([
      ['current_compaction_constraints', async () => this.rankRetrievalHits(
        compactionEntries.flatMap((entry) => (entry.constraints ?? []).map((constraint) => ({
          layer: 'current_compaction_constraints' as const,
          text: `${constraint.key} ${constraint.desc}`,
          label: `${constraint.key} @turn_${constraint.turn}`,
          excerpt: constraint.desc,
          archived: archivedRefs(entry.archived).join(' | '),
          turnRange: this.parseTurnRange(entry.turns) ?? undefined,
        }))),
        terms,
        maxItems,
      )],
      ['current_compaction_summary', async () => this.rankRetrievalHits(
        compactionEntries.map((entry) => ({
          layer: 'current_compaction_summary' as const,
          text: entry.summary.join(' '),
          label: entry.turns,
          excerpt: entry.summary.join(' '),
          archived: archivedRefs(entry.archived).join(' | '),
          turnRange: this.parseTurnRange(entry.turns) ?? undefined,
        })),
        terms,
        maxItems,
      )],
      ['current_partial_summary', async () => this.rankRetrievalHits(
        partialEntries.map((entry) => ({
          layer: 'current_partial_summary' as const,
          text: entry.summary.join(' '),
          label: entry.turns,
          excerpt: entry.summary.join(' '),
          archived: archivedRefs(entry.archived).join(' | '),
          turnRange: this.parseTurnRange(entry.turns) ?? undefined,
        })),
        terms,
        maxItems,
      )],
      ['turn_log', async () => {
        const archivedTurnsResult = await getArchivedTurns();
        return this.rankRetrievalHits(
          archivedTurnsResult.turns.map((entry) => ({
            layer: 'turn_log' as const,
            text: `${entry.role} ${entry.content}`,
            label: `turn_${entry.turnNumber ?? '?'}`,
            excerpt: excerpt(entry.content, 220),
            turnRange: entry.turnNumber ? { start: entry.turnNumber, end: entry.turnNumber } : undefined,
          })),
          terms,
          maxItems,
        );
      }],
      ['workspace_files', async () => {
        const workspaceSearch = await getWorkspaceSearch();
        return this.rankRetrievalHits(
          (workspaceSearch?.hits ?? [])
            .filter((hit) => hit.layer === 'workspace_files')
            .map((hit) => ({
              layer: 'workspace_files' as const,
              text: `${hit.path} ${hit.excerpt}`,
              label: hit.path,
              excerpt: hit.excerpt,
            })),
          terms,
          maxItems,
        );
      }],
      ['workspace_content', async () => {
        const workspaceSearch = await getWorkspaceSearch();
        return this.rankRetrievalHits(
          (workspaceSearch?.hits ?? [])
            .filter((hit) => hit.layer === 'workspace_content')
            .map((hit) => ({
              layer: 'workspace_content' as const,
              text: `${hit.path} ${hit.excerpt}`,
              label: hit.line ? `${hit.path}:${hit.line}` : hit.path,
              excerpt: hit.excerpt,
            })),
          terms,
          maxItems,
        );
      }],
      ['persistent_constraints', async () => this.rankRetrievalHits(
        persistentConstraintPool.map((entry) => ({
          layer: 'persistent_constraints' as const,
          text: `${entry.family ?? entry.key} ${entry.key} ${(entry.familyMembers ?? []).join(' ')} ${entry.desc} ${(entry.evidence ?? []).join(' ')}`,
          label: `${entry.family ?? entry.key} @turn_${entry.turn}`,
          excerpt: `${entry.desc}${(entry.familyMembers?.length ?? 0) > 1 ? ` | members: ${entry.familyMembers?.join(', ')}` : ''}${(entry.evidence?.length ?? 0) > 0 ? ` | evidence: ${entry.evidence?.join('; ')}` : ''}`,
          turnRange: { start: entry.turn, end: entry.turn },
        })),
        terms,
        maxItems,
      )],
      ['persistent_summary', async () => this.rankRetrievalHits(
        persistentSummary.map((entry, index) => ({
          layer: 'persistent_summary' as const,
          text: entry,
          label: `persistent_summary_${index + 1}`,
          excerpt: entry,
        })),
        terms,
        maxItems,
      )],
      ['memory_constraints', async () => this.rankRetrievalHits(
        memoryConstraintPool.map((entry) => ({
          layer: 'memory_constraints' as const,
          text: `${entry.family ?? entry.key} ${entry.key} ${(entry.familyMembers ?? []).join(' ')} ${entry.desc} ${(entry.evidence ?? []).join(' ')}`,
          label: `${entry.family ?? entry.key} @turn_${entry.turn}`,
          excerpt: `${entry.desc}${(entry.familyMembers?.length ?? 0) > 1 ? ` | members: ${entry.familyMembers?.join(', ')}` : ''}${(entry.evidence?.length ?? 0) > 0 ? ` | evidence: ${entry.evidence?.join('; ')}` : ''}`,
          turnRange: { start: entry.turn, end: entry.turn },
        })),
        terms,
        maxItems,
      )],
      ['memory_summary', async () => this.rankRetrievalHits(
        memorySummary.map((entry, index) => ({
          layer: 'memory_summary' as const,
          text: entry,
          label: `memory_summary_${index + 1}`,
          excerpt: entry,
        })),
        terms,
        maxItems,
      )],
    ]);

    const layers: AgentRetrievalLayerResult[] = [];
    const searchedLayers: AgentRetrievalHit['layer'][] = [];
    const skippedLayers: AgentRetrievalHit['layer'][] = [];
    let evidenceQuality: 'none' | 'weak' | 'moderate' | 'strong' = 'none';
    let stopReason: 'strong_evidence' | 'searched_all_layers' | 'no_evidence' = 'searched_all_layers';
    for (const layer of orderedLayers) {
      const historyHitsBeforeWorkspace = layers.some((item) => (
        item.layer !== 'workspace_files'
        && item.layer !== 'workspace_content'
        && item.hits.length > 0
      ));
      if (
        optimizeForTokenEconomics
        && request.includeWorkspaceSearch !== true
        && planner.queryKind === 'mixed'
        && (layer === 'workspace_files' || layer === 'workspace_content')
        && (historyHitsBeforeWorkspace || evidenceQuality === 'moderate')
      ) {
        skippedLayers.push(layer);
        economicsRationale.push(
          `Skipped ${layer} because mixed-query history evidence had already produced hits before workspace search, so extra workspace hits would add mostly uncached cost.`,
        );
        continue;
      }
      const provider = layerProviders.get(layer);
      const hits = provider ? await provider() : [];
      layers.push({ layer, hits });
      searchedLayers.push(layer);
      evidenceQuality = this.assessEvidenceQuality(layers);
      if (evidenceQuality === 'strong') {
        stopReason = 'strong_evidence';
        break;
      }
    }
    if (layers.every((layer) => layer.hits.length === 0)) {
      stopReason = 'no_evidence';
    }
    for (const layer of orderedLayers) {
      if (!searchedLayers.includes(layer) && !skippedLayers.includes(layer)) {
        skippedLayers.push(layer);
      }
    }
    const needsHumanClarification = layers.every((layer) => layer.hits.length === 0)
      || this.shouldClarifyWeakConstraintOnlyEvidence(planner.queryKind, layers, evidenceQuality);
    const clarification = request.openClarificationOnMiss && needsHumanClarification
      ? await this.openClarification(
        agentId,
        sessionId,
        query,
        'retrieval chain produced no evidence for the requested query',
        this.clarificationKindForQuery(planner.queryKind),
      )
      : undefined;
    const evidenceSummary = this.buildRetrievalEvidenceSummary(layers);
    const archivedTurnsResult = searchedLayers.includes('turn_log')
      ? await getArchivedTurns()
      : { turns: [], ranges: [] as Array<{ source: string; start: number; end: number }> };
    const workspaceSearch = workspaceSearchExecuted ? await getWorkspaceSearch() : null;
    const tokenEconomics = this.buildRetrievalTokenEconomics({
      archivedTurns: archivedTurnsResult.turns,
      workspaceHits: workspaceSearch?.hits ?? [],
      evidenceLayers: layers,
      usedWorkspaceSearch: workspaceSearchExecuted,
      reopenedRanges: archivedTurnsResult.ranges,
    });
    return {
      agentId,
      sessionId,
      query,
      needsHumanClarification,
      recommendedAction: needsHumanClarification ? 'ask_human_for_clarification' : 'answer_from_history',
      clarification,
      planner: {
        ...planner,
        orderedLayers,
        workspaceSearchExecuted,
        economicsAdjusted: economicsRationale.length > 0,
        economicsRationale,
        searchedLayers,
        skippedLayers,
        evidenceQuality,
        stopReason,
        reopenedArchivedRanges: archivedTurnsResult.ranges,
        evidenceSummary,
        tokenEconomics,
      },
      layers,
    };
  }

  async searchWorkspace(agentId: string, request: AgentWorkspaceSearchRequest = {}): Promise<AgentWorkspaceSearchResult> {
    const agent = await this.getAgent(agentId);
    const mode = request.mode ?? 'both';
    const maxResults = Math.max(1, Math.min(200, Math.floor(request.maxResults ?? 50)));
    const query = String(request.query || '').trim();
    const queryTerms = focusTerms(query);
    const fileGlob = request.fileGlob?.trim();
    const hits: AgentWorkspaceSearchResult['hits'] = [];
    const fileHits: AgentWorkspaceSearchResult['hits'] = [];
    let strongestFileScore = 0;
    const contentHits: Array<AgentWorkspaceSearchResult['hits'][number] & { score: number }> = [];
    const scoreWorkspaceCandidate = (path: string, excerptText = ''): number => {
      const combined = `${path} ${excerptText}`;
      let score = queryTerms.length === 0 ? 1 : scoreTextMatch(combined, queryTerms);
      const loweredPath = path.toLowerCase();
      for (const term of queryTerms) {
        if (!term) {
          continue;
        }
        if (loweredPath.includes(term)) {
          score += 2;
          if (/[./_-]/.test(term) || /\d/.test(term) || term.length >= 10) {
            score += 2;
          }
        }
      }
      return score;
    };

    if (mode === 'files' || mode === 'both') {
      const fileArgs = ['--files'];
      if (fileGlob) {
        fileArgs.push('-g', fileGlob);
      }
      const fileRun = await execFileAsync('rg', fileArgs, {
        cwd: agent.workingDirectory,
        maxBuffer: 8 * 1024 * 1024,
      });
      const files = fileRun.stdout
        .split('\n')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((path) => ({
          path,
          score: scoreWorkspaceCandidate(path),
        }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .slice(0, maxResults);
      strongestFileScore = files[0]?.score ?? 0;
      for (const file of files) {
        fileHits.push({
          layer: 'workspace_files',
          path: file.path,
          excerpt: file.path,
        });
      }
    }

    if ((mode === 'content' || mode === 'both') && query) {
      const patterns = queryTerms.length > 0 ? queryTerms : [query];
      const seenContentHits = new Set<string>();
      const strongFileHit = strongestFileScore >= 6;
      const minContentScore = fileHits.length > 0
        ? (strongFileHit ? 4 : 2)
        : 1;
      const contentBudget = Math.max(
        strongFileHit ? 1 : 2,
        Math.min(
          maxResults,
          fileHits.length > 0
            ? Math.min(strongFileHit ? 1 : 3, Math.max(strongFileHit ? 1 : 2, maxResults - fileHits.length))
            : Math.min(6, maxResults),
        ),
      );
      for (const pattern of patterns) {
        const contentArgs = ['-n', '--no-heading', '--color', 'never'];
        if (!request.caseSensitive) {
          contentArgs.push('-i');
        }
        if (fileGlob) {
          contentArgs.push('-g', fileGlob);
        }
        contentArgs.push(pattern);
        contentArgs.push('.');
        try {
          const contentRun = await execFileAsync('rg', contentArgs, {
            cwd: agent.workingDirectory,
            maxBuffer: 8 * 1024 * 1024,
          });
          const lines = contentRun.stdout
            .split('\n')
            .map((item) => item.trim())
            .filter(Boolean);
          for (const line of lines) {
            const match = line.match(/^([^:]+):(\d+):(.*)$/);
            if (!match) {
              continue;
            }
            const key = `${match[1]}:${match[2]}:${match[3].trim()}`;
            if (seenContentHits.has(key)) {
              continue;
            }
            seenContentHits.add(key);
            const excerptText = match[3].trim();
            contentHits.push({
              layer: 'workspace_content',
              path: match[1],
              line: Number(match[2]),
              excerpt: excerptText,
              score: scoreWorkspaceCandidate(match[1], excerptText),
            });
          }
        } catch (error) {
          const exitCode = typeof error === 'object' && error && 'code' in error
            ? Number((error as { code?: unknown }).code)
            : null;
          if (exitCode !== 1) {
            throw error;
          }
        }
      }

      const seenPaths = new Set<string>();
      for (const hit of contentHits
        .filter((hit) => hit.score >= minContentScore)
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0))) {
        const pathKey = hit.path.toLowerCase();
        if (seenPaths.has(pathKey) && fileHits.some((file) => file.path.toLowerCase() === pathKey)) {
          continue;
        }
        if (!seenPaths.has(pathKey)) {
          seenPaths.add(pathKey);
        }
        hits.push({
          layer: 'workspace_content',
          path: hit.path,
          line: hit.line,
          excerpt: hit.excerpt,
        });
        if (hits.filter((entry) => entry.layer === 'workspace_content').length >= contentBudget) {
          break;
        }
      }
    }

    hits.unshift(...fileHits);

    const tokenEconomics = this.buildRetrievalTokenEconomics({
      workspaceHits: hits,
      usedWorkspaceSearch: true,
    });

    return {
      agentId,
      workingDirectory: agent.workingDirectory,
      mode,
      query: query || undefined,
      fileGlob,
      hits: hits.slice(0, maxResults),
      tokenEconomics,
    };
  }

  async getPendingClarification(agentId: string): Promise<AgentClarificationRecord | null> {
    const agent = await this.getAgent(agentId);
    if (!agent.runtime.pendingClarificationId) {
      return null;
    }
    return await this.store.getClarification(agentId, agent.runtime.pendingClarificationId);
  }

  async listClarifications(agentId: string): Promise<AgentClarificationRecord[]> {
    await this.getAgent(agentId);
    return await this.store.listClarifications(agentId);
  }

  async resolveClarification(agentId: string, request: ResolveClarificationRequest): Promise<AgentClarificationRecord> {
    const agent = await this.getAgent(agentId);
    const response = String(request.response || '').trim();
    if (!response) {
      throw new Error('response is required');
    }
    let clarification = request.clarificationId
      ? await this.store.getClarification(agentId, request.clarificationId)
      : null;
    if (!clarification) {
      clarification = await this.getPendingClarification(agentId);
    }
    if (!clarification) {
      clarification = (await this.store.listClarifications(agentId)).find((item) => item.status === 'pending') ?? null;
    }
    if (!clarification) {
      throw new Error(`Pending clarification not found for agent: ${agentId}`);
    }
    clarification.status = 'resolved';
    clarification.response = response;
    clarification.resolvedAt = nowIso();
    await this.store.saveClarification(clarification);
    await this.store.appendPersistentSummary(
      agentId,
      clarification.sessionId,
      `Human clarification resolved for "${clarification.query}": ${excerpt(response, 240)}`,
    );
    agent.runtime.pendingClarificationId = undefined;
    agent.status = 'active';
    if (typeof request.resumeAutonomy === 'boolean') {
      agent.autonomy.enabled = request.resumeAutonomy;
    }
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    await this.enqueueGoal(agentId, {
      goal: `Human clarification for "${clarification.query}": ${response}`,
    });
    return clarification;
  }

  async sendMessage(
    agentId: string,
    request: AgentMessageRequest,
    stream?: AgentRunStreamOptions,
  ): Promise<AgentRunRecord> {
    return await this.executePrompt(agentId, request, 'user', stream);
  }

  async enqueueGoal(agentId: string, request: AgentGoalRequest): Promise<AgentGoalRecord[]> {
    const agent = await this.getAgent(agentId);
    const goal = String(request.goal || '').trim();
    if (!goal) {
      throw new Error('goal is required');
    }
    const record: AgentGoalRecord = {
      id: `goal-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      content: goal,
      source: 'user',
      createdAt: nowIso(),
    };
    await this.store.enqueueGoal(agentId, record);
    agent.runtime.pendingGoalCount = (await this.store.listPendingGoals(agentId)).length;
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return await this.store.listPendingGoals(agentId);
  }

  async updateAutonomy(agentId: string, request: AgentAutonomyRequest): Promise<AgentManifest> {
    const agent = await this.getAgent(agentId);
    if (typeof request.enabled === 'boolean') {
      agent.autonomy.enabled = request.enabled;
      if (request.enabled && agent.status === 'paused') {
        agent.status = 'active';
      }
    }
    if (typeof request.intervalMs === 'number' && Number.isFinite(request.intervalMs)) {
      agent.autonomy.intervalMs = Math.max(5_000, Math.floor(request.intervalMs));
    }
    if (typeof request.autoReflect === 'boolean') {
      agent.autonomy.autoReflect = request.autoReflect;
    }
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return agent;
  }

  async compactAgent(agentId: string, request: CompactAgentRequest = {}): Promise<AgentCompactionTagRecord | null> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    return await this.compactSessionWork(agent, session, request.mode ?? 'auto', request.decisionBy ?? 'human');
  }

  async previewCompaction(agentId: string, request: CompactAgentRequest = {}): Promise<CompactPreviewResult> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getActiveSession(agentId);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agentId}`);
    }
    const currentWork = await this.store.listCurrentWork(agent.id, session.id);
    const runs = await this.store.listRuns(agent.id, session.id);
    const contextSnapshot = await this.getContextSnapshot(agentId);
    const partialPlan = this.planPartialCompaction(currentWork, runs);
    const turns = currentWork.filter(normalizeWorkEntryTurn);
    const fullTurnRange = turns.length > 0 ? this.formatTurnRange(turns) : undefined;
    const partialTurns = partialPlan?.compressibleEntries.filter(normalizeWorkEntryTurn) ?? [];
    const partialTurnRange = partialTurns.length > 0 ? this.formatTurnRange(partialTurns) : undefined;
    const partialAvailable = Boolean(partialPlan && contextSnapshot.workLayout.safetyPointReached);
    const hardThresholdReached = contextSnapshot.workBudget.status === 'hard_threshold_reached';
    const partialSemanticOpportunity = this.estimatePartialSemanticOpportunity(partialPlan);
    const partialCostDelta = partialPlan
      ? this.buildCompactionCostDelta(contextSnapshot.workBudget.approxPrefixTokens, currentWork, 'partial', partialPlan)
      : undefined;
    const fullCostDelta = this.buildCompactionCostDelta(contextSnapshot.workBudget.approxPrefixTokens, currentWork, 'full');
    const requestedMode = request.mode ?? 'auto';
    const budgetRecommendedMode: CompactDecisionSnapshot['budgetRecommendedMode'] = hardThresholdReached
      ? 'full'
      : partialAvailable && (
        contextSnapshot.workBudget.status !== 'healthy'
        || Boolean(
          partialCostDelta
          && partialCostDelta.estimatedSavingsPerFutureTurn >= MIN_PARTIAL_COST_SAVINGS_PER_TURN
          && partialCostDelta.estimatedSavingsRatio >= MIN_PARTIAL_COST_SAVINGS_RATIO
        )
        || partialSemanticOpportunity.score >= MIN_PARTIAL_SEMANTIC_OPPORTUNITY_SCORE
      )
        ? 'partial'
        : 'none';
    const semanticSuggestion = await this.analyzeCompactionSemantics(
      contextSnapshot.workLayout,
      contextSnapshot.workBudget,
      currentWork,
      partialPlan,
      budgetRecommendedMode,
      partialCostDelta,
      fullCostDelta,
    );
    const decision = this.resolveCompactionDecision(
      contextSnapshot.workLayout,
      contextSnapshot.workBudget,
      partialPlan,
      semanticSuggestion,
      budgetRecommendedMode,
    );
    const recommendedMode = decision.resolvedMode;
    const previewStableBoundaryTurn = semanticSuggestion?.recommendedMode === 'partial'
      ? semanticSuggestion.suggestedStableBoundaryTurn ?? partialPlan?.stableBoundaryTurn
      : partialPlan?.stableBoundaryTurn;
    const candidates: CompactPreviewCandidate[] = [
      {
        mode: 'partial',
        available: partialAvailable,
        reason: !partialPlan
          ? 'not enough raw dynamic work exists after the latest compressed island to justify partial compaction'
          : !contextSnapshot.workLayout.safetyPointReached
            ? 'partial compaction still requires a safety point'
            : 'partial compaction can replace the current dynamic island while preserving stable/raw islands',
        estimatedCompressionRatio: partialTurns.length > 0 ? this.estimateCompressionRatio(partialTurns) : undefined,
        semanticOpportunityScore: partialSemanticOpportunity.score,
        costDelta: partialCostDelta,
        turnRange: partialTurnRange,
        stableBoundaryTurn: previewStableBoundaryTurn,
        dynamicTailTurns: partialPlan?.dynamicTailTurns,
        boundaryCandidates: semanticSuggestion?.candidateTurns
          ?.map((candidate) => ({
            ...candidate,
            selected: candidate.turnNumber === previewStableBoundaryTurn,
          })) ?? partialPlan?.boundaryCandidates,
        rationale: [
          ...(partialPlan?.rationale ?? contextSnapshot.workLayout.rationale),
          ...(semanticSuggestion?.provider === 'llm'
            ? semanticSuggestion.rationale.map((item) => `semantic: ${item}`)
            : []),
        ],
      },
      {
        mode: 'full',
        available: turns.length >= 2,
        reason: hardThresholdReached
          ? 'hard work_ratio threshold reached; full compaction is now the recommended safety valve'
          : 'full compaction is always available as an explicit human operation, but is mainly recommended when the hard threshold is reached',
        estimatedCompressionRatio: turns.length > 0 ? this.estimateCompressionRatio(turns) : undefined,
        costDelta: fullCostDelta,
        turnRange: fullTurnRange,
        stableBoundaryTurn: contextSnapshot.workLayout.stableBoundaryTurn,
        rationale: hardThresholdReached
          ? [
            ...contextSnapshot.workBudget.rationale,
            'full compaction will re-evaluate the whole work window instead of only compressing the current dynamic suffix',
          ]
          : ['full compaction would compress the whole current work window into one compaction tag'],
      },
    ];
    return {
      agentId,
      sessionId: session.id,
      requestedMode,
      recommendedMode,
      decision,
      workLayout: contextSnapshot.workLayout,
      workBudget: contextSnapshot.workBudget,
      candidates,
      semanticSuggestion,
      rationale: decision.rationale,
    };
  }

  async runNextGoal(agentId: string): Promise<AgentRunRecord | null> {
    return await this.serializeAgentOperation(agentId, async () => {
      const agent = await this.getAgent(agentId);
      const nextGoal = await this.store.dequeueGoal(agentId);
      agent.runtime.pendingGoalCount = (await this.store.listPendingGoals(agentId)).length;
      await this.store.saveAgent(agent);
      if (!nextGoal) {
        return null;
      }
      return await this.executePromptUnsafe(agentId, { message: nextGoal.content }, nextGoal.source);
    });
  }

  async enqueueReflection(agentId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    const pendingGoals = await this.store.listPendingGoals(agentId);
    if (pendingGoals.length > 0) {
      return;
    }
    const reflectionGoal: AgentGoalRecord = {
      id: `goal-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      source: 'system',
      createdAt: nowIso(),
      content: '请检查当前 working directory 和已有记忆，判断下一步最有价值的自主工作；如果没有安全且明确的下一步，就简要说明原因。',
    };
    await this.store.enqueueGoal(agentId, reflectionGoal);
    agent.runtime.pendingGoalCount = 1;
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
  }

  private async executePrompt(
    agentId: string,
    request: AgentMessageRequest,
    role: 'user' | 'system',
    stream?: AgentRunStreamOptions,
  ): Promise<AgentRunRecord> {
    return await this.serializeAgentOperation(agentId, async () => (
      await this.executePromptUnsafe(agentId, request, role, stream)
    ));
  }

  private async executePromptUnsafe(
    agentId: string,
    request: AgentMessageRequest,
    role: 'user' | 'system',
    stream?: AgentRunStreamOptions,
  ): Promise<AgentRunRecord> {
    const message = String(request.message || '').trim();
    if (!message) {
      throw new Error('message is required');
    }
    const contextPolicy = resolveAgentMessageContextPolicy(request.contextPolicy);

    const contextSnapshot = await this.getContextSnapshot(agentId);
    const { agent } = contextSnapshot;
    const session = await this.store.getActiveSession(agent.id);
    if (!session) {
      throw new Error(`Active session not found for agent: ${agent.id}`);
    }
    if (agent.status !== 'active') {
      throw new Error(`Agent is not active: ${agent.status}`);
    }

    const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
    const orchestratorRequest = resolveOrchestratorRequest(request.metadata);
    const stageId = `${runId}-stage-implement-1`;
    const stageOwnership: AgentRunStageOwnership = {
      workspaceId: agent.workingDirectory,
      writeMode: 'serial',
    };
    const orchestratorStartedAt = nowIso();
    const initialOrchestratorLedger = buildRuleBasedOrchestratorLedger({
      runId,
      primaryBackend: agent.backend,
      workspace: agent.workingDirectory,
      requestText: message,
      createdAt: orchestratorStartedAt,
      planKind: orchestratorRequest.mode === 'multi_stage'
        ? orchestratorRequest.planKind
        : 'implement-only',
    });
    if (orchestratorRequest.failureStrategy) {
      initialOrchestratorLedger.policy.failureStrategy = orchestratorRequest.failureStrategy;
    }
    agent.runtime.isRunning = true;
    agent.runtime.currentRunId = runId;
    agent.runtime.lastTickAt = nowIso();
    agent.updatedAt = agent.runtime.lastTickAt;
    await this.store.saveAgent(agent);
    const nextTurnNumber = Math.max(session.nextTurnNumber ?? 1, await this.store.getNextTurnNumber(agent.id, session.id));
    session.nextTurnNumber = nextTurnNumber + 2;
    session.updatedAt = nowIso();
    await this.store.saveSession(session);

    const executionContext = this.assembleContext(
      agent,
      session,
      contextSnapshot.memorySummaryEntries,
      contextSnapshot.memoryConstraintEntries,
      contextSnapshot.persistentSummaryEntries,
      contextSnapshot.persistentConstraintEntries,
      contextSnapshot.recentTurns,
      contextSnapshot.currentWorkEntries,
      contextSnapshot.workLayout,
      contextSnapshot.workBudget,
      contextSnapshot.persistentBudget,
      contextSnapshot.memoryBudget,
      contextSnapshot.operationalGuidance,
      contextSnapshot.recoveryIssues,
      contextSnapshot.pendingGoals,
      contextSnapshot.pendingClarification ?? null,
      message,
      contextPolicy,
    );
    const contextRefs = this.buildRunContextRefs(contextSnapshot, contextPolicy);
    const workspaceFacts = await this.collectWorkspaceFacts(agent.workingDirectory);
    const constraints = [
      ...contextSnapshot.memoryConstraintEntries.map((item) => item.desc),
      ...contextSnapshot.persistentConstraintEntries.map((item) => item.desc),
    ].filter(Boolean);
    const openQuestions = contextSnapshot.pendingClarification
      ? [contextSnapshot.pendingClarification.question]
      : [];
    const canonicalContext = {
      goal: message,
      plan: initialOrchestratorLedger.plan.map((stage) => `${stage.type}:${stage.backend}`),
      decisions: [],
      constraints,
      workspaceState: {
        ...workspaceFacts,
      },
      artifacts: [],
      backendRunRecords: [],
      openQuestions,
    };
    const handoffPacket: BackendHandoffPacket = buildStageHandoffPacket({
      runId,
      stage: initialOrchestratorLedger.plan[0] || {
        stageId,
        type: 'implement',
        backend: agent.backend,
        dependsOn: [],
        reason: 'Default single stage fallback.',
        ownership: stageOwnership,
      },
      goal: message,
      userRequest: message,
      canonicalContext,
      stageInstructions: this.renderHandoffStageInstructions(agent.backend, 'implement'),
      constraints,
      workspaceFacts,
      priorStageSummaries: [],
      openQuestions,
      metadata: request.metadata,
    });
    const userTurn = {
      kind: 'turn' as const,
      turnId: `turn-${randomUUID()}`,
      runId,
      role,
      content: message,
      createdAt: nowIso(),
      turnNumber: nextTurnNumber,
    };
    await this.store.appendTurn(agent.id, session.id, userTurn);
    const runStartedAtMs = Date.now();

    const events: SessionStreamEvent[] = [];
    const emitEvent = (event: SessionStreamEvent): void => {
      events.push(event);
      try {
        stream?.onEvent?.(event);
      } catch (error) {
        console.warn('[agent-server] stream event callback failed:', error);
      }
    };
    emitEvent({
      type: 'run-plan',
      runId,
      backend: agent.backend,
      plan: initialOrchestratorLedger.plan.map((stage) => `${stage.type}:${stage.backend}`),
      message: `Plan: ${initialOrchestratorLedger.plan.map((stage) => `${stage.type} via ${stage.backend}`).join(' -> ') || `implement via ${agent.backend}`}`,
    });
    let output: SessionOutput;
    let stageRecord: AgentRunStageRecord;
    let stageRecords: AgentRunStageRecord[];
    let orchestratorLedger: AgentRunOrchestratorLedger;
    if (orchestratorRequest.mode === 'multi_stage' && initialOrchestratorLedger.plan.length > 1) {
      const multiStage = await this.runMultiStageBackendTurns({
        agent,
        session,
        runId,
        message,
        executionContext,
        ledger: initialOrchestratorLedger,
        canonicalContext,
        constraints,
        openQuestions,
        metadata: request.metadata,
        runtimeModel: request,
        localDevPolicy: request.localDevPolicy,
        runStartedAtMs,
        maxRetries: orchestratorRequest.maxRetries,
        fallbackBackend: orchestratorRequest.fallbackBackend,
        emitEvent,
      });
      output = multiStage.output;
      emitEvent({ type: 'result', output });
      stageRecord = multiStage.stages[multiStage.stages.length - 1] || this.createSyntheticFailedStageRecord({
        runId,
        stageId,
        backend: agent.backend,
        handoffPacket,
        message,
        output,
        startedAtMs: runStartedAtMs,
      });
      stageRecords = multiStage.stages.length > 0 ? multiStage.stages : [stageRecord];
      orchestratorLedger = multiStage.ledger;
    } else {
      emitEvent({
        type: 'stage-start',
        runId,
        stageId,
        backend: agent.backend,
        message: `Starting implement stage on ${agent.backend}`,
        detail: handoffPacket.stageInstructions,
      });
      const stageExecution = await this.runSingleStageBackendTurn({
        agent,
        session,
        backend: agent.backend,
        message,
        executionContext,
        handoffPacket,
        runtimeModel: request,
        localDevPolicy: request.localDevPolicy,
        emitEvent,
      });
      const single = await this.buildStageRecordFromExecution({
        agent,
        runId,
        stagePlan: initialOrchestratorLedger.plan[0],
        fallbackStageId: stageId,
        handoffPacket,
        stageExecution,
        output: stageExecution.output,
        events,
        beforeWorkspaceFacts: workspaceFacts,
        runStartedAtMs,
        createdAt: userTurn.createdAt,
      });
      output = stageExecution.output;
      stageRecord = single.stageRecord;
      stageRecords = [stageRecord];
      orchestratorLedger = this.completeOrchestratorLedger(initialOrchestratorLedger, [stageRecord]);
      emitEvent({
        type: 'stage-result',
        stageId: stageRecord.id,
        result: stageRecord.result!,
      });
    }

    const assistantContent = output.success ? output.result : output.error;
    const assistantTurn = {
      kind: 'turn' as const,
      turnId: `turn-${randomUUID()}`,
      runId,
      role: 'assistant' as const,
      content: assistantContent,
      usage: output.usage,
      createdAt: nowIso(),
      turnNumber: nextTurnNumber + 1,
    };
    await this.store.appendTurn(agent.id, session.id, assistantTurn);

    const summary = `User: ${excerpt(message, 180)} | Assistant: ${excerpt(assistantContent, 240)}`;
    if (contextPolicy.persistRunSummary) {
      await this.store.appendPersistentSummary(agent.id, session.id, summary);
    }
    const extractedConstraints = this.extractConstraintsFromRun(events, assistantTurn, session.id);
    if (contextPolicy.persistExtractedConstraints && extractedConstraints.length > 0) {
      await this.store.appendPersistentConstraints(agent.id, session.id, extractedConstraints);
    }

    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    session.updatedAt = agent.updatedAt;
    await this.store.saveSession(session);

    const basicEvaluation: AgentRunRecord['evaluation'] = {
      outcome: output.success ? 'success' : 'failed',
      reasons: output.success ? ['backend returned a successful result'] : [assistantContent || 'backend returned an error'],
      evaluator: 'agent-server-basic',
    };
    let evaluation = basicEvaluation;
    if (this.options.evaluateRun) {
      try {
        const evaluated = await this.options.evaluateRun({
          run: {
            id: runId,
            agentId: agent.id,
            sessionId: session.id,
            status: output.success ? 'completed' : 'failed',
            request: {
              message,
              context: executionContext,
            },
            output,
            events,
            stages: stageRecords,
            orchestrator: orchestratorLedger,
            contextRefs,
            metrics: {
              durationMs: Math.max(0, Date.now() - runStartedAtMs),
              toolCallCount: events.filter((event) => event.type === 'tool-call').length,
              approxContextTokens: approxTokens(executionContext),
              backend: agent.backend,
              usage: output.usage,
            },
            evaluation: basicEvaluation,
            metadata: request.metadata,
            createdAt: userTurn.createdAt,
            completedAt: assistantTurn.createdAt,
          },
          contextSnapshot,
          output,
        });
        if (evaluated) {
          evaluation = evaluated;
        }
      } catch (error) {
        evaluation = {
          ...basicEvaluation,
          reasons: [
            ...basicEvaluation.reasons,
            `evaluation hook failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
        };
      }
    }

    const run: AgentRunRecord = {
      id: runId,
      agentId: agent.id,
      sessionId: session.id,
      status: output.success ? 'completed' : 'failed',
      request: {
        message,
        context: executionContext,
      },
      output,
      events,
      stages: stageRecords,
      orchestrator: orchestratorLedger,
      contextRefs,
      metrics: {
        durationMs: Math.max(0, Date.now() - runStartedAtMs),
        toolCallCount: events.filter((event) => event.type === 'tool-call').length,
        approxContextTokens: approxTokens(executionContext),
        backend: agent.backend,
        usage: output.usage,
      },
      evaluation: {
        ...evaluation,
      },
      metadata: request.metadata,
      createdAt: userTurn.createdAt,
      completedAt: assistantTurn.createdAt,
    };
    await this.store.saveRun(run);
    agent.runtime.isRunning = false;
    agent.runtime.currentRunId = undefined;
    agent.runtime.lastRunAt = run.completedAt;
    agent.runtime.pendingGoalCount = (await this.store.listPendingGoals(agent.id)).length;
    if (output.success) {
      agent.runtime.consecutiveErrors = 0;
      agent.runtime.lastError = undefined;
    } else {
      agent.runtime.consecutiveErrors += 1;
      agent.runtime.lastError = assistantContent;
      if (agent.runtime.consecutiveErrors >= agent.autonomy.maxConsecutiveErrors) {
        agent.status = 'error';
        agent.autonomy.enabled = false;
      }
    }
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    await this.maybeCompactAfterRun(agent.id, session.id);
    return run;
  }

  private assembleContext(
    agent: AgentManifest,
    session: AgentSessionRecord,
    memorySummaryEntries: string[],
    memoryConstraintEntries: AgentConstraintRecord[],
    persistentSummaryEntries: string[],
    persistentConstraintEntries: AgentConstraintRecord[],
    recentTurns: { role: string; content: string; createdAt: string }[],
    currentWorkEntries: AgentWorkEntry[],
    workLayout: AgentWorkLayout,
    workBudget: AgentWorkBudgetSnapshot,
    persistentBudget: AgentPersistentBudgetSnapshot,
    memoryBudget: AgentMemoryBudgetSnapshot,
    operationalGuidance: AgentOperationalGuidance,
    recoveryIssues: AgentRecoveryIssueRecord[],
    pendingGoals: AgentGoalRecord[],
    pendingClarification: AgentClarificationRecord | null,
    focus?: string,
    contextPolicy?: Required<AgentMessageContextPolicy>,
  ): string {
    const resolvedPolicy = resolveAgentMessageContextPolicy(contextPolicy);
    const terms = focusTerms(focus);
    const compactionEntries = currentWorkEntries.filter((entry): entry is AgentCompactionTagRecord => entry.kind === 'compaction');
    const partialEntries = currentWorkEntries.filter((entry): entry is AgentCompactionTagRecord => entry.kind === 'partial_compaction');
    const liveWorkEntries = currentWorkEntries.filter(normalizeWorkEntryTurn);
    const currentWindowConstraints = dedupeConstraints(compactionEntries.flatMap((entry) => entry.constraints ?? []));
    const selectedCurrentWindowConstraints = this.semanticMergeConstraintFamilies(currentWindowConstraints, 'session');
    const selectedPersistentConstraintPool = this.semanticMergeConstraintFamilies(persistentConstraintEntries, 'session');
    const selectedMemoryConstraintPool = this.semanticMergeConstraintFamilies(memoryConstraintEntries, 'memory');
    const compactionSummaryEntries = compactionEntries.map((entry) => `${entry.turns} | ${entry.summary.join(' ')}`);
    const partialSummaryEntries = partialEntries.map((entry) => `${entry.turns} | ${entry.summary.join(' ')}`);
    const selectedCompactionConstraints = resolvedPolicy.includeCurrentWork ? selectRelevantItems(
      selectedCurrentWindowConstraints,
      terms,
      (entry) => `${entry.family ?? entry.key} ${entry.key} ${(entry.familyMembers ?? []).join(' ')} ${entry.desc} ${(entry.evidence ?? []).join(' ')}`,
      12,
    ) : [];
    const selectedCompactionSummary = resolvedPolicy.includeCurrentWork ? selectRelevantItems(
      compactionSummaryEntries,
      terms,
      (entry) => entry,
      8,
    ) : [];
    const selectedPartialSummary = resolvedPolicy.includeCurrentWork ? selectRelevantItems(
      partialSummaryEntries,
      terms,
      (entry) => entry,
      8,
    ) : [];
    const selectedLiveWork = resolvedPolicy.includeCurrentWork ? selectRelevantItems(
      liveWorkEntries,
      terms,
      (entry) => `${entry.role} ${entry.content}`,
      8,
    ) : [];
    const selectedRecentTurns = resolvedPolicy.includeRecentTurns ? selectRelevantItems(
      recentTurns,
      terms,
      (entry) => `${entry.role} ${entry.content}`,
      8,
    ) : [];
    const selectedPersistentConstraints = resolvedPolicy.includePersistent ? selectRelevantItems(
      selectedPersistentConstraintPool,
      terms,
      (entry) => `${entry.family ?? entry.key} ${entry.key} ${(entry.familyMembers ?? []).join(' ')} ${entry.desc} ${(entry.evidence ?? []).join(' ')}`,
      16,
    ) : [];
    const selectedPersistentSummary = resolvedPolicy.includePersistent ? selectRelevantItems(
      persistentSummaryEntries,
      terms,
      (entry) => entry,
      8,
    ) : [];
    const selectedMemoryConstraints = resolvedPolicy.includeMemory ? selectRelevantItems(
      selectedMemoryConstraintPool,
      terms,
      (entry) => `${entry.family ?? entry.key} ${entry.key} ${(entry.familyMembers ?? []).join(' ')} ${entry.desc} ${(entry.evidence ?? []).join(' ')}`,
      16,
    ) : [];
    const selectedMemorySummary = resolvedPolicy.includeMemory ? selectRelevantItems(
      memorySummaryEntries,
      terms,
      (entry) => entry,
      8,
    ) : [];

    return [
      'Agent identity:',
      `- id: ${agent.id}`,
      `- name: ${agent.name}`,
      `- backend: ${agent.backend}`,
      `- working_directory: ${agent.workingDirectory}`,
      `- active_session_id: ${session.id}`,
      '',
      'System prompt:',
      agent.systemPrompt,
      '',
      focus ? `Current retrieval focus:\n- ${excerpt(focus, 240)}` : 'Current retrieval focus:\n- (none)',
      '',
      'Retrieval chain:',
      resolvedPolicy.includeCurrentWork ? '- current-window compaction constraints/summary' : '- current-window compaction constraints/summary (disabled for this run)',
      resolvedPolicy.includeCurrentWork ? '- current-window partial compaction summary' : '- current-window partial compaction summary (disabled for this run)',
      resolvedPolicy.includeCurrentWork ? '- current work raw turns' : '- current work raw turns (disabled for this run)',
      resolvedPolicy.includePersistent ? '- current-session persistent' : '- current-session persistent (disabled for this run)',
      resolvedPolicy.includeMemory ? '- cross-session memory' : '- cross-session memory (disabled for this run)',
      '- if all fail: ask the human instead of guessing',
      '',
      renderConstraintsBlock('Current-window compaction constraints', selectedCompactionConstraints),
      '',
      renderSummaryBlock('Current-window compaction summary', selectedCompactionSummary),
      '',
      renderSummaryBlock('Current-window partial compaction summary', selectedPartialSummary),
      '',
      renderWorkLayoutBlock(workLayout),
      '',
      renderWorkBudgetBlock(workBudget),
      '',
      renderPersistentBudgetBlock(persistentBudget),
      '',
      renderMemoryBudgetBlock(memoryBudget),
      '',
      renderOperationalGuidanceBlock(operationalGuidance),
      '',
      renderRecoveryIssuesBlock(recoveryIssues),
      '',
      renderWorkBlock(selectedLiveWork),
      '',
      renderTurnsBlock(selectedRecentTurns),
      '',
      renderConstraintsBlock('Current-session persistent constraints', selectedPersistentConstraints),
      '',
      renderSummaryBlock('Current-session persistent summary', selectedPersistentSummary),
      '',
      renderConstraintsBlock('Cross-session memory constraints', selectedMemoryConstraints),
      '',
      renderSummaryBlock('Cross-session memory summary', selectedMemorySummary),
      '',
      renderSummaryBlock('Pending goals', pendingGoalsToStrings(pendingGoals.slice(0, 12))),
      '',
      pendingClarification
        ? renderSummaryBlock('Pending human clarification', [
          `clarification_id=${pendingClarification.id}`,
          `question=${pendingClarification.question}`,
          `reason=${pendingClarification.reason}`,
        ])
        : 'Pending human clarification:\n- (none)',
      '',
      'Instructions:',
      '- The working directory is stable for this agent instance and must be treated as its long-term workspace.',
      '- Reuse remembered facts when valid, but verify external or mutable state before relying on it.',
      '- If this run disables current-work, persistent, or memory retrieval, treat the delivered task body as the only request-specific source of truth.',
      '- If constraints exist for a key, use the latest turn version and re-verify mutable state before acting.',
      '- Partial compaction keeps stable raw work before the tag and a live dynamic tail after the tag; use the tag summary before reopening older raw turns.',
      '- If the retrieval chain does not produce enough evidence, ask the human for clarification instead of filling the gap with guesses.',
      '- Keep decisions auditable; prefer reading facts over guessing.',
    ].join('\n');
  }

  private renderHandoffStageInstructions(backend: string, stageType: AgentRunStageType): string {
    const shared = [
      `Stage type: ${stageType}`,
      'Use the handoff packet as the task boundary.',
      'Prefer workspace facts, git diff, test output, and tool results over natural-language summaries.',
      'Return enough detail for AgentServer to build a structured stage result and next handoff.',
    ];
    if (backend === 'codex') {
      shared.push('Focus on correctness, bug finding, risk review, and verification signals.');
    } else if (backend === 'claude-code') {
      shared.push('Focus on implementation, refactoring, and coherent file edits.');
    } else if (backend === 'gemini') {
      shared.push('Focus on long-context reading, multimodal or broad-repository synthesis, and explicit uncertainty boundaries.');
      shared.push('Avoid claiming high-risk workspace writes are complete unless tool/sandbox capability is explicitly available.');
    } else if (backend === 'openteam_agent') {
      shared.push('Focus on transparent tool/context behavior for self-hosted harness experimentation.');
    } else if (isBackendEnabled(backend as BackendType) && getBackendDescriptor(backend as BackendType).kind === 'model_provider') {
      shared.push('This is a model-provider fallback path: do not imply native agent loop, sandbox, or native session state.');
      shared.push('Be explicit about capability gaps and return concise structured facts for the next full agent-backend stage.');
    }
    return shared.join('\n');
  }

  private async runSingleStageBackendTurn(input: {
    agent: AgentManifest;
    session: AgentSessionRecord;
    backend: AgentBackendId;
    message: string;
    executionContext: string;
    handoffPacket: BackendHandoffPacket;
    runtimeModel?: Pick<AgentMessageRequest, 'model' | 'modelProvider' | 'modelName' | 'llmEndpoint'>;
    localDevPolicy?: AgentMessageRequest['localDevPolicy'];
    emitEvent: (event: SessionStreamEvent) => void;
  }): Promise<{
    output: SessionOutput;
    adapterStageResult?: BackendStageResult;
    nativeSessionRef?: BackendSessionRef;
    executionPath: 'agent_backend_adapter' | 'legacy_supervisor';
  }> {
    if (hasAgentBackendAdapter(input.backend) && !shouldRouteModelEndpointThroughSupervisor(input.runtimeModel)) {
      return await this.runSingleStageViaAgentBackendAdapter(input);
    }
    if (!isBackendEnabled(input.backend as BackendType)) {
      const output: SessionOutput = {
        success: false,
        error: `No agent backend adapter or legacy runtime is registered for backend: ${input.backend}`,
      };
      input.emitEvent({ type: 'error', stageId: input.handoffPacket.stageId, error: output.error });
      input.emitEvent({ type: 'result', output });
      return {
        output,
        executionPath: 'legacy_supervisor',
      };
    }
    if (shouldRouteModelEndpointThroughSupervisor(input.runtimeModel)) {
      input.emitEvent({
        type: 'status',
        stageId: input.handoffPacket.stageId,
        status: 'starting',
        message: `${input.backend} using configured OpenAI-compatible model endpoint through the shared AgentServer tool bridge.`,
        raw: {
          kind: 'model-endpoint-supervisor-route',
          backend: input.backend,
          provider: input.runtimeModel?.llmEndpoint?.provider || input.runtimeModel?.modelProvider || null,
          modelName: input.runtimeModel?.llmEndpoint?.modelName || input.runtimeModel?.modelName || null,
        },
      });
    }
    return await this.runSingleStageViaLegacySupervisor(input);
  }

  private async runSingleStageViaAgentBackendAdapter(input: {
    agent: AgentManifest;
    session: AgentSessionRecord;
    backend: AgentBackendId;
    message: string;
    executionContext: string;
    handoffPacket: BackendHandoffPacket;
    runtimeModel?: Pick<AgentMessageRequest, 'model' | 'modelProvider' | 'modelName' | 'llmEndpoint'>;
    localDevPolicy?: AgentMessageRequest['localDevPolicy'];
    emitEvent: (event: SessionStreamEvent) => void;
  }): Promise<{
    output: SessionOutput;
    adapterStageResult?: BackendStageResult;
    nativeSessionRef?: BackendSessionRef;
    executionPath: 'agent_backend_adapter';
  }> {
    const adapter = createAgentBackendAdapter(input.backend);
    let sessionRef: BackendSessionRef | undefined;
    let adapterStageResult: BackendStageResult | undefined;
    let output: SessionOutput | undefined;
    const textParts: string[] = [];
    const executionPolicy = {
      approvalPolicy: 'never' as const,
      sandbox: 'danger-full-access' as const,
    };
    let lastBackendEventAt = Date.now();
    let heartbeat: NodeJS.Timeout | undefined;
    let backendWaitNoticeCount = 0;
    const sessionScope = input.handoffPacket.stageType === 'implement' ? 'session' as const : 'stage' as const;
    try {
      input.emitEvent({
        type: 'status',
        stageId: input.handoffPacket.stageId,
        status: 'starting',
        message: `${input.backend} agent backend starting with native tools and highest local permissions.`,
      });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        textParts.length = 0;
        adapterStageResult = undefined;
        output = undefined;
        sessionRef = await adapter.startSession({
          agentServerSessionId: `${input.agent.id}:${input.session.id}`,
          backend: input.backend,
          workspace: input.agent.workingDirectory,
          scope: sessionScope,
          runtimeModel: input.runtimeModel,
          localDevPolicy: input.localDevPolicy,
          executionPolicy,
          metadata: {
            runId: input.handoffPacket.runId,
            stageId: input.handoffPacket.stageId,
            agentId: input.agent.id,
            agentServerSessionId: input.session.id,
            nativeSessionScope: sessionScope,
            nativeSessionAttempt: attempt,
            executionPolicy,
          },
        });

        if (!heartbeat) {
          heartbeat = setInterval(() => {
            const quietMs = Date.now() - lastBackendEventAt;
            if (quietMs >= 10_000) {
              backendWaitNoticeCount += 1;
              lastBackendEventAt = Date.now();
              input.emitEvent({
                type: 'status',
                stageId: input.handoffPacket.stageId,
                status: 'running',
                message: `${input.backend} backend still running; no native event for ${Math.round(quietMs / 1000)}s. Waiting for text-delta, tool-call, tool-result, or stage-result.`,
                raw: {
                  kind: 'backend-heartbeat',
                  backend: input.backend,
                  quietMs,
                  noticeCount: backendWaitNoticeCount,
                },
              });
            }
          }, 10_000);
          heartbeat.unref?.();
        }

        for await (const event of adapter.runTurn({
          sessionRef,
          handoff: input.handoffPacket,
          runtimeModel: input.runtimeModel,
          localDevPolicy: input.localDevPolicy,
          executionPolicy,
        })) {
          lastBackendEventAt = Date.now();
          if (event.type === 'stage-result') {
            adapterStageResult = event.result;
            input.emitEvent(event);
            continue;
          }
          if (event.type === 'text-delta') {
            textParts.push(event.text);
          }
          if (event.type === 'result') {
            output = event.output;
          }
          input.emitEvent(event);
        }

        if (!output) {
          output = outputFromAdapterStageResult(adapterStageResult, textParts.join(''));
        }
        const retryableNativeSessionError = attempt === 1
          && sessionRef.scope === 'session'
          && isRetryableNativeSessionHistoryError(output.error || adapterStageResult?.handoffSummary || '');
        if (!retryableNativeSessionError) {
          input.emitEvent({ type: 'result', output });
          break;
        }
        input.emitEvent({
          type: 'status',
          stageId: input.handoffPacket.stageId,
          status: 'running',
          message: `${input.backend} native session history looked corrupt; restarting native session and retrying once.`,
          raw: {
            kind: 'native-session-history-retry',
            backend: input.backend,
            reason: 'tool_use_tool_result_pairing',
            nativeSessionRef: sessionRef.id,
          },
        });
        await adapter.dispose({ sessionRef, reason: 'retry after native tool_use/tool_result pairing error' }).catch((error) => {
          console.warn('[agent-server] adapter dispose before native-session retry failed:', error);
        });
        sessionRef = undefined;
      }
      return {
        output: output ?? { success: false, error: `${input.backend} backend produced no output.` },
        adapterStageResult,
        nativeSessionRef: adapterStageResult?.nativeSessionRef || sessionRef,
        executionPath: 'agent_backend_adapter',
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      input.emitEvent({ type: 'error', stageId: input.handoffPacket.stageId, error: messageText });
      output = { success: false, error: messageText };
      input.emitEvent({ type: 'result', output });
      return {
        output,
        adapterStageResult,
        nativeSessionRef: sessionRef,
        executionPath: 'agent_backend_adapter',
      };
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (sessionRef?.scope === 'stage') {
        await adapter.dispose({ sessionRef, reason: 'single stage execution finished' }).catch((error) => {
          console.warn('[agent-server] adapter dispose failed:', error);
        });
      }
    }
  }

  private async runMultiStageBackendTurns(input: {
    agent: AgentManifest;
    session: AgentSessionRecord;
    runId: string;
    message: string;
    executionContext: string;
    ledger: AgentRunOrchestratorLedger;
    canonicalContext: CanonicalSessionContextSnapshot;
    constraints: string[];
    openQuestions: string[];
    metadata?: Record<string, unknown>;
    runtimeModel?: Pick<AgentMessageRequest, 'model' | 'modelProvider' | 'modelName' | 'llmEndpoint'>;
    localDevPolicy?: AgentMessageRequest['localDevPolicy'];
    runStartedAtMs: number;
    maxRetries?: number;
    fallbackBackend?: AgentBackendId;
    emitEvent: (event: SessionStreamEvent) => void;
  }): Promise<{
    output: SessionOutput;
    stages: AgentRunStageRecord[];
    ledger: AgentRunOrchestratorLedger;
  }> {
    const result = await executeMultiStagePlan({
      runId: input.runId,
      ledger: input.ledger,
      goal: input.message,
      userRequest: input.message,
      canonicalContext: input.canonicalContext,
      constraints: input.constraints,
      openQuestions: input.openQuestions,
      metadata: input.metadata,
      maxRetries: input.maxRetries,
      fallbackBackend: input.fallbackBackend,
      getWorkspaceFacts: async () => await this.collectWorkspaceFacts(input.agent.workingDirectory),
      renderStageInstructions: (stage) => this.renderHandoffStageInstructions(stage.backend, stage.type),
      runStage: async (handoff, stage, attempt) => {
        const stageStartedAtMs = Date.now();
        const stageEvents: SessionStreamEvent[] = [];
        input.emitEvent({
          type: 'stage-start',
          runId: handoff.runId,
          stageId: stage.stageId,
          backend: stage.backend,
          message: `Starting ${stage.type} stage on ${stage.backend}`,
          detail: stage.reason,
        });
        const stageExecution = await this.runSingleStageBackendTurn({
          agent: input.agent,
          session: input.session,
          backend: stage.backend,
          message: input.message,
          executionContext: input.executionContext,
          handoffPacket: handoff,
          runtimeModel: input.runtimeModel,
          localDevPolicy: input.localDevPolicy,
          emitEvent: (event) => {
            stageEvents.push(event);
            if (event.type !== 'result') {
              input.emitEvent(event);
            }
          },
        });
        const built = await this.buildStageRecordFromExecution({
          agent: input.agent,
          runId: handoff.runId,
          stagePlan: stage,
          fallbackStageId: stage.stageId,
          handoffPacket: handoff,
          stageExecution,
          output: stageExecution.output,
          events: stageEvents,
          beforeWorkspaceFacts: handoff.workspaceFacts,
          runStartedAtMs: stageStartedAtMs,
          approxInputTokens: approxTokens(input.executionContext) + approxTokens(JSON.stringify(handoff)),
          createdAt: new Date(stageStartedAtMs).toISOString(),
          attempt,
        });
        input.emitEvent({
          type: 'stage-result',
          stageId: built.stageRecord.id,
          result: built.stageRecord.result!,
        });
        return built.stageRecord;
      },
    });
    const lastStage = result.stages[result.stages.length - 1];
    const usage = mergeModelProviderUsage(result.stages.map((stage) => stage.metrics?.usage || stage.result?.usage));
    const output = result.failureAction
      ? { success: false as const, error: result.failureAction.reason, usage }
      : {
          success: true as const,
          result: lastStage?.result?.finalText || lastStage?.result?.handoffSummary || '',
          usage,
        };
    return {
      output,
      stages: result.stages,
      ledger: result.ledger,
    };
  }

  private async runSingleStageViaLegacySupervisor(input: {
    agent: AgentManifest;
    session: AgentSessionRecord;
    backend: AgentBackendId;
    message: string;
    executionContext: string;
    handoffPacket: BackendHandoffPacket;
    runtimeModel?: Pick<AgentMessageRequest, 'model' | 'modelProvider' | 'modelName' | 'llmEndpoint'>;
    localDevPolicy?: AgentMessageRequest['localDevPolicy'];
    emitEvent: (event: SessionStreamEvent) => void;
  }): Promise<{
    output: SessionOutput;
    executionPath: 'legacy_supervisor';
  }> {
    try {
      const backend = input.backend as BackendType;
      const output = await runSessionViaSupervisor(
        backend,
        {
          task: input.message,
          context: renderLegacySupervisorContext(input.executionContext, input.handoffPacket),
        },
        {
          backend,
          teamId: input.agent.runtimeTeamId,
          agentId: input.agent.runtimeAgentId,
          cwd: input.agent.workingDirectory,
          sessionMode: 'persistent',
          persistentKey: input.agent.runtimePersistentKey,
          requestId: input.handoffPacket.runId,
          sessionKey: `agent-server:${input.agent.id}:${input.session.id}`,
          model: input.runtimeModel?.model ?? undefined,
          modelProvider: input.runtimeModel?.modelProvider ?? undefined,
          modelName: input.runtimeModel?.modelName ?? undefined,
          llmEndpoint: input.runtimeModel?.llmEndpoint ?? undefined,
          localDevPolicy: input.localDevPolicy,
        },
        {
          onEvent: (event) => {
            input.emitEvent(event);
          },
        },
      );
      return {
        output,
        executionPath: 'legacy_supervisor',
      };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      input.emitEvent({ type: 'error', error: messageText });
      const output: SessionOutput = { success: false, error: messageText };
      input.emitEvent({ type: 'result', output });
      return {
        output,
        executionPath: 'legacy_supervisor',
      };
    }
  }

  private completeOrchestratorLedger(
    ledger: AgentRunOrchestratorLedger,
    stages: AgentRunStageRecord[],
  ): AgentRunOrchestratorLedger {
    const stageSummaries = stages
      .filter((stage) => Boolean(stage.result))
      .map((stage) => this.toStageSummary(stage));
    const completedStageIds = stages
      .filter((stage) => stage.status === 'completed')
      .map((stage) => stage.id);
    const failedStageIds = stages
      .filter((stage) => stage.status === 'failed' || stage.status === 'timeout' || stage.status === 'cancelled')
      .map((stage) => stage.id);
    const skippedStageIds = stages
      .filter((stage) => stage.status === 'skipped')
      .map((stage) => stage.id);
    return {
      ...ledger,
      completedStageIds,
      failedStageIds,
      skippedStageIds,
      stageSummaries,
      summary: [
        ledger.summary,
        `Completed=${completedStageIds.length}; failed=${failedStageIds.length}; skipped=${skippedStageIds.length}.`,
      ].join(' '),
      updatedAt: nowIso(),
    };
  }

  private async buildStageRecordFromExecution(input: {
    agent: AgentManifest;
    runId: string;
    stagePlan?: AgentRunStagePlan;
    fallbackStageId: string;
    handoffPacket: BackendHandoffPacket;
    stageExecution: {
      output: SessionOutput;
      adapterStageResult?: BackendStageResult;
      nativeSessionRef?: BackendSessionRef;
      executionPath: 'agent_backend_adapter' | 'legacy_supervisor';
    };
    output: SessionOutput;
    events: SessionStreamEvent[];
    beforeWorkspaceFacts: WorkspaceFacts;
    runStartedAtMs: number;
    approxInputTokens?: number;
    createdAt: string;
    attempt?: number;
  }): Promise<{ stageRecord: AgentRunStageRecord }> {
    const stagePlan = input.stagePlan || {
      stageId: input.fallbackStageId,
      type: input.handoffPacket.stageType,
      backend: input.handoffPacket.stageType === 'implement' ? input.agent.backend : input.handoffPacket.canonicalContext.backendRunRecords[0]?.backend || input.agent.backend,
      dependsOn: [],
      reason: 'Fallback stage plan synthesized from handoff packet.',
      ownership: {
        workspaceId: input.agent.workingDirectory,
        writeMode: input.handoffPacket.stageType === 'implement' ? 'serial' : 'none',
      } satisfies AgentRunStageOwnership,
    } satisfies AgentRunStagePlan;
    const output = input.output;
    const assistantContent = output.success ? output.result : output.error;
    const postRunWorkspaceFacts = await this.collectWorkspaceFacts(input.agent.workingDirectory);
    const boundaryVerification = await this.verifyStageBoundary({
      agentId: input.agent.id,
      sessionId: input.agent.activeSessionId,
      runId: input.runId,
      before: input.beforeWorkspaceFacts,
      after: postRunWorkspaceFacts,
      events: input.events,
    });
    const backendInfo = this.describeExecutionBackend(stagePlan.backend);
    const stageResult: BackendStageResult = {
      status: output.success ? 'completed' : 'failed',
      finalText: assistantContent,
      filesChanged: boundaryVerification.filesChanged,
      diffSummary: postRunWorkspaceFacts.lastKnownDiffSummary,
      toolCalls: input.stageExecution.adapterStageResult?.toolCalls ?? input.events
        .filter((event) => event.type === 'tool-call')
        .map((event) => ({
          toolName: event.toolName,
          detail: event.detail,
          status: 'unknown' as const,
        })),
      testsRun: boundaryVerification.testsRun,
      findings: input.stageExecution.adapterStageResult?.findings ?? [],
      handoffSummary: output.success
        ? (input.stageExecution.adapterStageResult?.handoffSummary || excerpt(assistantContent, 500))
        : `Backend failed: ${excerpt(assistantContent, 500)}`,
      nextActions: input.stageExecution.adapterStageResult?.nextActions ?? [],
      risks: output.success
        ? (input.stageExecution.adapterStageResult?.risks ?? [])
        : [assistantContent || 'backend returned an error'],
      artifacts: boundaryVerification.artifacts,
      usage: output.usage,
      nativeSessionRef: input.stageExecution.nativeSessionRef || {
        id: `agent-server:${input.agent.id}:${input.agent.activeSessionId}:${stagePlan.backend}`,
        backend: stagePlan.backend,
        scope: 'stage',
        resumable: backendInfo.resumable,
      },
      boundaryVerification,
    };
    const stageRecord: AgentRunStageRecord = {
      id: stagePlan.stageId,
      runId: input.runId,
      type: stagePlan.type,
      backend: stagePlan.backend,
      status: stageResult.status,
      dependsOn: [...stagePlan.dependsOn],
      ownership: stagePlan.ownership,
      input: input.handoffPacket,
      result: stageResult,
      metrics: {
        durationMs: Math.max(0, Date.now() - input.runStartedAtMs),
        toolCallCount: stageResult.toolCalls.length,
        approxInputTokens: input.approxInputTokens,
        usage: output.usage,
      },
      audit: {
        backend: stagePlan.backend,
        backendKind: backendInfo.kind,
        backendTier: backendInfo.tier,
        executionPath: input.stageExecution.executionPath,
        inputSummary: excerpt(input.handoffPacket.userRequest, 500),
        outputSummary: excerpt(assistantContent, 500),
        failureReason: output.success ? undefined : assistantContent,
        nativeSessionRef: stageResult.nativeSessionRef,
      },
      createdAt: input.createdAt,
      completedAt: nowIso(),
    };
    if (input.attempt && input.attempt > 0) {
      stageRecord.audit.outputSummary = `[retry ${input.attempt}] ${stageRecord.audit.outputSummary || ''}`.trim();
    }
    return { stageRecord };
  }

  private createSyntheticFailedStageRecord(input: {
    runId: string;
    stageId: string;
    backend: AgentBackendId;
    handoffPacket: BackendHandoffPacket;
    message: string;
    output: SessionOutput;
    startedAtMs: number;
  }): AgentRunStageRecord {
    const error = input.output.success ? input.output.result : input.output.error;
    return {
      id: input.stageId,
      runId: input.runId,
      type: input.handoffPacket.stageType,
      backend: input.backend,
      status: 'failed',
      dependsOn: [],
      input: input.handoffPacket,
      result: {
        status: 'failed',
        finalText: error,
        filesChanged: [],
        toolCalls: [],
        testsRun: [],
        findings: [],
        handoffSummary: `Stage failed before execution record could be built: ${excerpt(error, 500)}`,
        nextActions: [],
        risks: [error],
        artifacts: [],
      },
      metrics: {
        durationMs: Math.max(0, Date.now() - input.startedAtMs),
        toolCallCount: 0,
      },
      audit: {
        backend: input.backend,
        backendKind: hasAgentBackendAdapter(input.backend) ? 'agent_backend' : undefined,
        backendTier: this.describeExecutionBackend(input.backend).tier,
        inputSummary: excerpt(input.message, 500),
        outputSummary: excerpt(error, 500),
        failureReason: error,
      },
      createdAt: new Date(input.startedAtMs).toISOString(),
      completedAt: nowIso(),
    };
  }

  private describeExecutionBackend(backend: AgentBackendId): {
    kind?: 'model_provider' | 'agent_backend';
    tier?: 'strategic' | 'experimental' | 'compatibility' | 'legacy';
    resumable: boolean;
  } {
    if (isBackendEnabled(backend as BackendType)) {
      const descriptor = getBackendDescriptor(backend as BackendType);
      return {
        kind: descriptor.kind,
        tier: descriptor.tier,
        resumable: descriptor.capabilities.persistentSession,
      };
    }
    if (hasAgentBackendAdapter(backend)) {
      return {
        kind: 'agent_backend',
        tier: 'strategic',
        resumable: true,
      };
    }
    return {
      resumable: false,
    };
  }

  private toStageSummary(stage: AgentRunStageRecord): StageSummary {
    const result = stage.result;
    return {
      runId: stage.runId,
      stageId: stage.id,
      backend: stage.backend,
      summary: result?.handoffSummary || stage.audit.outputSummary || '',
      filesChanged: result?.filesChanged || [],
      testsRun: result?.testsRun.map((item) => `${item.command}: ${item.status}`) || [],
      risks: result?.risks || [],
    };
  }

  private deriveStageFilesChanged(before: WorkspaceFacts, after: WorkspaceFacts): string[] {
    const beforeFiles = new Set(before.dirtyFiles);
    const newDirtyFiles = after.dirtyFiles.filter((file) => !beforeFiles.has(file));
    if (newDirtyFiles.length > 0) {
      return [...new Set(newDirtyFiles)].sort();
    }
    if (before.lastKnownDiffSummary !== after.lastKnownDiffSummary && after.dirtyFiles.length > 0) {
      return [...new Set(after.dirtyFiles)].sort();
    }
    return [];
  }

  private async verifyStageBoundary(input: {
    agentId: string;
    sessionId: string;
    runId: string;
    before: WorkspaceFacts;
    after: WorkspaceFacts;
    events: SessionStreamEvent[];
  }): Promise<StageBoundaryVerification> {
    const filesChanged = this.deriveStageFilesChanged(input.before, input.after);
    const testsRun = this.collectObservedTestRuns(input.events);
    const artifacts = await this.collectRunArtifacts(input.agentId, input.sessionId, input.runId);
    const notes: string[] = [
      'Workspace facts were collected by AgentServer before and after the stage.',
    ];
    if (testsRun.length === 0) {
      notes.push('No machine-readable test command/result event was observed for this stage.');
    }
    if (artifacts.length === 0) {
      notes.push('No run-scoped artifact files were observed for this stage.');
    }
    return {
      source: 'agent-server',
      verifiedAt: nowIso(),
      beforeWorkspaceFacts: input.before,
      afterWorkspaceFacts: input.after,
      filesChanged,
      testsRun,
      artifacts,
      notes,
    };
  }

  private collectObservedTestRuns(events: SessionStreamEvent[]): TestRunSummary[] {
    const summaries: TestRunSummary[] = [];
    for (const event of events) {
      if (event.type !== 'tool-call' && event.type !== 'tool-result') {
        continue;
      }
      const detail = [event.toolName, event.detail, event.type === 'tool-result' ? event.output : undefined]
        .filter(Boolean)
        .join('\n');
      if (!/\b(test|pytest|vitest|jest|npm\s+test|pnpm\s+test|yarn\s+test|cargo\s+test|go\s+test)\b/i.test(detail)) {
        continue;
      }
      const status: TestRunSummary['status'] = event.type === 'tool-result'
        ? (/fail|error|exit\s+[1-9]/i.test(detail) ? 'failed' : 'unknown')
        : 'unknown';
      summaries.push({
        command: excerpt(detail, 240),
        status,
        summary: event.type === 'tool-result' ? excerpt(event.output || event.detail || '', 500) : undefined,
      });
    }
    return summaries.slice(0, 20);
  }

  private async collectRunArtifacts(
    agentId: string,
    sessionId: string,
    runId: string,
  ): Promise<StageBoundaryVerification['artifacts']> {
    const root = getSessionRunArtifactsDir(agentId, sessionId, runId);
    try {
      const entries = await readdir(root);
      const artifacts: StageBoundaryVerification['artifacts'] = [];
      for (const entry of entries.slice(0, 100)) {
        const path = join(root, entry);
        const entryStat = await stat(path).catch(() => null);
        if (!entryStat || !entryStat.isFile()) {
          continue;
        }
        artifacts.push({
          id: `run-artifact:${runId}:${entry}`,
          kind: inferArtifactKind(entry),
          path,
          metadata: {
            fileName: basename(entry),
            sizeBytes: entryStat.size,
            modifiedAt: entryStat.mtime.toISOString(),
          },
        });
      }
      return artifacts;
    } catch {
      return [];
    }
  }

  private async collectWorkspaceFacts(root: string): Promise<WorkspaceFacts> {
    const facts: WorkspaceFacts = {
      root,
      dirtyFiles: [],
    };
    try {
      const branchRun = await execFileAsync('git', ['branch', '--show-current'], {
        cwd: root,
        timeout: 2_000,
      });
      const branch = String(branchRun.stdout || '').trim();
      if (branch) {
        facts.branch = branch;
      }
    } catch {
      // Non-git workspaces are valid; leave branch unset.
    }
    try {
      const statusRun = await execFileAsync('git', ['status', '--porcelain'], {
        cwd: root,
        timeout: 2_000,
      });
      facts.dirtyFiles = String(statusRun.stdout || '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .slice(0, 200);
    } catch {
      // Keep workspace facts best-effort; lack of git should not block a run.
    }
    try {
      const diffRun = await execFileAsync('git', ['diff', '--stat'], {
        cwd: root,
        timeout: 2_000,
      });
      const diffSummary = String(diffRun.stdout || '').trim();
      if (diffSummary) {
        facts.lastKnownDiffSummary = diffSummary.slice(0, 4_000);
      }
    } catch {
      // Best-effort only.
    }
    return facts;
  }

  private buildRunContextRefs(
    snapshot: AgentContextSnapshot,
    contextPolicy: Required<AgentMessageContextPolicy>,
  ): AgentContextRef[] {
    const refs: AgentContextRef[] = [
      {
        scope: 'policy',
        kind: 'context-policy',
        label: 'message-context-policy',
        metadata: {
          includeCurrentWork: contextPolicy.includeCurrentWork,
          includeRecentTurns: contextPolicy.includeRecentTurns,
          includePersistent: contextPolicy.includePersistent,
          includeMemory: contextPolicy.includeMemory,
          persistRunSummary: contextPolicy.persistRunSummary,
          persistExtractedConstraints: contextPolicy.persistExtractedConstraints,
        },
      },
      {
        scope: 'runtime',
        kind: 'backend',
        label: snapshot.agent.backend,
        metadata: {
          agentId: snapshot.agent.id,
          sessionId: snapshot.session.id,
          workingDirectory: snapshot.agent.workingDirectory,
        },
      },
    ];
    if (contextPolicy.includeMemory) {
      refs.push(
        {
          scope: 'memory',
          kind: 'summary-layer',
          label: 'cross-session memory summary',
          metadata: { count: snapshot.memorySummaryEntries.length },
        },
        {
          scope: 'memory',
          kind: 'constraint-layer',
          label: 'cross-session memory constraints',
          metadata: { count: snapshot.memoryConstraintEntries.length },
        },
      );
    }
    if (contextPolicy.includePersistent) {
      refs.push(
        {
          scope: 'state',
          kind: 'summary-layer',
          label: 'current-session persistent summary',
          metadata: { count: snapshot.persistentSummaryEntries.length },
        },
        {
          scope: 'state',
          kind: 'constraint-layer',
          label: 'current-session persistent constraints',
          metadata: { count: snapshot.persistentConstraintEntries.length },
        },
      );
    }
    if (contextPolicy.includeCurrentWork) {
      refs.push({
        scope: 'work',
        kind: 'current-work-layer',
        label: 'current work',
        metadata: {
          count: snapshot.currentWorkEntries.length,
          layout: snapshot.workLayout.strategy,
        },
      });
    }
    if (contextPolicy.includeRecentTurns) {
      refs.push({
        scope: 'work',
        kind: 'recent-turns-layer',
        label: 'recent turns',
        metadata: { count: snapshot.recentTurns.length },
      });
    }
    return refs;
  }

  private async maybeCompactAfterRun(agentId: string, sessionId: string): Promise<void> {
    const agent = await this.getAgent(agentId);
    const session = await this.store.getSession(agentId, sessionId);
    if (!session) {
      return;
    }
    try {
      await this.compactSessionWork(agent, session, 'auto', 'agent');
    } catch (error) {
      if (!isPersistentBudgetExceededError(error)) {
        throw error;
      }
      const recovered = await this.tryAutoRecoverPersistentBudget(agentId);
      if (!recovered) {
        return;
      }
      const recoveredAgent = await this.getAgent(agentId);
      const recoveredSession = await this.store.getSession(agentId, sessionId);
      if (!recoveredSession) {
        return;
      }
      await this.compactSessionWork(recoveredAgent, recoveredSession, 'auto', 'agent');
    }
  }

  private async tryAutoRecoverPersistentBudget(agentId: string): Promise<boolean> {
    const preview = await this.previewPersistentBudgetRecovery(agentId);
    const strategy = preview.candidates.find((candidate) => candidate.statusAfterApply === 'clean')?.strategy;
    if (!strategy) {
      return false;
    }
    await this.applyPersistentBudgetRecovery(agentId, {
      confirm: true,
      strategy,
      resumeAutonomy: false,
    });
    return true;
  }

  private resolveAutonomousAgentPolicy(policy?: AutonomousAgentPolicy): Required<AutonomousAgentPolicy> {
    return {
      autoRevive: policy?.autoRevive ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.autoRevive,
      autoPersistentRecovery: policy?.autoPersistentRecovery ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.autoPersistentRecovery,
      allowPersistentReset: policy?.allowPersistentReset ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.allowPersistentReset,
      resetReusesMemorySeed: policy?.resetReusesMemorySeed ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.resetReusesMemorySeed,
      clearCurrentWorkOnReset: policy?.clearCurrentWorkOnReset ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.clearCurrentWorkOnReset,
      resumeAutonomyAfterRecovery: policy?.resumeAutonomyAfterRecovery ?? DEFAULT_AUTONOMOUS_AGENT_POLICY.resumeAutonomyAfterRecovery,
    };
  }

  private buildAutonomousRecoveryAction(
    kind: AutonomousAgentRecoveryAction['kind'],
    detail: string,
  ): AutonomousAgentRecoveryAction {
    return {
      kind,
      detail,
      createdAt: nowIso(),
    };
  }

  private async transitionEvolutionProposal(
    proposalId: string,
    status: AgentEvolutionProposal['status'],
    request: UpdateAgentEvolutionProposalStatusRequest,
  ): Promise<AgentEvolutionProposal> {
    const proposal = await this.getEvolutionProposal(proposalId);
    if (proposal.status === 'rejected' || proposal.status === 'rolled_back') {
      throw new Error(`cannot transition proposal from terminal status: ${proposal.status}`);
    }
    if (proposal.status === 'applied' && status !== 'rolled_back') {
      throw new Error('applied proposal can only transition to rolled_back');
    }
    const now = nowIso();
    proposal.status = status;
    proposal.updatedAt = now;
    if (status === 'applied') {
      proposal.appliedAt = now;
    }
    if (status === 'rolled_back') {
      proposal.rolledBackAt = now;
    }
    proposal.history.push({
      status,
      actor: request.actor,
      note: request.note,
      createdAt: now,
    });
    await this.store.saveEvolutionProposal(proposal);
    return proposal;
  }

  private async ensureAutonomousAgentInternal(
    input: EnsureAutonomousAgentRequest,
    actions: AutonomousAgentRecoveryAction[] = [],
  ): Promise<{ agent: AgentManifest; created: boolean; reconciled: boolean }> {
    await this.ensureInitialized();
    const workingDirectory = input.workingDirectory?.trim();
    if (!workingDirectory) {
      throw new Error('workingDirectory is required');
    }
    await this.store.validateWorkingDirectory(workingDirectory);

    const agentId = String(input.id || `agent-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`).trim();
    const existing = await this.store.getAgent(agentId);
    if (!existing) {
      const created = await this.createAgent({
        ...input,
        id: agentId,
        workingDirectory,
      });
      actions.push(this.buildAutonomousRecoveryAction(
        'created',
        `created autonomous hosted agent ${agentId}`,
      ));
      return {
        agent: created,
        created: true,
        reconciled: false,
      };
    }

    if (input.reconcileExisting === false) {
      return {
        agent: existing,
        created: false,
        reconciled: false,
      };
    }

    const desiredName = String(input.name || existing.name || normalizeNameFromDirectory(workingDirectory)).trim() || agentId;
    const desiredBackend = normalizeBackendType(input.backend, existing.backend);
    const desiredRuntimeTeamId = String(input.runtimeTeamId || existing.runtimeTeamId || DEFAULT_RUNTIME_TEAM_ID).trim() || DEFAULT_RUNTIME_TEAM_ID;
    const desiredRuntimeAgentId = String(input.runtimeAgentId || existing.runtimeAgentId || agentId).trim() || agentId;
    const desiredSystemPrompt = String(input.systemPrompt || existing.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
    const desiredAutonomy = {
      enabled: input.autonomy?.enabled ?? existing.autonomy.enabled,
      intervalMs: Math.max(5_000, Number(input.autonomy?.intervalMs ?? existing.autonomy.intervalMs)),
      autoReflect: input.autonomy?.autoReflect ?? existing.autonomy.autoReflect,
      maxConsecutiveErrors: Math.max(
        1,
        Number(input.autonomy?.maxConsecutiveErrors ?? existing.autonomy.maxConsecutiveErrors),
      ),
    };

    const changedFields: string[] = [];
    if (existing.name !== desiredName) {
      existing.name = desiredName;
      changedFields.push('name');
    }
    if (existing.backend !== desiredBackend) {
      existing.backend = desiredBackend;
      changedFields.push('backend');
    }
    if (existing.workingDirectory !== workingDirectory) {
      existing.workingDirectory = workingDirectory;
      changedFields.push('workingDirectory');
    }
    if (existing.runtimeTeamId !== desiredRuntimeTeamId) {
      existing.runtimeTeamId = desiredRuntimeTeamId;
      changedFields.push('runtimeTeamId');
    }
    if (existing.runtimeAgentId !== desiredRuntimeAgentId) {
      existing.runtimeAgentId = desiredRuntimeAgentId;
      changedFields.push('runtimeAgentId');
    }
    if (existing.systemPrompt !== desiredSystemPrompt) {
      existing.systemPrompt = desiredSystemPrompt;
      changedFields.push('systemPrompt');
    }
    if (JSON.stringify(existing.autonomy) !== JSON.stringify(desiredAutonomy)) {
      existing.autonomy = desiredAutonomy;
      changedFields.push('autonomy');
    }
    if (input.metadata !== undefined && JSON.stringify(existing.metadata ?? {}) !== JSON.stringify(input.metadata ?? {})) {
      existing.metadata = input.metadata;
      changedFields.push('metadata');
    }
    if (changedFields.length > 0) {
      existing.updatedAt = nowIso();
      await this.store.saveAgent(existing);
      actions.push(this.buildAutonomousRecoveryAction(
        'reconciled',
        `reconciled existing autonomous hosted agent ${agentId}: ${changedFields.join(', ')}`,
      ));
      return {
        agent: existing,
        created: false,
        reconciled: true,
      };
    }
    return {
      agent: existing,
      created: false,
      reconciled: false,
    };
  }

  private async prepareAutonomousAgent(
    agentId: string,
    policy: Required<AutonomousAgentPolicy>,
    actions: AutonomousAgentRecoveryAction[],
  ): Promise<AgentManifest> {
    let agent = await this.getAgent(agentId);
    let recovery = await this.getRecoverySnapshot(agentId);
    const needsPersistentRecovery = this.agentNeedsPersistentBudgetRecovery(agent, recovery);

    if (needsPersistentRecovery && policy.autoPersistentRecovery) {
      const recovered = await this.tryAutoRecoverPersistentBudget(agentId);
      if (recovered) {
        actions.push(this.buildAutonomousRecoveryAction(
          'persistent_recovery',
          `applied automatic persistent budget slimming before autonomous task dispatch for ${agentId}`,
        ));
        agent = await this.getAgent(agentId);
        recovery = await this.getRecoverySnapshot(agentId);
      }
    }

    if (this.agentNeedsPersistentBudgetRecovery(agent, recovery) && policy.allowPersistentReset) {
      await this.resetPersistent(agentId, {
        confirm: true,
        reseedFromMemory: policy.resetReusesMemorySeed,
        clearCurrentWork: policy.clearCurrentWorkOnReset,
      });
      actions.push(this.buildAutonomousRecoveryAction(
        'persistent_reset',
        `reset persistent context before autonomous task dispatch for ${agentId}`,
      ));
      agent = await this.getAgent(agentId);
      recovery = await this.getRecoverySnapshot(agentId);
    }

    if (
      policy.autoRevive
      && (
        agent.status !== 'active'
        || Boolean(agent.runtime.lastError)
        || recovery.status !== 'clean'
      )
    ) {
      agent = await this.reviveAgent(agentId, {
        clearLastError: true,
        resetConsecutiveErrors: true,
        resumeAutonomy: policy.resumeAutonomyAfterRecovery,
      });
      actions.push(this.buildAutonomousRecoveryAction(
        'revived',
        `revived autonomous hosted agent ${agentId} before task execution`,
      ));
    }

    return agent;
  }

  private agentNeedsPersistentBudgetRecovery(
    agent: AgentManifest,
    recovery: AgentRecoverySnapshot,
  ): boolean {
    const runtimeError = String(agent.runtime.lastError || '').toLowerCase();
    if (runtimeError.includes('persistent/ exceeded') || runtimeError.includes('persistent budget')) {
      return true;
    }
    return recovery.issues.some((issue) => issue.kind === 'persistent_budget_exceeded');
  }

  private async compactSessionWork(
    agent: AgentManifest,
    session: AgentSessionRecord,
    mode: CompactAgentRequest['mode'],
    decisionBy: 'human' | 'agent',
  ): Promise<AgentCompactionTagRecord | null> {
    const currentWork = await this.store.listCurrentWork(agent.id, session.id);
    const turns = currentWork.filter(normalizeWorkEntryTurn);
    if (turns.length < 2) {
      return null;
    }
    const contextSnapshot = await this.getContextSnapshot(agent.id);
    const workBudget = contextSnapshot.workBudget;
    const workRatio = workBudget.workRatio;
    const runs = await this.store.listRuns(agent.id, session.id);
    const initialPartialPlan = this.planPartialCompaction(currentWork, runs);
    const partialSemanticOpportunity = this.estimatePartialSemanticOpportunity(initialPartialPlan);
    const partialCostDelta = initialPartialPlan
      ? this.buildCompactionCostDelta(workBudget.approxPrefixTokens, currentWork, 'partial', initialPartialPlan)
      : undefined;
    let semanticSuggestion: CompactSemanticSuggestion | null = null;
    const budgetRecommendedMode: CompactDecisionSnapshot['budgetRecommendedMode'] = (
      workRatio >= WORK_RATIO_HARD_THRESHOLD
        ? 'full'
        : initialPartialPlan && (
          workBudget.status !== 'healthy'
          || Boolean(
            partialCostDelta
            && partialCostDelta.estimatedSavingsPerFutureTurn >= MIN_PARTIAL_COST_SAVINGS_PER_TURN
            && partialCostDelta.estimatedSavingsRatio >= MIN_PARTIAL_COST_SAVINGS_RATIO
          )
          || partialSemanticOpportunity.score >= MIN_PARTIAL_SEMANTIC_OPPORTUNITY_SCORE
        )
          ? 'partial'
          : 'none'
    );
    if (mode === 'auto') {
      semanticSuggestion = await this.analyzeCompactionSemantics(
        contextSnapshot.workLayout,
        workBudget,
        currentWork,
        initialPartialPlan,
        budgetRecommendedMode,
        partialCostDelta,
        this.buildCompactionCostDelta(workBudget.approxPrefixTokens, currentWork, 'full'),
      );
    }

    const decision = this.resolveCompactionDecision(
      contextSnapshot.workLayout,
      workBudget,
      initialPartialPlan,
      semanticSuggestion,
      budgetRecommendedMode,
    );
    const resolvedMode = mode === 'auto'
      ? (decision.resolvedMode === 'none' ? null : decision.resolvedMode)
      : mode;
    if (!resolvedMode) {
      return null;
    }
    if (resolvedMode === 'partial' && !this.isSafetyPoint(currentWork)) {
      return null;
    }
    let compressible: AgentWorkEntry[] = [];
    let nextCurrent: AgentWorkEntry[] = currentWork;
    let rationale: string[] = [];
    let stableBoundaryTurn: number | undefined;
    let dynamicTailTurns: string | undefined;
    let safetyPointTurn: number | undefined;

    let partialPlan:
      | {
        compressibleEntries: AgentWorkEntry[];
        nextCurrentWithoutTag: AgentWorkEntry[];
        dynamicTailEntries: AgentTurnRecord[];
        stableBoundaryTurn?: number;
        dynamicTailTurns?: string;
        safetyPointTurn?: number;
        rationale: string[];
      }
      | null = null;

    if (resolvedMode === 'full') {
      compressible = currentWork;
      nextCurrent = [];
      const layout = this.inspectWorkLayout(currentWork);
      rationale = layout.rationale;
      stableBoundaryTurn = layout.stableBoundaryTurn;
      safetyPointTurn = layout.safetyPointTurn;
    } else {
      partialPlan = this.planPartialCompaction(
        currentWork,
        runs,
        semanticSuggestion?.suggestedStableBoundaryTurn,
      );
      if (!partialPlan) {
        return null;
      }
      compressible = partialPlan.compressibleEntries;
      nextCurrent = partialPlan.nextCurrentWithoutTag;
      rationale = partialPlan.rationale;
      stableBoundaryTurn = partialPlan.stableBoundaryTurn;
      dynamicTailTurns = partialPlan.dynamicTailTurns;
      safetyPointTurn = partialPlan.safetyPointTurn;
      rationale = [
        ...partialPlan.rationale,
        ...(semanticSuggestion?.provider === 'llm'
          ? semanticSuggestion.rationale.map((item) => `semantic: ${item}`)
          : []),
        `decision_source=${decision.source}`,
      ];
    }

    const turnBlock = compressible.filter(normalizeWorkEntryTurn);
    if (turnBlock.length === 0) {
      return null;
    }

    const constraintBlock = this.extractConstraintsFromCompressedEntries(compressible);
    const summaryBlock = this.summarizeCompressedEntries(compressible);
    const toolNames = this.collectToolsFromRuns(runs, turnBlock);
    const tag: AgentCompactionTagRecord = {
      kind: resolvedMode === 'full' ? 'compaction' : 'partial_compaction',
      id: `${resolvedMode}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      createdAt: nowIso(),
      decisionBy,
      archived: this.collectArchivedRefs(session.id, compressible),
      turns: this.formatTurnRange(turnBlock),
      tools: toolNames,
      files: [],
      constraints: resolvedMode === 'full' ? constraintBlock : undefined,
      summary: summaryBlock,
      workRatio,
      mode: resolvedMode,
      stableBoundaryTurn,
      dynamicTailTurns,
      safetyPointTurn,
      rationale,
    };

    const recoveryIntent: AgentCompactionIntentRecord = {
      id: `intent-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      agentId: agent.id,
      sessionId: session.id,
      mode: resolvedMode,
      phase: 'replacing_current_work',
      targetTurns: tag.turns,
      createdAt: nowIso(),
    };

    await this.store.saveRecoveryIntent(recoveryIntent);
    try {
      if (resolvedMode === 'full') {
        await this.store.appendPersistentSummary(agent.id, session.id, summaryBlock.join(' '));
        if (constraintBlock.length > 0) {
          await this.store.appendPersistentConstraints(agent.id, session.id, constraintBlock);
        }
        await this.store.saveCurrentWork(agent.id, session.id, [tag]);
      } else {
        const nextEntries = [...nextCurrent, tag];
        nextEntries.push(...(partialPlan?.dynamicTailEntries ?? []));
        await this.store.saveCurrentWork(agent.id, session.id, nextEntries);
      }
    } finally {
      await this.store.clearRecoveryIntent(agent.id, session.id);
    }
    return tag;
  }

  private computeWorkBudgetSnapshot(
    systemPrompt: string,
    memorySummaryEntries: string[],
    memoryConstraintEntries: AgentConstraintRecord[],
    persistentSummaryEntries: string[],
    persistentConstraintEntries: AgentConstraintRecord[],
    currentWorkEntries: AgentWorkEntry[],
  ): AgentWorkBudgetSnapshot {
    const approxPrefixTokens = approxTokens([
      systemPrompt,
      memorySummaryEntries.join('\n'),
      persistentSummaryEntries.join('\n'),
      memoryConstraintEntries.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
      persistentConstraintEntries.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
    ].join('\n'));
    const approxCurrentWorkTokens = approxTokens(JSON.stringify(currentWorkEntries));
    const approxRemainingTokens = Math.max(1, APPROX_CONTEXT_TOKENS - approxPrefixTokens);
    const workRatio = approxCurrentWorkTokens / approxRemainingTokens;
    const tokenEconomics = this.computeWorkTokenEconomics(
      approxPrefixTokens,
      currentWorkEntries,
    );
    const status = workRatio >= WORK_RATIO_HARD_THRESHOLD
      ? 'hard_threshold_reached'
      : workRatio >= WORK_RATIO_SOFT_THRESHOLD
        ? 'soft_threshold_reached'
        : 'healthy';
    const rationale = [
      `current_work_tokens=${approxCurrentWorkTokens}, remaining_context_tokens=${approxRemainingTokens}, work_ratio=${workRatio.toFixed(3)}`,
      status === 'hard_threshold_reached'
        ? 'hard threshold reached: full compaction should no longer depend on a safety point'
        : status === 'soft_threshold_reached'
          ? 'soft threshold reached: compaction is recommended when a safety point exists'
          : 'current work remains below the soft compaction threshold',
    ];
    return {
      approxContextTokens: APPROX_CONTEXT_TOKENS,
      approxPrefixTokens,
      approxCurrentWorkTokens,
      approxRemainingTokens,
      workRatio,
      softThreshold: WORK_RATIO_SOFT_THRESHOLD,
      hardThreshold: WORK_RATIO_HARD_THRESHOLD,
      status,
      tokenEconomics,
      rationale,
    };
  }

  private computePersistentBudgetSnapshot(
    persistentSummaryEntries: string[],
    persistentConstraintEntries: AgentConstraintRecord[],
  ): AgentPersistentBudgetSnapshot {
    const approxSummaryTokens = approxTokens(persistentSummaryEntries.join('\n'));
    const approxConstraintTokens = approxTokens(
      persistentConstraintEntries.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
    );
    const approxTotalTokens = this.approxPersistentTokens(
      persistentSummaryEntries,
      persistentConstraintEntries,
    );
    const tokenEconomics = this.buildTokenEconomicsSnapshot(
      approxTotalTokens,
      0,
      [
        'Persistent summary/constraints sit in the reusable prefix and should mostly benefit from KV cache hits across turns.',
      ],
    );
    let status: AgentPersistentBudgetSnapshot['status'] = 'healthy';
    if (
      approxTotalTokens > PERSISTENT_MAX_APPROX_TOKENS
      || approxSummaryTokens > PERSISTENT_SUMMARY_HARD_APPROX_TOKENS
      || approxConstraintTokens > PERSISTENT_CONSTRAINT_HARD_APPROX_TOKENS
    ) {
      status = 'hard_limit_reached';
    } else if (approxConstraintTokens >= PERSISTENT_CONSTRAINT_SOFT_APPROX_TOKENS) {
      status = 'constraint_soft_limit_reached';
    } else if (approxSummaryTokens >= PERSISTENT_SUMMARY_SOFT_APPROX_TOKENS) {
      status = 'summary_soft_limit_reached';
    }
    const rationale = [
      `summary_tokens=${approxSummaryTokens}, constraint_tokens=${approxConstraintTokens}, total_tokens=${approxTotalTokens}`,
      status === 'hard_limit_reached'
        ? 'persistent context exceeded a hard limit and should be finalized, slimmed, or explicitly cleaned before more work accumulates'
        : status === 'constraint_soft_limit_reached'
          ? 'constraint storage is approaching its hard limit; prefer consolidation or human-guided cleanup soon'
          : status === 'summary_soft_limit_reached'
            ? 'summary storage is approaching its hard limit; prefer finalize/compaction before it grows further'
            : 'persistent context remains within the current soft limits',
    ];
    return {
      approxSummaryTokens,
      approxConstraintTokens,
      approxTotalTokens,
      summarySoftLimit: PERSISTENT_SUMMARY_SOFT_APPROX_TOKENS,
      summaryHardLimit: PERSISTENT_SUMMARY_HARD_APPROX_TOKENS,
      constraintSoftLimit: PERSISTENT_CONSTRAINT_SOFT_APPROX_TOKENS,
      constraintHardLimit: PERSISTENT_CONSTRAINT_HARD_APPROX_TOKENS,
      totalHardLimit: PERSISTENT_MAX_APPROX_TOKENS,
      status,
      tokenEconomics,
      rationale,
    };
  }

  private computeMemoryBudgetSnapshot(
    memorySummaryEntries: string[],
    memoryConstraintEntries: AgentConstraintRecord[],
  ): AgentMemoryBudgetSnapshot {
    const approxSummaryTokens = approxTokens(memorySummaryEntries.join('\n'));
    const approxConstraintTokens = approxTokens(
      memoryConstraintEntries.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
    );
    const approxTotalTokens = approxTokens([
      memorySummaryEntries.join('\n'),
      memoryConstraintEntries.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
    ].join('\n'));
    const tokenEconomics = this.buildTokenEconomicsSnapshot(
      approxTotalTokens,
      0,
      [
        'Cross-session memory also belongs to the reusable prefix; slimming it lowers every future turn, even when cache hits are discounted to one tenth.',
      ],
    );
    let status: AgentMemoryBudgetSnapshot['status'] = 'healthy';
    if (
      approxTotalTokens > MEMORY_MAX_APPROX_TOKENS
      || approxSummaryTokens > MEMORY_SUMMARY_HARD_APPROX_TOKENS
      || approxConstraintTokens > MEMORY_CONSTRAINT_HARD_APPROX_TOKENS
    ) {
      status = 'hard_limit_reached';
    } else if (approxConstraintTokens >= MEMORY_CONSTRAINT_SOFT_APPROX_TOKENS) {
      status = 'constraint_soft_limit_reached';
    } else if (approxSummaryTokens >= MEMORY_SUMMARY_SOFT_APPROX_TOKENS) {
      status = 'summary_soft_limit_reached';
    }
    const rationale = [
      `summary_tokens=${approxSummaryTokens}, constraint_tokens=${approxConstraintTokens}, total_tokens=${approxTotalTokens}`,
      status === 'hard_limit_reached'
        ? 'cross-session memory is beyond a current hard limit; future session finalize operations should be human-reviewed and memory cleanup may be needed'
        : status === 'constraint_soft_limit_reached'
          ? 'cross-session memory constraints are approaching their hard limit; prefer consolidation before many more sessions are finalized'
          : status === 'summary_soft_limit_reached'
            ? 'cross-session memory summaries are approaching their hard limit; prefer memory cleanup or more selective finalize soon'
            : 'cross-session memory remains within the current soft limits',
    ];
    return {
      approxSummaryTokens,
      approxConstraintTokens,
      approxTotalTokens,
      summarySoftLimit: MEMORY_SUMMARY_SOFT_APPROX_TOKENS,
      summaryHardLimit: MEMORY_SUMMARY_HARD_APPROX_TOKENS,
      constraintSoftLimit: MEMORY_CONSTRAINT_SOFT_APPROX_TOKENS,
      constraintHardLimit: MEMORY_CONSTRAINT_HARD_APPROX_TOKENS,
      totalHardLimit: MEMORY_MAX_APPROX_TOKENS,
      status,
      tokenEconomics,
      rationale,
    };
  }

  private buildTokenEconomicsSnapshot(
    approxCacheEligibleTokens: number,
    approxUncachedTokens: number,
    rationale: string[] = [],
  ): AgentTokenEconomicsSnapshot {
    return {
      approxCacheEligibleTokens,
      approxUncachedTokens,
      cacheHitPriceFactor: CACHE_HIT_PRICE_FACTOR,
      effectivePerTurnCostUnits: round2((approxCacheEligibleTokens * CACHE_HIT_PRICE_FACTOR) + approxUncachedTokens),
      rationale: [
        `cache-hit tokens are priced at ${CACHE_HIT_PRICE_FACTOR}x uncached tokens in this model`,
        ...rationale,
      ],
    };
  }

  private estimateTagPromptTokens(entries: AgentTurnRecord[]): number {
    if (entries.length === 0) {
      return 0;
    }
    const rawTokens = approxTokens(JSON.stringify(entries));
    const ratio = this.estimateCompressionRatio(entries);
    return Math.max(24, Math.ceil(rawTokens * ratio));
  }

  private computeWorkEntryTokenEconomics(entries: AgentWorkEntry[]): {
    approxStableTokens: number;
    approxCompressedTagTokens: number;
    approxDynamicTokens: number;
    tokenEconomics: AgentTokenEconomicsSnapshot;
  } {
    let approxStableTokens = 0;
    let approxCompressedTagTokens = 0;
    let approxDynamicTokens = 0;
    let sawCompressed = false;
    let rawBuffer: AgentTurnRecord[] = [];
    const flushRaw = (): void => {
      if (rawBuffer.length === 0) {
        return;
      }
      const tokenCount = approxTokens(JSON.stringify(rawBuffer));
      if (sawCompressed) {
        approxDynamicTokens += tokenCount;
      } else {
        approxStableTokens += tokenCount;
      }
      rawBuffer = [];
    };
    for (const entry of entries) {
      if (normalizeWorkEntryTurn(entry)) {
        rawBuffer.push(entry);
        continue;
      }
      flushRaw();
      sawCompressed = true;
      approxCompressedTagTokens += approxTokens(JSON.stringify({
        turns: entry.turns,
        tools: entry.tools,
        files: entry.files,
        summary: entry.summary,
        mode: entry.mode,
      }));
    }
    flushRaw();
    return {
      approxStableTokens,
      approxCompressedTagTokens,
      approxDynamicTokens,
      tokenEconomics: this.buildTokenEconomicsSnapshot(
        approxStableTokens + approxCompressedTagTokens,
        approxDynamicTokens,
        [
          'Stable raw islands and compaction tags are treated as cache-eligible if they remain byte-stable across turns.',
          'Dynamic raw islands are treated as uncached because they are most likely to change on the next turn.',
        ],
      ),
    };
  }

  private computeWorkTokenEconomics(
    approxPrefixTokens: number,
    currentWorkEntries: AgentWorkEntry[],
  ): AgentTokenEconomicsSnapshot {
    const workEconomics = this.computeWorkEntryTokenEconomics(currentWorkEntries);
    return this.buildTokenEconomicsSnapshot(
      approxPrefixTokens + workEconomics.approxStableTokens + workEconomics.approxCompressedTagTokens,
      workEconomics.approxDynamicTokens,
      [
        'System prompt, memory, and persistent context are treated as cache-eligible prefix tokens.',
        `Current work contributes stable/cache-eligible=${workEconomics.approxStableTokens + workEconomics.approxCompressedTagTokens} and uncached/dynamic=${workEconomics.approxDynamicTokens} tokens.`,
      ],
    );
  }

  private buildTokenCostDelta(
    beforeEffectivePerTurnCostUnits: number,
    afterEffectivePerTurnCostUnits: number,
    oneTimeRewriteCostUnits: number,
    rationale: string[] = [],
  ): AgentTokenCostDelta {
    const estimatedSavingsPerFutureTurn = round2(Math.max(0, beforeEffectivePerTurnCostUnits - afterEffectivePerTurnCostUnits));
    const estimatedSavingsRatio = beforeEffectivePerTurnCostUnits > 0
      ? round2(estimatedSavingsPerFutureTurn / beforeEffectivePerTurnCostUnits)
      : 0;
    const estimatedBreakEvenTurns = estimatedSavingsPerFutureTurn > 0
      ? round2(oneTimeRewriteCostUnits / estimatedSavingsPerFutureTurn)
      : undefined;
    return {
      beforeEffectivePerTurnCostUnits: round2(beforeEffectivePerTurnCostUnits),
      afterEffectivePerTurnCostUnits: round2(afterEffectivePerTurnCostUnits),
      estimatedSavingsPerFutureTurn,
      estimatedSavingsRatio,
      oneTimeRewriteCostUnits: round2(oneTimeRewriteCostUnits),
      estimatedBreakEvenTurns,
      rationale,
    };
  }

  private buildCompactionCostDelta(
    approxPrefixTokens: number,
    currentWorkEntries: AgentWorkEntry[],
    mode: 'partial' | 'full',
    partialPlan?: ReturnType<AgentServerService['planPartialCompaction']> | null,
  ): AgentTokenCostDelta | undefined {
    const before = this.computeWorkTokenEconomics(approxPrefixTokens, currentWorkEntries);
    if (mode === 'partial') {
      if (!partialPlan) {
        return undefined;
      }
      const stableAfter = this.computeWorkEntryTokenEconomics(partialPlan.nextCurrentWithoutTag);
      const dynamicTailTokens = approxTokens(JSON.stringify(partialPlan.dynamicTailEntries));
      const tagPromptTokens = this.estimateTagPromptTokens(
        partialPlan.compressibleEntries.filter(normalizeWorkEntryTurn),
      );
      const after = this.buildTokenEconomicsSnapshot(
        approxPrefixTokens + stableAfter.approxStableTokens + stableAfter.approxCompressedTagTokens + tagPromptTokens,
        dynamicTailTokens,
        [
          'Partial compaction keeps existing stable/cache-friendly islands intact and replaces only the selected dynamic island with a new compact tag.',
        ],
      );
      return this.buildTokenCostDelta(
        before.effectivePerTurnCostUnits,
        after.effectivePerTurnCostUnits,
        tagPromptTokens,
        [
          `Partial compaction is estimated to rewrite about ${tagPromptTokens} uncached tag tokens once, then reduce future effective turn cost.`,
        ],
      );
    }
    const tagPromptTokens = this.estimateTagPromptTokens(
      currentWorkEntries.filter(normalizeWorkEntryTurn),
    );
    const after = this.buildTokenEconomicsSnapshot(
      approxPrefixTokens + tagPromptTokens,
      0,
      [
        'Full compaction rewrites the whole window into a single cache-eligible tag and removes the uncached raw work tail.',
      ],
    );
    return this.buildTokenCostDelta(
      before.effectivePerTurnCostUnits,
      after.effectivePerTurnCostUnits,
      tagPromptTokens,
      [
        `Full compaction is estimated to rewrite about ${tagPromptTokens} uncached tag tokens once, then minimize future current-window cost.`,
      ],
    );
  }

  private estimatePartialSemanticOpportunity(
    partialPlan: ReturnType<AgentServerService['planPartialCompaction']> | null | undefined,
  ): {
    score: number;
    rationale: string[];
  } {
    if (!partialPlan) {
      return {
        score: 0,
        rationale: ['no partial plan exists, so semantic partial opportunity is zero'],
      };
    }
    const topCandidate = partialPlan.boundaryCandidates[0];
    const compressibleTurns = partialPlan.compressibleEntries.filter(normalizeWorkEntryTurn).length;
    const dynamicTailTurns = partialPlan.dynamicTailEntries.length;
    let score = 0;
    const rationale: string[] = [];
    if (topCandidate) {
      score += topCandidate.score;
      rationale.push(`top stable-boundary candidate score=${topCandidate.score} at turn_${topCandidate.turnNumber}`);
      if (topCandidate.signals.length > 0) {
        rationale.push(`boundary signals: ${topCandidate.signals.join(', ')}`);
      }
    }
    score += Math.min(4, compressibleTurns);
    rationale.push(`compressible dynamic turns=${compressibleTurns}`);
    if (partialPlan.stableBoundaryTurn) {
      score += 2;
      rationale.push(`semantic milestone boundary exists at turn_${partialPlan.stableBoundaryTurn}`);
    }
    if (dynamicTailTurns >= LIVE_DYNAMIC_TAIL_TURNS) {
      score += 1;
      rationale.push(`live dynamic tail preserved with ${dynamicTailTurns} turn(s)`);
    }
    return {
      score,
      rationale,
    };
  }

  private summarizeWorkEntries(entries: AgentTurnRecord[]): string[] {
    return entries.map((entry) => {
      const label = entry.role === 'assistant' ? 'assistant' : entry.role;
      return `[${label} turn_${entry.turnNumber ?? '?'}] ${excerpt(entry.content, 220)}`;
    });
  }

  private buildRetrievalTokenEconomics(
    options: {
      archivedTurns?: AgentTurnRecord[];
      workspaceHits?: AgentWorkspaceSearchResult['hits'];
      evidenceLayers?: AgentRetrievalLayerResult[];
      usedWorkspaceSearch?: boolean;
      reopenedRanges?: Array<{ source: string; start: number; end: number }>;
    },
  ): AgentWorkspaceSearchResult['tokenEconomics'] {
    const archivedTurns = options.archivedTurns ?? [];
    const workspaceHits = options.workspaceHits ?? [];
    const evidenceLayers = options.evidenceLayers ?? [];
    const reopenedRanges = options.reopenedRanges ?? [];
    const approxArchivedReopenTokens = reopenedRanges.length > 0
      ? approxTokens(JSON.stringify(archivedTurns))
      : 0;
    const approxWorkspaceSearchTokens = options.usedWorkspaceSearch
      ? approxTokens(JSON.stringify(workspaceHits))
      : 0;
    const approxInjectedEvidenceTokens = approxTokens(JSON.stringify(
      evidenceLayers.flatMap((layer) => layer.hits.slice(0, 3).map((hit) => ({
        layer: hit.layer,
        label: hit.label,
        excerpt: hit.excerpt,
      }))),
    ));
    const prefixStabilityRisk: AgentWorkspaceSearchResult['tokenEconomics']['prefixStabilityRisk'] = !options.usedWorkspaceSearch && reopenedRanges.length === 0
      ? 'low'
      : reopenedRanges.length >= 3 || workspaceHits.length >= 8
        ? 'high'
        : 'medium';
    return {
      approxArchivedReopenTokens,
      approxWorkspaceSearchTokens,
      approxInjectedEvidenceTokens,
      additionalEffectiveCostUnits: round2(
        approxArchivedReopenTokens
        + approxWorkspaceSearchTokens
        + approxInjectedEvidenceTokens,
      ),
      prefixStabilityRisk,
      rationale: [
        'Retrieval and workspace-search costs are modeled as additional uncached work because they vary with the current query and hit set.',
        reopenedRanges.length > 0
          ? `Archived reopen contributed about ${approxArchivedReopenTokens} tokens across ${reopenedRanges.length} reopened range(s).`
          : 'No archived reopen cost was added for this query.',
        options.usedWorkspaceSearch
          ? `Workspace search contributed about ${approxWorkspaceSearchTokens} tokens from ${workspaceHits.length} hit(s).`
          : 'Workspace search was not used for this query.',
        `The injected evidence payload is estimated at ${approxInjectedEvidenceTokens} tokens.`,
        prefixStabilityRisk === 'high'
          ? 'This query likely perturbs the stable prefix noticeably because it reopens many archived turns or injects a large workspace result set.'
          : prefixStabilityRisk === 'medium'
            ? 'This query adds a moderate amount of uncached retrieval evidence.'
            : 'This query keeps retrieval overhead low and should preserve most stable prefix reuse.',
      ],
    };
  }

  private summarizeCompressedEntries(entries: AgentWorkEntry[]): string[] {
    return entries.flatMap((entry) => {
      if (normalizeWorkEntryTurn(entry)) {
        return this.summarizeWorkEntries([entry]);
      }
      return [
        `[${entry.kind} ${entry.turns}] ${entry.summary.join(' ')}`,
      ];
    });
  }

  private formatTurnRange(entries: AgentTurnRecord[]): string {
    const numbers = entries
      .map((entry) => entry.turnNumber)
      .filter((value): value is number => Number.isFinite(value));
    if (numbers.length === 0) {
      return 'turn_unknown';
    }
    return `turn_${Math.min(...numbers)}-turn_${Math.max(...numbers)}`;
  }

  private collectToolsFromRuns(runs: AgentRunRecord[], entries: AgentTurnRecord[]): string[] {
    const runIds = new Set(entries.map((entry) => entry.runId).filter(Boolean));
    const tools = new Set<string>();
    for (const run of runs) {
      if (!runIds.has(run.id)) {
        continue;
      }
      for (const event of run.events) {
        if (event.type === 'tool-call' && event.toolName) {
          tools.add(event.toolName);
        }
      }
    }
    return [...tools];
  }

  private extractConstraintsFromRun(
    events: SessionStreamEvent[],
    assistantTurn: AgentTurnRecord,
    sessionId: string,
  ): AgentConstraintRecord[] {
    const constraints: AgentConstraintRecord[] = [
      this.buildConstraintRecord({
        key: 'env.working_directory',
        desc: 'The agent works inside a stable working directory and must verify mutable filesystem state before reuse.',
        turn: assistantTurn.turnNumber ?? 0,
        type: 'env_config',
        createdAt: assistantTurn.createdAt,
        priority: 'critical',
        durability: 'stable',
        evidence: ['stable working directory contract'],
      }),
    ];
    for (const event of events) {
      if ((event.type === 'tool-call' || event.type === 'tool-result') && event.toolName) {
        const toolEvidenceText = event.type === 'tool-result'
          ? (event.output?.trim() || event.detail)
          : event.detail;
        if (event.type === 'tool-call') {
          constraints.push(this.buildConstraintRecord({
            key: `tool.${event.toolName}.available`,
            desc: `${event.toolName} was successfully invoked in session ${sessionId}; mutable outputs should still be re-verified before reuse.`,
            turn: assistantTurn.turnNumber ?? 0,
            type: 'tool_behavior',
            priority: 'high',
            durability: 'stable',
            evidence: [event.detail ? `${event.toolName}: ${excerpt(event.detail, 120)}` : `${event.toolName} invoked successfully`],
            createdAt: assistantTurn.createdAt,
          }));
        } else {
          constraints.push(this.buildConstraintRecord({
            key: `tool.${event.toolName}.result_observed`,
            family: 'tool.result_observed',
            desc: `${event.toolName} produced an observable tool result in session ${sessionId}; similar work should prefer reusing or re-verifying this result pattern before broad exploration.`,
            turn: assistantTurn.turnNumber ?? 0,
            type: 'tool_behavior',
            priority: 'medium',
            durability: 'session',
            evidence: [toolEvidenceText ? `${event.toolName}: ${excerpt(toolEvidenceText, 140)}` : `${event.toolName} returned a result`],
            createdAt: assistantTurn.createdAt,
          }));
        }
        constraints.push(...this.extractToolDetailConstraints(event.toolName, toolEvidenceText, assistantTurn));
      }
    }
    constraints.push(...this.extractSemanticAssistantConstraints(assistantTurn));
    return dedupeConstraints(constraints);
  }

  private extractToolDetailConstraints(
    toolName: string,
    detail: string | undefined,
    assistantTurn: AgentTurnRecord,
  ): AgentConstraintRecord[] {
    if (!detail?.trim()) {
      return [];
    }
    const turn = assistantTurn.turnNumber ?? 0;
    const createdAt = assistantTurn.createdAt;
    const constraints: AgentConstraintRecord[] = [];
    for (const path of this.extractPathLikeTokens(detail).slice(0, 6)) {
      constraints.push(this.buildConstraintRecord({
        key: `workspace.paths_recently_observed.${this.toConstraintSlug(path)}`,
        family: 'workspace.paths_recently_observed',
        familyMembers: [path],
        desc: `Tool detail referenced workspace path/file "${path}"; re-read this concrete path before relying on it.`,
        turn,
        type: 'env_config',
        createdAt,
        priority: 'medium',
        durability: 'mutable',
        evidence: [`${toolName}: ${excerpt(detail, 140)}`],
      }));
    }
    for (const scope of this.extractSearchScopeTokens(detail).slice(0, 4)) {
      constraints.push(this.buildConstraintRecord({
        key: `workspace.search_scope_recently_used.${this.toConstraintSlug(scope)}`,
        family: 'workspace.search_scope_recently_used',
        familyMembers: [scope],
        desc: `Tool detail referenced search scope/pattern "${scope}"; reuse this scope when searching the workspace again.`,
        turn,
        type: 'api_behavior',
        createdAt,
        priority: 'low',
        durability: 'session',
        evidence: [`${toolName}: ${excerpt(detail, 140)}`],
      }));
    }
    return constraints;
  }

  private extractPathLikeTokens(detail: string): string[] {
    const matches = detail.match(/(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?|[A-Za-z0-9._-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|py|sh|txt)\b/g) ?? [];
    return [...new Set(matches.map((item) => item.trim()).filter((item) => item.length >= 3))];
  }

  private extractSearchScopeTokens(detail: string): string[] {
    const matches = [
      ...(detail.match(/\*\.[A-Za-z0-9_-]+/g) ?? []),
      ...(detail.match(/--glob\s+([^\s]+)/g) ?? []),
      ...(detail.match(/"([^"\n]{2,80})"/g) ?? []),
      ...(detail.match(/'([^'\n]{2,80})'/g) ?? []),
    ];
    return [...new Set(matches
      .map((item) => item.replace(/^--glob\s+/, '').replace(/^["']|["']$/g, '').trim())
      .filter((item) => item.length >= 2)
      .map((item) => excerpt(item, 80)))];
  }

  private toConstraintSlug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'item';
  }

  private extractConstraintsFromWorkEntries(entries: AgentTurnRecord[]): AgentConstraintRecord[] {
    const constraints: AgentConstraintRecord[] = [];
    for (const entry of entries) {
      if (entry.role !== 'assistant') {
        continue;
      }
      const normalized = entry.content.toLowerCase();
      if (normalized.includes('working directory')) {
        constraints.push(this.buildConstraintRecord({
          key: 'env.working_directory',
          desc: 'The agent works inside a stable working directory and must verify mutable filesystem state before reuse.',
          turn: entry.turnNumber ?? 0,
          type: 'env_config',
          priority: 'critical',
          durability: 'stable',
          evidence: ['assistant referenced working directory'],
          createdAt: entry.createdAt,
        }));
      }
      constraints.push(...this.extractSemanticAssistantConstraints(entry));
    }
    return dedupeConstraints(constraints);
  }

  private buildConstraintRecord(input: {
    key: string;
    family?: string;
    familyMembers?: string[];
    desc: string;
    turn: number;
    type: AgentConstraintRecord['type'];
    createdAt: string;
    priority?: ConstraintPriority;
    durability?: ConstraintDurability;
    evidence?: string[];
  }): AgentConstraintRecord {
    return {
      ...input,
      family: input.family ?? this.deriveConstraintFamily(input.key),
      familyMembers: input.familyMembers ?? [input.key],
      priority: input.priority ?? 'medium',
      durability: input.durability ?? 'session',
      evidence: input.evidence ?? [],
    };
  }

  private deriveConstraintFamily(key: string): string {
    if (key.startsWith('tool.')) {
      return 'tool.available';
    }
    if (key.startsWith('workspace.paths_recently_observed')) {
      return 'workspace.paths_recently_observed';
    }
    if (key.startsWith('workspace.search_scope_recently_used')) {
      return 'workspace.search_scope_recently_used';
    }
    if (key.startsWith('workflow.')) {
      return 'workflow.current_plan';
    }
    if (key.startsWith('protocol.')) {
      return key.split('.').slice(0, 2).join('.');
    }
    if (key.startsWith('env.')) {
      return key.split('.').slice(0, 2).join('.');
    }
    return key.split('.').slice(0, 2).join('.');
  }

  private semanticMergeConstraintFamilies(
    constraints: AgentConstraintRecord[],
    mode: 'session' | 'memory',
  ): AgentConstraintRecord[] {
    const byFamily = new Map<string, AgentConstraintRecord[]>();
    for (const constraint of dedupeConstraints(constraints)) {
      const family = constraint.family ?? this.deriveConstraintFamily(constraint.key);
      const bucket = byFamily.get(family) ?? [];
      bucket.push({
        ...constraint,
        family,
        familyMembers: constraint.familyMembers ?? [constraint.key],
      });
      byFamily.set(family, bucket);
    }
    const merged: AgentConstraintRecord[] = [];
    for (const [family, items] of byFamily.entries()) {
      if (items.length === 1) {
        merged.push(items[0]);
        continue;
      }
      const ranked = items
        .map((entry, index) => ({
          entry,
          index,
          score: this.scoreConstraintValue(entry, index, items.length),
        }))
        .sort((left, right) => right.score - left.score || right.entry.turn - left.entry.turn);
      const representative = ranked[0].entry;
      const evidence = [...new Set(items.flatMap((entry) => entry.evidence ?? []))].slice(-8);
      const familyMembers = [...new Set(items.flatMap((entry) => entry.familyMembers ?? [entry.key]))];
      const memberTail = familyMembers.slice(0, 6).join(', ');
      const desc = family === 'tool.available'
        ? `Representative tool availability constraint aggregated from ${items.length} observed tools (${memberTail}); mutable outputs still require re-verification.`
        : family === 'workspace.paths_recently_observed'
          ? `Representative workspace path observation aggregated from ${items.length} recent path/file mentions (${memberTail}); re-read concrete paths before relying on them.`
          : family === 'workspace.search_scope_recently_used'
            ? `Representative workspace search scope aggregated from ${items.length} recent search patterns (${memberTail}); reuse these scopes before broadening the search.`
          : family === 'workflow.current_plan'
            ? `Representative workflow plan checkpoint aggregated from ${items.length} recent plan/decision statements.`
          : representative.desc;
      merged.push({
        ...representative,
        family,
        familyMembers,
        desc,
        evidence,
        durability: representative.durability ?? (mode === 'memory' ? 'stable' : 'session'),
      });
    }
    return dedupeConstraints(merged);
  }

  private extractSemanticAssistantConstraints(entry: AgentTurnRecord): AgentConstraintRecord[] {
    if (entry.role !== 'assistant') {
      return [];
    }
    const lowered = entry.content.toLowerCase();
    const turn = entry.turnNumber ?? 0;
    const createdAt = entry.createdAt;
    const constraints: AgentConstraintRecord[] = [];
    if (/\b(decision|decided|plan|checkpoint|summary)\b/.test(lowered) || /(决策|决定|方案|阶段结论|阶段性结论|总结)/.test(entry.content)) {
      constraints.push(this.buildConstraintRecord({
        key: 'workflow.current_plan',
        desc: `Latest explicit plan checkpoint: ${excerpt(entry.content, 180)}`,
        turn,
        type: 'api_behavior',
        createdAt,
        priority: 'high',
        durability: 'session',
        evidence: ['assistant emitted an explicit plan/decision checkpoint'],
      }));
    }
    if (/\b(ask human|clarification|need more information|not enough evidence|unclear|unknown)\b/.test(lowered)
      || /(澄清|请提供|需要更多信息|证据不足|不确定|不清楚)/.test(entry.content)) {
      constraints.push(this.buildConstraintRecord({
        key: 'protocol.ask_human_on_uncertainty',
        desc: 'When retrieval evidence is insufficient, the agent should ask the human instead of guessing.',
        turn,
        type: 'protocol',
        createdAt,
        priority: 'critical',
        durability: 'stable',
        evidence: ['assistant explicitly acknowledged uncertainty or clarification need'],
      }));
    }
    if (/[`][^`]+[`]|(?:\/[A-Za-z0-9._-]+){1,}|[A-Za-z0-9._-]+\.(ts|tsx|js|json|md|toml|yaml|yml)\b/.test(entry.content)) {
      constraints.push(this.buildConstraintRecord({
        key: 'workspace.paths_recently_observed',
        desc: 'Recent assistant output referenced concrete workspace paths/files; prefer re-reading those paths over guessing.',
        turn,
        type: 'env_config',
        createdAt,
        priority: 'medium',
        durability: 'mutable',
        evidence: [excerpt(entry.content, 140)],
      }));
    }
    return constraints;
  }

  private extractConstraintsFromCompressedEntries(entries: AgentWorkEntry[]): AgentConstraintRecord[] {
    const inherited = entries.flatMap((entry) => (
      normalizeWorkEntryTurn(entry) ? [] : (entry.constraints ?? [])
    ));
    const turns = entries.filter(normalizeWorkEntryTurn);
    return dedupeConstraints([
      ...inherited,
      ...this.extractConstraintsFromWorkEntries(turns),
    ]);
  }

  private inspectWorkLayout(entries: AgentWorkEntry[]): AgentWorkLayout {
    const turns = entries.filter(normalizeWorkEntryTurn);
    if (turns.length === 0) {
      return {
        strategy: 'empty',
        safetyPointReached: true,
        rationale: ['current work is empty'],
        segments: [],
      };
    }
    const safetyPointReached = this.isSafetyPoint(entries);
    const safetyPointTurn = turns.at(-1)?.turnNumber;
    const lastCompaction = [...entries].reverse().find((entry): entry is AgentCompactionTagRecord => (
      entry.kind === 'compaction' || entry.kind === 'partial_compaction'
    ));
    if (lastCompaction?.kind === 'compaction') {
      return {
        strategy: 'full_compaction',
        safetyPointReached,
        safetyPointTurn,
        stableBoundaryTurn: lastCompaction.stableBoundaryTurn,
        rationale: lastCompaction.rationale ?? ['current work is represented by a single compaction tag'],
        boundaryCandidates: lastCompaction.stableBoundaryTurn
          ? [{
            turnNumber: lastCompaction.stableBoundaryTurn,
            score: 0,
            selected: true,
            signals: lastCompaction.rationale ?? [],
            excerpt: excerpt(lastCompaction.summary.join(' '), 140),
          }]
          : [],
        segments: [{
          kind: 'compressed_work',
          source: 'compaction_tag',
          turnRange: this.parseTurnRange(lastCompaction.turns) ?? undefined,
          entryCount: 1,
          note: 'full work window is compressed into one tag',
        }],
      };
    }
    const partialPlan = this.planPartialCompaction(entries);
    const segments = this.buildWorkLayoutSegments(entries);
    if (!partialPlan) {
      const hasPartialTag = entries.some((entry) => entry.kind === 'partial_compaction');
      return {
        strategy: hasPartialTag ? 'partial_compacted' : 'live_only',
        safetyPointReached,
        safetyPointTurn,
        stableBoundaryTurn: segments.find((segment) => segment.kind === 'stable_work')?.turnRange?.end,
        rationale: [
          !safetyPointReached
            ? 'the latest assistant turn does not look like a safe pause point yet'
            : hasPartialTag
              ? 'existing partial islands remain stable; the newest raw suffix is not large enough to justify another partial compaction'
              : 'there is not enough dynamic work after the stable boundary to justify partial compaction',
        ],
        boundaryCandidates: [],
        segments,
      };
    }
    return {
      strategy: 'partial_compaction_candidate',
      safetyPointReached,
      safetyPointTurn: partialPlan.safetyPointTurn,
      stableBoundaryTurn: partialPlan.stableBoundaryTurn,
      rationale: partialPlan.rationale,
      boundaryCandidates: partialPlan.boundaryCandidates,
      segments: this.buildWorkLayoutSegments([
        ...partialPlan.nextCurrentWithoutTag,
        {
          kind: 'partial_compaction',
          id: 'preview',
          createdAt: nowIso(),
          decisionBy: 'agent',
          archived: [],
          turns: partialPlan.previewTurnRange,
          tools: [],
          files: [],
          summary: [],
          mode: 'partial',
        },
        ...partialPlan.dynamicTailEntries,
      ]),
    };
  }

  private planPartialCompaction(
    currentWork: AgentWorkEntry[],
    runs: AgentRunRecord[] = [],
    preferredBoundaryTurn?: number,
  ): {
    compressibleEntries: AgentWorkEntry[];
    nextCurrentWithoutTag: AgentWorkEntry[];
    dynamicTailEntries: AgentTurnRecord[];
    stableBoundaryTurn?: number;
    dynamicTailTurns?: string;
    previewTurnRange: string;
    safetyPointTurn?: number;
    rationale: string[];
    boundaryCandidates: Array<{
      turnNumber: number;
      score: number;
      selected: boolean;
      signals: string[];
      excerpt: string;
    }>;
  } | null {
    const turns = currentWork.filter(normalizeWorkEntryTurn);
    if (turns.length < MIN_STABLE_WORK_TURNS + RELAXED_MIN_DYNAMIC_COMPRESS_TURNS + LIVE_DYNAMIC_TAIL_TURNS) {
      return null;
    }
    const lastTagIndex = currentWork.findLastIndex((entry) => (
      entry.kind === 'partial_compaction' || entry.kind === 'compaction'
    ));
    const prefixEntries = lastTagIndex >= 0 ? currentWork.slice(0, lastTagIndex + 1) : [];
    const suffixEntries = lastTagIndex >= 0 ? currentWork.slice(lastTagIndex + 1) : currentWork;
    const dynamicTurns = suffixEntries.filter(normalizeWorkEntryTurn);
    if (dynamicTurns.length < RELAXED_MIN_DYNAMIC_COMPRESS_TURNS + LIVE_DYNAMIC_TAIL_TURNS) {
      return null;
    }
    const dynamicTailEntries = dynamicTurns.slice(-LIVE_DYNAMIC_TAIL_TURNS);
    const compressibleTurns = dynamicTurns.slice(0, Math.max(0, dynamicTurns.length - LIVE_DYNAMIC_TAIL_TURNS));
    if (compressibleTurns.length < RELAXED_MIN_DYNAMIC_COMPRESS_TURNS) {
      return null;
    }
    const runMeta = this.indexRunsById(runs);
    const rankedCandidates = this.rankStableBoundaryCandidates(compressibleTurns, runMeta)
      .filter((item) => Number.isFinite(item.turn.turnNumber))
      .sort((left, right) => right.score - left.score || right.index - left.index);
    const strongestCandidate = rankedCandidates[0] ?? null;
    const veryStrongBoundaryAllowed = Boolean(
      preferredBoundaryTurn
      || (strongestCandidate && strongestCandidate.score >= VERY_STRONG_SEMANTIC_BOUNDARY_SCORE),
    );
    const relaxedBoundaryAllowed = Boolean(
      preferredBoundaryTurn
      || (strongestCandidate && strongestCandidate.score >= STRONG_SEMANTIC_BOUNDARY_SCORE),
    );
    const minDynamicCompressTurns = relaxedBoundaryAllowed
      ? (veryStrongBoundaryAllowed ? MICRO_DYNAMIC_COMPRESS_TURNS : RELAXED_MIN_DYNAMIC_COMPRESS_TURNS)
      : MIN_DYNAMIC_COMPRESS_TURNS;
    const validCandidates = rankedCandidates.filter((item) => {
      const turnNumber = item.turn.turnNumber ?? 0;
      return compressibleTurns.filter((entry) => (entry.turnNumber ?? 0) > turnNumber).length >= minDynamicCompressTurns;
    });
    const preferredCandidate = preferredBoundaryTurn
      ? validCandidates.find((item) => item.turn.turnNumber === preferredBoundaryTurn)
      : null;
    const milestoneBoundaryTurn = preferredCandidate
      ? preferredCandidate.turn.turnNumber
      : validCandidates.find((item) => item.score >= STRONG_SEMANTIC_BOUNDARY_SCORE)?.turn.turnNumber;
    const stableBoundaryTurn = milestoneBoundaryTurn;
    const rationale = [
      preferredCandidate
        ? `semantic boundary preference selected turn_${preferredCandidate.turn.turnNumber} with score=${preferredCandidate.score}`
        : 'no explicit semantic boundary preference was supplied',
      veryStrongBoundaryAllowed
        ? `very strong semantic boundary signals allow a micro dynamic compression island (min_turns=${minDynamicCompressTurns})`
        : relaxedBoundaryAllowed
        ? `strong semantic boundary signals allow a smaller dynamic compression island (min_turns=${minDynamicCompressTurns})`
        : `dynamic compression still requires at least ${minDynamicCompressTurns} raw turn(s) after the stable boundary`,
      stableBoundaryTurn
        ? `latest milestone inside the raw suffix is turn_${stableBoundaryTurn}, so turns after it are treated as dynamic_work for this partial island`
        : 'no strong semantic milestone was found inside the raw suffix; the planner compresses the suffix as one dynamic island',
      `the newest ${LIVE_DYNAMIC_TAIL_TURNS} raw turns remain live as dynamic_work after the safety point`,
    ];
    const boundaryCandidates = validCandidates
      .slice(0, 5)
      .map((item) => ({
        turnNumber: item.turn.turnNumber ?? 0,
        score: item.score,
        selected: item.turn.turnNumber === stableBoundaryTurn,
        signals: item.signals,
        excerpt: excerpt(item.turn.content, 140),
      }))
      .filter((item) => item.turnNumber > 0);
    const compressibleEntries: AgentWorkEntry[] = compressibleTurns;
    const stableRawSuffix = stableBoundaryTurn
      ? compressibleTurns.filter((entry) => (entry.turnNumber ?? Number.MAX_SAFE_INTEGER) <= stableBoundaryTurn)
      : [];
    const dynamicCompressTurns = stableBoundaryTurn
      ? compressibleTurns.filter((entry) => (entry.turnNumber ?? 0) > stableBoundaryTurn)
      : compressibleTurns;
    if (dynamicCompressTurns.length < minDynamicCompressTurns) {
      return null;
    }
    const nextCurrentWithoutTag = [
      ...prefixEntries,
      ...stableRawSuffix,
    ];
    return {
      compressibleEntries: dynamicCompressTurns,
      nextCurrentWithoutTag,
      dynamicTailEntries,
      stableBoundaryTurn,
      dynamicTailTurns: this.formatTurnRange(dynamicTailEntries),
      previewTurnRange: this.formatTurnRange(dynamicCompressTurns),
      safetyPointTurn: turns.at(-1)?.turnNumber,
      rationale,
      boundaryCandidates,
    };
  }

  private buildWorkLayoutSegments(entries: AgentWorkEntry[]): AgentWorkLayoutSegment[] {
    const segments: AgentWorkLayoutSegment[] = [];
    let rawBuffer: AgentTurnRecord[] = [];
    const flushRaw = (): void => {
      if (rawBuffer.length === 0) {
        return;
      }
      segments.push({
        kind: segments.some((segment) => segment.kind === 'compressed_work') ? 'dynamic_work' : 'stable_work',
        source: 'raw',
        turnRange: this.turnRange(rawBuffer),
        entryCount: rawBuffer.length,
        note: segments.some((segment) => segment.kind === 'compressed_work')
          ? 'raw work preserved between or after compressed islands'
          : 'raw work preserved before the first compressed island',
      });
      rawBuffer = [];
    };
    for (const entry of entries) {
      if (normalizeWorkEntryTurn(entry)) {
        rawBuffer.push(entry);
        continue;
      }
      flushRaw();
      segments.push({
        kind: 'compressed_work',
        source: entry.kind === 'compaction' ? 'compaction_tag' : 'partial_compaction_tag',
        turnRange: this.parseTurnRange(entry.turns) ?? undefined,
        entryCount: 1,
        note: entry.kind === 'compaction'
          ? 'full work window compressed into one tag'
          : 'partial compressed island inside the current window',
      });
    }
    flushRaw();
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.source !== 'raw') {
        continue;
      }
      const hasCompressedBefore = segments.slice(0, index).some((item) => item.kind === 'compressed_work');
      const hasCompressedAfter = segments.slice(index + 1).some((item) => item.kind === 'compressed_work');
      if (!hasCompressedBefore && !hasCompressedAfter) {
        segments[index] = {
          ...segment,
          kind: 'dynamic_work',
          note: 'all current raw turns remain live',
        };
        continue;
      }
      if (hasCompressedAfter) {
        segments[index] = {
          ...segment,
          kind: 'stable_work',
          note: 'raw work preserved before a later compressed island',
        };
        continue;
      }
      segments[index] = {
        ...segment,
        kind: 'dynamic_work',
        note: 'latest raw tail kept live after previous compressed islands',
      };
    }
    return segments;
  }

  private normalizeRecoveredCurrentWork(
    currentWork: AgentWorkEntry[],
    logTurns: AgentTurnRecord[],
  ): AgentWorkEntry[] {
    if (currentWork.length === 0) {
      return currentWork;
    }

    const lastFullCompactionIndex = currentWork.findLastIndex((entry) => entry.kind === 'compaction');
    const visibleEntries = lastFullCompactionIndex >= 0
      ? currentWork.slice(lastFullCompactionIndex)
      : [...currentWork];

    const normalized: AgentWorkEntry[] = [];
    const seenTagIds = new Set<string>();
    const coveredTurns = new Set<number>();
    let fullCompactionEnd = 0;

    for (const entry of visibleEntries) {
      if (normalizeWorkEntryTurn(entry)) {
        continue;
      }
      if (seenTagIds.has(entry.id)) {
        continue;
      }
      seenTagIds.add(entry.id);
      normalized.push(entry);
      const range = this.parseTurnRange(entry.turns);
      if (!range) {
        continue;
      }
      if (entry.kind === 'compaction') {
        fullCompactionEnd = Math.max(fullCompactionEnd, range.end);
      }
      for (let turn = range.start; turn <= range.end; turn += 1) {
        coveredTurns.add(turn);
      }
    }

    const seenTurnNumbers = new Set<number>();
    for (const entry of visibleEntries) {
      if (!normalizeWorkEntryTurn(entry)) {
        continue;
      }
      const turnNumber = entry.turnNumber ?? 0;
      if (turnNumber <= 0) {
        continue;
      }
      if (turnNumber <= fullCompactionEnd) {
        continue;
      }
      if (coveredTurns.has(turnNumber)) {
        continue;
      }
      if (seenTurnNumbers.has(turnNumber)) {
        continue;
      }
      seenTurnNumbers.add(turnNumber);
      normalized.push(entry);
    }

    if (normalized.length === 0 && logTurns.length > 0) {
      return logTurns.map((turn) => ({
        ...turn,
        kind: 'turn',
      }));
    }

    return normalized.sort((left, right) => {
      const leftStart = normalizeWorkEntryTurn(left)
        ? (left.turnNumber ?? Number.MAX_SAFE_INTEGER)
        : (this.parseTurnRange(left.turns)?.start ?? Number.MAX_SAFE_INTEGER);
      const rightStart = normalizeWorkEntryTurn(right)
        ? (right.turnNumber ?? Number.MAX_SAFE_INTEGER)
        : (this.parseTurnRange(right.turns)?.start ?? Number.MAX_SAFE_INTEGER);
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }
      if (normalizeWorkEntryTurn(left) && !normalizeWorkEntryTurn(right)) {
        return 1;
      }
      if (!normalizeWorkEntryTurn(left) && normalizeWorkEntryTurn(right)) {
        return -1;
      }
      return 0;
    });
  }

  private workEntriesDiffer(left: AgentWorkEntry[], right: AgentWorkEntry[]): boolean {
    if (left.length !== right.length) {
      return true;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
        return true;
      }
    }
    return false;
  }

  private createRecoveryIssue(
    kind: AgentRecoveryIssueRecord['kind'],
    detail: string,
    severity: AgentRecoveryIssueRecord['severity'] = 'warning',
  ): AgentRecoveryIssueRecord {
    return {
      id: `recovery-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      kind,
      severity,
      detail,
      createdAt: nowIso(),
    };
  }

  private approxPersistentTokens(summary: string[], constraints: AgentConstraintRecord[]): number {
    return approxTokens([
      summary.join('\n'),
      constraints.map((entry) => `${entry.key}:${entry.desc}`).join('\n'),
    ].join('\n'));
  }

  private isPersistentBudgetHealthy(summary: string[], constraints: AgentConstraintRecord[]): boolean {
    const snapshot = this.computePersistentBudgetSnapshot(summary, constraints);
    return snapshot.status !== 'hard_limit_reached';
  }

  private buildPersistentBudgetCandidates(
    summary: string[],
    constraints: AgentConstraintRecord[],
  ): PersistentBudgetCandidate[] {
    const beforeApproxTokens = this.approxPersistentTokens(summary, constraints);
    const beforeBudgetSnapshot = this.computePersistentBudgetSnapshot(summary, constraints);
    return [
      this.toPersistentBudgetCandidate('conservative', summary, constraints, beforeApproxTokens, beforeBudgetSnapshot),
      this.toPersistentBudgetCandidate('balanced', summary, constraints, beforeApproxTokens, beforeBudgetSnapshot),
      this.toPersistentBudgetCandidate('aggressive', summary, constraints, beforeApproxTokens, beforeBudgetSnapshot),
    ];
  }

  private buildPersistentRecoveryHeuristicStrategy(
    candidates: PersistentBudgetCandidate[],
  ): PersistentRecoveryStrategy {
    const cleanCandidates = candidates.filter((candidate) => candidate.statusAfterApply === 'clean');
    if (cleanCandidates.length > 0) {
      return cleanCandidates
        .slice()
        .sort((left, right) => (
          right.costDelta.estimatedSavingsPerFutureTurn - left.costDelta.estimatedSavingsPerFutureTurn
          || right.costDelta.estimatedSavingsRatio - left.costDelta.estimatedSavingsRatio
          || (left.strategy === 'conservative' ? -1 : left.strategy === 'balanced' ? 0 : 1)
        ))[0]?.strategy ?? 'conservative';
    }
    return candidates
      .slice()
      .sort((left, right) => (
        right.costDelta.estimatedSavingsPerFutureTurn - left.costDelta.estimatedSavingsPerFutureTurn
        || right.costDelta.estimatedSavingsRatio - left.costDelta.estimatedSavingsRatio
      ))[0]?.strategy ?? 'conservative';
  }

  private resolvePersistentRecoveryDecision(
    heuristicStrategy: PersistentRecoveryStrategy,
    semanticSuggestion?: PersistentRecoverySemanticSuggestion | null,
  ): PersistentRecoveryDecisionSnapshot {
    const semanticRecommendedStrategy = semanticSuggestion?.recommendedStrategy ?? heuristicStrategy;
    if (semanticSuggestion?.provider === 'llm') {
      return {
        heuristicStrategy,
        semanticRecommendedStrategy,
        resolvedStrategy: semanticRecommendedStrategy,
        source: 'semantic',
        rationale: [
          `Semantic persistent recovery analysis recommends ${semanticRecommendedStrategy} as the best slimming strategy.`,
        ],
      };
    }
    return {
      heuristicStrategy,
      semanticRecommendedStrategy,
      resolvedStrategy: heuristicStrategy,
      source: 'heuristic',
      rationale: [
        `Persistent recovery falls back to the heuristic recommendation: ${heuristicStrategy}.`,
      ],
    };
  }

  private async resolvePersistentRecoveryStrategy(
    agentId: string,
    sessionId: string,
  ): Promise<PersistentRecoveryStrategy> {
    const persistentSummary = await this.store.listPersistentSummary(agentId, sessionId);
    const persistentConstraints = await this.store.listPersistentConstraints(agentId, sessionId);
    const candidates = this.buildPersistentBudgetCandidates(persistentSummary, persistentConstraints);
    const heuristicStrategy = this.buildPersistentRecoveryHeuristicStrategy(candidates);
    const semanticSuggestion = await this.analyzePersistentRecoverySemantics(
      persistentSummary,
      persistentConstraints,
      candidates,
      heuristicStrategy,
    );
    return this.resolvePersistentRecoveryDecision(heuristicStrategy, semanticSuggestion).resolvedStrategy;
  }

  private analyzePersistentSummaryValue(value: string, index: number, total: number): {
    score: number;
    reasons: string[];
  } {
    const lowered = value.toLowerCase();
    let score = 0;
    const reasons: string[] = [];
    score += Math.max(0, total - index);
    reasons.push(index >= total - 3 ? 'recent summary' : 'older summary');
    score += Math.min(6, Math.floor(value.length / 120));
    if (value.length > 160) {
      reasons.push('contains richer detail');
    }
    if (HIGH_VALUE_SUMMARY_TERMS.some((term) => lowered.includes(term))) {
      score += 8;
      reasons.push('contains high-value planning or decision signals');
    }
    if (LOW_VALUE_SUMMARY_TERMS.some((term) => lowered.includes(term))) {
      score -= 4;
      reasons.push('looks like low-value filler or confirmation text');
    }
    if (/[`/._-]/.test(value)) {
      score += 3;
      reasons.push('mentions concrete code/path-like tokens');
    }
    return {
      score,
      reasons,
    };
  }

  private scorePersistentSummaryValue(value: string, index: number, total: number): number {
    return this.analyzePersistentSummaryValue(value, index, total).score;
  }

  private isHighValueSummary(value: string, index: number, total: number): boolean {
    return this.scorePersistentSummaryValue(value, index, total) >= 12;
  }

  private analyzeConstraintValue(entry: AgentConstraintRecord, index: number, total: number): {
    score: number;
    reasons: string[];
  } {
    const lowered = `${entry.key} ${entry.desc}`.toLowerCase();
    let score = 10 + Math.max(0, total - index);
    const reasons: string[] = [index >= total - 3 ? 'recent constraint' : 'older constraint'];
    if (entry.priority === 'critical') {
      score += 10;
      reasons.push('marked as critical');
    } else if (entry.priority === 'high') {
      score += 6;
      reasons.push('marked as high priority');
    } else if (entry.priority === 'low') {
      score -= 3;
      reasons.push('marked as low priority');
    }
    if (entry.durability === 'stable') {
      score += 6;
      reasons.push('durable across sessions');
    } else if (entry.durability === 'mutable') {
      score -= 2;
      reasons.push('mutable and should be re-verified');
    }
    if (HIGH_VALUE_CONSTRAINT_TERMS.some((term) => lowered.includes(term))) {
      score += 6;
      reasons.push('captures durable environment or tool behavior');
    }
    if (entry.type === 'protocol' || entry.type === 'env_config') {
      score += 4;
      reasons.push('constraint type is protocol/env_config');
    }
    return {
      score,
      reasons,
    };
  }

  private scoreConstraintValue(entry: AgentConstraintRecord, index: number, total: number): number {
    return this.analyzeConstraintValue(entry, index, total).score;
  }

  private countCriticalConstraints(constraints: AgentConstraintRecord[]): number {
    return constraints.filter((entry) => entry.priority === 'critical').length;
  }

  private countStableConstraints(constraints: AgentConstraintRecord[]): number {
    return constraints.filter((entry) => entry.durability === 'stable').length;
  }

  private toPersistentBudgetCandidate(
    strategy: PersistentRecoveryStrategy,
    summary: string[],
    constraints: AgentConstraintRecord[],
    beforeApproxTokens = this.approxPersistentTokens(summary, constraints),
    beforeBudgetSnapshot = this.computePersistentBudgetSnapshot(summary, constraints),
  ): PersistentBudgetCandidate {
    const { keptSummary, keptConstraints } = this.planPersistentBudgetRecovery(summary, constraints, strategy);
    const afterApproxTokens = this.approxPersistentTokens(keptSummary, keptConstraints);
    const afterBudgetSnapshot = this.computePersistentBudgetSnapshot(keptSummary, keptConstraints);
    const keptSummarySet = new Set(keptSummary);
    const keptConstraintKeySet = new Set(keptConstraints.map((entry) => entry.key));
    const droppedSummary = summary.filter((item) => !keptSummarySet.has(item));
    const droppedConstraints = constraints.filter((entry) => !keptConstraintKeySet.has(entry.key));
    const reasoning = this.describePersistentRecoveryCandidate(
      strategy,
      summary,
      constraints,
      keptSummary,
      keptConstraints,
      droppedSummary,
      droppedConstraints,
    );
    return {
      strategy,
      description: strategy === 'conservative'
        ? 'Keep as many recent summaries and all constraints as possible.'
        : strategy === 'balanced'
          ? 'Trim older summaries more aggressively and allow light constraint pruning.'
          : 'Favor getting back under budget quickly, even if that means keeping only a small recent core.',
      beforeApproxTokens,
      afterApproxTokens,
      budgetApproxTokens: PERSISTENT_MAX_APPROX_TOKENS,
      costDelta: this.buildTokenCostDelta(
        beforeBudgetSnapshot.tokenEconomics.effectivePerTurnCostUnits,
        afterBudgetSnapshot.tokenEconomics.effectivePerTurnCostUnits,
        0,
        [
          'Persistent slimming reduces reusable prefix cost on future turns; the main savings is recurring rather than a one-time rewrite reduction.',
        ],
      ),
      keptHighValueSummaryCount: keptSummary.filter((value, index) => (
        this.isHighValueSummary(value, index, keptSummary.length)
      )).length,
      keptCriticalConstraintCount: this.countCriticalConstraints(keptConstraints),
      keptStableConstraintCount: this.countStableConstraints(keptConstraints),
      currentSummaryCount: summary.length,
      currentConstraintCount: constraints.length,
      keptSummaryCount: keptSummary.length,
      keptConstraintCount: keptConstraints.length,
      droppedSummaryCount: droppedSummary.length,
      droppedConstraintCount: droppedConstraints.length,
      keptSummarySamples: keptSummary
        .slice(-3)
        .map((item) => excerpt(item, 120)),
      droppedSummarySamples: droppedSummary
        .slice(-5)
        .map((item) => excerpt(item, 120)),
      keptConstraintKeys: this.selectRepresentativeConstraintKeys(keptConstraints, 'keep'),
      droppedConstraintKeys: this.selectRepresentativeConstraintKeys(droppedConstraints, 'drop'),
      reasoning,
      statusAfterApply: this.isPersistentBudgetHealthy(keptSummary, keptConstraints) ? 'clean' : 'needs_human',
    };
  }

  private selectRepresentativeConstraintKeys(
    constraints: AgentConstraintRecord[],
    mode: 'keep' | 'drop',
    limit = 6,
  ): string[] {
    return constraints
      .map((entry, index) => ({
        entry,
        index,
        score: this.scoreConstraintValue(entry, index, constraints.length),
      }))
      .sort((left, right) => (
        mode === 'keep'
          ? right.score - left.score || left.index - right.index
          : left.score - right.score || left.index - right.index
      ))
      .slice(0, limit)
      .map((item) => item.entry.key);
  }

  private describePersistentRecoveryCandidate(
    strategy: PersistentRecoveryStrategy,
    summary: string[],
    constraints: AgentConstraintRecord[],
    keptSummary: string[],
    keptConstraints: AgentConstraintRecord[],
    droppedSummary: string[],
    droppedConstraints: AgentConstraintRecord[],
  ): string[] {
    const reasons: string[] = [];
    if (strategy === 'conservative') {
      reasons.push('Prioritize keeping recent summaries and most durable constraints, even if the result may still exceed budget.');
    } else if (strategy === 'balanced') {
      reasons.push('Prefer dropping older or low-signal summaries first, then trim lower-value constraints only if needed.');
    } else {
      reasons.push('Prefer getting under budget quickly, even if only a very small recent core remains.');
    }
    const keptHighValueSummary = keptSummary
      .map((value, index) => ({ value, ...this.analyzePersistentSummaryValue(value, index, keptSummary.length) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 2)
      .map((item) => excerpt(item.value, 100));
    if (keptHighValueSummary.length > 0) {
      reasons.push(`Kept high-value summaries such as: ${keptHighValueSummary.join(' | ')}`);
    }
    if (droppedSummary.length > 0) {
      const sample = droppedSummary
        .map((value, index) => ({ value, ...this.analyzePersistentSummaryValue(value, index, droppedSummary.length) }))
        .sort((left, right) => left.score - right.score)
        .slice(0, 2)
        .map((item) => excerpt(item.value, 100));
      reasons.push(`Dropped lower-value summaries such as: ${sample.join(' | ')}`);
    }
    if (droppedConstraints.length > 0) {
      reasons.push(`Dropped lower-priority constraints: ${droppedConstraints.slice(0, 4).map((entry) => `${entry.key}(${entry.priority ?? 'medium'}/${entry.durability ?? 'session'})`).join(', ')}`);
    } else if (constraints.length > keptConstraints.length) {
      reasons.push('Constraint set was reduced while trying to stay under budget.');
    } else {
      reasons.push('All current constraints were preserved.');
    }
    const protectedConstraints = keptConstraints
      .filter((entry) => entry.priority === 'critical' || entry.durability === 'stable')
      .slice(0, 4)
      .map((entry) => `${entry.key}(${entry.priority ?? 'medium'}/${entry.durability ?? 'session'})`);
    if (protectedConstraints.length > 0) {
      reasons.push(`Protected durable constraints: ${protectedConstraints.join(', ')}`);
    }
    const budgetAfter = this.approxPersistentTokens(keptSummary, keptConstraints);
    reasons.push(
      this.isPersistentBudgetHealthy(keptSummary, keptConstraints)
        ? `This candidate returns persistent context under the current hard limits (total=${budgetAfter}).`
        : `This candidate still violates at least one current hard limit (total=${budgetAfter}) and will require human cleanup.`,
    );
    return reasons;
  }

  private planPersistentBudgetRecovery(
    summary: string[],
    constraints: AgentConstraintRecord[],
    strategy: PersistentRecoveryStrategy = 'conservative',
  ): {
    keptSummary: string[];
    keptConstraints: AgentConstraintRecord[];
  } {
    const minSummary = strategy === 'aggressive' ? 1 : strategy === 'balanced' ? 2 : 3;
    const minConstraints = strategy === 'aggressive' ? 1 : strategy === 'balanced' ? 2 : Math.min(constraints.length, 6);
    const scoredSummary = summary.map((value, index) => ({
      value,
      index,
      score: this.scorePersistentSummaryValue(value, index, summary.length),
    }));
    const scoredConstraints = constraints.map((entry, index) => ({
      entry,
      index,
      score: this.scoreConstraintValue(entry, index, constraints.length),
    }));
    const protectedConstraintIndices = new Set(
      scoredConstraints
        .filter((item) => (
          item.entry.priority === 'critical'
          || (item.entry.durability === 'stable' && item.entry.priority === 'high')
        ))
        .map((item) => item.index),
    );
    const summaryOrder = strategy === 'conservative'
      ? [...scoredSummary].sort((left, right) => left.index - right.index)
      : [...scoredSummary].sort((left, right) => left.score - right.score || left.index - right.index);
    const constraintOrder = [...scoredConstraints].sort((left, right) => (
      left.score - right.score
        || Number(protectedConstraintIndices.has(left.index)) - Number(protectedConstraintIndices.has(right.index))
        || left.index - right.index
    ));

    const droppedSummary = new Set<number>();
    const droppedConstraints = new Set<number>();
    let keptSummary = [...summary];
    let keptConstraints = [...constraints];

    for (const item of summaryOrder) {
      if (keptSummary.length <= minSummary || this.isPersistentBudgetHealthy(keptSummary, keptConstraints)) {
        break;
      }
      if (droppedSummary.has(item.index)) {
        continue;
      }
      droppedSummary.add(item.index);
      keptSummary = summary.filter((_, index) => !droppedSummary.has(index));
    }

    for (const item of constraintOrder) {
      if (keptConstraints.length <= minConstraints || this.isPersistentBudgetHealthy(keptSummary, keptConstraints)) {
        break;
      }
      const remainingDroppable = constraintOrder.some((candidate) => (
        !droppedConstraints.has(candidate.index) && !protectedConstraintIndices.has(candidate.index)
      ));
      if (protectedConstraintIndices.has(item.index) && remainingDroppable) {
        continue;
      }
      if (droppedConstraints.has(item.index)) {
        continue;
      }
      droppedConstraints.add(item.index);
      keptConstraints = constraints.filter((_, index) => !droppedConstraints.has(index));
    }

    if (strategy === 'aggressive') {
      for (const item of summaryOrder) {
        if (keptSummary.length <= 1 || this.isPersistentBudgetHealthy(keptSummary, keptConstraints)) {
          break;
        }
        if (droppedSummary.has(item.index)) {
          continue;
        }
        droppedSummary.add(item.index);
        keptSummary = summary.filter((_, index) => !droppedSummary.has(index));
      }
    }

    return {
      keptSummary,
      keptConstraints,
    };
  }

  private planFinalizeMemoryPromotion(
    memorySummaryBefore: string[],
    memoryConstraintsBefore: AgentConstraintRecord[],
    persistentSummary: string[],
    persistentConstraints: AgentConstraintRecord[],
    carryOverSummary: string | undefined,
    promotePersistentToMemory: boolean,
    strategy: FinalizeMemoryStrategy,
  ): {
    promotedSummary: string[];
    promotedConstraints: AgentConstraintRecord[];
    memorySummaryAfter: string[];
    memoryConstraintsAfter: AgentConstraintRecord[];
    rationale: string[];
  } {
    const carry = carryOverSummary?.trim();
    if (!promotePersistentToMemory) {
      const promotedSummary = carry ? [carry] : [];
      const memorySummaryAfter = [...memorySummaryBefore, ...promotedSummary].slice(-48);
      return {
        promotedSummary,
        promotedConstraints: [],
        memorySummaryAfter,
        memoryConstraintsAfter: memoryConstraintsBefore,
        rationale: [
          carry
            ? 'Persistent state promotion is disabled, so only the human carry-over summary would enter memory.'
            : 'Persistent state promotion is disabled and there is no carry-over summary, so memory would remain unchanged.',
        ],
      };
    }

    const summaryCandidates = [
      ...persistentSummary,
      ...(carry ? [carry] : []),
    ];
    const scoredSummary = summaryCandidates.map((value, index) => ({
      value,
      index,
      score: this.scorePersistentSummaryValue(value, index, summaryCandidates.length)
        + (carry && value === carry ? 8 : 0),
    }));
    const mergedPersistentConstraints = this.semanticMergeConstraintFamilies(persistentConstraints, 'memory');
    const scoredConstraints = mergedPersistentConstraints.map((entry, index) => ({
      entry,
      index,
      score: this.scoreConstraintValue(entry, index, mergedPersistentConstraints.length),
    }));

    const promotedSummaryLimit = strategy === 'aggressive' ? 3 : strategy === 'balanced' ? 8 : summaryCandidates.length;
    const promotedConstraintLimit = strategy === 'aggressive' ? 8 : strategy === 'balanced' ? 16 : mergedPersistentConstraints.length;

    const promotedSummary = [...scoredSummary]
      .sort((left, right) => right.score - left.score || right.index - left.index)
      .slice(0, promotedSummaryLimit)
      .sort((left, right) => left.index - right.index)
      .map((item) => item.value);

    const protectedConstraints = scoredConstraints.filter((item) => (
      item.entry.priority === 'critical'
        || (item.entry.durability === 'stable' && item.entry.priority === 'high')
    ));
    const remainingConstraints = scoredConstraints.filter((item) => !protectedConstraints.includes(item));
    const promotedConstraints = [
      ...protectedConstraints.map((item) => item.entry),
      ...remainingConstraints
        .sort((left, right) => right.score - left.score || right.index - left.index)
        .slice(0, Math.max(0, promotedConstraintLimit - protectedConstraints.length))
        .map((item) => item.entry),
    ];

    const memorySummaryAfter = [...memorySummaryBefore, ...promotedSummary].slice(-48);
    const memoryConstraintsAfter = dedupeConstraints([
      ...memoryConstraintsBefore,
      ...promotedConstraints,
    ]);
    const rationale = [
      strategy === 'conservative'
        ? 'Conservative finalize keeps nearly all current persistent state in cross-session memory.'
        : strategy === 'balanced'
          ? 'Balanced finalize keeps the most valuable summaries and constraints while avoiding low-signal carry-over.'
          : 'Aggressive finalize keeps only a compact high-value memory core from this session.',
      carry
        ? 'The human carry-over summary is treated as high-priority input for memory promotion.'
        : 'No human carry-over summary is provided for this finalize candidate.',
      `This candidate would promote ${promotedSummary.length} summary item(s) and ${promotedConstraints.length} constraint(s) into memory.`,
    ];
    return {
      promotedSummary,
      promotedConstraints: dedupeConstraints(promotedConstraints),
      memorySummaryAfter,
      memoryConstraintsAfter,
      rationale,
    };
  }

  private indexRunsById(runs: AgentRunRecord[]): Map<string, { toolCalls: number; success: boolean }> {
    const out = new Map<string, { toolCalls: number; success: boolean }>();
    for (const run of runs) {
      out.set(run.id, {
        toolCalls: run.events.filter((event) => event.type === 'tool-call').length,
        success: run.status === 'completed',
      });
    }
    return out;
  }

  private findStableBoundaryTurn(
    turns: AgentTurnRecord[],
    runMeta: Map<string, { toolCalls: number; success: boolean }>,
  ): number | undefined {
    const candidates = this.rankStableBoundaryCandidates(turns, runMeta)
      .filter((item) => item.score >= 7);
    candidates.sort((left, right) => right.score - left.score || right.index - left.index);
    return candidates[0]?.turn.turnNumber;
  }

  private isStableMilestoneTurn(
    turn: AgentTurnRecord,
    meta?: { toolCalls: number; success: boolean },
  ): boolean {
    return this.scoreStableMilestoneTurn(turn, meta, 0, 1) >= 7;
  }

  private scoreStableMilestoneTurn(
    turn: AgentTurnRecord,
    meta: { toolCalls: number; success: boolean } | undefined,
    index: number,
    total: number,
  ): number {
    return this.analyzeStableMilestoneTurn(turn, meta, index, total).score;
  }

  private analyzeStableMilestoneTurn(
    turn: AgentTurnRecord,
    meta: { toolCalls: number; success: boolean } | undefined,
    index: number,
    total: number,
  ): {
    score: number;
    signals: string[];
  } {
    const lowered = turn.content.toLowerCase();
    let score = 0;
    const signals: string[] = [];
    if (containsAnySemanticTerm(lowered, UNSETTLED_SIGNAL_TERMS)) {
      score -= 8;
      signals.push('contains unresolved or uncertain language');
    }
    if (/[?？]\s*$/.test(turn.content.trim())) {
      score -= 6;
      signals.push('ends with a question');
    }
    if (containsAnySemanticTerm(lowered, STABLE_SIGNAL_TERMS)) {
      score += 8;
      signals.push('contains decision or checkpoint language');
    }
    if ((meta?.toolCalls ?? 0) > 0 && meta?.success && lowered.length > 40) {
      score += 4;
      signals.push('follows successful tool use with enough detail');
    }
    if (/[`/._-]/.test(turn.content)) {
      score += 2;
      signals.push('mentions concrete code or path-like tokens');
    }
    if (turn.content.length > 80) {
      score += 2;
      signals.push('contains a longer explanation');
    }
    score += Math.floor((index / Math.max(1, total)) * 3);
    if (index >= Math.max(0, total - 3)) {
      signals.push('appears near the latest raw suffix boundary');
    }
    return {
      score,
      signals,
    };
  }

  private estimateCompressionRatio(turns: AgentTurnRecord[]): number {
    if (turns.length === 0) {
      return 1;
    }
    const weights = turns.map((turn) => {
      const lowered = turn.content.toLowerCase();
      if (/(error|retry|failed|fix|失败|重试|修复)/.test(lowered)) {
        return 0.4;
      }
      if (/[`][^`]+[`]|(?:\/[A-Za-z0-9._-]+){1,}|[A-Za-z0-9._-]+\.(ts|tsx|js|json|md|toml|yaml|yml)\b/.test(turn.content)) {
        return 0.15;
      }
      if ((turn.runId && turn.role === 'assistant') || /(tool|read|write|list|grep|glob|搜索|读取|写入|目录|文件)/.test(lowered)) {
        return 0.12;
      }
      if (turn.role === 'user') {
        return 0.3;
      }
      return 0.4;
    });
    const average = weights.reduce((sum, item) => sum + item, 0) / weights.length;
    return Math.max(0.05, Math.min(0.95, Number(average.toFixed(3))));
  }

  private resolveCompactionDecision(
    workLayout: AgentWorkLayout,
    workBudget: AgentWorkBudgetSnapshot,
    partialPlan: ReturnType<AgentServerService['planPartialCompaction']>,
    semanticSuggestion: CompactSemanticSuggestion | null | undefined,
    budgetRecommendedMode: CompactDecisionSnapshot['budgetRecommendedMode'],
  ): CompactDecisionSnapshot {
    const semanticOpportunityMode: CompactDecisionSnapshot['semanticOpportunityMode'] = (
      workLayout.safetyPointReached && partialPlan ? 'partial' : 'none'
    );
    const semanticRecommendedMode = semanticSuggestion?.recommendedMode ?? 'none';
    if (workBudget.status === 'hard_threshold_reached') {
      return {
        budgetRecommendedMode,
        semanticOpportunityMode,
        semanticRecommendedMode,
        resolvedMode: 'full',
        source: 'hard_threshold',
        selectedStableBoundaryTurn: semanticSuggestion?.suggestedStableBoundaryTurn ?? partialPlan?.stableBoundaryTurn,
        selectedBoundarySource: semanticSuggestion?.boundarySource ?? (partialPlan?.stableBoundaryTurn ? 'heuristic_candidate' : 'none'),
        rationale: [
          'The hard threshold is reached, so the safest recommendation is full compaction.',
        ],
      };
    }
    if (semanticRecommendedMode === 'partial' && semanticOpportunityMode === 'partial') {
      return {
        budgetRecommendedMode,
        semanticOpportunityMode,
        semanticRecommendedMode,
        resolvedMode: 'partial',
        source: 'semantic',
        selectedStableBoundaryTurn: semanticSuggestion?.suggestedStableBoundaryTurn ?? partialPlan?.stableBoundaryTurn,
        selectedBoundarySource: semanticSuggestion?.boundarySource ?? 'heuristic_candidate',
        rationale: [
          'A safety point exists and semantic boundary analysis identified a compressible dynamic_work island, so partial compaction is recommended.',
        ],
      };
    }
    if (budgetRecommendedMode === 'partial') {
      return {
        budgetRecommendedMode,
        semanticOpportunityMode,
        semanticRecommendedMode,
        resolvedMode: 'partial',
        source: 'budget',
        selectedStableBoundaryTurn: partialPlan?.stableBoundaryTurn,
        selectedBoundarySource: partialPlan?.stableBoundaryTurn ? 'heuristic_candidate' : 'none',
        rationale: [
          'Budget pressure is no longer trivial and a partial compaction candidate exists, so partial compaction is recommended.',
        ],
      };
    }
    return {
      budgetRecommendedMode,
      semanticOpportunityMode,
      semanticRecommendedMode,
      resolvedMode: 'none',
      source: 'none',
      selectedStableBoundaryTurn: semanticSuggestion?.suggestedStableBoundaryTurn ?? partialPlan?.stableBoundaryTurn,
      selectedBoundarySource: semanticSuggestion?.boundarySource ?? (partialPlan?.stableBoundaryTurn ? 'heuristic_candidate' : 'none'),
      rationale: [
        'Current work can stay live for now; use compaction preview to monitor when the recommendation changes.',
      ],
    };
  }

  private async analyzeFinalizeSemantics(
    memoryBudgetBefore: AgentMemoryBudgetSnapshot,
    candidates: FinalizeSessionCandidate[],
    carryOverSummary: string | undefined,
    promotePersistentToMemory: boolean,
    heuristicStrategy: FinalizeMemoryStrategy,
  ): Promise<FinalizeSemanticSuggestion> {
    const fallback = (): FinalizeSemanticSuggestion => ({
      available: true,
      provider: 'heuristic',
      recommendedStrategy: heuristicStrategy,
      confidence: 'medium',
      rationale: [
        'semantic finalize analysis fell back to the current heuristic strategy',
        ...memoryBudgetBefore.rationale,
      ],
    });

    try {
      const config = loadOpenTeamConfig();
      const baseUrl = String(config.llm.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(config.llm.model || '').trim();
      if (!baseUrl || !model) {
        return {
          ...fallback(),
          available: false,
          provider: 'unavailable',
          rationale: ['LLM config is missing baseUrl or model, so semantic finalize analysis is unavailable'],
        };
      }
      const prompt = [
        'You are a session-finalize memory promotion analyst for a long-running agent.',
        'Choose the best finalize strategy for promoting this session into cross-session memory.',
        'Return JSON only.',
        'Output schema example: {"recommendedStrategy":"balanced","confidence":"medium","rationale":["reason 1","reason 2"]}',
        'recommendedStrategy must be one of: conservative, balanced, aggressive.',
        'confidence must be one of: low, medium, high.',
        'Always include at least two short rationale strings.',
        'Prefer strategies that preserve the highest-value cross-session memory, avoid creating the next budget bottleneck, and minimize long-run effective token cost.',
        '',
        `promote_persistent_to_memory=${promotePersistentToMemory ? 'yes' : 'no'}`,
        `heuristic_strategy=${heuristicStrategy}`,
        `carry_over_summary=${carryOverSummary?.trim() ? excerpt(carryOverSummary.trim(), 180) : 'none'}`,
        `memory_budget_before=status:${memoryBudgetBefore.status} total:${memoryBudgetBefore.approxTotalTokens} summary:${memoryBudgetBefore.approxSummaryTokens} constraints:${memoryBudgetBefore.approxConstraintTokens} effective:${memoryBudgetBefore.tokenEconomics.effectivePerTurnCostUnits}`,
        '',
        'Candidates:',
        ...candidates.map((candidate) => (
          [
            `- strategy=${candidate.strategy}`,
            `  memory_after=${candidate.memoryBudgetAfter.status} total=${candidate.memoryBudgetAfter.approxTotalTokens}`,
            `  next_session_seed=${candidate.nextSessionSeedBudget.status} total=${candidate.nextSessionSeedBudget.approxTotalTokens}`,
            `  memory_after_effective=${candidate.memoryBudgetAfter.tokenEconomics.effectivePerTurnCostUnits}`,
            `  next_session_seed_effective=${candidate.nextSessionSeedBudget.tokenEconomics.effectivePerTurnCostUnits}`,
            `  cost_delta=savings_per_turn:${candidate.costDelta.estimatedSavingsPerFutureTurn} ratio:${candidate.costDelta.estimatedSavingsRatio} rewrite:${candidate.costDelta.oneTimeRewriteCostUnits} break_even:${candidate.costDelta.estimatedBreakEvenTurns ?? 'n/a'}`,
            `  value_metrics=high_value_summary:${candidate.promotedHighValueSummaryCount} critical_constraints:${candidate.promotedCriticalConstraintCount} stable_constraints:${candidate.promotedStableConstraintCount}`,
            `  promoted_summary_count=${candidate.promotedSummaryCount}`,
            `  promoted_constraint_count=${candidate.promotedConstraintCount}`,
            `  summary_samples=${candidate.promotedSummarySamples.join(' | ') || 'none'}`,
            `  constraint_keys=${candidate.promotedConstraintKeys.join(', ') || 'none'}`,
            `  next_session_seed_summary_samples=${candidate.nextSessionSeedSummarySamples.join(' | ') || 'none'}`,
            `  next_session_seed_constraint_keys=${candidate.nextSessionSeedConstraintKeys.join(', ') || 'none'}`,
            `  rationale=${candidate.rationale.join(' | ')}`,
          ].join('\n')
        )),
      ].join('\n');

      const parsed = await this.requestSemanticJson<{
        recommendedStrategy?: FinalizeMemoryStrategy;
        confidence?: FinalizeSemanticSuggestion['confidence'];
        rationale?: string[];
      }>(prompt);
      if (!parsed) {
        return fallback();
      }
      const recommendedStrategy = parsed.recommendedStrategy === 'conservative'
        || parsed.recommendedStrategy === 'balanced'
        || parsed.recommendedStrategy === 'aggressive'
        ? parsed.recommendedStrategy
        : heuristicStrategy;
      if (
        recommendedStrategy === heuristicStrategy
        && (!Array.isArray(parsed.rationale) || parsed.rationale.length === 0)
      ) {
        return fallback();
      }
      return {
        available: true,
        provider: 'llm',
        recommendedStrategy,
        confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : 'medium',
        rationale: Array.isArray(parsed.rationale) && parsed.rationale.length > 0
          ? parsed.rationale.map((item) => String(item))
          : fallback().rationale,
      };
    } catch {
      return fallback();
    }
  }

  private extractFirstJsonObject(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() || trimmed;
    const start = candidate.indexOf('{');
    if (start < 0) {
      return null;
    }
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let index = start; index < candidate.length; index += 1) {
      const char = candidate[index];
      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === '\\') {
          escaping = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') {
        depth += 1;
        continue;
      }
      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          return candidate.slice(start, index + 1);
        }
      }
    }
    return null;
  }

  private async requestSemanticJson<T>(prompt: string): Promise<T | null> {
    const endpoints = listConfiguredLlmEndpoints(loadOpenTeamConfig())
      .map((endpoint) => ({
        baseUrl: String(endpoint.baseUrl || '').trim().replace(/\/$/, ''),
        apiKey: String(endpoint.apiKey || '').trim() || 'EMPTY',
        model: String(endpoint.model || '').trim(),
      }))
      .filter((endpoint) => endpoint.baseUrl && endpoint.model);
    if (endpoints.length === 0) {
      return null;
    }
    for (const endpointConfig of endpoints) {
      const endpoint = endpointConfig.baseUrl.endsWith('/chat/completions')
        ? endpointConfig.baseUrl
        : `${endpointConfig.baseUrl}/chat/completions`;
      const commonBody = {
        model: endpointConfig.model,
        temperature: 0,
        messages: [{ role: 'user' as const, content: prompt }],
      };
      const attempts: Array<Record<string, unknown>> = [
        {
          ...commonBody,
          response_format: { type: 'json_object' },
        },
        commonBody,
      ];
      for (const body of attempts) {
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${endpointConfig.apiKey}`,
            },
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            continue;
          }
          const payload = await response.json() as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const content = payload.choices?.[0]?.message?.content?.trim() || '';
          const jsonBlock = this.extractFirstJsonObject(content);
          if (!jsonBlock) {
            continue;
          }
          return JSON.parse(jsonBlock) as T;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  private normalizeSemanticBoundaryTurn(
    rawBoundaryTurn: unknown,
    candidateTurns: Array<{ turnNumber: number }>,
  ): number | undefined {
    const numeric = typeof rawBoundaryTurn === 'string'
      ? Number.parseInt(rawBoundaryTurn.replace(/[^\d]/g, ''), 10)
      : Number(rawBoundaryTurn);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return candidateTurns.find((item) => item.turnNumber === numeric)?.turnNumber;
  }

  private async analyzeCompactionSemantics(
    workLayout: AgentWorkLayout,
    workBudget: AgentWorkBudgetSnapshot,
    currentWork: AgentWorkEntry[],
    partialPlan: ReturnType<AgentServerService['planPartialCompaction']>,
    heuristicRecommendedMode: CompactSemanticSuggestion['recommendedMode'],
    partialCostDelta?: AgentTokenCostDelta,
    fullCostDelta?: AgentTokenCostDelta,
  ): Promise<CompactSemanticSuggestion> {
    const turns = currentWork.filter(normalizeWorkEntryTurn).slice(-16);
    if (turns.length === 0) {
      return {
        available: false,
        provider: 'heuristic',
        recommendedMode: 'none',
        boundarySource: 'none',
        confidence: 'low',
        rationale: ['current work is empty, so there is nothing meaningful to analyze'],
      };
    }
    const candidateTurns = partialPlan?.boundaryCandidates ?? [];
    const semanticOpportunityMode: CompactSemanticSuggestion['recommendedMode'] = (
      workLayout.safetyPointReached && candidateTurns.length > 0
        ? 'partial'
        : heuristicRecommendedMode
    );
    const fallback = (): CompactSemanticSuggestion => ({
      available: true,
      provider: 'heuristic',
      recommendedMode: heuristicRecommendedMode,
      suggestedStableBoundaryTurn: partialPlan?.stableBoundaryTurn,
      boundarySource: partialPlan?.stableBoundaryTurn ? 'heuristic_candidate' : 'none',
      candidateTurns,
      compressibleTurnRange: partialPlan?.previewTurnRange,
      confidence: heuristicRecommendedMode === 'none' ? 'low' : 'medium',
      rationale: [
        'semantic boundary analysis fell back to the current heuristic planner',
        ...workLayout.rationale,
        ...workBudget.rationale,
      ],
    });

    try {
      const config = loadOpenTeamConfig();
      const baseUrl = String(config.llm.baseUrl || '').trim().replace(/\/$/, '');
      const model = String(config.llm.model || '').trim();
      if (!baseUrl || !model) {
        return {
          ...fallback(),
          available: false,
          provider: 'unavailable',
          boundarySource: 'none',
          rationale: ['LLM config is missing baseUrl or model, so semantic boundary analysis is unavailable'],
        };
      }
      const prompt = [
        'You are a compaction boundary analyst for a long-running agent context window.',
        'Decide whether the current work should stay live, use partial compaction, or use full compaction.',
        'IMPORTANT: This is not only a token-budget problem. If the agent is at a safety point and there is a clear dynamic_work island, partial compaction can still be the right answer even when work_ratio is low.',
        'Treat work_ratio as one signal, but not as the sole decision rule.',
        'Prefer partial compaction when it preserves stable/raw islands and meaningfully lowers future uncached token cost.',
        'If partial_available=yes and the candidate boundary signals show a clear checkpoint/decision boundary, partial can still be the best semantic choice even when savings look modest.',
        'Repeated verification or inspection rounds can still form a coherent dynamic_work island when they are anchored by explicit checkpoint, milestone, decision, or stage-conclusion language.',
        'Do not dismiss a candidate only because the turns look repetitive if the boundary signals clearly mark a completed checkpoint and the newest raw tail still remains live.',
        'Prefer full compaction when hard-threshold pressure dominates or when local partial compression is not semantically coherent.',
        'If partial compaction is appropriate, select one stable boundary turn from the allowed candidate list.',
        'If no candidate should be chosen, use null for suggestedStableBoundaryTurn.',
        'Return JSON only.',
        'Output schema example: {"recommendedMode":"partial","suggestedStableBoundaryTurn":12,"confidence":"medium","rationale":["reason 1","reason 2"]}',
        'recommendedMode must be one of: none, partial, full.',
        'confidence must be one of: low, medium, high.',
        'suggestedStableBoundaryTurn must be one of the allowed candidate turn numbers or null.',
        'Always include at least two short rationale strings.',
        '',
        `work_layout_strategy=${workLayout.strategy}`,
        `safety_point=${workLayout.safetyPointReached ? `yes@turn_${workLayout.safetyPointTurn ?? '?'}` : 'no'}`,
        `budget_recommended_mode=${heuristicRecommendedMode}`,
        `semantic_opportunity_mode=${semanticOpportunityMode}`,
        `work_ratio=${workBudget.workRatio.toFixed(3)} soft=${workBudget.softThreshold} hard=${workBudget.hardThreshold} status=${workBudget.status}`,
        `work_budget_effective=prefix:${workBudget.tokenEconomics.approxCacheEligibleTokens} uncached:${workBudget.tokenEconomics.approxUncachedTokens} effective:${workBudget.tokenEconomics.effectivePerTurnCostUnits}`,
        `heuristic_partial_boundary=${partialPlan?.stableBoundaryTurn ? `turn_${partialPlan.stableBoundaryTurn}` : 'none'}`,
        `heuristic_partial_turns=${partialPlan?.previewTurnRange ?? 'none'}`,
        `partial_available=${partialPlan ? 'yes' : 'no'}`,
        `partial_candidate_count=${candidateTurns.length}`,
        `dynamic_tail_turns=${partialPlan?.dynamicTailTurns ?? 'none'}`,
        `compressible_turn_count=${partialPlan?.compressibleEntries.filter(normalizeWorkEntryTurn).length ?? 0}`,
        `semantic_opportunity_score=${this.estimatePartialSemanticOpportunity(partialPlan).score}`,
        `partial_plan_rationale=${partialPlan?.rationale.join(' | ') || 'none'}`,
        `partial_cost_delta=${partialCostDelta
          ? `savings_per_turn:${partialCostDelta.estimatedSavingsPerFutureTurn} ratio:${partialCostDelta.estimatedSavingsRatio} rewrite:${partialCostDelta.oneTimeRewriteCostUnits} break_even:${partialCostDelta.estimatedBreakEvenTurns ?? 'n/a'}`
          : 'none'}`,
        `full_cost_delta=${fullCostDelta
          ? `savings_per_turn:${fullCostDelta.estimatedSavingsPerFutureTurn} ratio:${fullCostDelta.estimatedSavingsRatio} rewrite:${fullCostDelta.oneTimeRewriteCostUnits} break_even:${fullCostDelta.estimatedBreakEvenTurns ?? 'n/a'}`
          : 'none'}`,
        '',
        'Allowed stable boundary candidates:',
        ...(candidateTurns.length > 0
          ? candidateTurns.map((candidate) => (
            `- turn_${candidate.turnNumber} score=${candidate.score} signals=${candidate.signals.join('; ') || 'none'} excerpt=${candidate.excerpt}`
          ))
          : ['- none']),
        '',
        `top_boundary_candidate=${candidateTurns[0]
          ? `turn_${candidateTurns[0].turnNumber} score=${candidateTurns[0].score} signals=${candidateTurns[0].signals.join('; ') || 'none'}`
          : 'none'}`,
        '',
        'Recent raw turns:',
        ...turns.map((turn) => `turn_${turn.turnNumber ?? '?'} [${turn.role}] ${excerpt(turn.content, 220)}`),
      ].join('\n');

      const parsed = await this.requestSemanticJson<{
        recommendedMode?: CompactSemanticSuggestion['recommendedMode'];
        suggestedStableBoundaryTurn?: number;
        confidence?: CompactSemanticSuggestion['confidence'];
        rationale?: string[];
      }>(prompt);
      if (!parsed) {
        return fallback();
      }
      const recommendedMode = parsed.recommendedMode === 'partial' || parsed.recommendedMode === 'full' || parsed.recommendedMode === 'none'
        ? parsed.recommendedMode
        : heuristicRecommendedMode;
      const suggestedStableBoundaryTurn = this.normalizeSemanticBoundaryTurn(
        parsed.suggestedStableBoundaryTurn,
        candidateTurns,
      ) ?? partialPlan?.stableBoundaryTurn;
      const hasSemanticBoundary = recommendedMode === 'partial' && Number.isFinite(suggestedStableBoundaryTurn);
      const rationale = Array.isArray(parsed.rationale) && parsed.rationale.length > 0
        ? parsed.rationale.map((item) => String(item))
        : fallback().rationale;
      if (
        recommendedMode === heuristicRecommendedMode
        && suggestedStableBoundaryTurn === partialPlan?.stableBoundaryTurn
        && (!Array.isArray(parsed.rationale) || parsed.rationale.length === 0)
      ) {
        return fallback();
      }
      return {
        available: true,
        provider: 'llm',
        recommendedMode,
        suggestedStableBoundaryTurn,
        boundarySource: hasSemanticBoundary ? 'llm_candidate' : suggestedStableBoundaryTurn ? 'heuristic_candidate' : 'none',
        candidateTurns,
        compressibleTurnRange: partialPlan?.previewTurnRange,
        confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
          ? parsed.confidence
          : 'medium',
        rationale,
      };
    } catch {
      return fallback();
    }
  }

  private rankStableBoundaryCandidates(
    turns: AgentTurnRecord[],
    runMeta: Map<string, { toolCalls: number; success: boolean }>,
  ): Array<{
    turn: AgentTurnRecord;
    index: number;
    score: number;
    signals: string[];
  }> {
    return turns
      .filter((turn) => turn.role === 'assistant')
      .map((turn, index) => {
        const analysis = this.analyzeStableMilestoneTurn(turn, runMeta.get(turn.runId || ''), index, turns.length);
        return {
          turn,
          index,
          score: analysis.score,
          signals: analysis.signals,
        };
      });
  }

  private turnRange(entries: AgentTurnRecord[]): { start: number; end: number } | undefined {
    const numbers = entries
      .map((entry) => entry.turnNumber)
      .filter((value): value is number => Number.isFinite(value));
    if (numbers.length === 0) {
      return undefined;
    }
    return {
      start: Math.min(...numbers),
      end: Math.max(...numbers),
    };
  }

  private async seedSessionPersistentFromMemory(agentId: string, sessionId: string): Promise<void> {
    const memorySummary = await this.store.listMemorySummary(agentId);
    const memoryConstraints = this.semanticMergeConstraintFamilies(
      await this.store.listMemoryConstraints(agentId),
      'session',
    );
    if (memorySummary.length > 0) {
      await this.store.replacePersistentSummary(agentId, sessionId, memorySummary.slice(-24));
    }
    if (memoryConstraints.length > 0) {
      await this.store.replacePersistentConstraints(agentId, sessionId, memoryConstraints);
    }
  }

  private async promoteSessionPersistentToMemory(
    agentId: string,
    sessionId: string,
    carryOverSummary?: string,
    strategy: FinalizeMemoryStrategy = 'conservative',
  ): Promise<void> {
    const memorySummaryBefore = await this.store.listMemorySummary(agentId);
    const memoryConstraintsBefore = await this.store.listMemoryConstraints(agentId);
    const persistentSummary = await this.store.listPersistentSummary(agentId, sessionId);
    const persistentConstraints = await this.store.listPersistentConstraints(agentId, sessionId);
    const plan = this.planFinalizeMemoryPromotion(
      memorySummaryBefore,
      memoryConstraintsBefore,
      persistentSummary,
      persistentConstraints,
      carryOverSummary,
      true,
      strategy,
    );
    await this.store.replaceMemorySummary(agentId, plan.memorySummaryAfter);
    await this.store.replaceMemoryConstraints(agentId, plan.memoryConstraintsAfter);
  }

  private async recoverAllAgents(): Promise<void> {
    const agents = await this.store.listAgents();
    for (const agent of agents) {
      await this.recoverAgentEnvelope(agent);
    }
  }

  private async recoverAgentEnvelope(agent: AgentManifest): Promise<void> {
    const sessions = await this.store.listSessions(agent.id);
    let activeSession = sessions.find((session) => session.id === agent.activeSessionId && session.status === 'active') ?? null;
    const recoveryIssues: AgentRecoveryIssueRecord[] = [];

    if (!activeSession) {
      const fallback = sessions
        .filter((session) => session.status === 'active')
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
      if (fallback) {
        agent.activeSessionId = fallback.id;
        agent.updatedAt = nowIso();
        await this.store.saveAgent(agent);
        activeSession = fallback;
        recoveryIssues.push(this.createRecoveryIssue(
          'active_session_pointer_recovered',
          `agent.activeSessionId was missing or stale; reassigned it to existing active session ${fallback.id}`,
          'warning',
        ));
      } else {
        const recreated = this.store.createSessionRecord(agent.id);
        await this.store.saveSession(recreated);
        await this.seedSessionPersistentFromMemory(agent.id, recreated.id);
        agent.activeSessionId = recreated.id;
        agent.updatedAt = nowIso();
        await this.store.saveAgent(agent);
        activeSession = recreated;
        recoveryIssues.push(this.createRecoveryIssue(
          'active_session_recreated',
          'agent.activeSessionId did not point to any active session, so a new active session was created and seeded from memory',
          'warning',
        ));
      }
    }

    if (recoveryIssues.length > 0) {
      await this.store.replaceSessionRecoveryIssues(agent.id, activeSession.id, recoveryIssues, 'recovered');
    }
    await this.recoverAgentState(agent, activeSession.id);
  }

  private async recoverAgentState(agentOrId: AgentManifest | string, sessionId: string): Promise<void> {
    const agent = typeof agentOrId === 'string'
      ? await this.store.getAgent(agentOrId)
      : agentOrId;
    if (!agent) {
      throw new Error(`Agent not found during recovery: ${typeof agentOrId === 'string' ? agentOrId : agentOrId.id}`);
    }
    const agentId = agent.id;
    const currentWork = await this.store.listCurrentWork(agentId, sessionId);
    const session = await this.store.getSession(agentId, sessionId);
    const recoveryIssues: AgentRecoveryIssueRecord[] = [];
    const recoveryIntent = await this.store.getRecoveryIntent(agentId, sessionId);
    if (session) {
      const recoveredNextTurn = await this.store.getNextTurnNumber(agentId, sessionId);
      if ((session.nextTurnNumber ?? 1) !== recoveredNextTurn) {
        session.nextTurnNumber = recoveredNextTurn;
        session.updatedAt = nowIso();
        await this.store.saveSession(session);
      }
    }
    const logTurns = currentWork.length === 0
      ? await this.store.listTurns(agentId, sessionId)
      : [];
    if (currentWork.length === 0 && logTurns.length > 0) {
      await this.store.saveCurrentWork(agentId, sessionId, logTurns.map((turn) => ({
        ...turn,
        kind: 'turn',
      })));
      recoveryIssues.push(this.createRecoveryIssue(
        'current_work_rebuilt_from_log',
        'current.jsonl was empty while turn log still existed, so current work was rebuilt from work/log/turns.jsonl',
        'warning',
      ));
      if (recoveryIntent) {
        recoveryIssues.push(this.createRecoveryIssue(
          'compaction_intent_recovered',
          `found unfinished ${recoveryIntent.mode} compaction intent targeting ${recoveryIntent.targetTurns ?? 'unknown turns'}; rebuilt current work from the turn log instead`,
          'warning',
        ));
        await this.store.clearRecoveryIntent(agentId, sessionId);
      }
      if (recoveryIssues.length > 0) {
        await this.store.replaceSessionRecoveryIssues(agentId, sessionId, recoveryIssues, 'recovered');
      }
      return;
    }

    if (currentWork.length === 0 && logTurns.length === 0) {
      const runs = await this.store.listRuns(agentId, sessionId);
      const appearsCorrupted = runs.length > 0 || (session?.nextTurnNumber ?? 1) > 1;
      if (appearsCorrupted) {
        recoveryIssues.push(this.createRecoveryIssue(
          'missing_turn_log',
          'current.jsonl and work/log/turns.jsonl are both empty even though this session already shows prior activity; human review is required.',
          'critical',
        ));
        if (recoveryIntent) {
          recoveryIssues.push(this.createRecoveryIssue(
            'compaction_intent_recovered',
            `found unfinished ${recoveryIntent.mode} compaction intent targeting ${recoveryIntent.targetTurns ?? 'unknown turns'} but neither current work nor turn log could be rebuilt automatically`,
            'critical',
          ));
          await this.store.clearRecoveryIntent(agentId, sessionId);
        }
        await this.store.replaceSessionRecoveryIssues(agentId, sessionId, recoveryIssues, 'needs_human');
        agent.status = 'waiting_user';
        agent.autonomy.enabled = false;
        agent.runtime.lastError = 'Recovery detected missing current work and turn log; human review is required.';
        agent.updatedAt = nowIso();
        await this.store.saveAgent(agent);
      }
      return;
    }

    const normalized = this.normalizeRecoveredCurrentWork(currentWork, logTurns);
    if (this.workEntriesDiffer(currentWork, normalized)) {
      const currentRawTurns = currentWork.filter(normalizeWorkEntryTurn).length;
      const normalizedRawTurns = normalized.filter(normalizeWorkEntryTurn).length;
      const currentTagCount = currentWork.filter((entry) => !normalizeWorkEntryTurn(entry)).length;
      const normalizedTagCount = normalized.filter((entry) => !normalizeWorkEntryTurn(entry)).length;
      if (currentRawTurns > normalizedRawTurns) {
        recoveryIssues.push(this.createRecoveryIssue(
          'covered_turns_pruned',
          `pruned ${currentRawTurns - normalizedRawTurns} raw turns from current.jsonl because they were already covered by compaction tags`,
          'warning',
        ));
      }
      if (currentTagCount > normalizedTagCount) {
        recoveryIssues.push(this.createRecoveryIssue(
          'duplicate_tags_pruned',
          `pruned ${currentTagCount - normalizedTagCount} duplicate compaction tags from current.jsonl during recovery`,
          'warning',
        ));
      }
      await this.store.saveCurrentWork(agentId, sessionId, normalized);
    }
    if (recoveryIntent) {
      recoveryIssues.push(this.createRecoveryIssue(
        'compaction_intent_recovered',
        `found unfinished ${recoveryIntent.mode} compaction intent targeting ${recoveryIntent.targetTurns ?? 'unknown turns'}; normalized current work and cleared the stale intent`,
        'warning',
      ));
      await this.store.clearRecoveryIntent(agentId, sessionId);
    }
    if (recoveryIssues.length > 0) {
      await this.store.replaceSessionRecoveryIssues(agentId, sessionId, recoveryIssues, 'recovered');
    }
  }

  private async assertPersistentBudget(agent: AgentManifest, session: AgentSessionRecord): Promise<void> {
    const persistentSummary = await this.store.listPersistentSummary(agent.id, session.id);
    const persistentConstraints = await this.store.listPersistentConstraints(agent.id, session.id);
    const snapshot = this.computePersistentBudgetSnapshot(persistentSummary, persistentConstraints);
    if (snapshot.status !== 'hard_limit_reached') {
      return;
    }
    const budgetReasons = [
      snapshot.approxTotalTokens > snapshot.totalHardLimit
        ? `total ${snapshot.approxTotalTokens} > ${snapshot.totalHardLimit}`
        : null,
      snapshot.approxSummaryTokens > snapshot.summaryHardLimit
        ? `summary ${snapshot.approxSummaryTokens} > ${snapshot.summaryHardLimit}`
        : null,
      snapshot.approxConstraintTokens > snapshot.constraintHardLimit
        ? `constraints ${snapshot.approxConstraintTokens} > ${snapshot.constraintHardLimit}`
        : null,
    ].filter(Boolean).join(', ');
    const issues = [
      this.createRecoveryIssue(
        'persistent_budget_exceeded',
        `persistent context exceeded its configured hard budget (${budgetReasons}); human cleanup is required before continuing.`,
        'critical',
      ),
    ];
    await this.store.replaceSessionRecoveryIssues(agent.id, session.id, issues, 'needs_human');
    agent.status = 'waiting_user';
    agent.autonomy.enabled = false;
    agent.updatedAt = nowIso();
    agent.runtime.lastError = 'persistent/ exceeded a configured hard budget; human cleanup is required before continuing.';
    await this.store.saveAgent(agent);
    throw new Error('persistent/ exceeded a configured hard budget; please finalize or clean up the session before continuing.');
  }

  private async openClarification(
    agentId: string,
    sessionId: string,
    query: string,
    reason: string,
    kind: AgentClarificationRecord['kind'],
  ): Promise<AgentClarificationRecord> {
    const agent = await this.getAgent(agentId);
    const existing = await this.getPendingClarification(agentId);
    if (existing && existing.sessionId === sessionId) {
      return existing;
    }
    const clarification: AgentClarificationRecord = {
      id: `clar-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
      agentId,
      sessionId,
      status: 'pending',
      kind,
      query,
      reason,
      question: `I could not verify enough history for "${query}". Please provide the missing fact or decision explicitly.`,
      createdAt: nowIso(),
    };
    await this.store.saveClarification(clarification);
    agent.runtime.pendingClarificationId = clarification.id;
    agent.status = 'waiting_user';
    agent.updatedAt = nowIso();
    await this.store.saveAgent(agent);
    return clarification;
  }

  private getNextTurnNumber(turns: AgentTurnRecord[]): number {
    const maxTurn = turns.reduce((max, turn) => Math.max(max, turn.turnNumber ?? 0), 0);
    return maxTurn + 1;
  }

  private async buildTurnLogCandidates(
    agentId: string,
    sessionId: string,
    currentWorkEntries: AgentWorkEntry[],
    maxRangesToReopen: number,
  ): Promise<{
    turns: AgentTurnRecord[];
    ranges: Array<{ source: string; start: number; end: number }>;
  }> {
    const candidates = currentWorkEntries.filter(normalizeWorkEntryTurn);
    const seenTurnNumbers = new Set(
      candidates
        .map((entry) => entry.turnNumber)
        .filter((value): value is number => Number.isFinite(value)),
    );
    const referencedTurns = await this.readArchivedTurnsFromTags(agentId, sessionId, currentWorkEntries, maxRangesToReopen);
    for (const turn of referencedTurns) {
      const number = turn.turnNumber ?? 0;
      if (number > 0 && !seenTurnNumbers.has(number)) {
        seenTurnNumbers.add(number);
        candidates.push(turn);
      }
    }
    return {
      turns: candidates.sort((left, right) => (left.turnNumber ?? 0) - (right.turnNumber ?? 0)),
      ranges: this.collectArchivedRangeRefs(currentWorkEntries).slice(0, maxRangesToReopen),
    };
  }

  private async readArchivedTurnsFromTags(
    agentId: string,
    sessionId: string,
    entries: AgentWorkEntry[],
    maxRangesToReopen: number,
  ): Promise<AgentTurnRecord[]> {
    const tags = entries.filter((entry): entry is AgentCompactionTagRecord => (
      entry.kind === 'compaction' || entry.kind === 'partial_compaction'
    ));
    const merged: AgentTurnRecord[] = [];
    const seen = new Set<string>();
    let reopened = 0;
    for (const tag of tags) {
      const ranges = this.parseArchivedRanges(tag.archived);
      const fallback = this.parseTurnRange(tag.turns);
      const targets = ranges.length > 0 ? ranges : (fallback ? [fallback] : []);
      for (const range of targets) {
        if (reopened >= maxRangesToReopen) {
          return merged;
        }
        reopened += 1;
        const turns = await this.store.listTurnsRange(agentId, sessionId, range.start, range.end);
        for (const turn of turns) {
          if (seen.has(turn.turnId)) {
            continue;
          }
          seen.add(turn.turnId);
          merged.push(turn);
        }
      }
    }
    return merged;
  }

  private parseArchivedRanges(archived?: string | string[]): { start: number; end: number }[] {
    return archivedRefs(archived)
      .map((entry) => {
        const match = entry.match(/@turn_(\d+)-turn_(\d+)/);
        if (!match) {
          return null;
        }
        return {
          start: Number(match[1]),
          end: Number(match[2]),
        };
      })
      .filter((entry): entry is { start: number; end: number } => Boolean(entry));
  }

  private collectArchivedRangeRefs(entries: AgentWorkEntry[]): Array<{ source: string; start: number; end: number }> {
    const refs: Array<{ source: string; start: number; end: number }> = [];
    for (const entry of entries) {
      if (normalizeWorkEntryTurn(entry)) {
        continue;
      }
      for (const source of archivedRefs(entry.archived)) {
        for (const range of this.parseArchivedRanges(source)) {
          refs.push({
            source,
            start: range.start,
            end: range.end,
          });
        }
      }
    }
    return refs;
  }

  private parseTurnRange(turns?: string): { start: number; end: number } | null {
    if (!turns) {
      return null;
    }
    const match = turns.match(/turn_(\d+)-turn_(\d+)/);
    if (!match) {
      const single = turns.match(/turn_(\d+)/);
      if (!single) {
        return null;
      }
      const value = Number(single[1]);
      return { start: value, end: value };
    }
    return {
      start: Number(match[1]),
      end: Number(match[2]),
    };
  }

  private rankRetrievalHits<T extends {
    layer: AgentRetrievalHit['layer'];
    text: string;
    label: string;
    excerpt: string;
    archived?: string;
    turnRange?: { start: number; end: number };
  }>(
    candidates: T[],
    terms: string[],
    limit: number,
  ): AgentRetrievalHit[] {
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: scoreHit(candidate.text, terms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label))
      .slice(0, limit)
      .map((candidate) => ({
        layer: candidate.layer,
        score: candidate.score,
        label: candidate.label,
        excerpt: excerpt(candidate.excerpt, 240),
        archived: candidate.archived,
        turnRange: candidate.turnRange,
      }));
  }

  private isSafetyPoint(entries: AgentWorkEntry[]): boolean {
    const turns = entries.filter(normalizeWorkEntryTurn);
    if (turns.length === 0) {
      return true;
    }
    const lastTurn = turns[turns.length - 1];
    if (lastTurn.role === 'user') {
      return false;
    }
    const lowered = lastTurn.content.trim().toLowerCase();
    if (/[?？]\s*$/.test(lastTurn.content.trim())) {
      return false;
    }
    if (containsAnySemanticTerm(lowered, UNSETTLED_SIGNAL_TERMS)) {
      return false;
    }
    return true;
  }

  private async serializeAgentOperation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.agentOperationChains.get(agentId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => tail);
    this.agentOperationChains.set(agentId, next);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (this.agentOperationChains.get(agentId) === next) {
        this.agentOperationChains.delete(agentId);
      }
    }
  }

  private planRetrieval(
    query: string,
    includeWorkspaceSearch?: boolean,
  ): {
    queryKind: 'history_fact' | 'workspace_fact' | 'mixed';
    strategy: 'history_first' | 'workspace_first' | 'balanced';
    orderedLayers: AgentRetrievalHit['layer'][];
    usedWorkspaceSearch: boolean;
  } {
    const lowered = query.toLowerCase();
    const workspaceScore = WORKSPACE_PRIORITY_TERMS.reduce((score, term) => score + (lowered.includes(term) ? 1 : 0), 0);
    const historyScore = HISTORY_PRIORITY_TERMS.reduce((score, term) => score + (lowered.includes(term) ? 1 : 0), 0);
    const queryKind = workspaceScore > historyScore
      ? 'workspace_fact'
      : historyScore > workspaceScore
        ? 'history_fact'
        : 'mixed';
    const strategy = workspaceScore > historyScore
      ? 'workspace_first'
      : historyScore > workspaceScore
        ? 'history_first'
        : 'balanced';
    const usedWorkspaceSearch = includeWorkspaceSearch ?? strategy !== 'history_first';
    const baseHistory: AgentRetrievalHit['layer'][] = [
      'current_compaction_constraints',
      'current_compaction_summary',
      'current_partial_summary',
      'turn_log',
      'persistent_constraints',
      'persistent_summary',
      'memory_constraints',
      'memory_summary',
    ];
    const workspaceLayers: AgentRetrievalHit['layer'][] = ['workspace_files', 'workspace_content'];
    const orderedLayers = strategy === 'workspace_first'
      ? [
        ...(usedWorkspaceSearch ? workspaceLayers : []),
        ...baseHistory,
      ]
      : strategy === 'history_first'
        ? [
          ...baseHistory,
          ...(usedWorkspaceSearch ? workspaceLayers : []),
        ]
        : [
          'current_compaction_constraints',
          'current_compaction_summary',
          ...(usedWorkspaceSearch ? workspaceLayers : []),
          'current_partial_summary',
          'turn_log',
          'persistent_constraints',
          'persistent_summary',
          'memory_constraints',
          'memory_summary',
        ];
    return { queryKind, strategy, orderedLayers: orderedLayers as AgentRetrievalHit['layer'][], usedWorkspaceSearch };
  }

  private defaultArchivedRangeBudget(strategy: 'history_first' | 'workspace_first' | 'balanced'): number {
    if (strategy === 'history_first') {
      return 4;
    }
    if (strategy === 'workspace_first') {
      return 1;
    }
    return 2;
  }

  private assessEvidenceQuality(layers: AgentRetrievalLayerResult[]): 'none' | 'weak' | 'moderate' | 'strong' {
    const hits = layers.flatMap((layer) => layer.hits);
    if (hits.length === 0) {
      return 'none';
    }
    const topScore = Math.max(...hits.map((hit) => hit.score));
    const hitLayers = new Set(layers.filter((layer) => layer.hits.length > 0).map((layer) => layer.layer));
    if (topScore >= 9 || (topScore >= 6 && hitLayers.size >= 2)) {
      return 'strong';
    }
    if (topScore >= 5 || hitLayers.size >= 2) {
      return 'moderate';
    }
    return 'weak';
  }

  private shouldClarifyWeakConstraintOnlyEvidence(
    queryKind: 'history_fact' | 'workspace_fact' | 'mixed',
    layers: AgentRetrievalLayerResult[],
    evidenceQuality: 'none' | 'weak' | 'moderate' | 'strong',
  ): boolean {
    if (queryKind === 'workspace_fact' || evidenceQuality !== 'weak') {
      return false;
    }
    const hits = layers.flatMap((layer) => layer.hits);
    if (hits.length === 0) {
      return false;
    }
    const constraintOnlyLayers = new Set<AgentRetrievalHit['layer']>([
      'current_compaction_constraints',
      'persistent_constraints',
      'memory_constraints',
    ]);
    if (!hits.every((hit) => constraintOnlyLayers.has(hit.layer))) {
      return false;
    }
    return hits.every((hit) => {
      const combined = `${hit.label} ${hit.excerpt}`.toLowerCase();
      return hit.label.startsWith('tool.')
        || hit.label.startsWith('env.working_directory')
        || hit.label.startsWith('workspace.paths_recently_observed')
        || combined.includes('tool result')
        || combined.includes('tool available')
        || combined.includes('working directory')
        || combined.includes('workspace observation')
        || combined.includes('observable tool result');
    });
  }

  private clarificationKindForQuery(queryKind: 'history_fact' | 'workspace_fact' | 'mixed'): AgentClarificationRecord['kind'] {
    if (queryKind === 'history_fact') {
      return 'history_missing';
    }
    if (queryKind === 'workspace_fact') {
      return 'workspace_missing';
    }
    return 'mixed_missing';
  }

  private collectArchivedRefs(sessionId: string, entries: AgentWorkEntry[]): string[] {
    const refs = new Set<string>();
    const rawTurnNumbers = entries
      .filter(normalizeWorkEntryTurn)
      .map((entry) => entry.turnNumber)
      .filter((value): value is number => Number.isFinite(value))
      .sort((left, right) => left - right);
    for (const range of this.groupTurnNumbers(rawTurnNumbers)) {
      refs.add(`/sessions/${sessionId}/work/log/turns.jsonl @turn_${range.start}-turn_${range.end}`);
    }
    for (const entry of entries) {
      if (normalizeWorkEntryTurn(entry)) {
        continue;
      }
      for (const ref of archivedRefs(entry.archived)) {
        refs.add(ref);
      }
    }
    return [...refs];
  }

  private groupTurnNumbers(numbers: number[]): Array<{ start: number; end: number }> {
    if (numbers.length === 0) {
      return [];
    }
    const ranges: Array<{ start: number; end: number }> = [];
    let start = numbers[0];
    let end = numbers[0];
    for (const number of numbers.slice(1)) {
      if (number === end + 1) {
        end = number;
        continue;
      }
      ranges.push({ start, end });
      start = number;
      end = number;
    }
    ranges.push({ start, end });
    return ranges;
  }

  private buildRetrievalEvidenceSummary(layers: AgentRetrievalLayerResult[]): string[] {
    return layers
      .filter((layer) => layer.hits.length > 0)
      .slice(0, 4)
      .map((layer) => `${layer.layer}: ${layer.hits.slice(0, 2).map((hit) => hit.label).join(', ')}`);
  }
}

function pendingGoalsToStrings(goals: AgentGoalRecord[]): string[] {
  return goals.map((goal) => `[${goal.source}] ${goal.content}`);
}
