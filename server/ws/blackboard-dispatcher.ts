import { randomUUID } from 'crypto';
import type { AgentMessage } from '../../core/runtime/types.js';
import { tickBlackboardAgent } from '../../core/runtime/blackboard-agent.js';
import type { DecisionFact, ProposalFact, TaskFact, ToolBinding } from '../../core/runtime/blackboard-types.js';
import type { BlackboardStore } from '../../core/store/blackboard-store.js';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';
import { getRequestStateStore } from '../../core/store/request-state-store.js';
import type { TeamChatStore } from '../../core/store/team-chat-store.js';
import { getTeamChatStore } from '../../core/store/team-chat-store.js';
import type { TeamRegistry } from '../../core/team/registry.js';
import { resolveHostedAgentServerId } from '../../core/runtime/hosted-agent-server-id.js';
import { getAgentServerClient } from '../agent_server/client.js';
import { resolveRuntimeBackend } from '../runtime/session-runner-registry.js';
import { disposeSupervisorSession, listSupervisorSessions } from '../runtime/supervisor-client.js';
import { ensureCoordinatorSynthesisTask } from '../runtime/request-finalization.js';
import { resolveLowRiskProposalBacklog } from '../runtime/blackboard-low-risk.js';
import {
  canMaterializeProposalDecision,
  latestDecisionForProposal,
} from '../../core/runtime/blackboard-proposals.js';
import { getEnabledSkillAliasesForTeam, normalizeSkillId } from '../api/skill-registry.js';
import { getEndpointRegistry, type ToolEndpoint } from '../api/endpoints.js';
import { deriveRunningHeartbeatWindow, type RunningHeartbeatState } from '../../core/runtime/running-heartbeat.js';
import { deriveAgentLivenessSnapshot, isFreshRunningHeartbeatState } from '../../core/runtime/agent-liveness.js';

export interface BlackboardDispatchPlanItem {
  agentId: string;
  taskId: string;
  requestId: string;
  kind: 'claimed' | 'continue' | 'ping';
  runId?: string;
  endpointBindings?: ToolBinding[];
  body: string;
  message: AgentMessage;
}

interface DrainBlackboardDispatchArgs {
  teamId: string;
  requestId: string;
  chatSessionId: string;
  registry: TeamRegistry;
  runtimeBusyAgentIds?: Set<string>;
  board?: BlackboardStore;
  teamChatStore?: TeamChatStore;
  deliver?: (message: AgentMessage) => Promise<unknown> | unknown;
}

const ORPHAN_RUNNING_TASK_IDLE_MS = 90_000;
const DETACHED_HOSTED_TASK_IDLE_MS = 30_000;
const BUSY_ORPHAN_HOSTED_SESSION_IDLE_MS = 90_000;
const WORK_CONTINUITY_PING_AFTER_MS = 90_000;
const WORK_CONTINUITY_RESET_AFTER_PING_MS = 90_000;
const MAX_AUTO_RESET_RETRYABLE_ENV_FAILURES = 3;

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function filterEnabledMemberSkills(member: { skills?: string[] }, enabledSkillAliases: Set<string> | null): string[] {
  const skills = member.skills || [];
  if (!enabledSkillAliases) {
    return skills;
  }
  return skills.filter((skill) => enabledSkillAliases.has(normalizeSkillId(skill)));
}

function retainCoordinatorOwnershipOnReset(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  coordinatorAgentId?: string | null;
  task: TaskFact | null;
}): TaskFact | null {
  const coordinatorAgentId = String(args.coordinatorAgentId || '').trim();
  if (!args.task) {
    return null;
  }
  if (!coordinatorAgentId || args.task.requiredCapability !== 'coordination') {
    return args.task;
  }
  if (String(args.task.owner || '').trim() === coordinatorAgentId) {
    return args.task;
  }
  return args.board.write(args.teamId, args.chatSessionId, {
    id: args.task.id,
    revision: args.task.revision,
    owner: coordinatorAgentId,
  }) || args.task;
}

function isCoordinatorControlTask(task: Pick<TaskFact, 'id' | 'requiredCapability'>): boolean {
  return task.requiredCapability === 'coordination' || task.id.startsWith('coordinator:');
}

function releaseCoordinatorOwnedSubstantiveTasks(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorAgentId: string | null;
}): string[] {
  const coordinatorAgentId = String(args.coordinatorAgentId || '').trim();
  if (!coordinatorAgentId) {
    return [];
  }
  const releasedTaskIds: string[] = [];
  const tasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    owner: coordinatorAgentId,
  }).filter((task) =>
    (task.status === 'pending' || task.status === 'running')
    && !isCoordinatorControlTask(task));

  for (const task of tasks) {
    const released = task.status === 'running'
      ? args.board.reset(args.teamId, args.chatSessionId, task.id, 'lease_expired_reset')
      : args.board.write(args.teamId, args.chatSessionId, {
          id: task.id,
          revision: task.revision,
          owner: null,
          currentRunId: null,
          claimedAt: undefined,
          lastHeartbeatAt: undefined,
          leaseUntil: undefined,
        });
    if (released) {
      releasedTaskIds.push(released.id);
    }
  }
  return releasedTaskIds;
}

