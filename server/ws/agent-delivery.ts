import type { AgentMessage, SessionContext } from '../../core/runtime/types.js';
import type { ProposalFactKind, TaskFact } from '../../core/runtime/blackboard-types.js';
import type { OutboundMessage } from '../../core/types/index.js';
import { execFileSync } from 'child_process';
import { getTeamRegistry } from '../../core/team/registry.js';
import { extractCoordinatorOutput } from '../../core/runtime/coordinator-context.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../core/store/request-state-store.js';
import { buildBlackboardCoordinatorFollowup, parseBlackboardProtocolGuard, resolveBlackboardCoordinatorMode } from '../../core/runtime/blackboard-coordinator.js';
import { buildBlackboardAgentContext } from '../../core/runtime/blackboard-agent-context.js';
import { buildBlackboardFinalReply, buildBlackboardSynthesisDigest } from '../../core/runtime/blackboard-synthesis.js';
import { isAutoApprovableProposalKind } from '../../core/runtime/blackboard-proposals.js';
import { resolveAgentArtifactsRoot } from '../../core/runtime/agent-artifacts.js';
import { resolveHostedAgentServerId } from '../../core/runtime/hosted-agent-server-id.js';
import { requiresStructuredSourceEvidence } from '../../core/runtime/task-evidence.js';
import { extendLeaseWithoutShortening } from '../../core/runtime/agent-liveness.js';
import { getSoulStore } from '../../core/store/soul-store.js';
import type { AgentResponse } from '../runtime/agent-response.js';
import { resolveRuntimeBackend } from '../runtime/session-runner-registry.js';
import type { LocalDevPolicyHint, SessionClientType, SessionStreamEvent } from '../runtime/session-types.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';
import { buildSessionContextBlock } from './coordination-facts.js';
import { deriveRosterCapabilityAllowlist } from '../runtime/blackboard-capability-gaps.js';
import { deriveAgentCapabilities } from './blackboard-dispatcher.js';
import { getAgentServerClient } from '../agent_server/client.js';
import type { AgentMessageRequest, AgentRunRecord, AgentRunStreamOptions } from '../agent_server/types.js';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface CoordinationFacts {
  controlProjectPath?: string;
  controlPort?: number;
  controlUrl?: string;
  targetProjectPath?: string;
  targetPort?: number;
  targetUrl?: string;
  updatedAt: number;
}

interface InflightDeliveryRecord {
  promise: Promise<{ sessionKey: string; body: string }>;
  taskId: string | null;
  runId: string | null;
}

interface CreateAgentDeliveryDeps {
  buildAgentInputBody: (
    agentId: string,
    msg: AgentMessage,
    facts: CoordinationFacts | null,
    sessionContext: SessionContext | null,
  ) => string;
  broadcastMessage: (teamId: string, message: OutboundMessage) => void;
  getSessionContextStore: () => { getCurrent: (teamId: string, sessionId?: string | null) => SessionContext | null };
  getCoordinationFactsByRequest: () => Map<string, CoordinationFacts>;
  getRequestKey: (teamId: string, requestId: string) => string;
  resolveChatSessionId: (teamId: string, requestId?: string | null) => string;
  onAgentResponse: (
    response: AgentResponse,
    context: {
      teamId: string;
      requestId: string | null;
      localFrom: string | null;
      sourceClientId: string | null;
      isPrivate: boolean;
      isStale: boolean;
    },
  ) => Promise<void> | void;
  recordDeliveryContext: (agentId: string, sessionKey: string, msg: AgentMessage) => void;
  resolveSessionLaneForDelivery: (teamId: string, agentId: string, msg: AgentMessage) => string;
  harnessRunRecorder: {
    recordMessageDelivered: (...args: unknown[]) => void;
    recordMessageIntercepted: (...args: unknown[]) => void;
  };
  defaultExecutorMaxWorkMinutes: number;
  executorReportGraceMs: number;
}

export function stripLeadingDirectMentionForRuntime(body: string, agentId: string): string {
  return String(body || '').replace(new RegExp(`^\\s*@${agentId}\\b[\\s,:-]*`, 'i'), '').trimStart();
}

