import {
  extractAndNormalizeLocalDevPrimitiveCall,
  summarizeLocalDevPrimitiveCall,
} from './local-dev-primitives.js';
import { loadOpenTeamConfig } from '../../utils/openteam-config.js';
import { appendFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { executeRoutedToolCall } from '../tool-executor.js';
import type { ToolRoutingPolicy, WorkerProfile, WorkspaceSpec } from '../../../core/runtime/tool-routing.js';
import type { SessionUsage } from '../session-types.js';
import { mergeModelProviderUsage } from '../model-provider-usage.js';
import {
  ModelProviderCallError,
  requestOpenAICompatibleTextCompletion,
} from '../model-provider-client.js';

export type LocalDevChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LocalDevTextCompletionResult = {
  text: string;
  usage?: SessionUsage;
};

export type LocalDevTextCompletionRequester = (params: {
  messages: LocalDevChatMessage[];
}) => Promise<string | LocalDevTextCompletionResult>;

type AgentHooks = {
  onToolCall?: (toolName: string, detail?: string) => void;
  onToolResult?: (toolName: string, detail?: string, output?: string) => void;
  onTextDelta?: (text: string) => void;
  onStatus?: (status: 'running' | 'completed' | 'failed', message?: string) => void;
};

const LOCAL_TOOL_HEARTBEAT_INTERVAL_MS = 15_000;

function startLocalToolHeartbeat(args: {
  hooks?: AgentHooks;
  toolName: string;
  detail?: string;
}): (() => void) | null {
  if (!args.hooks?.onStatus) {
    return null;
  }
  const detail = args.detail ? `: ${args.detail}` : '';
  const emit = () => {
    args.hooks?.onStatus?.('running', `Local tool still running ${args.toolName}${detail}`);
  };
  const timer = setInterval(emit, LOCAL_TOOL_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

type SourceTaskDriftState = {
  isSourceTask: boolean;
  localExplorationCount: number;
  remoteEvidenceCount: number;
};

type LocalDevRoutingContext = {
  workspace: WorkspaceSpec;
  workers: WorkerProfile[];
  policy?: ToolRoutingPolicy;
};

export type LocalDevRunPolicy = {
  isSourceTask: boolean;
  maxSteps: number;
  forceSummaryOnBudgetExhausted: boolean;
};

const DEFAULT_LOCAL_DEV_TOOL_MAX_STEPS = Math.max(
  1,
  loadOpenTeamConfig().runtime.localDev.toolMaxSteps,
);
const DEFAULT_SOURCE_TASK_LOCAL_EXPLORATION_SOFT_LIMIT = Math.max(
  1,
  loadOpenTeamConfig().runtime.localDev.sourceTaskLocalExplorationSoftLimit,
);
const RETRYABLE_PROVIDER_ERROR_DELAY_MS = 600;
const LOCAL_DEV_AGENT_DEBUG_LOG = join(process.cwd(), 'tmp', 'local-dev-agent-debug.log');

function logLocalDevAgentDebug(payload: Record<string, unknown>): void {
  try {
    mkdirSync(join(process.cwd(), 'tmp'), { recursive: true });
    appendFileSync(LOCAL_DEV_AGENT_DEBUG_LOG, `${JSON.stringify({
      at: new Date().toISOString(),
      ...payload,
    })}\n`, 'utf8');
  } catch {
    // ignore debug logging failures
  }
}

function looksLikePlannedButUnexecutedToolWork(text: string): boolean {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    return false;
  }
  const hasBashFence = /```(?:bash|sh|shell)\b[\s\S]*?```/i.test(normalized);
  const hasToolMarkup = /<(?:minimax:tool_call|tool_call|invoke\s+name=|append_file|read_file|write_file|list_dir|grep_search|run_command|apply_patch|web_search|web_fetch|browser_open|browser_activate)>/i.test(normalized);
  if (!hasBashFence || hasToolMarkup) {
    return false;
  }
  const hasPlanLanguage = /(让我执行|我来(?:先)?(?:检查|验证|准备|执行)|逐步检查|以下检查|将执行|准备执行|先检查)/i.test(normalized);
  const hasShellFlow = /\b(if\s+\[|for\s+\w+\s+in|find\s+\/|ls\s+-la|cat\s+\/|curl\s+|rg\s+|grep\s+)/i.test(normalized);
  const hasObservedOutput = /(exit_code=|stdout:|stderr:|path=|status=success|status=failure)/i.test(normalized);
  return (hasPlanLanguage || hasShellFlow) && !hasObservedOutput;
}

function looksLikeEmbeddedProviderToolCallText(text: string): boolean {
  const normalized = String(text || '');
  if (!normalized.trim()) {
    return false;
  }
  return /<minimax:tool_call>/i.test(normalized)
    || /<tool_call>/i.test(normalized)
    || /<invoke\s+name=/i.test(normalized)
    || /&lt;invoke\s+name=/i.test(normalized)
    || /<step>[\s\S]*?<invoke\s+name=/i.test(normalized);
}

function buildSystemPrompt(maxSteps: number): string {
  return [
    'You are an OpenTeam local development agent.',
    'When real work requires tools, respond with exactly one XML tool block and no extra prose.',
    'The prompt may already include canonical server blackboard facts. Treat those prompt facts as authoritative; do not inspect or recreate .blackboard/* shadow files.',
    'Available tools:',
    '<append_file><path>ABSOLUTE_OR_RELATIVE_PATH</path><content>TEXT_TO_APPEND</content></append_file>',
    '<read_file><path>ABSOLUTE_OR_RELATIVE_PATH</path></read_file>',
    '<write_file><path>ABSOLUTE_OR_RELATIVE_PATH</path><content>FULL_FILE_CONTENT</content></write_file>',
    '<list_dir><path>DIRECTORY_PATH</path></list_dir>',
    '<grep_search><path>DIRECTORY_OR_FILE_PATH</path><pattern>TEXT_OR_REGEX</pattern></grep_search>',
    '<run_command><command>SHELL_COMMAND</command></run_command>',
    '<apply_patch><patch>UNIFIED_DIFF_PATCH</patch></apply_patch>',
    '<web_search><query>SEARCH_QUERY</query></web_search>',
    '<web_fetch><url>HTTP_OR_HTTPS_URL</url></web_fetch>',
    '<browser_open><url>HTTP_OR_HTTPS_URL</url></browser_open>',
    '<browser_activate><app>APPLICATION_NAME</app></browser_activate>',
    'Rules:',
    '1. Use tools instead of pretending.',
    '2. After a tool result arrives, either use another tool or provide the final answer.',
    '3. Only provide normal prose when the task is complete.',
    `4. You have at most ${maxSteps} tool calls for this run.`,
    '5. Do not spend the entire budget on exploration. If the task is not fully solved, stop and return the best partial findings, what you already checked, what remains unknown, and the next recommended step.',
    '6. If you previously learned provider-specific tool names like web.search or file.append, translate them to the canonical tools above instead of outputting provider-specific XML.',
  ].join('\n');
}

export function looksLikeSourceBasedBlackboardTask(prompt: string): boolean {
  const normalized = String(prompt || '');
  if (!normalized.includes('[[BLACKBOARD_TASK]]')) {
    return false;
  }
  return /evidenceRequirements:\s*.*summary\.md/i.test(normalized)
    || /evidenceRequirements:\s*.*minSourceCount=/i.test(normalized)
    || /TASK_EVIDENCE/i.test(normalized)
    || /source-based research task/i.test(normalized);
}

function pathLooksLikeRelevantScpLocalContext(path: string): boolean {
  const normalized = String(path || '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/agents/skills/scp')
    || normalized.includes('/server/api/scp-tools')
    || normalized.endsWith('/docs/t006_scp_biochem_tools_summary.md')
    || normalized.endsWith('/project.md')
    || normalized.includes('/openteam.json');
}

function pathIsInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child).replace(/\/+$/, '');
  const normalizedParent = resolve(parent).replace(/\/+$/, '');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function ensureBackendAndLocalServerWorkers(workers: WorkerProfile[], cwd: string): WorkerProfile[] {
  const byId = new Map(workers.map((worker) => [worker.id, worker]));
  if (!byId.has('backend-server')) {
    byId.set('backend-server', {
      id: 'backend-server',
      kind: 'backend-server',
      capabilities: ['network', 'metadata'],
    });
  }
  if (!byId.has('server-local')) {
    byId.set('server-local', {
      id: 'server-local',
      kind: 'server',
      allowedRoots: [cwd],
      capabilities: ['filesystem', 'shell', 'network', 'metadata'],
    });
  }
  return [...byId.values()];
}

function resolveLocalDevRoutingContext(cwd: string): LocalDevRoutingContext {
  const absoluteCwd = resolve(cwd || process.cwd());
  const config = loadOpenTeamConfig();
  const workspace = config.runtime.workspace.workspaces.find((candidate) => pathIsInside(absoluteCwd, candidate.root));
  if (workspace) {
    return {
      workspace,
      workers: config.runtime.workspace.workers,
      policy: config.runtime.workspace.toolRouting || undefined,
    };
  }

  return {
    workspace: {
      id: 'local-dev',
      root: absoluteCwd,
      ownerWorker: 'server-local',
    },
    workers: ensureBackendAndLocalServerWorkers(config.runtime.workspace.workers, absoluteCwd),
    policy: undefined,
  };
}

function isRemoteEvidenceOrientedTool(toolName: string, args: Record<string, string>): boolean {
  if (toolName === 'web_fetch' || toolName === 'web_search' || toolName === 'browser_open') {
    return true;
  }
  if (toolName !== 'run_command') {
    return false;
  }
  const command = String(args.command || '').toLowerCase();
  return /\b(curl|wget|http|lynx)\b/.test(command)
    || command.includes('scphub.intern-ai.org.cn');
}

function isLocalExplorationTool(toolName: string, args: Record<string, string>): boolean {
  if (toolName === 'list_dir' || toolName === 'read_file' || toolName === 'grep_search' || toolName === 'write_file' || toolName === 'append_file') {
    return true;
  }
  if (toolName !== 'run_command') {
    return false;
  }
  const command = String(args.command || '').toLowerCase();
  if (/\b(curl|wget)\b/.test(command)) {
    return false;
  }
  return /\b(ls|cat|find|rg|grep)\b/.test(command);
}

export function shouldRedirectSourceTaskLocalExploration(params: {
  state: SourceTaskDriftState;
  toolName: string;
  args: Record<string, string>;
}): boolean {
  if (!params.state.isSourceTask) {
    return false;
  }
  if (isRemoteEvidenceOrientedTool(params.toolName, params.args)) {
    return false;
  }
  if (!isLocalExplorationTool(params.toolName, params.args)) {
    return false;
  }
  const primaryPath = String(
    params.args.path
    || params.args.cwd
    || params.args.command
    || '',
  );
  if (pathLooksLikeRelevantScpLocalContext(primaryPath)) {
    return false;
  }
  return params.state.localExplorationCount >= DEFAULT_SOURCE_TASK_LOCAL_EXPLORATION_SOFT_LIMIT;
}

function resolveLocalDevToolMaxSteps(override?: number): number {
  const candidate = Number.isFinite(override) ? Number(override) : DEFAULT_LOCAL_DEV_TOOL_MAX_STEPS;
  return Math.max(1, Math.trunc(candidate));
}

export function resolveLocalDevRunPolicy(params: {
  prompt: string;
  requestedMaxSteps?: number;
  requestedForceSummaryOnBudgetExhausted?: boolean;
  requestedIsSourceTask?: boolean;
}): LocalDevRunPolicy {
  const config = loadOpenTeamConfig().runtime.localDev;
  const isSourceTask = params.requestedIsSourceTask === true
    || looksLikeSourceBasedBlackboardTask(params.prompt);
  const requestedMaxSteps = Number.isFinite(params.requestedMaxSteps)
    ? Math.max(1, Math.trunc(Number(params.requestedMaxSteps)))
    : undefined;
  const configuredBaseMaxSteps = Math.max(1, Math.trunc(config.toolMaxSteps));
  const configuredSourceTaskMaxSteps = Math.max(1, Math.trunc(config.sourceTaskToolMaxSteps));
  const maxSteps = isSourceTask
    ? Math.max(requestedMaxSteps ?? configuredBaseMaxSteps, configuredSourceTaskMaxSteps)
    : (requestedMaxSteps ?? configuredBaseMaxSteps);

  const configuredForceSummary = isSourceTask
    ? config.sourceTaskForceSummaryOnBudgetExhausted
    : config.forceSummaryOnBudgetExhausted;
  const forceSummaryOnBudgetExhausted =
    typeof params.requestedForceSummaryOnBudgetExhausted === 'boolean'
      ? params.requestedForceSummaryOnBudgetExhausted
      : configuredForceSummary;

  return {
    isSourceTask,
    maxSteps,
    forceSummaryOnBudgetExhausted,
  };
}

async function requestChatCompletion(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: LocalDevChatMessage[];
}): Promise<LocalDevTextCompletionResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await requestOpenAICompatibleTextCompletion({
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
        model: params.model,
        provider: 'openai-compatible',
        messages: params.messages,
        stream: false,
      });
    } catch (error) {
      const retryable = error instanceof ModelProviderCallError ? error.retryable : true;
      if (attempt < 2 && retryable) {
        await new Promise((resolve) => setTimeout(resolve, RETRYABLE_PROVIDER_ERROR_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
  throw new Error('chat.completions exhausted retries without returning assistant text.');
}

function normalizeCompletionResult(value: string | LocalDevTextCompletionResult): LocalDevTextCompletionResult {
  return typeof value === 'string' ? { text: value } : value;
}

export async function runLocalDevToolAgentWithRequester(params: {
  modelLabel: string;
  requestTextCompletion: LocalDevTextCompletionRequester;
  prompt: string;
  cwd: string;
  hooks?: AgentHooks;
  maxSteps?: number;
  forceSummaryOnBudgetExhausted?: boolean;
}): Promise<{ success: true; result: string; usage?: SessionUsage } | { success: false; error: string; usage?: SessionUsage }> {
  const policy = resolveLocalDevRunPolicy({
    prompt: params.prompt,
    requestedMaxSteps: params.maxSteps,
    requestedForceSummaryOnBudgetExhausted: params.forceSummaryOnBudgetExhausted,
  });
  const maxSteps = resolveLocalDevToolMaxSteps(policy.maxSteps);
  const messages: LocalDevChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(maxSteps) },
    { role: 'user', content: params.prompt },
  ];
  const driftState: SourceTaskDriftState = {
    isSourceTask: policy.isSourceTask,
    localExplorationCount: 0,
    remoteEvidenceCount: 0,
  };
  const usageParts: SessionUsage[] = [];
  logLocalDevAgentDebug({
    phase: 'policy',
    isSourceTask: policy.isSourceTask,
    maxSteps,
    forceSummaryOnBudgetExhausted: policy.forceSummaryOnBudgetExhausted,
  });

  params.hooks?.onStatus?.('running', `Calling local model ${params.modelLabel}`);

  for (let step = 0; step < maxSteps; step += 1) {
    const completion = normalizeCompletionResult(await params.requestTextCompletion({ messages }));
    if (completion.usage) {
      usageParts.push(completion.usage);
    }
    const assistantText = completion.text;
    messages.push({ role: 'assistant', content: assistantText });

    const toolCall = extractAndNormalizeLocalDevPrimitiveCall(assistantText, params.cwd);
    const hasEmbeddedProviderToolCallText = looksLikeEmbeddedProviderToolCallText(assistantText);
    const hasPlannedButUnexecutedToolWork = looksLikePlannedButUnexecutedToolWork(assistantText);
    logLocalDevAgentDebug({
      phase: 'main-loop',
      step,
      hasToolCall: Boolean(toolCall),
      toolName: toolCall?.toolName || null,
      embeddedProviderToolCallText: hasEmbeddedProviderToolCallText,
      plannedButUnexecutedToolWork: hasPlannedButUnexecutedToolWork,
      assistantPreview: assistantText.slice(0, 500),
    });
    if (!toolCall) {
      if (hasEmbeddedProviderToolCallText || hasPlannedButUnexecutedToolWork) {
        messages.push({
          role: 'user',
          content: [
            'You returned tool syntax or shell commands as plain text instead of executing a tool.',
            'Do not describe, preview, or wrap commands in prose.',
            'Respond with exactly one XML tool block for the next real action.',
          ].join('\n'),
        });
        continue;
      }
      const finalText = assistantText.trim();
      params.hooks?.onTextDelta?.(finalText);
      params.hooks?.onStatus?.('completed', 'Local tool agent completed');
      return {
        success: true,
        result: finalText,
        usage: mergeModelProviderUsage(usageParts),
      };
    }

    if (shouldRedirectSourceTaskLocalExploration({
      state: driftState,
      toolName: toolCall.toolName,
      args: toolCall.args,
    })) {
      messages.push({
        role: 'user',
        content: [
          'You are drifting into unrelated local-repository exploration for a source-based research task.',
          'Stop reading broad local folders such as data/, teams/, or historical blackboard snapshots unless they are explicitly required for the final evidence.',
          'From this point, prioritize remote SCP Hub evidence and the directly relevant local targets only: agents/skills/scp, server/api/scp-tools, docs/t006_scp_biochem_tools_summary.md, PROJECT.md, openteam.json, and the assigned artifactsRoot/summary.md.',
          'Either execute one real remote evidence step now or finish with the best partial handoff and concrete findings.',
        ].join('\n'),
      });
      continue;
    }

    if (isRemoteEvidenceOrientedTool(toolCall.toolName, toolCall.args)) {
      driftState.remoteEvidenceCount += 1;
    } else if (isLocalExplorationTool(toolCall.toolName, toolCall.args)) {
      driftState.localExplorationCount += 1;
    }

    const toolDetail = summarizeLocalDevPrimitiveCall(toolCall);
    params.hooks?.onToolCall?.(toolCall.toolName, toolDetail);
    const stopToolHeartbeat = startLocalToolHeartbeat({
      hooks: params.hooks,
      toolName: toolCall.toolName,
      detail: toolDetail,
    });
    const routing = resolveLocalDevRoutingContext(params.cwd);
    const routedResult = await executeRoutedToolCall({
      toolName: toolCall.toolName,
      toolArgs: toolCall.args,
      workspace: routing.workspace,
      workers: routing.workers,
      policy: routing.policy,
    }).catch((error) => ({
      ok: false,
      output: error instanceof Error ? error.message : String(error),
      route: null,
      workerId: undefined,
      attempts: [],
      writeback: {
        status: 'not-needed' as const,
        reason: 'tool did not execute',
      },
    })).finally(() => {
      stopToolHeartbeat?.();
    });
    const routeDetail = routedResult.route
      ? [
          `workspace=${routedResult.route.workspaceId}`,
          `primary=${routedResult.route.primaryWorker}`,
          routedResult.route.fallbackWorkers.length > 0 ? `fallbacks=${routedResult.route.fallbackWorkers.join(',')}` : null,
          routedResult.workerId ? `worker=${routedResult.workerId}` : null,
          `writeback=${routedResult.writeback.status}`,
        ].filter(Boolean).join(' ')
      : 'route=unavailable';
    const toolResult = {
      ok: routedResult.ok,
      output: `${routedResult.output}\n\n[route] ${routeDetail}`,
    };
    params.hooks?.onToolResult?.(
      toolCall.toolName,
      toolResult.output,
      toolResult.output,
    );
    messages.push({
      role: 'user',
      content: [
        `Tool result for ${toolCall.toolName}:`,
        toolResult.ok ? 'STATUS: success' : 'STATUS: failure',
        toolResult.output,
        'Continue using tools if needed, otherwise provide the final answer.',
      ].join('\n\n'),
    });
  }

  if (!policy.forceSummaryOnBudgetExhausted) {
    return {
      success: false,
      error: `Local tool agent exceeded ${maxSteps} steps and forced-summary fallback is disabled by policy.`,
      usage: mergeModelProviderUsage(usageParts),
    };
  }

  const forcedSummaryPrompt = [
    `Tool budget exhausted after ${maxSteps} steps.`,
    'Do not call any more tools.',
    'Using only the tool results already collected, provide the best partial handoff now.',
    'Required sections:',
    '1. Checked',
    '2. Findings so far',
    '3. Unknown / blocked',
    '4. Recommended next step',
  ].join('\n');
  messages.push({ role: 'user', content: forcedSummaryPrompt });

  try {
    const completion = normalizeCompletionResult(await params.requestTextCompletion({ messages }));
    if (completion.usage) {
      usageParts.push(completion.usage);
    }
    const assistantText = completion.text;
    const toolCall = extractAndNormalizeLocalDevPrimitiveCall(assistantText, params.cwd);
    const hasEmbeddedProviderToolCallText = looksLikeEmbeddedProviderToolCallText(assistantText);
    const hasPlannedButUnexecutedToolWork = looksLikePlannedButUnexecutedToolWork(assistantText);
    logLocalDevAgentDebug({
      phase: 'forced-summary',
      hasToolCall: Boolean(toolCall),
      toolName: toolCall?.toolName || null,
      embeddedProviderToolCallText: hasEmbeddedProviderToolCallText,
      plannedButUnexecutedToolWork: hasPlannedButUnexecutedToolWork,
      assistantPreview: assistantText.slice(0, 500),
    });
    if (!toolCall && !hasPlannedButUnexecutedToolWork && !hasEmbeddedProviderToolCallText) {
      const finalText = assistantText.trim();
      if (finalText) {
        params.hooks?.onTextDelta?.(finalText);
        params.hooks?.onStatus?.('completed', `Local tool agent returned partial findings after hitting the ${maxSteps}-step budget`);
        return {
          success: true,
          result: finalText,
          usage: mergeModelProviderUsage(usageParts),
        };
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Local tool agent exhausted ${maxSteps} steps and the forced partial-summary pass failed: ${detail}`,
      usage: mergeModelProviderUsage(usageParts),
    };
  }

  return {
    success: false,
    error: `Local tool agent exceeded ${maxSteps} steps and still did not return a usable partial summary.`,
    usage: mergeModelProviderUsage(usageParts),
  };
}

export async function runLocalDevToolAgent(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  cwd: string;
  hooks?: AgentHooks;
  maxSteps?: number;
  forceSummaryOnBudgetExhausted?: boolean;
}): Promise<{ success: true; result: string; usage?: SessionUsage } | { success: false; error: string; usage?: SessionUsage }> {
  return runLocalDevToolAgentWithRequester({
    modelLabel: params.model,
    requestTextCompletion: ({ messages }) => requestChatCompletion({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      messages,
    }),
    prompt: params.prompt,
    cwd: params.cwd,
    hooks: params.hooks,
    maxSteps: params.maxSteps,
    forceSummaryOnBudgetExhausted: params.forceSummaryOnBudgetExhausted,
  });
}