function normalizeRoleName(roleName?: string | null): string {
  return String(roleName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** 与 {@link tickBlackboardAgent} 认领逻辑一致，供黑板 API 诊断 capability 覆盖 */
export function deriveAgentCapabilities(member: {
  id: string;
  roleType?: string;
  roleName?: string;
  skills?: string[];
}, options?: {
  coordinatorAgentId?: string | null;
}): string[] {
  const capabilities = new Set<string>();
  capabilities.add('general');
  capabilities.add(member.id);
  const normalizedMemberId = normalizeRoleName(member.id);
  if (normalizedMemberId) {
    capabilities.add(normalizedMemberId);
  }
  const normalizedRole = normalizeRoleName(member.roleName || member.roleType);
  if (normalizedRole) {
    capabilities.add(normalizedRole);
  }
  const coordinatorAgentId = String(options?.coordinatorAgentId || '').trim();
  if ((coordinatorAgentId && coordinatorAgentId === member.id) || (!coordinatorAgentId && member.roleType === 'coordinator')) {
    capabilities.add('coordination');
  }
  if (/review/.test(normalizedRole)) {
    capabilities.add('review');
  }
  if (/qa|test/.test(normalizedRole)) {
    capabilities.add('qa');
  }
  if (/research|literature/.test(normalizedRole)) {
    capabilities.add('research');
  }
  if (/tool|operator/.test(normalizedRole)) {
    capabilities.add('tools');
  }
  for (const skill of member.skills || []) {
    capabilities.add(String(skill).trim().toLowerCase());
  }
  return [...capabilities];
}

function deriveDispatchAgentCapabilities(member: {
  id: string;
  roleType?: string;
  roleName?: string;
  skills?: string[];
}, options?: {
  coordinatorAgentId?: string | null;
}): string[] {
  const coordinatorAgentId = String(options?.coordinatorAgentId || '').trim();
  if ((coordinatorAgentId && coordinatorAgentId === member.id) || (!coordinatorAgentId && member.roleType === 'coordinator')) {
    return ['coordination'];
  }
  return deriveAgentCapabilities(member, options);
}

export function deriveDispatchCapabilitiesWithSkillPolicy(member: {
  id: string;
  roleType?: string;
  roleName?: string;
  skills?: string[];
}, options?: {
  coordinatorAgentId?: string | null;
  enabledSkillAliases?: Set<string> | null;
}): string[] {
  const dispatchMember = {
    ...member,
    skills: filterEnabledMemberSkills(member, options?.enabledSkillAliases ?? null),
  };
  return deriveDispatchAgentCapabilities(dispatchMember, {
    coordinatorAgentId: options?.coordinatorAgentId,
  });
}

function buildDispatchSelectionReason(args: {
  member: { id: string; roleType?: string; roleName?: string; skills?: string[] };
  task: TaskFact;
  capabilities: string[];
  enabledSkillAliases?: Set<string> | null;
  endpointBindings?: ToolBinding[];
}): string {
  const matchedCapability = args.capabilities.includes(args.task.requiredCapability)
    ? args.task.requiredCapability
    : args.capabilities.find((capability) => capability === args.task.owner) || 'owner/preassigned';
  const enabledSkills = filterEnabledMemberSkills(args.member, args.enabledSkillAliases ?? null);
  const enabledSkillSet = new Set(enabledSkills.map(normalizeSkillId));
  const disabledSkills = (args.member.skills || [])
    .map((skill) => normalizeSkillId(skill))
    .filter((skill) => skill && !enabledSkillSet.has(skill));
  const skillMatches = enabledSkills
    .map((skill) => String(skill || '').trim().toLowerCase())
    .filter((skill) => skill && (
      skill === args.task.requiredCapability
      || args.task.executionScope.allowedTools?.includes(skill)
      || args.task.goal.toLowerCase().includes(skill)
    ));
  const workspace = args.task.executionScope.workspaceId || 'workspace:default';
  const cwd = args.task.executionScope.cwd || 'cwd:n/a';
  return [
    `dispatch match: agent=${args.member.id}`,
    `capability=${matchedCapability}`,
    skillMatches.length ? `skills=${dedupe(skillMatches).join(',')}` : 'skills=none',
    disabledSkills.length ? `disabledSkills=${dedupe(disabledSkills).join(',')}` : 'disabledSkills=none',
    `endpoints=${formatEndpointBindingSummary(args.endpointBindings || [])}`,
    `workspace=${workspace}`,
    `cwd=${cwd}`,
  ].join(' · ');
}

function normalizeEndpointSignal(value: string | undefined | null): string {
  return String(value || '').trim().toLowerCase();
}

function endpointIsRunnable(endpoint: ToolEndpoint): boolean {
  return endpoint.enabled && endpoint.health.status !== 'error' && endpoint.health.status !== 'offline';
}

function endpointMatchesCapability(endpoint: ToolEndpoint, capability: string): boolean {
  const wanted = normalizeEndpointSignal(capability);
  if (!wanted || wanted === 'general') {
    return false;
  }
  return endpoint.capabilities.some((candidate) => {
    const normalized = normalizeEndpointSignal(candidate);
    return normalized === wanted || normalized.includes(wanted) || wanted.includes(normalized);
  });
}

function endpointMatchesTaskText(endpoint: ToolEndpoint, task: TaskFact): boolean {
  const haystack = [
    task.goal,
    task.requiredCapability,
    ...(task.executionScope.allowedTools || []),
    ...(task.endpointHints || []).map((hint) => hint.capability || ''),
  ].join('\n').toLowerCase();
  return endpoint.capabilities.concat(endpoint.tags, endpoint.kind, endpoint.transport, endpoint.provider)
    .map(normalizeEndpointSignal)
    .filter((value) => value.length >= 3)
    .some((value) => haystack.includes(value));
}

function buildBinding(endpoint: ToolEndpoint, task: TaskFact, capability: string): ToolBinding {
  return {
    endpointId: endpoint.id,
    capability,
    cwd: endpoint.kind === 'local-shell' || endpoint.kind === 'ssh-host'
      ? task.executionScope.cwd
      : endpoint.workspace?.root,
    networkMode: task.networkMode || endpoint.networkMode,
    allowedRoots: endpoint.safety.allowedRoots || task.executionScope.allowedRoots,
    allowedTools: task.executionScope.allowedTools,
    riskClass: task.riskClass || endpoint.safety.riskClasses[0],
    evidencePolicy: endpoint.evidence,
  };
}

function compareEndpointPreference(task: TaskFact): (left: ToolEndpoint, right: ToolEndpoint) => number {
  return (left, right) => {
    const score = (endpoint: ToolEndpoint): number => {
      let value = 0;
      if (endpointIsRunnable(endpoint)) value += 80;
      if (task.networkMode && endpoint.networkMode === task.networkMode) value += 25;
      if (task.riskClass && endpoint.safety.riskClasses.includes(task.riskClass)) value += 20;
      if (endpoint.health.status === 'available') value += 10;
      if (endpoint.id === task.executionScope.workspaceId) value += 50;
      if (task.executionScope.workspaceId.startsWith('local:') && endpoint.id === 'local:shell') value += 45;
      if (task.executionScope.workspaceId.startsWith('ssh:') && endpoint.id === task.executionScope.workspaceId) value += 45;
      if (endpoint.kind === 'local-shell' || endpoint.kind === 'ssh-host' || endpoint.kind === 'remote-worker') value += 5;
      return value;
    };
    return score(right) - score(left) || left.id.localeCompare(right.id);
  };
}

export function deriveTaskEndpointBindings(task: TaskFact, endpoints: ToolEndpoint[]): ToolBinding[] {
  const usableEndpoints = endpoints
    .filter(endpointIsRunnable)
    .sort(compareEndpointPreference(task));
  const selected = new Map<string, ToolBinding>();
  const addBinding = (endpoint: ToolEndpoint | undefined, capability: string): void => {
    if (!endpoint || selected.has(endpoint.id)) {
      return;
    }
    selected.set(endpoint.id, buildBinding(endpoint, task, capability));
  };

  for (const binding of task.toolBindings || []) {
    if (binding.endpointId && binding.capability) {
      selected.set(binding.endpointId, binding);
    }
  }

  for (const hint of task.endpointHints || []) {
    const byId = hint.endpointId ? usableEndpoints.find((endpoint) => endpoint.id === hint.endpointId) : undefined;
    const byKind = hint.kind ? usableEndpoints.find((endpoint) => endpoint.kind === hint.kind) : undefined;
    const byCapability = hint.capability
      ? usableEndpoints.find((endpoint) => endpointMatchesCapability(endpoint, hint.capability || ''))
      : undefined;
    addBinding(byId || byKind || byCapability, hint.capability || task.requiredCapability);
  }

  const workspaceEndpoint = usableEndpoints.find((endpoint) => endpoint.id === task.executionScope.workspaceId)
    || (task.executionScope.workspaceId.startsWith('local:')
      ? usableEndpoints.find((endpoint) => endpoint.id === 'local:shell')
      : undefined)
    || (task.executionScope.workspaceId.startsWith('ssh:')
      ? usableEndpoints.find((endpoint) => endpoint.id === task.executionScope.workspaceId)
      : undefined);
  addBinding(workspaceEndpoint, task.requiredCapability === 'general' ? 'workspace' : task.requiredCapability);

  const requestedCapabilities = dedupe([
    task.requiredCapability,
    ...(task.executionScope.allowedTools || []),
    ...(task.endpointHints || []).map((hint) => hint.capability || ''),
  ]);
  for (const capability of requestedCapabilities) {
    const endpoint = usableEndpoints.find((candidate) =>
      !selected.has(candidate.id)
      && endpointMatchesCapability(candidate, capability)
      && (!task.networkMode || candidate.networkMode === task.networkMode || candidate.kind !== 'ssh-host'));
    addBinding(endpoint, capability);
  }

  const serviceMatches = usableEndpoints
    .filter((endpoint) => endpoint.kind === 'scp-service' || endpoint.kind === 'mcp-server' || endpoint.kind === 'http-api')
    .filter((endpoint) => !selected.has(endpoint.id))
    .filter((endpoint) => endpointMatchesTaskText(endpoint, task))
    .slice(0, 4);
  for (const endpoint of serviceMatches) {
    const capability = requestedCapabilities.find((candidate) => endpointMatchesCapability(endpoint, candidate))
      || endpoint.capabilities[0]
      || 'service';
    addBinding(endpoint, capability);
  }

  if (selected.size === 0) {
    addBinding(usableEndpoints.find((endpoint) => endpoint.id === 'local:shell') || usableEndpoints[0], 'workspace');
  }

  return [...selected.values()].slice(0, 8);
}

export function formatEndpointBindingSummary(bindings: ToolBinding[]): string {
  if (bindings.length === 0) {
    return 'none';
  }
  return bindings
    .map((binding) => [
      binding.endpointId,
      binding.capability,
      binding.networkMode,
      binding.riskClass,
    ].filter(Boolean).join('/'))
    .join(',');
}

export function shouldResetOrphanRunningHostedTask(args: {
  hostedSessionBusy?: boolean | null;
  hasHostedSession?: boolean;
  hostedSessionStatus?: string | null;
  hostedSessionCurrentRequestId?: string | null;
  taskRequestId?: string | null;
  idleMs: number;
  sessionIdleMs?: number | null;
  runningHeartbeatState?: RunningHeartbeatState | null;
}): boolean {
  if (isFreshRunningHeartbeatState(args.runningHeartbeatState || null)) {
    return false;
  }
  if (!Number.isFinite(args.idleMs) || args.idleMs < ORPHAN_RUNNING_TASK_IDLE_MS) {
    const hostedSessionStatus = String(args.hostedSessionStatus || '').trim();
    const hostedSessionCurrentRequestId = String(args.hostedSessionCurrentRequestId || '').trim();
    const taskRequestId = String(args.taskRequestId || '').trim();
    const sessionIdleMs = Number(args.sessionIdleMs ?? NaN);
    const detachedFromRequest =
      hostedSessionStatus === 'ready'
      || hostedSessionStatus === 'error'
      || hostedSessionStatus === 'offline';
    const requestDrifted =
      Boolean(taskRequestId)
      && Boolean(hostedSessionCurrentRequestId)
      && hostedSessionCurrentRequestId !== taskRequestId;
    const requestDetached = !hostedSessionCurrentRequestId || requestDrifted;
    if (
      args.hasHostedSession
      && !args.hostedSessionBusy
      && detachedFromRequest
      && requestDetached
      && (
        args.idleMs >= DETACHED_HOSTED_TASK_IDLE_MS
        && (!Number.isFinite(sessionIdleMs) || sessionIdleMs >= DETACHED_HOSTED_TASK_IDLE_MS)
      )
    ) {
      return true;
    }
    return false;
  }
  if (!args.hasHostedSession) {
    return true;
  }
  return !args.hostedSessionBusy;
}

export function shouldResetRetryableBlockedHostedTask(args: {
  blockedKind?: string | null;
  blockedReason?: string | null;
  retryable?: boolean | null;
  hasHostedSession?: boolean;
  hostedSessionBusy?: boolean | null;
  hostedSessionStatus?: string | null;
  hostedSessionCurrentRequestId?: string | null;
  taskRequestId?: string | null;
  sessionIdleMs?: number | null;
  autoResetCount?: number | null;
}): boolean {
  if (!args.retryable) {
    return false;
  }
  const blockedKind = String(args.blockedKind || '').trim();
  const blockedReason = String(args.blockedReason || '').toLowerCase();
  const hostedSessionStatus = String(args.hostedSessionStatus || '').trim();
  const disposedForRecovery = blockedReason.includes('dispose stale hosted session before auto-recovering request')
    || blockedReason.includes('runtime session stopped by supervisor')
    || blockedReason.includes('session disposed for recovery');
  const recoverableEnvFailure = blockedKind === 'env_error';
  const autoResetCount = Number(args.autoResetCount || 0);
  if (recoverableEnvFailure && autoResetCount >= MAX_AUTO_RESET_RETRYABLE_ENV_FAILURES) {
    return false;
  }
  const taskRequestId = String(args.taskRequestId || '').trim();
  const hostedSessionCurrentRequestId = String(args.hostedSessionCurrentRequestId || '').trim();
  const liveness = deriveAgentLivenessSnapshot({
    hostedSessionBusy: args.hostedSessionBusy,
    hostedSessionStatus: args.hostedSessionStatus,
    idleMs: args.sessionIdleMs,
    staleAfterMs: BUSY_ORPHAN_HOSTED_SESSION_IDLE_MS,
  });
  if (
    args.hasHostedSession
    && liveness.state === 'active'
    && (!taskRequestId || !hostedSessionCurrentRequestId || taskRequestId === hostedSessionCurrentRequestId)
  ) {
    return false;
  }
  if (!args.hasHostedSession) {
    return disposedForRecovery || recoverableEnvFailure;
  }
  if (recoverableEnvFailure) {
    return true;
  }
  return !args.hostedSessionBusy && hostedSessionStatus === 'error';
}

export function shouldDisposeBusyHostedSessionWithoutRunningFact(args: {
  currentRequestId?: string | null;
  lastRequestId?: string | null;
  activeRequestId?: string | null;
  idleMs?: number | null;
  hostedSessionBusy?: boolean | null;
  hostedSessionStatus?: string | null;
}): boolean {
  const activeRequestId = String(args.activeRequestId || '').trim();
  const currentRequestId = String(args.currentRequestId || '').trim();
  const lastRequestId = String(args.lastRequestId || '').trim();
  const idleMs = Number(args.idleMs ?? Number.POSITIVE_INFINITY);
  if (Number.isFinite(idleMs) && idleMs < BUSY_ORPHAN_HOSTED_SESSION_IDLE_MS) {
    return false;
  }
  if (activeRequestId && (currentRequestId === activeRequestId || lastRequestId === activeRequestId)) {
    return false;
  }
  const liveness = deriveAgentLivenessSnapshot({
    hostedSessionBusy: args.hostedSessionBusy,
    hostedSessionStatus: args.hostedSessionStatus,
    idleMs,
    staleAfterMs: BUSY_ORPHAN_HOSTED_SESSION_IDLE_MS,
  });
  if (liveness.state === 'active' || liveness.state === 'awaiting') {
    return false;
  }
  return true;
}

function countAutoResetRetryableEnvFailures(task: TaskFact): number {
  return task.failureHistory.filter((event) =>
    event.resetKind === 'hosted_run_recovery_reset'
    && event.blockedBy?.kind === 'env_error'
    && event.blockedBy?.retryable === true,
  ).length;
}

export function formatWorkContinuityEvent(event: {
  t: 'pull' | 'ping' | 'ok' | 'block' | 'done';
  task?: string;
  why?: string;
  dep?: string;
  ev?: string;
}): string {
  const compact: Record<string, string> = { t: event.t };
  if (event.task) compact.task = event.task;
  if (event.why) compact.why = event.why;
  if (event.dep) compact.dep = event.dep;
  if (event.ev) compact.ev = event.ev;
  return JSON.stringify(compact);
}

export function shouldPingStaleRunningTask(args: {
  idleMs: number;
  lastPingAt?: number | null;
  lastProgressAt?: number | null;
}): boolean {
  if (!Number.isFinite(args.idleMs) || args.idleMs < WORK_CONTINUITY_PING_AFTER_MS) {
    return false;
  }
  const lastPingAt = Number(args.lastPingAt || 0);
  const lastProgressAt = Number(args.lastProgressAt || 0);
  return lastPingAt <= lastProgressAt;
}

export function shouldResetStaleRunningTaskAfterPing(args: {
  idleMs: number;
  lastPingAt?: number | null;
  lastProgressAt?: number | null;
  now?: number;
}): boolean {
  if (!Number.isFinite(args.idleMs) || args.idleMs < WORK_CONTINUITY_PING_AFTER_MS + WORK_CONTINUITY_RESET_AFTER_PING_MS) {
    return false;
  }
  const lastPingAt = Number(args.lastPingAt || 0);
  const lastProgressAt = Number(args.lastProgressAt || 0);
  if (lastPingAt <= lastProgressAt) {
    return false;
  }
  const now = Number(args.now ?? Date.now());
  return Number.isFinite(now) && now - lastPingAt >= WORK_CONTINUITY_RESET_AFTER_PING_MS;
}

function lastProgressAt(task: TaskFact): number {
  return Math.max(
    Number(task.claimedAt || 0),
    Number(task.lastHeartbeatAt || 0),
    Number(task.updatedAt && !task.lastHeartbeatAt ? task.updatedAt : 0),
  );
}

function deriveWorkspaceIds(task: TaskFact): string[] {
  return dedupe([task.executionScope.workspaceId]);
}

function deriveServedRoots(task: TaskFact): string[] {
  return dedupe([task.executionScope.cwd, ...task.executionScope.allowedRoots]);
}

function latestUserRequestMessage(
  teamChatStore: TeamChatStore,
  teamId: string,
  chatSessionId: string,
  requestId: string,
): string {
  const history = teamChatStore.getHistory(teamId, chatSessionId);
  const latest = [...history.messages]
    .reverse()
    .find((message) => message.requestId === requestId && message.agent === 'user');
  return String(latest?.text || '').trim();
}

function buildDispatchBody(args: {
  teamChatStore: TeamChatStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  agentId: string;
  task: TaskFact;
  kind: 'claimed' | 'continue' | 'ping';
}): string {
  if (args.kind === 'ping') {
    return formatWorkContinuityEvent({ t: 'ping', task: args.task.id });
  }
  if (args.agentId === args.task.owner && args.task.requiredCapability === 'coordination') {
    return latestUserRequestMessage(args.teamChatStore, args.teamId, args.chatSessionId, args.requestId) || args.task.goal;
  }
  return args.task.goal;
}

function buildDispatchMessage(args: {
  teamId: string;
  requestId: string;
  agentId: string;
  body: string;
}): AgentMessage {
  return {
    id: `blackboard-dispatch-${randomUUID()}`,
    from: 'system',
    to: args.agentId,
    body: args.body,
    replyTo: null,
    mentions: [args.agentId],
    timestamp: Date.now(),
    teamId: args.teamId,
    requestId: args.requestId,
    isPrivate: true,
    stale: false,
    messagePlane: 'control',
  };
}

function materializeRunnableApprovedProposals(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string[] {
  const proposals = args.board.listProposals(args.teamId, args.chatSessionId, { requestId: args.requestId });
  const decisions = args.board.listDecisions(args.teamId, args.chatSessionId, { requestId: args.requestId });
  const createdTaskIds: string[] = [];
  for (const proposal of proposals) {
    const latestDecision = latestDecisionForProposal(decisions, proposal.id);
    if (!latestDecision) {
      continue;
    }
    if (!canMaterializeProposalDecision(latestDecision)) {
      continue;
    }
    if ((latestDecision.materializedTaskIds || []).length > 0) {
      continue;
    }
    const task = args.board.materializeApprovedProposal(
      args.teamId,
      args.chatSessionId,
      proposal.id,
    );
    if (task) {
      createdTaskIds.push(task.id);
    }
  }
  return createdTaskIds;
}

function blockPendingTasksOnTerminalDependencyFailure(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): string[] {
  const changedTaskIds: string[] = [];
  const pendingTasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    status: 'pending',
  });
  for (const task of pendingTasks) {
    const terminalDependency = task.requires
      .map((dependencyId) => args.board.get(args.teamId, args.chatSessionId, dependencyId))
      .find((dependency) =>
        Boolean(dependency)
        && (dependency!.status === 'blocked' || dependency!.status === 'failed')
        && dependency!.blockedBy?.retryable === false,
      );
    if (!terminalDependency) {
      continue;
    }
    const next = args.board.write(args.teamId, args.chatSessionId, {
      id: task.id,
      revision: task.revision,
      status: 'blocked',
      blockedBy: {
        kind: 'unknown',
        retryable: false,
        message: `依赖任务「${terminalDependency.id}」已 ${terminalDependency.status} 且不可自动恢复：${String(terminalDependency.blockedBy?.message || terminalDependency.result || 'upstream terminal failure').trim()}`,
      },
    });
    if (next) {
      changedTaskIds.push(next.id);
    }
  }
  return changedTaskIds;
}

async function recoverDuplicateRunningCoordinatorTasks(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorAgentId: string | null;
  registry: TeamRegistry;
}): Promise<string[]> {
  const coordinatorAgentId = String(args.coordinatorAgentId || '').trim();
  if (!coordinatorAgentId) {
    return [];
  }
  const runningCoordinatorTasks = args.board.list(args.teamId, args.chatSessionId, {
    capability: 'coordination',
    status: 'running',
  }).filter((task) => task.owner === coordinatorAgentId);
  if (runningCoordinatorTasks.length <= 1) {
    return [];
  }
  const resetTaskIds: string[] = [];
  for (const task of runningCoordinatorTasks) {
    const reset = args.board.reset(args.teamId, args.chatSessionId, task.id, 'lease_expired_reset');
    if (reset) {
      resetTaskIds.push(reset.id);
    }
  }
  const runtime = resolveRuntimeBackend(args.registry.raw.runtime);
  const hostedAgentId = resolveHostedAgentServerId(args.teamId, coordinatorAgentId);
  try {
    await disposeSupervisorSession(runtime, {
      teamId: args.teamId,
      agentId: coordinatorAgentId,
      persistentKey: `agent-server:${hostedAgentId}`,
      reason: `dispose duplicate running coordinator sessions before redispatching request ${args.requestId}`,
    });
  } catch (error) {
    console.warn('[blackboard] failed to dispose duplicate coordinator session during recovery:', error);
  }
  return resetTaskIds;
}