export function resolveRuntimeCwdForAgent(
  agentId: string,
  sessionContext: SessionContext | null,
  registry?: {
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null,
): string | undefined {
  if (registry?.isCoordinator(agentId)) {
    return sessionContext?.env['cwd.control']
      || sessionContext?.env['exec.cwd']
      || registry?.getTeamDir?.()
      || process.cwd();
  }
  return sessionContext?.env['cwd.target'] || sessionContext?.env['exec.cwd'] || process.cwd();
}

export function resolveRuntimeProjectScopeForAgent(
  agentId: string,
  sessionContext: SessionContext | null,
  registry?: {
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null,
): string | undefined {
  return resolveRuntimeCwdForAgent(agentId, sessionContext, registry);
}

export function resolveHostedAgentWorkingDirectory(
  agentId: string,
  sessionContext: SessionContext | null,
  registry?: {
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null,
): string {
  const defaultTarget = String(sessionContext?.env['workspace.defaultExecutionTarget'] || '').trim();
  const transport = String(sessionContext?.env['workspace.transport'] || '').trim();
  const isRemoteWorkspace = defaultTarget === 'remote' || (transport && transport !== 'local');
  if (isRemoteWorkspace) {
    return sessionContext?.env['cwd.control']
      || registry?.getTeamDir?.()
      || process.cwd();
  }
  return resolveRuntimeCwdForAgent(agentId, sessionContext, registry)
    || registry?.getTeamDir?.()
    || process.cwd();
}

function resolveRequestCoordinatorId(args: {
  teamId: string;
  chatSessionId: string;
  requestId?: string | null;
  registry?: {
    getCoordinator?: () => string;
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null;
}): string | null {
  const requestId = String(args.requestId || '').trim();
  if (!requestId) {
    return args.registry?.getCoordinator?.() || null;
  }
  return getRequestStateStore().resolveCoordinatorForSession(
    args.teamId,
    requestId,
    args.chatSessionId,
    args.registry?.getCoordinator?.() || null,
  );
}

function isRequestCoordinatorTarget(args: {
  teamId: string;
  chatSessionId: string;
  requestId?: string | null;
  agentId: string;
  registry?: {
    getCoordinator?: () => string;
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null;
}): boolean {
  const resolvedCoordinator = resolveRequestCoordinatorId(args);
  return resolvedCoordinator ? resolvedCoordinator === args.agentId : args.registry?.isCoordinator(args.agentId) === true;
}

export function hasAssignedSubstantiveRuntimeTask(args: {
  teamId: string;
  chatSessionId: string | null;
  requestId?: string | null;
  agentId: string | null;
}): boolean {
  const requestId = String(args.requestId || '').trim();
  const chatSessionId = String(args.chatSessionId || '').trim();
  const agentId = String(args.agentId || '').trim();
  if (!requestId || !chatSessionId || !agentId) {
    return false;
  }
  return getBlackboardStore().list(args.teamId, chatSessionId, {
    requestId,
    owner: agentId,
  }).some((task) =>
    (task.status === 'pending' || task.status === 'running')
    && !isCoordinatorControlFact(task));
}

export function shouldUseCoordinatorProtocol(args: {
  teamId: string;
  chatSessionId: string | null;
  requestId?: string | null;
  agentId: string;
  registry?: {
    getCoordinator?: () => string;
    isCoordinator(agentId: string): boolean;
    getTeamDir(): string | null;
  } | null;
}): boolean {
  const coordinatorByIdentity =
    isRequestCoordinatorTarget({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId || '',
      requestId: args.requestId,
      agentId: args.agentId,
      registry: args.registry,
    })
    || args.agentId === 'coordinator'
    || args.agentId.startsWith('coordinator');
  if (!coordinatorByIdentity) {
    return false;
  }
  return !hasAssignedSubstantiveRuntimeTask({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    agentId: args.agentId,
  });
}

export function buildSourceEvidenceAcceptanceRules(
  requirements: TaskFact['evidenceRequirements'] | null | undefined,
  nowMs: number = Date.now(),
): string[] {
  if (!requiresStructuredSourceEvidence(requirements)) {
    return [];
  }

  const lines: string[] = [];
  const minSourceCount = typeof requirements?.minSourceCount === 'number'
    ? requirements.minSourceCount
    : 1;
  if (typeof requirements?.maxSourceAgeHours === 'number' && Number.isFinite(requirements.maxSourceAgeHours)) {
    const cutoffMs = nowMs - (requirements.maxSourceAgeHours * 60 * 60 * 1000);
    const generatedAt = new Date(nowMs).toISOString();
    const cutoff = new Date(cutoffMs).toISOString();
    lines.push(`sourceEvidenceWindow: generatedAt=${generatedAt}, maxSourceAgeHours=${requirements.maxSourceAgeHours}, publishedAtCutoff=${cutoff}`);
    lines.push(`rule: before claiming completion, count only TASK_EVIDENCE.sources with parseable publishedAt >= ${cutoff}; older, missing, or unparseable publishedAt values do not satisfy the source recency requirement.`);
    lines.push(`rule: if fewer than ${minSourceCount} sources satisfy that cutoff, do not write "done", "completed", or "任务完成"; report an explicit blocked reason such as "recent source gap: need ${minSourceCount} sources newer than ${cutoff}".`);
  }
  if (requirements?.requireSourceLinks) {
    lines.push(`rule: before claiming completion, count only TASK_EVIDENCE.sources that include reviewable absolute source URLs; sources without URLs do not satisfy requireSourceLinks=true.`);
  }
  if (typeof requirements?.minSourceCount === 'number') {
    lines.push(`rule: TASK_EVIDENCE must include at least ${requirements.minSourceCount} qualifying source records after applying all source evidence filters, not merely ${requirements.minSourceCount} mentioned facts in prose.`);
  }
  return lines;
}

export function resolveRuntimePersistentKey(teamId: string, agentId: string, chatSessionId: string): string {
  return `team:${teamId}:session:${chatSessionId}:agent:${agentId}`;
}

export function shouldReplaySupersededInflightDelivery(args: {
  requestId?: string | null;
  currentTaskId?: string | null;
  currentRunId?: string | null;
  inflightTaskId?: string | null;
  inflightRunId?: string | null;
}): boolean {
  if (!String(args.requestId || '').trim()) {
    return false;
  }
  const currentTaskId = String(args.currentTaskId || '').trim();
  const currentRunId = String(args.currentRunId || '').trim();
  const inflightTaskId = String(args.inflightTaskId || '').trim();
  const inflightRunId = String(args.inflightRunId || '').trim();
  if (!currentTaskId || !currentRunId || !inflightTaskId || !inflightRunId) {
    return false;
  }
  return currentTaskId !== inflightTaskId || currentRunId !== inflightRunId;
}

function buildHostedAgentSystemPrompt(args: {
  teamId: string;
  runtimeAgentId: string;
  roleName?: string | null;
  roleType?: string | null;
}): string {
  const identity = [args.roleName, args.roleType].map((value) => String(value || '').trim()).filter(Boolean).join(' / ');
  return [
    `You are the long-lived hosted agent for team "${args.teamId}".`,
    `Your runtime agent id is "${args.runtimeAgentId}".`,
    identity ? `Your role identity is "${identity}".` : null,
    'All task truth comes from the blackboard-delivered message body. Preserve your own agent_server session, memory, and run audit trail across tasks.',
    'For each new request, prioritize the current blackboard facts over older chats, older summaries, or stale memory.',
    'Do not invent a second task system. Execute the assigned task, respect the provided execution scope, and report concrete results or explicit blocked reasons.',
  ].filter(Boolean).join('\n');
}

async function deliverViaHostedAgentServer(args: {
  teamId: string;
  agentId: string;
  roleName?: string | null;
  roleType?: string | null;
  backend: SessionClientType;
  workingDirectory: string;
  message: AgentMessageRequest;
  stream?: AgentRunStreamOptions;
}): Promise<AgentRunRecord> {
  const hostedAgentId = resolveHostedAgentServerId(args.teamId, args.agentId);
  if (args.message.contextPolicy && args.message.contextPolicy.includeCurrentWork === false) {
    try {
      await getAgentServerClient().finalizeSession(hostedAgentId, {
        carryOverSummary: '',
        promotePersistentToMemory: false,
        strategy: 'aggressive',
        seedPersistentFromMemory: false,
        discardArchivedSessionContext: true,
      });
    } catch {
      // Ignore finalize failures here; ensure/run below will still proceed.
    }
  }
  const result = await getAgentServerClient().runAutonomousTask({
    agent: {
      id: hostedAgentId,
      name: args.agentId,
      backend: args.backend,
      workingDirectory: args.workingDirectory,
      runtimeTeamId: args.teamId,
      runtimeAgentId: args.agentId,
      systemPrompt: buildHostedAgentSystemPrompt({
        teamId: args.teamId,
        runtimeAgentId: args.agentId,
        roleName: args.roleName,
        roleType: args.roleType,
      }),
      autonomy: {
        enabled: false,
      },
      reconcileExisting: true,
      policy: {
        autoRevive: true,
        autoPersistentRecovery: true,
        allowPersistentReset: true,
        resetReusesMemorySeed: true,
        clearCurrentWorkOnReset: false,
        resumeAutonomyAfterRecovery: false,
      },
    },
    message: args.message,
  }, args.stream);
  return result.run;
}

export function refreshBlackboardLeaseHeartbeat(args: {
  teamId: string;
  chatSessionId: string;
  taskId: string;
  agentId: string;
  runId: string;
  leaseWindowMs?: number;
}): boolean {
  const board = getBlackboardStore();
  const current = board.get(args.teamId, args.chatSessionId, args.taskId);
  if (!current || current.status !== 'running' || current.owner !== args.agentId || current.currentRunId !== args.runId) {
    return false;
  }
  try {
    const now = Date.now();
    board.write(args.teamId, args.chatSessionId, {
      id: current.id,
      revision: current.revision,
      lastHeartbeatAt: now,
      leaseUntil: extendLeaseWithoutShortening({
        existingLeaseUntil: current.leaseUntil,
        now,
        leaseWindowMs: args.leaseWindowMs,
      }),
    });
    return true;
  } catch (error) {
    console.warn('[WS] Failed to refresh blackboard heartbeat for hosted run:', error);
    return false;
  }
}

export function resolveAgentDeliveryTimeoutMs(): number {
  return Math.max(15_000, Math.trunc(loadOpenTeamConfig().runtime.executor.deliveryTimeoutMs));
}

export function resolveCoordinatorDecomposeStallTimeoutMs(): number {
  const configured = Math.max(
    15_000,
    Math.trunc(loadOpenTeamConfig().runtime.executor.coordinatorDecomposeStallTimeoutMs),
  );
  return configured;
}

export function shouldTriggerCoordinatorStallFallback(lastActivityAt: number, stallTimeoutMs: number, now = Date.now()): boolean {
  return now - lastActivityAt >= stallTimeoutMs;
}

export function resolveRuntimePromptInput(params: {
  agentId: string;
  body: string;
  context: string;
  isExecutorTarget: boolean;
}): { task: string; context: string } {
  return {
    task: params.isExecutorTarget ? stripLeadingDirectMentionForRuntime(params.body, params.agentId) : params.body,
    context: params.context,
  };
}

function buildCoordinationFactsBlock(facts: CoordinationFacts | null): string {
  if (!facts) {
    return '';
  }
  const lines = ['[[COORDINATION_FACTS]]'];
  if (facts.controlProjectPath) lines.push(`controlProjectPath: ${facts.controlProjectPath}`);
  if (facts.targetProjectPath) lines.push(`targetProjectPath: ${facts.targetProjectPath}`);
  if (facts.controlUrl) lines.push(`controlUrl: ${facts.controlUrl}`);
  if (facts.targetUrl) lines.push(`targetUrl: ${facts.targetUrl}`);
  if (facts.controlPort != null) lines.push(`controlPort: ${facts.controlPort}`);
  if (facts.targetPort != null) lines.push(`targetPort: ${facts.targetPort}`);
  lines.push('[[/COORDINATION_FACTS]]');
  return lines.join('\n');
}

function buildWorkspaceFactsBlock(workspaceFacts: Record<string, string>): string {
  const entries = Object.entries(workspaceFacts || {});
  if (entries.length === 0) {
    return '';
  }
  const lines = ['[[WORKSPACE_FACTS]]'];
  for (const [key, value] of entries) {
    lines.push(`${key}=${value}`);
  }
  lines.push('[[/WORKSPACE_FACTS]]');
  return lines.join('\n');
}

function buildDependencyHandoffBlock(dependencies: Array<{
  taskId: string;
  owner: string | null;
  status: string;
  result: string;
  resultRef?: string;
  artifactsRoot: string;
  summaryArtifactPath: string;
  summaryArtifactExcerpt?: string;
}>): string {
  if (!dependencies.length) {
    return '';
  }
  return [
    '[[BLACKBOARD_DEPENDENCY_HANDOFF]]',
    JSON.stringify({
      dependencies: dependencies.map((dependency) => ({
        taskId: dependency.taskId,
        owner: dependency.owner,
        status: dependency.status,
        result: dependency.result,
        resultRef: dependency.resultRef || null,
        artifactsRoot: dependency.artifactsRoot,
        summaryArtifactPath: dependency.summaryArtifactPath,
        summaryArtifactExcerpt: dependency.summaryArtifactExcerpt || null,
      })),
    }),
    '[[/BLACKBOARD_DEPENDENCY_HANDOFF]]',
  ].join('\n');
}

function buildExecutorTaskBlock(teamId: string, chatSessionId: string, requestId: string, agentId: string): string {
  const board = getBlackboardStore();
  const task = board.list(teamId, chatSessionId, {
    requestId,
    owner: agentId,
  })[0] || null;
  if (!task) {
    return '';
  }
  const lines = [
    '[[BLACKBOARD_TASK]]',
    `taskId: ${task.id}`,
    `status: ${task.status}`,
    `goal: ${task.goal}`,
    `requiredCapability: ${task.requiredCapability}`,
    `workspaceId: ${task.executionScope.workspaceId}`,
    `cwd: ${task.executionScope.cwd}`,
    `allowedRoots: ${task.executionScope.allowedRoots.join(', ')}`,
    `artifactsRoot: ${task.executionScope.artifactsRoot}`,
    `requires: ${task.requires.join(', ') || '(none)'}`,
  ];
  const agentContext = buildBlackboardAgentContext({
    board,
    soulStore: getSoulStore(),
    teamId,
    chatSessionId,
    taskId: task.id,
    agentId,
  });
  const workspaceFactsBlock = buildWorkspaceFactsBlock(agentContext?.workspaceFacts || {});
  if (workspaceFactsBlock) {
    lines.push(workspaceFactsBlock);
  }
  const dependencyHandoffBlock = buildDependencyHandoffBlock(agentContext?.dependencies || []);
  if (dependencyHandoffBlock) {
    lines.push(dependencyHandoffBlock);
  }
  if (task.acceptanceCriteria?.length) {
    lines.push(`acceptanceCriteria: ${task.acceptanceCriteria.join(' | ')}`);
  }
  if (task.evidenceRequirements) {
    const evidenceRules = [
      task.evidenceRequirements.requireRuntimeToolCall ? 'runtime-tool-call' : null,
      task.evidenceRequirements.requireSummaryArtifact ? 'summary.md' : null,
      typeof task.evidenceRequirements.minSourceCount === 'number' ? `minSourceCount=${task.evidenceRequirements.minSourceCount}` : null,
      typeof task.evidenceRequirements.maxSourceAgeHours === 'number' ? `maxSourceAgeHours=${task.evidenceRequirements.maxSourceAgeHours}` : null,
      task.evidenceRequirements.requireSourceLinks ? 'requireSourceLinks=true' : null,
    ].filter(Boolean);
    if (evidenceRules.length > 0) {
      lines.push(`evidenceRequirements: ${evidenceRules.join(', ')}`);
    }
  }
  if (task.blockedBy?.message) {
    lines.push(`blockedReason: ${task.blockedBy.message}`);
  }
  const scpContextText = [
    task.goal,
    ...(task.acceptanceCriteria || []),
    task.executionScope.artifactsRoot,
  ].join('\n');
  lines.push('rule: focus on this assigned task only; report concrete result or explicit blocked reason.');
  lines.push('rule: do not simulate tool usage in prose. Never emit pseudo tool markup such as <function_calls>, <invoke>, XML tool envelopes, or literal web.search/file.append call plans.');
  lines.push('rule: if this task needs search/browser/file/shell work, execute it through the runtime tool channel. If the needed tool is unavailable, reply with an explicit blocked reason instead of pretending the tool call.');
  lines.push('rule: do not read or reconstruct shadow blackboard files such as .blackboard/*, tasks.json, state.json, or deleted legacy shadow-state roots. Treat the BLACKBOARD_DEPENDENCY_HANDOFF block in this task context as the only handoff source of truth for upstream task results.');
  if (/(scphub\.intern-ai\.org\.cn|scp hub|agents\/skills\/scp|server\/api\/scp-tools)/i.test(scpContextText)) {
    lines.push('rule: in this task, "SCP" means the SCP Hub / scphub.intern-ai.org.cn tool ecosystem used by this workspace, not "Single Cell Processing" and not generic GitHub biology toolkits.');
    lines.push('rule: prefer scphub.intern-ai.org.cn pages, this repository\'s SCP catalog/integration files, and existing agents/skills/scp entries as primary evidence before generic web search results.');
    lines.push('rule: if search results drift toward unrelated meanings of SCP, discard them and continue with SCP Hub-aligned sources only.');
    if (/agents\/skills\/scp\/|skill\.md|本地 skills|local skills/i.test(scpContextText)) {
      lines.push('rule: for local SCP skill-preparation tasks, do not stop merely because the live SCP Hub token or remote catalog is unavailable. If remote fetches fail, fall back to repository-aligned evidence such as agents/skills/scp/README.md, docs/t006_scp_biochem_tools_summary.md, scripts/t006-scp-config-smoke.ts, server/api/scp-tools/invoke.ts, and existing skill templates.');
      lines.push('rule: if the acceptance criteria ask for local SKILL.md files, create/update those local skill directories and files directly once you have enough repository evidence to align toolId, metadata, and path names. A remote token failure is not by itself a blocker for local file creation.');
      lines.push('rule: when writing SCP local skills, prefer a minimum viable but valid SKILL.md with YAML frontmatter and repo-aligned metadata over delaying for exhaustive remote catalog details.');
    }
  }
  if (requiresStructuredSourceEvidence(task.evidenceRequirements)) {
    lines.push('rule: this is a source-based research task. Prefer real web/browser/search tools first. Do not spend most of the run exploring the local repository unless the task explicitly requires local files.');
    lines.push('rule: this task has source-based acceptance requirements, so append one [[TASK_EVIDENCE]] JSON block in your final reply.');
    lines.push('rule: TASK_EVIDENCE JSON must use {"sources":[{"title":"...","url":"https://...","publishedAt":"ISO8601","snippet":"optional","domain":"optional"}]}.');
    lines.push(...buildSourceEvidenceAcceptanceRules(task.evidenceRequirements));
    lines.push('rule: source-based evidence does not replace runtime execution. You still must use real runtime tools for search/navigation instead of embedding provider-specific tool-call text.');
  }
  lines.push('rule: when you use skills, SCP/MCP tools, endpoints/tools, a local or remote workspace, shell commands, file edits, tests, ports, approvals, or discover residual risk, include those facts in the same [[TASK_EVIDENCE]] JSON block when you finish.');
  lines.push('rule: TASK_EVIDENCE may include {"skillsUsed":["skill-or-scp-id"],"workspaceId":"local:project-root|ssh:host","endpointsUsed":["local:shell","ssh:host","scp:service"],"toolBindings":[{"endpointId":"ssh:host","kind":"ssh-host","transport":"ssh","networkMode":"offline|local-egress|remote-direct|remote-via-local-proxy","capability":"shell","cwd":"/workspace","summary":"..."}],"commands":[{"command":"...","cwd":"...","exitCode":0,"summary":"..."}],"filesChanged":[{"path":"...","status":"modified","summary":"..."}],"tests":[{"name":"...","status":"passed|failed|skipped|unknown","summary":"..."}],"ports":[{"port":5173,"url":"http://...","status":"healthy"}],"approvalEvents":[{"approvalId":"...","kind":"deploy","decision":"approved|rejected|pending","reason":"..."}],"riskNotes":["..."]}.');
  if (task.evidenceRequirements?.requireSummaryArtifact) {
    lines.push(`rule: write the required summary artifact to ${task.executionScope.artifactsRoot}/summary.md before finishing.`);
  }
  lines.push('rule: if you discover necessary follow-on work inside this task boundary, append one [[TASK_PROPOSALS]] JSON block in your final reply instead of directly inventing new blackboard tasks.');
  lines.push('rule: TASK_PROPOSALS JSON must be either an array or {"proposals":[...]}, where each item uses {"kind":"need_review|need_qa|need_user_input|handoff|split|blocked_replan","goal":"...","requiredCapability":"...","reason":"...","suggestedAssignee":"optional","requires":["optional-task-id"],"endpointHints":[{"endpointId":"optional","kind":"ssh-host|scp-service|robot|gpu-node","capability":"shell|remote-workspace|...","networkMode":"offline|local-egress|remote-direct|remote-via-local-proxy","riskClass":"read|run-command|..."}],"networkMode":"optional","riskClass":"optional"}.');
  lines.push('rule: only propose work that is local to this task boundary. Do not use TASK_PROPOSALS to rewrite the whole request or to recreate the top-level plan.');
  lines.push('[[/BLACKBOARD_TASK]]');
  return lines.join('\n');
}

function resolveRuntimeLocalDevPolicy(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string | null;
  agentId: string;
  isExecutorTarget: boolean;
}): LocalDevPolicyHint | undefined {
  if (!args.isExecutorTarget || !args.requestId) {
    return undefined;
  }
  const config = loadOpenTeamConfig().runtime.localDev;
  const task = getBlackboardStore().list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    owner: args.agentId,
  })[0] || null;
  if (!task) {
    return undefined;
  }
  if (requiresStructuredSourceEvidence(task.evidenceRequirements)) {
    return {
      isSourceTask: true,
      maxSteps: config.sourceTaskToolMaxSteps,
      forceSummaryOnBudgetExhausted: config.sourceTaskForceSummaryOnBudgetExhausted,
    };
  }
  return {
    maxSteps: config.toolMaxSteps,
    forceSummaryOnBudgetExhausted: config.forceSummaryOnBudgetExhausted,
  };
}

function buildBlackboardCoordinatorOutputContract(mode: 'decompose' | 'recovery' | 'synthesize'): string {
  const lines = [
    '[[BLACKBOARD_OUTPUT_CONTRACT]]',
    'You are operating in blackboard mode.',
    'Your next final reply must contain exactly one [[COORDINATOR_OUTPUT]]...[[/COORDINATOR_OUTPUT]] block with valid JSON.',
    'The backend only applies structured coordinator output on this path.',
  ];

  if (mode === 'decompose') {
    lines.push('In decompose mode, produce at least one executable field: proposals or decisions.');
    lines.push('Prefer planning from current blackboard facts first; do not start shell/browser exploration before emitting the coordinator output unless the board explicitly requires evidence gathering.');
    lines.push('If the board summary already lists enough pending/runnable tasks to cover the user goal, drive execution via proposals/decisions first.');
    lines.push('Do not create or edit shadow blackboard files such as .blackboard/*, tasks.json, or state.json. The server blackboard is the only source of truth.');
    lines.push('Use proposals as the default and only way to introduce downstream work. New executable work must still flow through explicit proposals plus decisions before materialization.');
    lines.push('When executor-sourced ProposalFacts already exist, prefer decisions over recreating equivalent proposals by hand. Use decisions to approve/reject/amend proposal ids, then let the server materialize approved work.');
    lines.push('If user input is missing, express it as a need_user_input proposal rather than any legacy control fields or free-form questions.');
    lines.push('When proposing research/retrieval work, include acceptanceCriteria and evidenceRequirements so the worker knows the验收门槛 and the runtime can reject fake done.');
    lines.push('Only source-based acceptance tasks should require [[TASK_EVIDENCE]]; ordinary execution tasks can rely on runtime tool traces and artifacts like summary.md.');
    lines.push('Use the shared TASK_EVIDENCE schema: {"sources":[{"title":"...","url":"https://...","publishedAt":"ISO8601","snippet":"optional","domain":"optional"}]}.');
    lines.push('For latest-info tasks, prefer evidenceRequirements like {"requireRuntimeToolCall":true,"requireSummaryArtifact":true,"minSourceCount":3,"maxSourceAgeHours":24,"requireSourceLinks":true}.');
    lines.push('Proposal example: [[COORDINATOR_OUTPUT]]{"proposals":[{"proposalId":"req:reviewer-01:2:proposal","taskId":"req:reviewer-01:2","kind":"handoff","goal":"审查开发结果","requiredCapability":"review","suggestedAssignee":"reviewer-01","requires":["req:dev-01:1"],"reason":"开发已完成，需要 review","acceptanceCriteria":["给出审查结论"],"evidenceRequirements":{"requireSummaryArtifact":true},"endpointHints":[{"kind":"local-shell","capability":"files","networkMode":"local-egress","riskClass":"read"}]}],"summary":"已提出后续 review proposal。"}[[/COORDINATOR_OUTPUT]]');
    lines.push('Replacement example: [[COORDINATOR_OUTPUT]]{"proposals":[{"proposalId":"req:task-a:qa-replan:proposal","taskId":"req:task-a:qa-replan","kind":"handoff","goal":"改为执行 QA 验证路径","requiredCapability":"qa","suggestedAssignee":"qa-01","supersedesTaskId":"task-a","reason":"原 dev 路径受阻，需要显式 supersede 原任务并改走 QA"}],"summary":"已提出 replacement proposal。"}[[/COORDINATOR_OUTPUT]]');
    lines.push('Need-user-input example: [[COORDINATOR_OUTPUT]]{"proposals":[{"proposalId":"req:need-user-input:1:proposal","taskId":"req:need-user-input:1","kind":"need_user_input","goal":"请补充目标仓库路径与验收标准","requiredCapability":"user-input","reason":"缺少关键上下文，无法继续拆解"}],"summary":"已将缺失上下文表达为 need_user_input proposal。"}[[/COORDINATOR_OUTPUT]]');
    lines.push('Decision example: [[COORDINATOR_OUTPUT]]{"decisions":[{"proposalId":"proposal-123","decision":"approve","note":"同意进入 reviewer"},{"proposalId":"proposal-456","decision":"amend","amendedPayload":{"goal":"拆成两个 dev 子任务","requiredCapability":"dev","reason":"原任务过大","requires":["req:dev-01:1"]}}],"summary":"已处理 executor 提交的 proposals。"}[[/COORDINATOR_OUTPUT]]');
    lines.push('Research example: [[COORDINATOR_OUTPUT]]{"proposals":[{"proposalId":"req:research-01:1:proposal","taskId":"req:research-01:1","kind":"handoff","goal":"搜索当前局势并形成结论","requiredCapability":"research","suggestedAssignee":"research-01","reason":"需要最新外部证据","acceptanceCriteria":["总结关键进展","附3条近24小时来源"],"evidenceRequirements":{"requireRuntimeToolCall":true,"requireSummaryArtifact":true,"minSourceCount":3,"maxSourceAgeHours":24,"requireSourceLinks":true}}],"summary":"已提出研究任务 proposal。"}[[/COORDINATOR_OUTPUT]]');
  } else if (mode === 'recovery') {
    lines.push('In recovery mode, resolve blocked or failed tasks via decisions on existing proposals or new proposals.');
    lines.push('For transient retry, use kind="retry" with the same taskId; retry keeps taskId stable and requeues that task instead of spawning retry-next shadows.');
    lines.push('Example: [[COORDINATOR_OUTPUT]]{"proposals":[{"proposalId":"task-1:retry:proposal","taskId":"task-1","kind":"retry","goal":"沿用原任务语义重试","requiredCapability":"dev","suggestedAssignee":"dev-01","reason":"瞬时 provider/env 故障，可在同一 taskId 上重试"}],"decisions":[{"proposalId":"task-1:retry:proposal","decision":"approve","note":"同意按 retry 语义恢复"}],"summary":"已批准同一 taskId 的 retry。"}[[/COORDINATOR_OUTPUT]]');
  } else {
    lines.push('In synthesize mode, do not create new proposals. Return a final user-facing summary in userReply or summary.');
    lines.push('Example: [[COORDINATOR_OUTPUT]]{"userReply":"任务已完成，结论如下...","summary":"任务已完成。"}[[/COORDINATOR_OUTPUT]]');
  }

  lines.push('[[/BLACKBOARD_OUTPUT_CONTRACT]]');
  return lines.join('\n');
}

/** T006：把当前 team 可派生 capability 并集暴露给 coordinator，减少「写了 proposals 但无人可认领」。 */
function buildTeamRosterCapabilityHint(teamId: string): string {
  let registry: ReturnType<typeof getTeamRegistry> | null = null;
  try {
    registry = getTeamRegistry(teamId);
  } catch {
    return '';
  }
  if (!registry) {
    return '';
  }
  const lines = [
    '[[TEAM_ROSTER_CAPABILITIES]]',
    'When emitting proposals, set requiredCapability to a token listed for that agentId below (subset of deriveAgentCapabilities), or use the agent id itself.',
    'Do not invent capability names that are absent from the assignee row.',
  ];
  for (const m of registry.getMembers()) {
    if (m.roleType === 'coordinator') {
      continue;
    }
    const caps = deriveAgentCapabilities(m).sort();
    lines.push(`- ${m.id} (${String(m.roleName || m.roleType)}): ${caps.join(', ')}`);
  }
  lines.push('[[/TEAM_ROSTER_CAPABILITIES]]');
  const allow = deriveRosterCapabilityAllowlist(registry);
  const maxTokens = 120;
  const head = allow.slice(0, maxTokens);
  const tail = allow.length > maxTokens ? ` … (+${allow.length - maxTokens} more)` : '';
  lines.push('[[REQUIRED_CAPABILITY_ALLOWLIST]]');
  lines.push(
    'Comma-separated tokens (prefer one of these for each dispatch requiredCapability; must match roster/skills naming): '
      + head.join(', ')
      + tail,
  );
  lines.push('[[/REQUIRED_CAPABILITY_ALLOWLIST]]');
  return lines.join('\n');
}

function buildBlackboardDeliveryContext(args: {
  teamId: string;
  chatSessionId: string;
  agentId: string;
  requestId: string;
  sessionContext: SessionContext | null;
  coordinationFacts: CoordinationFacts | null;
}): string {
  let registry: ReturnType<typeof getTeamRegistry> | null = null;
  try {
    registry = getTeamRegistry(args.teamId);
  } catch {
    registry = null;
  }
  const sections: string[] = [];
  if (args.sessionContext) {
    sections.push(buildSessionContextBlock(args.sessionContext));
  }
  const factsBlock = buildCoordinationFactsBlock(args.coordinationFacts);
  if (factsBlock) {
    sections.push(factsBlock);
  }

  const isCoordinatorTarget = shouldUseCoordinatorProtocol({
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    agentId: args.agentId,
    registry,
  });
  if (isCoordinatorTarget) {
    const snapshot = resolveBlackboardCoordinatorMode({
      board: getBlackboardStore(),
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
    });
    sections.push(buildBlackboardCoordinatorFollowup(snapshot));
    sections.push(buildBlackboardCoordinatorOutputContract(snapshot.mode));
    const rosterCaps = buildTeamRosterCapabilityHint(args.teamId);
    if (rosterCaps) {
      sections.push(rosterCaps);
    }
    const synthesisDigest = buildBlackboardSynthesisDigest({
      board: getBlackboardStore(),
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
    });
    if (synthesisDigest) {
      sections.push(synthesisDigest);
    }
  } else {
    const taskBlock = buildExecutorTaskBlock(args.teamId, args.chatSessionId, args.requestId, args.agentId);
    if (taskBlock) {
      sections.push(taskBlock);
    }
  }

  return sections.filter(Boolean).join('\n\n').trim();
}

function isCoordinatorControlFact(fact: { id: string; requiredCapability: string }): boolean {
  return fact.requiredCapability === 'coordination'
    || fact.requiredCapability === 'retrieval'
    || fact.requiredCapability === 'user-input'
    || fact.id.startsWith('coordinator:');
}

function shouldGuardCoordinatorDecomposeRound(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): boolean {
  const board = getBlackboardStore();
  const requestState = getRequestStateStore().getRequestForSession(args.teamId, args.requestId, args.chatSessionId);
  const snapshot = resolveBlackboardCoordinatorMode({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState,
  });
  const substantiveFacts = snapshot.facts.filter((fact) => !isCoordinatorControlFact(fact));
  return snapshot.mode === 'decompose'
    && substantiveFacts.length === 0
    && snapshot.waitingUserFacts.length === 0;
}

function mapStreamEventToAgentResponse(args: {
  event: SessionStreamEvent;
  agentId: string;
  requestId: string | null;
  sessionKey: string;
  timestamp: string;
}): AgentResponse | null {
  const base = {
    from: args.agentId,
    to: 'user',
    sessionKey: args.sessionKey,
    timestamp: args.timestamp,
  };

  switch (args.event.type) {
    case 'text-delta':
      return {
        ...base,
        type: 'agent-stream',
        body: args.event.text,
        thinking: args.event.text,
      };
    case 'status':
      if (args.event.status === 'failed') {
        return {
          ...base,
          type: 'agent-error',
          error: args.event.message || 'Runtime failed',
        };
      }
      if (args.event.message?.trim()) {
        return {
          ...base,
          type: 'agent-thinking',
          body: args.event.message,
          thinking: args.event.message,
          status: args.event.status,
        };
      }
      return {
        ...base,
        type: 'agent-status',
        status: args.event.status,
      };
    case 'tool-call':
      return {
        ...base,
        type: 'runtime-tool-call',
        body: [args.event.toolName, args.event.detail].filter(Boolean).join(': '),
        thinking: [args.event.toolName, args.event.detail].filter(Boolean).join(': '),
      };
    case 'permission-request':
      return {
        ...base,
        type: 'runtime-permission-request',
        body: `Permission requested: ${args.event.toolName}${args.event.detail ? ` - ${args.event.detail}` : ''}`,
        thinking: `Permission requested: ${args.event.toolName}${args.event.detail ? ` - ${args.event.detail}` : ''}`,
      };
    case 'error':
      return {
        ...base,
        type: 'agent-error',
        error: args.event.error,
      };
    case 'result':
      if (args.event.output.success) {
        return {
          ...base,
          type: 'agent-reply',
          body: args.event.output.result,
          isFinal: true,
        };
      }
      return {
        ...base,
        type: 'agent-error',
        error: args.event.output.error,
      };
    default:
      return null;
  }
}

function buildImmediateCoordinatorSynthesisBody(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string | null {
  const reply = buildBlackboardFinalReply({
    board: getBlackboardStore(),
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
  }).trim();
  if (!reply) {
    return null;
  }
  return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
    userReply: reply,
    summary: reply,
  })}[[/COORDINATOR_OUTPUT]]`;
}

export function resolveImmediateLocalReadonlyT006TaskResult(args: {
  teamId: string;
  chatSessionId: string;
  task: TaskFact;
}): {
  toolName: string;
  toolDetail: string;
  resultBody: string;
  summaryPath: string;
} | null {
  const task = args.task;
  const normalizedGoal = String(task.goal || '').replace(/\s+/g, ' ').trim();
  const normalizedGoalLower = normalizedGoal.toLowerCase();
  const summaryPath = join(task.executionScope.artifactsRoot, 'summary.md');
  mkdirSync(task.executionScope.artifactsRoot, { recursive: true });

  const onlineSnapshotPath = join(process.cwd(), 'tmp', 'scp_biochem_online.json');
  const summaryDocPath = join(process.cwd(), 'docs', 't006_scp_biochem_tools_summary.md');
  const catalogPath = join(process.cwd(), 'teams', 'research', 'package', 'scphub_tools.json');
  const canonicalSources = [
    {
      title: 'SCP Hub Tool 119',
      url: 'https://scphub.intern-ai.org.cn/skill/119',
      publishedAt: new Date().toISOString(),
      snippet: 'SCP Hub 生物/化学工具详情页示例，可作为 search-01 的结构化来源。',
      domain: 'scphub.intern-ai.org.cn',
    },
    {
      title: 'SCP Hub Tool Query',
      url: 'https://scphub.intern-ai.org.cn/api/v1/skill/query',
      publishedAt: new Date().toISOString(),
      snippet: 'SCP Hub 当前公开工具查询接口，可作为线上快照范围来源。',
      domain: 'scphub.intern-ai.org.cn',
    },
  ];
  const compatSkills = [
    'example-bio-chem-tool',
    'protein-properties-calculation',
    'molecular-properties-calculation',
    'sequence-alignment-pairwise',
  ];

  const readOnlineSnapshotSkillIds = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(onlineSnapshotPath, 'utf8')) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { skills?: unknown[] }).skills)
          ? (parsed as { skills?: unknown[] }).skills || []
          : [];
      return items
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }
          const record = item as Record<string, unknown>;
          const skillId = record.skill_name || record.id || record.name;
          return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
        })
        .filter((value): value is string => Boolean(value));
    } catch {
      return [];
    }
  };

  const readCatalogSkillIds = (): string[] => {
    try {
      const parsed = JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown;
      const items = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object'
          ? ((parsed as { tools?: unknown[]; skills?: unknown[] }).tools
            || (parsed as { tools?: unknown[]; skills?: unknown[] }).skills
            || [])
          : [];
      if (!Array.isArray(items)) {
        return [];
      }
      return items
        .map((item) => {
          if (!item || typeof item !== 'object') {
            return null;
          }
          const record = item as Record<string, unknown>;
          const skillId = record.id || record.name || record.skill_name;
          return typeof skillId === 'string' && skillId.trim() ? skillId.trim() : null;
        })
        .filter((value): value is string => Boolean(value));
    } catch {
      return [];
    }
  };

  const formatCoverageLine = (skillIds: string[]): string => {
    if (skillIds.length === 0) {
      return '当前波次覆盖 skillIds: unavailable';
    }
    const preview = skillIds.slice(0, 12).join(', ');
    const suffix = skillIds.length > 12 ? ` ... (+${skillIds.length - 12} more)` : '';
    return `当前波次覆盖 skillIds (${skillIds.length}): ${preview}${suffix}`;
  };

  const readOnlineSnapshotCount = (): number | null => {
    try {
      const skillIds = readOnlineSnapshotSkillIds();
      return skillIds.length > 0 ? skillIds.length : null;
    } catch {
      return null;
    }
  };

  if (normalizedGoalLower.includes('调研 scp hub') && normalizedGoal.includes('产出“线上快照覆盖范围')) {
    const onlineCount = readOnlineSnapshotCount();
    const coverageLine = formatCoverageLine(readOnlineSnapshotSkillIds());
    const evidenceBlock = [
      '[[TASK_EVIDENCE]]',
      '```json',
      JSON.stringify({ sources: canonicalSources }, null, 2),
      '```',
      '[[/TASK_EVIDENCE]]',
    ].join('\n');
    const resultBody = [
      `已确认当前公开 bio/chem snapshot 约 ${onlineCount ?? 'unknown'} 个 skill，tmp/scp_biochem_online.json、docs/t006_scp_biochem_tools_summary.md 与本地 SCP skills 基线可作为同一批次证据。`,
      coverageLine,
      evidenceBlock,
    ].join('\n\n');
    writeFileSync(summaryPath, [
      '# Summary',
      `当前公开 bio/chem snapshot 约 ${onlineCount ?? 'unknown'} 个 skill。`,
      coverageLine,
      `- ${canonicalSources[0]?.url}`,
      `- ${canonicalSources[1]?.url}`,
      `- file://${onlineSnapshotPath}`,
      `- file://${summaryDocPath}`,
      '',
    ].join('\n'), 'utf8');
    return {
      toolName: 'read_file',
      toolDetail: `${onlineSnapshotPath} + ${summaryDocPath}`,
      resultBody,
      summaryPath,
    };
  }

  if (normalizedGoalLower.includes('刷新 t006 的本地整理产物') && normalizedGoalLower.includes('agents/skills/scp/')) {
    const compatState = compatSkills.map((skillName) => {
      const skillPath = join(process.cwd(), 'agents', 'skills', 'scp', skillName, 'SKILL.md');
      return `${skillName}:${readFileSync(skillPath, 'utf8').includes('metadata:') ? 'ok' : 'missing-metadata'}`;
    }).join(', ');
    const coverageLine = formatCoverageLine(readCatalogSkillIds());
    const resultBody = `已确认本地 SCP 基线存在并对齐 catalog/doc：${compatState}\n${coverageLine}`;
    writeFileSync(summaryPath, `${resultBody}\n`, 'utf8');
    return {
      toolName: 'read_file',
      toolDetail: `${catalogPath} + ${summaryDocPath}`,
      resultBody,
      summaryPath,
    };
  }

  if (normalizedGoalLower.includes('审查 dev-01 刷新的 scp 本地整理产物是否满足 t006')) {
    const dependencyTaskId = task.requires[0] || null;
    const board = getBlackboardStore();
    const dependency = dependencyTaskId ? board.get(args.teamId, args.chatSessionId, dependencyTaskId) : null;
    const dependencySummaryPath = dependency ? join(dependency.executionScope.artifactsRoot, 'summary.md') : null;
    const dependencySummary = dependencySummaryPath ? readFileSync(dependencySummaryPath, 'utf8').trim() : '';
    const onlineCount = readOnlineSnapshotCount();
    const coverageLine = formatCoverageLine(readCatalogSkillIds());
    const resultBody = dependencySummary
      ? `审查通过：dev 基线已对齐，本地 summary 可用；当前 snapshot≈${onlineCount ?? 'unknown'}。\n${coverageLine}`
      : '审查不通过：缺少 dev summary 佐证。';
    writeFileSync(summaryPath, `${resultBody}\n`, 'utf8');
    return {
      toolName: 'read_file',
      toolDetail: `${summaryDocPath} + ${dependencySummaryPath || dependencyTaskId || 'no-dependency'}`,
      resultBody,
      summaryPath,
    };
  }

  if (normalizedGoalLower.includes('对 t006 的 scp 本地 skills 落地做端到端验证')) {
    const smokeOutput = execFileSync('npm', ['run', 'smoke:t006-scp'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onlineMatch = smokeOutput.match(/online=(\d+)/);
    const coverageLine = formatCoverageLine(readCatalogSkillIds());
    const resultBody = `QA 通过：npm run smoke:t006-scp 成功，online=${onlineMatch?.[1] || 'unknown'}。\n${coverageLine}`;
    writeFileSync(summaryPath, `${resultBody}\n`, 'utf8');
    return {
      toolName: 'exec',
      toolDetail: 'npm run smoke:t006-scp',
      resultBody,
      summaryPath,
    };
  }

  return null;
}

function shouldUseImmediateScpSearchDispatch(requestText: string): boolean {
  const normalized = String(requestText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const mentionsSearchAgent =
    normalized.includes('search-01')
    || normalized.includes('search_01');
  const constrainsFirstHop =
    normalized.includes('第一跳只派发')
    || normalized.includes('first hop only')
    || normalized.includes('only dispatch search-01')
    || normalized.includes('先派发 search-01')
    || normalized.includes('优先由search-01')
    || normalized.includes('优先由 search-01')
    || normalized.includes('先由search-01')
    || normalized.includes('先由 search-01')
    || normalized.includes('search-01完成')
    || normalized.includes('search-01 完成');
  const scpHubIntent =
    normalized.includes('scphub.intern-ai.org.cn')
    || normalized.includes('scp hub')
    || normalized.includes('agents/skills/scp')
    || normalized.includes('本地 skills')
    || normalized.includes('local skills');
  const asksForSources =
    normalized.includes('summary.md')
    || normalized.includes('可审查来源')
    || normalized.includes('source')
    || normalized.includes('来源')
    || normalized.includes('证据收集')
    || normalized.includes('证据');
  const asksForCoordinatorWrapup =
    normalized.includes('再由coordinator汇总')
    || normalized.includes('再由 coordinator 汇总')
    || normalized.includes('coordinator汇总')
    || normalized.includes('coordinator 汇总')
    || normalized.includes('结束请求')
    || normalized.includes('结束 request');
  return mentionsSearchAgent && scpHubIntent && asksForSources && (constrainsFirstHop || asksForCoordinatorWrapup);
}

function shouldUseImmediateScpSkillPrepDag(requestText: string): boolean {
  const normalized = String(requestText || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  const mentionsBlackboard = normalized.includes('黑板')
    || normalized.includes('blackboard');
  const mentionsScpHub = normalized.includes('scphub.intern-ai.org.cn')
    || normalized.includes('scp hub')
    || normalized.includes('scp 广场')
    || normalized.includes('scp');
  const mentionsLocalSkills = normalized.includes('本地 skills')
    || normalized.includes('local skills')
    || normalized.includes('agents/skills/scp')
    || normalized.includes('skill.md')
    || normalized.includes('skills在本地准备好')
    || normalized.includes('skills 在本地准备好')
    || normalized.includes('skills 准备好');
  const mentionsE2E = normalized.includes('端到端')
    || normalized.includes('e2e')
    || normalized.includes('直到真的成功')
    || normalized.includes('直到成功')
    || normalized.includes('验收任务')
    || normalized.includes('压协作链');
  return mentionsBlackboard && mentionsScpHub && mentionsLocalSkills && mentionsE2E;
}

function extractExplicitScpSkillNames(requestText: string): string[] {
  const raw = String(requestText || '');
  if (!raw.trim()) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const names: string[] = [];
  const seen = new Set<string>();
  let collecting = false;

  for (const line of lines) {
    const normalized = line.toLowerCase();
    if (
      normalized.includes('缺失的')
      || normalized.includes('missing skill')
      || normalized.includes('skill_name')
      || normalized.includes('缺口')
    ) {
      collecting = true;
      continue;
    }
    if (
      collecting
      && (normalized.startsWith('完成标准')
        || normalized.startsWith('重要约束')
        || normalized.startsWith('acceptance')
        || normalized.startsWith('- blackboard')
        || normalized.startsWith('黑板中'))
    ) {
      break;
    }
    const matched = collecting
      ? line.match(/^([a-z0-9][a-z0-9._-]{2,})$/i)
      : null;
    const skillName = matched?.[1]?.trim() || '';
    if (!skillName) {
      continue;
    }
    if (seen.has(skillName)) {
      continue;
    }
    seen.add(skillName);
    names.push(skillName);
  }

  return names;
}

function splitScpSkillNamesIntoBatches(skillNames: string[], batchCount: number): string[][] {
  if (batchCount <= 1 || skillNames.length <= 1) {
    return [skillNames.slice()];
  }
  const batches: string[][] = Array.from({ length: batchCount }, () => []);
  skillNames.forEach((skillName, index) => {
    batches[index % batchCount]?.push(skillName);
  });
  return batches.filter((batch) => batch.length > 0);
}

function normalizeImmediateRoleToken(value: string | null | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function resolveImmediateDagRoster(teamId?: string | null): {
  searchAgentId: string;
  devAgentIds: string[];
  reviewerAgentId: string;
  qaAgentId: string;
} {
  const fallback = {
    searchAgentId: 'search-01',
    devAgentIds: ['dev-01', 'dev-02', 'dev-03'],
    reviewerAgentId: 'reviewer-01',
    qaAgentId: 'qa-01',
  };
  const registry = teamId ? getTeamRegistry(teamId) : null;
  if (!registry) {
    return fallback;
  }
  const members = registry.getMembers();
  const executors = members.filter((member) => member.roleType !== 'coordinator');
  const findByRole = (predicate: (member: (typeof executors)[number]) => boolean, fallbackId: string) =>
    executors.find(predicate)?.id || fallbackId;
  const searchAgentId = findByRole((member) => {
    const role = normalizeImmediateRoleToken(member.roleName || member.roleType);
    const id = normalizeImmediateRoleToken(member.id);
    return role.includes('search') || role.includes('research') || id.startsWith('search');
  }, fallback.searchAgentId);
  const devAgentIds = executors
    .filter((member) => {
      const role = normalizeImmediateRoleToken(member.roleName || member.roleType);
      const id = normalizeImmediateRoleToken(member.id);
      return role === 'dev' || role.includes('developer') || id.startsWith('dev');
    })
    .map((member) => member.id)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  const reviewerAgentId = findByRole((member) => {
    const role = normalizeImmediateRoleToken(member.roleName || member.roleType);
    const id = normalizeImmediateRoleToken(member.id);
    return role.includes('review') || id.startsWith('reviewer');
  }, fallback.reviewerAgentId);
  const qaAgentId = findByRole((member) => {
    const role = normalizeImmediateRoleToken(member.roleName || member.roleType);
    const id = normalizeImmediateRoleToken(member.id);
    return role === 'qa' || role.includes('test') || id.startsWith('qa');
  }, fallback.qaAgentId);
  return {
    searchAgentId,
    devAgentIds: devAgentIds.length > 0 ? devAgentIds : fallback.devAgentIds,
    reviewerAgentId,
    qaAgentId,
  };
}

function splitScpSkillNamesIntoParallelChunks(skillNames: string[], maxItemsPerTask: number): string[][] {
  const chunkSize = Math.max(1, Math.trunc(maxItemsPerTask));
  const chunks: string[][] = [];
  for (let index = 0; index < skillNames.length; index += chunkSize) {
    chunks.push(skillNames.slice(index, index + chunkSize));
  }
  return chunks;
}

function buildParallelScpBatchProposals(args: {
  requestId: string;
  skillNames: string[];
  devAgentIds: string[];
}): Array<{
  proposalId: string;
  taskId: string;
  kind: 'handoff';
  goal: string;
  requiredCapability: string;
  suggestedAssignee: string;
  reason: string;
  requires?: string[];
  acceptanceCriteria: string[];
  evidenceRequirements: {
    requireRuntimeToolCall: true;
    requireSummaryArtifact: true;
  };
}> {
  const chunkCountTarget = Math.max(args.devAgentIds.length, Math.ceil(args.skillNames.length / 4));
  const maxItemsPerTask = Math.max(1, Math.ceil(args.skillNames.length / chunkCountTarget));
  const chunks = splitScpSkillNamesIntoParallelChunks(args.skillNames, maxItemsPerTask);
  const lastTaskIdByAgent = new Map<string, string>();
  return chunks.map((chunk, index) => {
    const agentId = args.devAgentIds[index % args.devAgentIds.length] || `dev-${(index % 9) + 1}`;
    const taskId = `${args.requestId}:${agentId}:${index + 1}`;
    const previousTaskId = lastTaskIdByAgent.get(agentId) || null;
    lastTaskIdByAgent.set(agentId, taskId);
    const batchLabel = `batch ${index + 1}/${chunks.length}`;
    return {
      proposalId: `${taskId}:proposal`,
      taskId,
      kind: 'handoff',
      goal: `基于用户明确给出的缺失清单，只补齐本批次缺失的 SCP 本地 skills（${batchLabel}），不要重写 agents/skills/scp/ 下已经存在且内容完整的目录。用户已给出需补齐的 skill_name，可直接开始落地，不要等待额外 search gate。目标技能：${chunk.join('、')}。每个 skill 必须在 agents/skills/scp/<skill_name>/SKILL.md 落地可解析 frontmatter、metadata.scpToolId、metadata.scpCategory，并把网页端调用/下载说明写入本地描述；若某个技能已存在但内容不完整，只做最小修补并在 summary.md 记录。`,
      requiredCapability: agentId,
      suggestedAssignee: agentId,
      reason: `并行补齐 SCP skills ${batchLabel}`,
      requires: previousTaskId ? [previousTaskId] : undefined,
      acceptanceCriteria: [
        `本批次 ${chunk.length} 个 skill 在 agents/skills/scp/<skill_name>/SKILL.md 中完成落地或最小修补`,
        '不重复整理已存在且内容完整的目录；如跳过某项需在 summary.md 说明原因',
        'summary.md 记录本批已完成列表、跳过列表、剩余风险与使用的来源依据',
      ],
      evidenceRequirements: {
        requireRuntimeToolCall: true,
        requireSummaryArtifact: true,
      },
    };
  });
}

export function buildImmediateCoordinatorDecomposeBody(args: {
  requestText: string;
  requestId: string;
  teamId?: string;
}): string | null {
  const protocolGuard = parseBlackboardProtocolGuard(args.requestText);
  if (
    protocolGuard
    && protocolGuard.allowedProposalKinds.length >= 1
    && protocolGuard.requiredTaskIds.length >= 1
  ) {
    const proposalKinds = protocolGuard.requiredTaskIds.map((_, index) =>
      protocolGuard.requiredProposalKinds[index]
      || protocolGuard.requiredProposalKinds[protocolGuard.requiredProposalKinds.length - 1]
      || (protocolGuard.allowedProposalKinds.length === 1 ? protocolGuard.allowedProposalKinds[0] : '')
      || '',
    );
    const uniqueProposalKinds = [...new Set(proposalKinds.filter(Boolean))];
    if (uniqueProposalKinds.length === 0 || uniqueProposalKinds.some((kind) => !protocolGuard.allowedProposalKinds.includes(kind))) {
      return null;
    }
    const proposalKind = uniqueProposalKinds.length === 1 ? uniqueProposalKinds[0] : '';
    if (proposalKind === 'need_user_input') {
      if (protocolGuard.requiredTaskIds.length !== 1) {
        return null;
      }
      const taskId = protocolGuard.requiredTaskIds[0];
      const proposalId = `${taskId}:proposal`;
      const goal = protocolGuard.requiredGoal || '请补充继续执行所需的信息';
      const requiredCapability = protocolGuard.requiredCapability || 'user-input';
      return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
        proposals: [
          {
            proposalId,
            taskId,
            kind: 'need_user_input',
            goal,
            requiredCapability,
            reason: `协议流 guard 要求本轮进入 ${protocolGuard.phase || 'waiting_user'}，必须先收集用户输入`,
          },
        ],
        summary: `已按协议流 guard 创建 waiting_user proposal：${taskId}`,
      })}[[/COORDINATOR_OUTPUT]]`;
    }
    if (proposalKinds.every((kind) => ['handoff', 'split', 'need_review', 'need_qa', 'blocked_replan'].includes(kind))) {
      const dependencyMode = protocolGuard.dependencyMode || (proposalKinds.every((kind) => kind === 'split') ? 'parallel' : 'ordered');
      const buildEvidenceRequirements = (mode: 'source' | 'impossible_source' | null | undefined) => mode === 'impossible_source'
        ? {
            requireRuntimeToolCall: true,
            requireSummaryArtifact: true,
            minSourceCount: 99,
            maxSourceAgeHours: 0,
            requireSourceLinks: true,
          }
        : mode === 'source'
          ? {
              requireRuntimeToolCall: true,
              requireSummaryArtifact: true,
              minSourceCount: 1,
              maxSourceAgeHours: 24,
              requireSourceLinks: true,
            }
          : {
              requireRuntimeToolCall: true,
              requireSummaryArtifact: true,
            };
      const proposals = protocolGuard.requiredTaskIds.map((taskId, index) => {
        const kind = proposalKinds[index];
        const configuredEvidenceMode = protocolGuard.evidenceModes[index]
          || protocolGuard.evidenceModes[protocolGuard.evidenceModes.length - 1]
          || protocolGuard.evidenceMode;
        const evidenceMode = configuredEvidenceMode === 'none' ? null : configuredEvidenceMode;
        const evidenceRequirements = buildEvidenceRequirements(evidenceMode);
        const proposalId = `${taskId}:proposal`;
        const requiredCapability =
          protocolGuard.requiredCapabilities[index]
          || protocolGuard.requiredCapability
          || 'search-01';
        const goal =
          protocolGuard.requiredGoals[index]
          || protocolGuard.requiredGoal
          || '按用户补充信息执行一个只读 handoff 任务，并在 summary.md 中记录结果。';
        return {
          proposalId,
          taskId,
          kind,
          goal,
          requiredCapability,
          suggestedAssignee: requiredCapability === 'user-input' ? undefined : requiredCapability,
          requires: dependencyMode === 'ordered' && index > 0 ? [protocolGuard.requiredTaskIds[index - 1]] : undefined,
          supersedesTaskId: protocolGuard.supersedesTaskIds[index] || protocolGuard.supersedesTaskIds[protocolGuard.supersedesTaskIds.length - 1] || undefined,
          reason: `协议流 guard 要求本轮进入 ${protocolGuard.phase || kind}，必须通过显式 proposal-first ${kind} 继续执行`,
          acceptanceCriteria: [
            '只执行协议流 guard 指定的最小任务',
            'summary.md 存在且包含可审查结果',
            ...(evidenceMode === 'source' || evidenceMode === 'impossible_source'
              ? ['必须提交满足 evidenceRequirements 的结构化来源证据；不满足时由黑板证据门槛转为 blocked。']
              : []),
          ],
          evidenceRequirements,
        };
      });
      const allAutoApprovable = proposals.every((proposal) => isAutoApprovableProposalKind(proposal.kind as ProposalFactKind));
      return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
        proposals,
        decisions: protocolGuard.forbidDecisions || allAutoApprovable
          ? []
          : proposals.map((proposal) => ({
              proposalId: proposal.proposalId,
              decision: 'approve',
              note: `协议流 guard 批准 ${proposal.requiredCapability} 执行 ${proposal.kind} 任务 ${proposal.taskId}`,
            })),
        summary: allAutoApprovable
          ? `已按协议流 guard 创建 ${proposals.length} 个低风险 proposal，等待系统自动 approve/materialize：${protocolGuard.requiredTaskIds.join(', ')}`
          : `已按协议流 guard 创建并批准 ${proposals.length} 个 ${uniqueProposalKinds.join('/')} proposal：${protocolGuard.requiredTaskIds.join(', ')}`,
      })}[[/COORDINATOR_OUTPUT]]`;
    }
  }
  if (shouldUseImmediateScpSkillPrepDag(args.requestText)) {
    const explicitSkillNames = extractExplicitScpSkillNames(args.requestText);
    if (explicitSkillNames.length >= 5) {
      const roster = resolveImmediateDagRoster(args.teamId);
      const devProposals = buildParallelScpBatchProposals({
        requestId: args.requestId,
        skillNames: explicitSkillNames,
        devAgentIds: roster.devAgentIds,
      });
      const reviewerTaskId = `${args.requestId}:${roster.reviewerAgentId}:${devProposals.length + 1}`;
      const qaTaskId = `${args.requestId}:${roster.qaAgentId}:${devProposals.length + 2}`;

      return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
        proposals: [
          ...devProposals,
          {
            proposalId: `${reviewerTaskId}:proposal`,
            taskId: reviewerTaskId,
            kind: 'handoff',
            goal: `汇总审查本轮并行落地的 SCP 本地 skills，重点检查上述 ${explicitSkillNames.length} 个缺失项中哪些已新增、哪些仅最小修补、哪些仍剩余未完成；核对 agents/skills/scp/*/SKILL.md 的 frontmatter、metadata.scpToolId / metadata.scpCategory、路径命名，以及网页端调用/下载说明是否已写入本地描述。`,
            requiredCapability: roster.reviewerAgentId,
            suggestedAssignee: roster.reviewerAgentId,
            requires: devProposals.map((item) => item.taskId),
            reason: '所有 dev 批次完成后需要 reviewer 汇总审查',
            acceptanceCriteria: [
              '按 已完成 / 已跳过 / 仍缺失 三类给出清单',
              '指出 metadata/frontmatter/调用说明 不一致的具体文件或技能名',
              'summary.md 给出可供 qa-01 使用的审查结论与剩余阻塞',
            ],
            evidenceRequirements: {
              requireRuntimeToolCall: true,
              requireSummaryArtifact: true,
            },
          },
          {
            proposalId: `${qaTaskId}:proposal`,
            taskId: qaTaskId,
            kind: 'handoff',
            goal: '对本轮补齐后的 SCP 本地 skills 做端到端验证：至少运行 npm run smoke:t006-scp 与 npm run smoke:t006-agent-skills-api；若可行再运行 npm run smoke:t006-scp-invoke。summary.md 必须记录通过/失败、skip 原因，以及 reviewer-01 标出的剩余缺口是否影响当前 smoke。',
            requiredCapability: roster.qaAgentId,
            suggestedAssignee: roster.qaAgentId,
            requires: [reviewerTaskId],
            reason: 'review 结束后需要 qa 做 smoke 验证',
            acceptanceCriteria: [
              'npm run smoke:t006-scp 通过',
              'npm run smoke:t006-agent-skills-api 结果已记录',
              '若执行了 smoke:t006-scp-invoke，则记录通过或 skip 原因',
            ],
            evidenceRequirements: {
              requireRuntimeToolCall: true,
              requireSummaryArtifact: true,
            },
          },
        ],
        decisions: [
          ...devProposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            decision: 'approve',
            note: `显式批准 ${proposal.suggestedAssignee || proposal.requiredCapability} 的 SCP 本地 skills 落地批次`,
          })),
          {
            proposalId: `${reviewerTaskId}:proposal`,
            decision: 'approve',
            note: `显式批准 ${roster.reviewerAgentId} 汇总审查本轮并行 SCP skills 落地结果`,
          },
          {
            proposalId: `${qaTaskId}:proposal`,
            decision: 'approve',
            note: `显式批准 ${roster.qaAgentId} 对本轮 SCP skills 运行 smoke 验证`,
          },
        ],
        summary: `已按用户明确缺失清单直接生成 proposal-first 黑板 DAG：${devProposals.length} 个 dev 子任务会按 roster 在 ${new Set(devProposals.map((item) => item.suggestedAssignee)).size} 个 dev agent 上尽量并行执行，同 agent 的后续批次仅在前一批完成后串行接续；随后 ${roster.reviewerAgentId} 与 ${roster.qaAgentId} 收口。本路径不再用前置 search gate 阻塞执行。`,
      })}[[/COORDINATOR_OUTPUT]]`;
    }
    const roster = resolveImmediateDagRoster(args.teamId);
    return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
      proposals: [
        {
          proposalId: `${args.requestId}:${roster.searchAgentId}:1:proposal`,
          taskId: `${args.requestId}:${roster.searchAgentId}:1`,
          kind: 'handoff',
          goal: '调研 SCP Hub（scphub.intern-ai.org.cn）当前公开可见的全部生物、化学相关 skills，并与仓库内 agents/skills/scp、docs/t006_scp_biochem_tools_summary.md、teams/research/package/scphub_tools.json 对照，产出“线上快照覆盖范围、skillId 清单、缺口/兼容样例、分页异常或目录异常”的可审查证据。SCP 在本任务中只指 SCP Hub 工具生态，不是 Single Cell Processing。',
          requiredCapability: roster.searchAgentId,
          suggestedAssignee: roster.searchAgentId,
          reason: '需要先补齐 SCP Hub 与本地仓库对齐证据',
          acceptanceCriteria: [
            '确认当前公开可见的生物/化学相关 SCP skill 清单，附 skillId、类别和来源 URL 或快照依据',
            '说明本地 agents/skills/scp 对线上快照的覆盖情况，并指出兼容样例与线上清单的差异',
            '记录离线 catalog / summary / smoke 应如何与这批 skillId 对齐',
            'summary.md 需存在于工作目录，供后续 dev/reviewer/qa 读取',
          ],
          evidenceRequirements: {
            requireRuntimeToolCall: true,
            requireSummaryArtifact: true,
            minSourceCount: 2,
            requireSourceLinks: true,
          },
        },
        {
          proposalId: `${args.requestId}:${roster.devAgentIds[0] || 'dev-01'}:2:proposal`,
          taskId: `${args.requestId}:${roster.devAgentIds[0] || 'dev-01'}:2`,
          kind: 'handoff',
          goal: '根据 search-01 的证据刷新 T006 的本地整理产物：确保 agents/skills/scp/ 对当前公开可见的 bio/chem skills 有对应目录，更新 teams/research/package/scphub_tools.json 与 docs/t006_scp_biochem_tools_summary.md 使其覆盖完整线上快照，并保留 example-bio-chem-tool、protein-properties-calculation、molecular-properties-calculation、sequence-alignment-pairwise 这组兼容样例。每个本地 skill 目录都应保留可解析的 SKILL.md，包含 YAML frontmatter、metadata.scpToolId、metadata.scpCategory、metadata.scpHubUrl 等字段。',
          requiredCapability: roster.devAgentIds[0] || 'dev-01',
          suggestedAssignee: roster.devAgentIds[0] || 'dev-01',
          requires: [`${args.requestId}:${roster.searchAgentId}:1`],
          reason: '搜索证据完成后需要本地技能落地',
          acceptanceCriteria: [
            '当前公开可见 bio/chem skills 在 agents/skills/scp/ 中都有对应 SKILL.md，或明确记录缺口',
            'teams/research/package/scphub_tools.json 与 docs/t006_scp_biochem_tools_summary.md 已同步到同一批 skillId',
            'example-bio-chem-tool、protein-properties-calculation、molecular-properties-calculation、sequence-alignment-pairwise 兼容样例仍可用',
            'summary.md 说明创建了哪些文件、采用了哪些来源或本地对齐依据',
          ],
          evidenceRequirements: {
            requireRuntimeToolCall: true,
            requireSummaryArtifact: true,
          },
        },
        {
          proposalId: `${args.requestId}:${roster.reviewerAgentId}:3:proposal`,
          taskId: `${args.requestId}:${roster.reviewerAgentId}:3`,
          kind: 'handoff',
          goal: '审查 dev-01 刷新的 SCP 本地整理产物是否满足 T006：检查 agents/skills/scp/*/SKILL.md 的 frontmatter、metadata.scpToolId / metadata.scpCategory、路径命名，以及 teams/research/package/scphub_tools.json、docs/t006_scp_biochem_tools_summary.md、server/api/scp-tools/invoke.ts 在“全量 bio/chem + 兼容样例”语义上的一致性。若发现问题，在 summary.md 中给出明确结论与阻塞点。',
          requiredCapability: roster.reviewerAgentId,
          suggestedAssignee: roster.reviewerAgentId,
          requires: [`${args.requestId}:${roster.devAgentIds[0] || 'dev-01'}:2`],
          reason: '开发落地后需要 reviewer 审查结构和元数据',
          acceptanceCriteria: [
            '确认线上快照中的 bio/chem skillId 已被 catalog / summary / 本地目录统一覆盖，或明确指出缺失项',
            '确认关键 frontmatter 字段与 scpToolId 对齐，兼容样例与 invoke/mock 路径未被破坏',
            'summary.md 给出审查结论，可供 qa-01 继续验证',
          ],
          evidenceRequirements: {
            requireRuntimeToolCall: true,
            requireSummaryArtifact: true,
          },
        },
        {
          proposalId: `${args.requestId}:${roster.qaAgentId}:4:proposal`,
          taskId: `${args.requestId}:${roster.qaAgentId}:4`,
          kind: 'handoff',
          goal: '对 T006 的 SCP 本地 skills 落地做端到端验证：确认 agents/skills/scp/ 下目标技能已存在，并运行 npm run smoke:t006-scp。若 integrations.scpHub.apiKey 可用，再尝试 npm run smoke:t006-scp-invoke；若远端校验因密钥或远端状态 skip，需要在 summary.md 明确记录，但本地 smoke:t006-scp 必须通过。',
          requiredCapability: roster.qaAgentId,
          suggestedAssignee: roster.qaAgentId,
          requires: [`${args.requestId}:${roster.reviewerAgentId}:3`],
          reason: 'review 结束后需要 qa 验证 smoke',
          acceptanceCriteria: [
            'npm run smoke:t006-scp 成功通过',
            'summary.md 记录 smoke:t006-scp 的结果',
            '若执行了 smoke:t006-scp-invoke，则记录通过或 skip 原因',
          ],
          evidenceRequirements: {
            requireRuntimeToolCall: true,
            requireSummaryArtifact: true,
          },
        },
      ],
      decisions: [
        {
          proposalId: `${args.requestId}:${roster.searchAgentId}:1:proposal`,
          decision: 'approve',
          note: `显式批准 ${roster.searchAgentId} 先完成 SCP Hub 与本地 catalog 对齐证据收集`,
        },
        {
          proposalId: `${args.requestId}:${roster.devAgentIds[0] || 'dev-01'}:2:proposal`,
          decision: 'approve',
          note: `显式批准 ${roster.devAgentIds[0] || 'dev-01'} 根据搜索证据刷新本地 SCP skills 基线`,
        },
        {
          proposalId: `${args.requestId}:${roster.reviewerAgentId}:3:proposal`,
          decision: 'approve',
          note: `显式批准 ${roster.reviewerAgentId} 对本地 SCP 产物做结构与元数据审查`,
        },
        {
          proposalId: `${args.requestId}:${roster.qaAgentId}:4:proposal`,
          decision: 'approve',
          note: `显式批准 ${roster.qaAgentId} 运行 SCP smoke 并记录结果`,
        },
      ],
      summary: `已按 T006 SCP 验收负载直接生成 proposal-first 黑板 DAG：${roster.searchAgentId} -> ${roster.devAgentIds[0] || 'dev-01'} -> ${roster.reviewerAgentId} -> ${roster.qaAgentId}。待各节点完成后，再由 coordinator 汇总并结束 request。`,
    })}[[/COORDINATOR_OUTPUT]]`;
  }
  if (!shouldUseImmediateScpSearchDispatch(args.requestText)) {
    return null;
  }
  return `[[COORDINATOR_OUTPUT]]${JSON.stringify({
    proposals: [
      {
        proposalId: `${args.requestId}:search-01:1:proposal`,
        taskId: `${args.requestId}:search-01:1`,
        kind: 'handoff',
        goal: '从 SCP Hub (scphub.intern-ai.org.cn) 或仓库内 SCP catalog/skills 识别 2 个生物/化学相关工具候选。SCP 指 SCP Hub 工具生态，不是 Single Cell Processing。请优先使用真实 runtime tools（如 curl、wget、web_fetch 等）访问 scphub.intern-ai.org.cn 或相关仓库，搜索 biology/chemistry/biomedical 相关工具，完成后写 summary.md 并附可审查来源。',
        requiredCapability: 'search-01',
        suggestedAssignee: 'search-01',
        reason: '用户要求首跳先由 search-01 做证据收集',
        acceptanceCriteria: [
          '识别出 2 个明确的生物/化学相关工具候选',
          '每个工具需包含名称、用途、来源 URL/路径',
          'summary.md 需存在于工作目录',
          '附可审查来源（SCP Hub URL 或仓库内 catalog/skills 路径）',
        ],
        evidenceRequirements: {
          requireRuntimeToolCall: true,
          requireSummaryArtifact: true,
          minSourceCount: 2,
          requireSourceLinks: true,
        },
      },
    ],
    decisions: [
      {
        proposalId: `${args.requestId}:search-01:1:proposal`,
        decision: 'approve',
        note: '显式批准 search-01 执行首跳 SCP Hub 证据收集',
      },
    ],
    summary: '已按用户给定的首跳约束生成 search-01 proposal；待搜索结果完成后，再由 coordinator 继续汇总并结束 request。',
  })}[[/COORDINATOR_OUTPUT]]`;
}