async function recoverOrphanRunningHostedTasks(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorAgentId: string | null;
  registry: TeamRegistry;
  runtimeBusyAgentIds?: Set<string>;
}): Promise<string[]> {
  const runtime = resolveRuntimeBackend(args.registry.raw.runtime);
  const sessions = await listSupervisorSessions(runtime, args.teamId);
  const hostedSessions = new Map(
    sessions
      .filter((session) => String(session.persistentKey || '').startsWith('agent-server:'))
      .map((session) => [String(session.persistentKey), session] as const),
  );
  const now = Date.now();
  const resetTaskIds: string[] = [];
  const runningTasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    status: 'running',
  });
  for (const task of runningTasks) {
    const owner = String(task.owner || '').trim();
    if (!owner) {
      continue;
    }
    const hostedKey = `agent-server:${resolveHostedAgentServerId(args.teamId, owner)}`;
    const hostedSession = hostedSessions.get(hostedKey);
    const runtimeReportsBusy = Boolean(args.runtimeBusyAgentIds?.has(owner));
    const lastHeartbeatAt = Number(task.lastHeartbeatAt || task.claimedAt || 0);
    const idleMs = lastHeartbeatAt > 0 ? now - lastHeartbeatAt : Number.POSITIVE_INFINITY;
    const heartbeat = deriveRunningHeartbeatWindow(task, now);
    const sessionLastEventAt = parseIsoMs(hostedSession?.lastEventAt || hostedSession?.lastUsedAt || hostedSession?.startedAt || null);
    const sessionIdleMs = sessionLastEventAt > 0 ? now - sessionLastEventAt : null;
    if (!shouldResetOrphanRunningHostedTask({
      hasHostedSession: Boolean(hostedSession) || runtimeReportsBusy,
      hostedSessionBusy: hostedSession?.busy || runtimeReportsBusy,
      hostedSessionStatus: hostedSession?.status || (runtimeReportsBusy ? 'busy' : null),
      hostedSessionCurrentRequestId: hostedSession?.currentRequestId || hostedSession?.lastRequestId || (runtimeReportsBusy ? task.requestId : null),
      taskRequestId: task.requestId,
      idleMs,
      sessionIdleMs,
      runningHeartbeatState: heartbeat.state,
    })) {
      continue;
    }
    const reset = args.board.reset(args.teamId, args.chatSessionId, task.id, 'lease_expired_reset');
    if (reset) {
      const reassigned = retainCoordinatorOwnershipOnReset({
        board: args.board,
        teamId: args.teamId,
        chatSessionId: args.chatSessionId,
        coordinatorAgentId: args.coordinatorAgentId,
        task: reset,
      });
      resetTaskIds.push(reassigned?.id || reset.id);
    }
  }
  return resetTaskIds;
}

async function recoverBusyHostedSessionsWithoutRunningFacts(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  registry: TeamRegistry;
}): Promise<string[]> {
  const runtime = resolveRuntimeBackend(args.registry.raw.runtime);
  const sessions = await listSupervisorSessions(runtime, args.teamId);
  const runningOwners = new Set(
    args.board.list(args.teamId, args.chatSessionId, {
      status: 'running',
    }).map((task) => String(task.owner || '').trim()).filter(Boolean),
  );
  const disposedAgentIds: string[] = [];

  for (const session of sessions) {
    if (!session.busy || session.status !== 'busy') {
      continue;
    }
    if (!String(session.persistentKey || '').startsWith('agent-server:')) {
      continue;
    }
    const agentId = String(session.agentId || '').trim();
    if (!agentId || runningOwners.has(agentId)) {
      continue;
    }
    const sessionLastEventAt = parseIsoMs(session.lastEventAt || session.lastUsedAt || session.startedAt || null);
    const idleMs = sessionLastEventAt > 0 ? Date.now() - sessionLastEventAt : Number.POSITIVE_INFINITY;
    if (!shouldDisposeBusyHostedSessionWithoutRunningFact({
      activeRequestId: args.requestId,
      currentRequestId: session.currentRequestId || null,
      lastRequestId: session.lastRequestId || null,
      idleMs,
      hostedSessionBusy: session.busy,
      hostedSessionStatus: session.status,
    })) {
      continue;
    }
    try {
      await disposeSupervisorSession(runtime, {
        teamId: args.teamId,
        agentId,
        persistentKey: String(session.persistentKey || ''),
        reason: `dispose busy hosted session without matching blackboard running fact for ${agentId}`,
      });
      disposedAgentIds.push(agentId);
    } catch (error) {
      console.warn('[blackboard] failed to dispose busy orphan hosted session during dispatch:', error);
    }
  }

  return dedupe(disposedAgentIds);
}