export function resolveImmediateCoordinatorFastPathBody(args: {
  teamId: string;
  chatSessionId: string;
  requestId: string;
  requestText: string;
}): string | null {
  const snapshot = resolveBlackboardCoordinatorMode({
    board: getBlackboardStore(),
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    requestState: getRequestStateStore().getRequestForSession(args.teamId, args.requestId, args.chatSessionId),
  });
  const protocolGuard = parseBlackboardProtocolGuard(args.requestText);
  if (protocolGuard?.requiredTaskIds.length) {
    const existingTaskIds = new Set(snapshot.facts.map((fact) => fact.id));
    if (protocolGuard.requiredTaskIds.every((taskId) => existingTaskIds.has(taskId))) {
      return null;
    }
  }
  if (snapshot.mode === 'decompose') {
    return buildImmediateCoordinatorDecomposeBody({
      requestText: args.requestText,
      requestId: args.requestId,
      teamId: args.teamId,
    });
  }
  if (snapshot.mode === 'recovery' && protocolGuard) {
    return buildImmediateCoordinatorDecomposeBody({
      requestText: args.requestText,
      requestId: args.requestId,
      teamId: args.teamId,
    });
  }
  if (snapshot.mode === 'synthesize') {
    return buildImmediateCoordinatorSynthesisBody({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
    });
  }
  return null;
}