async function recoverRetryableBlockedHostedTasks(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  coordinatorAgentId: string | null;
  registry: TeamRegistry;
}): Promise<string[]> {
  const runtime = resolveRuntimeBackend(args.registry.raw.runtime);
  const sessions = await listSupervisorSessions(runtime, args.teamId);
  const hostedSessions = new Map(
    sessions
      .filter((session) => String(session.persistentKey || '').startsWith('agent-server:'))
      .map((session) => [String(session.persistentKey), session] as const),
  );

  const resetTaskIds: string[] = [];
  const disposedKeys = new Set<string>();
  const blockedTasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    status: 'blocked',
  });

  for (const task of blockedTasks) {
    if (!task.blockedBy?.retryable) {
      continue;
    }
    const owner = String(task.owner || '').trim();
    if (!owner) {
      continue;
    }
    const hostedKey = `agent-server:${resolveHostedAgentServerId(args.teamId, owner)}`;
    const hostedSession = hostedSessions.get(hostedKey);
    const sessionLastEventAt = parseIsoMs(hostedSession?.lastEventAt || hostedSession?.lastUsedAt || hostedSession?.startedAt || null);
    if (!shouldResetRetryableBlockedHostedTask({
      blockedKind: task.blockedBy?.kind || null,
      blockedReason: task.blockedBy?.message || null,
      retryable: task.blockedBy?.retryable,
      hasHostedSession: Boolean(hostedSession),
      hostedSessionBusy: hostedSession?.busy,
      hostedSessionStatus: hostedSession?.status,
      hostedSessionCurrentRequestId: hostedSession?.currentRequestId || hostedSession?.lastRequestId || null,
      taskRequestId: task.requestId,
      sessionIdleMs: sessionLastEventAt > 0
        ? Date.now() - sessionLastEventAt
        : null,
      autoResetCount: countAutoResetRetryableEnvFailures(task),
    })) {
      continue;
    }

    if (hostedSession && !disposedKeys.has(hostedKey)) {
      try {
        await disposeSupervisorSession(runtime, {
          teamId: args.teamId,
          agentId: owner,
          persistentKey: hostedKey,
          reason: `dispose stale errored hosted session before retrying blocked task ${task.id} in request ${args.requestId}`,
        });
      } catch (error) {
        console.warn('[blackboard] failed to dispose stale hosted session during blocked-task recovery:', error);
        continue;
      }
      disposedKeys.add(hostedKey);
    }

    const reset = args.board.reset(args.teamId, args.chatSessionId, task.id, 'hosted_run_recovery_reset');
    if (reset) {
      const reassigned = retainCoordinatorOwnershipOnReset({
        board: args.board,
        teamId: args.teamId,
        chatSessionId: args.chatSessionId,
        coordinatorAgentId: args.coordinatorAgentId,
        task: reset,
      });
      resetTaskIds.push(reassigned?.id || reset.id);
    }
  }

  return dedupe(resetTaskIds);
}

function parseIsoMs(value: string | null | undefined): number {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

async function reconcileCompletedCoordinatorHostedRuns(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
  teamChatStore: TeamChatStore;
}): Promise<string[]> {
  const coordinatorTasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    capability: 'coordination',
    status: 'running',
  }).filter((task) => String(task.owner || '').trim());
  if (coordinatorTasks.length === 0) {
    return [];
  }

  const changedTaskIds: string[] = [];
  for (const task of coordinatorTasks) {
    const ownerId = String(task.owner || '').trim();
    if (!ownerId) {
      continue;
    }
    const hostedAgentId = resolveHostedAgentServerId(args.teamId, ownerId);
    let runs;
    try {
      runs = await getAgentServerClient().listRuns(hostedAgentId);
    } catch {
      continue;
    }
    const latestCompletedRun = runs
      .filter((run) => run.status === 'completed')
      .filter((run) => parseIsoMs(run.createdAt) >= Number(task.claimedAt || 0))
      .filter((run) => {
        const requestMessage = String(run.request?.message || '');
        return requestMessage.includes(`taskId=${task.id}`) || requestMessage.includes(args.requestId);
      })
      .sort((left, right) => parseIsoMs(right.completedAt || right.createdAt) - parseIsoMs(left.completedAt || left.createdAt))[0];
    const resultBody = String(latestCompletedRun?.output?.result || '').trim();
    if (!latestCompletedRun || !resultBody) {
      continue;
    }

    const { applyCoordinatorOutputToBlackboard } = await import('./blackboard-coordinator-apply.js');
    const applied = await applyCoordinatorOutputToBlackboard({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      coordinatorId: ownerId,
      body: resultBody,
    });
    if (applied.applied && !applied.blockedReason) {
      changedTaskIds.push(...applied.changedTaskIds);
      continue;
    }

    const { resolveImmediateCoordinatorFastPathBody } = await import('./agent-delivery.js');
    const fallbackBody = resolveImmediateCoordinatorFastPathBody({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      requestText: latestUserRequestMessage(args.teamChatStore, args.teamId, args.chatSessionId, args.requestId),
    });
    if (fallbackBody) {
      const fallbackApplied = await applyCoordinatorOutputToBlackboard({
        teamId: args.teamId,
        chatSessionId: args.chatSessionId,
        requestId: args.requestId,
        coordinatorId: ownerId,
        body: fallbackBody,
      });
      if (fallbackApplied.applied && !fallbackApplied.blockedReason) {
        changedTaskIds.push(...fallbackApplied.changedTaskIds);
        continue;
      }
    }

    const reset = args.board.reset(args.teamId, args.chatSessionId, task.id, 'hosted_run_recovery_reset');
    if (reset) {
      changedTaskIds.push(reset.id);
    }
  }
  return dedupe(changedTaskIds);
}