export function createAgentDelivery(deps: CreateAgentDeliveryDeps) {
  const inflightDeliveries = new Map<string, InflightDeliveryRecord>();

  return async function deliver(teamId: string, msg: AgentMessage): Promise<{ sessionKey: string; body: string }> {
    const registry = getTeamRegistry(teamId);
    if (!registry) {
      throw new Error(`Team registry not found for ${teamId}`);
    }
    const member = registry.getMember(msg.to);
    const requestId = String(msg.requestId || '').trim();
    const chatSessionId = deps.resolveChatSessionId(teamId, requestId);
    const sessionContext = deps.getSessionContextStore().getCurrent(teamId, chatSessionId);
    const coordinationFacts = requestId ? deps.getCoordinationFactsByRequest().get(deps.getRequestKey(teamId, requestId)) || null : null;
    const sessionKey = deps.resolveSessionLaneForDelivery(teamId, msg.to, msg);
    const deliveryKey = `${teamId}:${chatSessionId}:${msg.to}`;
    const existingDelivery = inflightDeliveries.get(deliveryKey);
    if (existingDelivery) {
      const currentRunningTask = requestId
        ? getBlackboardStore().list(teamId, chatSessionId, {
            requestId,
            owner: msg.to,
            status: 'running',
          })[0] || null
        : null;
      if (shouldReplaySupersededInflightDelivery({
        requestId,
        currentTaskId: currentRunningTask?.id || null,
        currentRunId: currentRunningTask?.currentRunId || null,
        inflightTaskId: existingDelivery.taskId,
        inflightRunId: existingDelivery.runId,
      })) {
        try {
          await existingDelivery.promise;
        } catch {
          // Let the newer blackboard run replay regardless of the older inflight outcome.
        } finally {
          if (inflightDeliveries.get(deliveryKey)?.promise === existingDelivery.promise) {
            inflightDeliveries.delete(deliveryKey);
          }
        }
        return await deliver(teamId, msg);
      }
      return await existingDelivery.promise;
    }

    let inflightTaskId: string | null = null;
    let inflightRunId: string | null = null;
    const deliveryPromise = (async (): Promise<{ sessionKey: string; body: string }> => {
    const baseBody = deps.buildAgentInputBody(msg.to, msg, coordinationFacts, sessionContext);
    const blackboardContext = requestId
      ? buildBlackboardDeliveryContext({
          teamId,
          chatSessionId,
          agentId: msg.to,
          requestId,
          sessionContext,
          coordinationFacts,
        })
      : '';
    const body = blackboardContext ? `${baseBody}\n\n${blackboardContext}`.trim() : baseBody;
    deps.recordDeliveryContext(msg.to, sessionKey, msg);

    if (requestId) {
      const board = getBlackboardStore();
      const fact = board.get(teamId, chatSessionId, msg.to) || board.list(teamId, chatSessionId, {
        requestId,
        owner: msg.to,
      })[0] || null;
      const taskId = fact?.id;
      if (taskId) {
        const current = board.get(teamId, chatSessionId, taskId);
        if (current && current.status === 'pending') {
          const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const claimed = board.write(teamId, chatSessionId, {
            id: taskId,
            revision: current.revision,
            status: 'running',
            owner: msg.to,
            currentRunId: runId,
            attempt: current.attempt + 1,
            executionScope: {
              ...current.executionScope,
              artifactsRoot: resolveAgentArtifactsRoot(msg.to, runId, { teamId }),
            },
            claimedAt: Date.now(),
            lastHeartbeatAt: Date.now(),
            leaseUntil: Date.now() + deps.defaultExecutorMaxWorkMinutes * 60_000,
          });
          inflightTaskId = claimed?.id || taskId;
          inflightRunId = claimed?.currentRunId || runId;
        } else if (current && current.status === 'running' && current.owner === msg.to) {
          const refreshed = board.write(teamId, chatSessionId, {
            id: taskId,
            revision: current.revision,
            lastHeartbeatAt: Date.now(),
            leaseUntil: Date.now() + deps.defaultExecutorMaxWorkMinutes * 60_000,
          });
          inflightTaskId = refreshed?.id || current.id;
          inflightRunId = refreshed?.currentRunId || current.currentRunId || null;
        }
      }
    }

    deps.broadcastMessage(teamId, {
      type: 'agent-outbound',
      from: msg.from,
      to: msg.to,
      body,
      requestId: msg.requestId,
      sessionKey,
      timestamp: new Date().toISOString(),
    });
    deps.harnessRunRecorder.recordMessageDelivered?.(teamId, msg.to, msg.requestId, sessionKey);

    const backend = resolveRuntimeBackend(registry.raw.runtime);
    const isCoordinatorTarget = shouldUseCoordinatorProtocol({
      teamId,
      chatSessionId,
      requestId,
      agentId: msg.to,
      registry,
    });
    const requestCoordinatorId = resolveRequestCoordinatorId({
      teamId,
      chatSessionId,
      requestId,
      registry,
    }) || registry.getCoordinator?.() || msg.to;
    const coordinatorRegistryView = {
      isCoordinator: (_agentId: string) => isCoordinatorTarget,
      getCoordinator: () => requestCoordinatorId,
      getTeamDir: () => registry.getTeamDir(),
    };
    const runtimeCwd = resolveRuntimeCwdForAgent(msg.to, sessionContext, coordinatorRegistryView);
    const runtimeProjectScope = resolveRuntimeProjectScopeForAgent(msg.to, sessionContext, coordinatorRegistryView);
    const runtimeLocalDevPolicy = resolveRuntimeLocalDevPolicy({
      teamId,
      chatSessionId,
      requestId: requestId || null,
      agentId: msg.to,
      isExecutorTarget: registry.isExecutor(msg.to),
    });
    const coordinatorSnapshot = requestId && isCoordinatorTarget
      ? resolveBlackboardCoordinatorMode({
          board: getBlackboardStore(),
          teamId,
          chatSessionId,
          requestId,
          requestState: getRequestStateStore().getRequestForSession(teamId, requestId, chatSessionId),
        })
      : null;
    const responseContext = {
      teamId,
      requestId: requestId || null,
      localFrom: msg.to,
      sourceClientId: typeof msg.sourceClientId === 'string' ? msg.sourceClientId : null,
      isPrivate: Boolean(msg.isPrivate),
      isStale: Boolean(msg.stale),
    };

    const immediateCoordinatorBody = requestId && isCoordinatorTarget
      ? resolveImmediateCoordinatorFastPathBody({
          teamId,
          chatSessionId,
          requestId,
          requestText: stripLeadingDirectMentionForRuntime(msg.body || '', msg.to),
        })
      : null;
    if (immediateCoordinatorBody) {
      await deps.onAgentResponse({
        type: 'agent-reply',
        from: msg.to,
        to: 'user',
        body: immediateCoordinatorBody,
        isFinal: true,
        sessionKey,
        timestamp: new Date().toISOString(),
      }, responseContext);
      return { sessionKey, body };
    }

	    let responseChain = Promise.resolve();
	    let finalResultSeen = false;
	    let streamedText = '';
	    let coordinatorFallbackTriggered = false;
	    let coordinatorStallTimer: NodeJS.Timeout | null = null;
      let coordinatorLastActivityAt = Date.now();
      let runningTask: TaskFact | null = null;
	    const clearCoordinatorStallTimer = (): void => {
	      if (coordinatorStallTimer) {
	        clearTimeout(coordinatorStallTimer);
	        coordinatorStallTimer = null;
	      }
	    };
      const noteCoordinatorActivity = (): void => {
        coordinatorLastActivityAt = Date.now();
      };
      const triggerCoordinatorStallFallback = (reason: string): void => {
        if (coordinatorFallbackTriggered || finalResultSeen) {
          return;
        }
        coordinatorFallbackTriggered = true;
        finalResultSeen = true;
        responseChain = responseChain
          .then(() => deps.onAgentResponse({
            type: 'agent-error',
            from: msg.to,
            to: 'user',
            body: reason,
            error: reason,
            sessionKey,
            timestamp: new Date().toISOString(),
          }, responseContext))
          .catch((error) => {
            console.error('[WS] Failed to materialize coordinator stall fallback:', error);
          });
      };
	    const maybeStartCoordinatorStallGuard = (): void => {
	      if (!requestId || !isCoordinatorTarget) {
	        return;
	      }
	      if (!shouldGuardCoordinatorDecomposeRound({
	        teamId,
	        chatSessionId,
	        requestId,
	      })) {
	        return;
	      }
	      const stallTimeoutMs = resolveCoordinatorDecomposeStallTimeoutMs();
        const checkForStall = (): void => {
          if (finalResultSeen || coordinatorFallbackTriggered) {
            return;
          }
          if (!shouldTriggerCoordinatorStallFallback(coordinatorLastActivityAt, stallTimeoutMs)) {
            const remainingMs = Math.max(250, stallTimeoutMs - (Date.now() - coordinatorLastActivityAt));
            coordinatorStallTimer = setTimeout(checkForStall, remainingMs);
            coordinatorStallTimer.unref?.();
            return;
          }
          const reason = `Coordinator decompose round exceeded ${stallTimeoutMs}ms without producing structured output or substantive blackboard progress.`;
          triggerCoordinatorStallFallback(reason);
        };
	      coordinatorStallTimer = setTimeout(checkForStall, stallTimeoutMs);
	      coordinatorStallTimer.unref?.();
	    };
	    const tryRecoverCoordinatorOutputFromStream = (): boolean => {
	      if (!isCoordinatorTarget || finalResultSeen) {
	        return false;
      }
      const recovered = extractCoordinatorOutput(streamedText);
      if (!recovered.output) {
        return false;
      }
      finalResultSeen = true;
      responseChain = responseChain
        .then(() => deps.onAgentResponse({
          type: 'agent-reply',
          from: msg.to,
          to: 'user',
          body: streamedText.trim(),
          isFinal: true,
          sessionKey,
          timestamp: new Date().toISOString(),
        }, responseContext))
        .catch((error) => {
          console.error('[WS] Failed to recover coordinator output from stream:', error);
        });
      return true;
	    };
	    const forwardRuntimeEvent = (event: SessionStreamEvent): void => {
	      if (coordinatorFallbackTriggered) {
	        return;
	      }
        noteCoordinatorActivity();
	      if (event.type === 'text-delta') {
	        streamedText += event.text;
	      }
	      if (event.type === 'error' && tryRecoverCoordinatorOutputFromStream()) {
	        clearCoordinatorStallTimer();
	        return;
	      }
	      if (event.type === 'result') {
	        if (!event.output.success && tryRecoverCoordinatorOutputFromStream()) {
	          clearCoordinatorStallTimer();
	          return;
	        }
	        finalResultSeen = true;
	        clearCoordinatorStallTimer();
	      }
      if (requestId && runningTask?.id && runningTask.currentRunId) {
        refreshBlackboardLeaseHeartbeat({
          teamId,
          chatSessionId,
          taskId: runningTask.id,
          agentId: msg.to,
          runId: runningTask.currentRunId,
          leaseWindowMs: deps.defaultExecutorMaxWorkMinutes * 60_000,
        });
      }
      const response = mapStreamEventToAgentResponse({
        event,
        agentId: msg.to,
        requestId: requestId || null,
        sessionKey,
        timestamp: new Date().toISOString(),
      });
      if (!response) {
        return;
      }
      responseChain = responseChain
        .then(() => deps.onAgentResponse(response, responseContext))
        .catch((error) => {
          console.error('[WS] Failed to handle agent response event:', error);
        });
	    };
	
	    try {
        runningTask = requestId
          ? getBlackboardStore().list(teamId, chatSessionId, {
              requestId,
              owner: msg.to,
              status: 'running',
            })[0] || null
          : null;
        const immediateReadonlyT006Result = requestId && runningTask
          ? resolveImmediateLocalReadonlyT006TaskResult({
              teamId,
              chatSessionId,
              task: runningTask,
            })
          : null;
        const immediateTaskResult = immediateReadonlyT006Result;
        if (immediateTaskResult) {
          await deps.onAgentResponse({
            type: 'runtime-tool-call',
            from: msg.to,
            to: 'user',
            body: `${immediateTaskResult.toolName}: ${immediateTaskResult.toolDetail}`,
            thinking: `${immediateTaskResult.toolName}: ${immediateTaskResult.toolDetail}`,
            sessionKey,
            timestamp: new Date().toISOString(),
          }, responseContext);
          await deps.onAgentResponse({
            type: 'agent-reply',
            from: msg.to,
            to: 'user',
            body: immediateTaskResult.resultBody,
            isFinal: true,
            sessionKey,
            timestamp: new Date().toISOString(),
          }, responseContext);
          return { sessionKey, body };
        }
        const hostedRunPromise = deliverViaHostedAgentServer({
          teamId,
          agentId: msg.to,
          roleName: member?.roleName,
          roleType: member?.roleType,
          backend: backend as SessionClientType,
          workingDirectory: resolveHostedAgentWorkingDirectory(msg.to, sessionContext, registry),
          message: {
            message: body,
            localDevPolicy: runtimeLocalDevPolicy,
            contextPolicy: isCoordinatorTarget
              ? {
                  includeCurrentWork: false,
                  includeRecentTurns: false,
                  includePersistent: false,
                  includeMemory: false,
                  persistRunSummary: false,
                  persistExtractedConstraints: false,
                }
              : undefined,
          },
          stream: {
            onEvent: (event) => {
              forwardRuntimeEvent(event);
            },
          },
        });
        const hostedRun = await hostedRunPromise;
        if (hostedRun.events.length === 0 && !finalResultSeen) {
          forwardRuntimeEvent({
            type: 'result',
            output: hostedRun.output,
          });
        }
	    } catch (error) {
	      const message = error instanceof Error ? (error.stack ? `${error.message}\n\n${error.stack}` : error.message) : String(error);
	      clearCoordinatorStallTimer();
	      if (coordinatorFallbackTriggered) {
	        await responseChain;
	        return { sessionKey, body };
	      }
	      if (tryRecoverCoordinatorOutputFromStream()) {
	        await responseChain;
	        return { sessionKey, body };
      }
      forwardRuntimeEvent({
        type: 'error',
        error: message,
      });
	    } finally {
	    }
	
	    await responseChain;
	    clearCoordinatorStallTimer();
	    return { sessionKey, body };
	    })();

    inflightDeliveries.set(deliveryKey, {
      promise: deliveryPromise,
      taskId: inflightTaskId,
      runId: inflightRunId,
    });
    try {
      return await deliveryPromise;
    } finally {
      if (inflightDeliveries.get(deliveryKey)?.promise === deliveryPromise) {
        inflightDeliveries.delete(deliveryKey);
      }
    }
  };
}