function reconcileWorkContinuityForRunningTasks(args: {
  board: BlackboardStore;
  teamId: string;
  chatSessionId: string;
  requestId: string;
}): BlackboardDispatchPlanItem[] {
  const now = Date.now();
  const plan: BlackboardDispatchPlanItem[] = [];
  const ops = args.board.listOps(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    op: 'ping',
  });
  const latestPingByTask = new Map<string, number>();
  for (const op of ops) {
    const taskId = String(op.taskId || op.entityId || '').trim();
    if (!taskId) {
      continue;
    }
    latestPingByTask.set(taskId, Math.max(latestPingByTask.get(taskId) || 0, Number(op.timestamp || 0)));
  }

  const runningTasks = args.board.list(args.teamId, args.chatSessionId, {
    requestId: args.requestId,
    status: 'running',
  });
  for (const task of runningTasks) {
    const owner = String(task.owner || '').trim();
    if (!owner || !task.currentRunId) {
      continue;
    }
    const progressAt = lastProgressAt(task);
    const idleMs = progressAt > 0 ? now - progressAt : Number.POSITIVE_INFINITY;
    const lastPingAt = latestPingByTask.get(task.id) || 0;
    if (shouldResetStaleRunningTaskAfterPing({
      idleMs,
      lastPingAt,
      lastProgressAt: progressAt,
      now,
    })) {
      args.board.reset(args.teamId, args.chatSessionId, task.id, 'lease_expired_reset');
      continue;
    }
    if (!shouldPingStaleRunningTask({
      idleMs,
      lastPingAt,
      lastProgressAt: progressAt,
    })) {
      continue;
    }
    const op = args.board.recordTaskOperation(args.teamId, args.chatSessionId, {
      requestId: args.requestId,
      op: 'ping',
      taskId: task.id,
      actor: 'system:work-continuity',
      source: 'system_rule',
      reason: formatWorkContinuityEvent({ t: 'ping', task: task.id }),
      runId: task.currentRunId,
    });
    if (!op) {
      continue;
    }
    const body = formatWorkContinuityEvent({ t: 'ping', task: task.id });
    plan.push({
      agentId: owner,
      taskId: task.id,
      requestId: args.requestId,
      kind: 'ping',
      runId: task.currentRunId,
      body,
      message: buildDispatchMessage({
        teamId: args.teamId,
        requestId: args.requestId,
        agentId: owner,
        body,
      }),
    });
  }
  return plan;
}

export async function drainBlackboardDispatch(args: DrainBlackboardDispatchArgs): Promise<BlackboardDispatchPlanItem[]> {
  const board = args.board || getBlackboardStore();
  const teamChatStore = args.teamChatStore || getTeamChatStore();
  await recoverBusyHostedSessionsWithoutRunningFacts({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    registry: args.registry,
  });
  resolveLowRiskProposalBacklog({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    decidedBy: 'coordinator:dispatch-low-risk',
    notePrefix: 'dispatch-auto-resolve',
  });
  materializeRunnableApprovedProposals({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
  });
  const requestCoordinatorId = getRequestStateStore().resolveCoordinatorForSession(
    args.teamId,
    args.requestId,
    args.chatSessionId,
    args.registry.getCoordinator?.() || null,
  );
  await recoverDuplicateRunningCoordinatorTasks({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorAgentId: requestCoordinatorId,
    registry: args.registry,
  });
  await reconcileCompletedCoordinatorHostedRuns({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    teamChatStore,
  });
  await recoverOrphanRunningHostedTasks({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorAgentId: requestCoordinatorId,
    registry: args.registry,
    runtimeBusyAgentIds: args.runtimeBusyAgentIds,
  });
  await recoverRetryableBlockedHostedTasks({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorAgentId: requestCoordinatorId,
    registry: args.registry,
  });
  blockPendingTasksOnTerminalDependencyFailure({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
  });
  const refreshedRequestState = getRequestStateStore().syncTaskSnapshotForSession(
    args.teamId,
    args.requestId,
    args.chatSessionId,
  );
  if (refreshedRequestState?.state === 'ready_for_final' && requestCoordinatorId) {
    ensureCoordinatorSynthesisTask({
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      coordinatorId: requestCoordinatorId,
    });
  }
  releaseCoordinatorOwnedSubstantiveTasks({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
    coordinatorAgentId: requestCoordinatorId,
  });
  let enabledSkillAliases: Set<string> | null = null;
  try {
    enabledSkillAliases = await getEnabledSkillAliasesForTeam(args.teamId);
  } catch (err) {
    console.warn('[blackboard] failed to load skill registry dispatch policy; falling back to declared member skills', err);
  }
  let toolEndpoints: ToolEndpoint[] = [];
  try {
    toolEndpoints = (await getEndpointRegistry(args.teamId)).endpoints;
  } catch (err) {
    console.warn('[blackboard] failed to load endpoint registry dispatch policy; falling back to workspace-only routing', err);
  }
  const plan: BlackboardDispatchPlanItem[] = [];
  const deliverErrors: unknown[] = [];

  for (const item of reconcileWorkContinuityForRunningTasks({
    board,
    teamId: args.teamId,
    chatSessionId: args.chatSessionId,
    requestId: args.requestId,
  })) {
    plan.push(item);
    const delivery = args.deliver?.(item.message);
    if (delivery && typeof (delivery as Promise<unknown>).then === 'function') {
      void (delivery as Promise<unknown>).catch((error) => {
        deliverErrors.push(error);
      });
    }
  }

  for (const member of args.registry.getMembers()) {
    const ownedTask = board.list(args.teamId, args.chatSessionId, {
      requestId: args.requestId,
      owner: member.id,
    })[0] || null;
    const coordinatorTask = member.id === requestCoordinatorId
      ? board.list(args.teamId, args.chatSessionId, {
          requestId: args.requestId,
          capability: 'coordination',
        })[0] || null
      : null;
    const previewTask = ownedTask || coordinatorTask;

    const memberCapabilities = deriveDispatchCapabilitiesWithSkillPolicy(member, {
      coordinatorAgentId: requestCoordinatorId,
      enabledSkillAliases,
    });
    const tick = tickBlackboardAgent({
      board,
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      agentId: member.id,
      capabilities: memberCapabilities,
      workspaceIds: previewTask ? deriveWorkspaceIds(previewTask) : undefined,
      servedRoots: previewTask ? deriveServedRoots(previewTask) : undefined,
      status: args.runtimeBusyAgentIds?.has(member.id) ? 'busy' : 'available',
      heartbeatRunning: Boolean(args.runtimeBusyAgentIds?.has(member.id)),
    });

    if (tick.kind === 'idle') {
      continue;
    }

    const endpointBindings = deriveTaskEndpointBindings(tick.task, toolEndpoints);
    let dispatchTask = tick.task;
    if (tick.kind === 'claimed' && endpointBindings.length > 0) {
      dispatchTask = board.write(args.teamId, args.chatSessionId, {
        id: tick.task.id,
        revision: tick.task.revision,
        toolBindings: endpointBindings,
        networkMode: tick.task.networkMode || endpointBindings[0]?.networkMode,
        riskClass: tick.task.riskClass || endpointBindings[0]?.riskClass,
      }, {
        op: 'write',
        actor: 'system:endpoint-router',
        source: 'system_rule',
        runId: tick.runId,
        reason: `endpoint bindings: ${formatEndpointBindingSummary(endpointBindings)}`,
      }) || tick.task;
    }

    const body = buildDispatchBody({
      teamChatStore,
      teamId: args.teamId,
      chatSessionId: args.chatSessionId,
      requestId: args.requestId,
      agentId: member.id,
      task: dispatchTask,
      kind: tick.kind,
    });
    const message = buildDispatchMessage({
      teamId: args.teamId,
      requestId: args.requestId,
      agentId: member.id,
      body,
    });
    const item: BlackboardDispatchPlanItem = {
      agentId: member.id,
      taskId: dispatchTask.id,
      requestId: args.requestId,
      kind: tick.kind,
      runId: tick.kind === 'claimed' ? tick.runId : dispatchTask.currentRunId || undefined,
      endpointBindings,
      body,
      message,
    };
    plan.push(item);
    if (tick.kind === 'claimed') {
      board.recordTaskOperation(args.teamId, args.chatSessionId, {
        requestId: args.requestId,
        op: 'claim',
        taskId: tick.task.id,
        actor: member.id,
        source: 'system_rule',
        runId: tick.runId,
        reason: buildDispatchSelectionReason({
          member,
          task: dispatchTask,
          capabilities: memberCapabilities,
          enabledSkillAliases,
          endpointBindings,
        }),
      });
    }
    if (tick.kind === 'continue') {
      continue;
    }
    const delivery = args.deliver?.(message);
    if (delivery && typeof (delivery as Promise<unknown>).then === 'function') {
      void (delivery as Promise<unknown>).catch((error) => {
        deliverErrors.push(error);
      });
    }
  }

  if (deliverErrors.length > 0) {
    console.warn('[blackboard] dispatch deliver failures observed after scheduling', deliverErrors);
  }

  return plan;
}
