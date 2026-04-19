import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BackendTier } from '../../../core/runtime/backend-catalog.js';
import type {
  AgentBackendAdapter,
  AgentBackendCapabilities,
  AgentBackendEvent,
  BackendReadableState,
  AbortBackendRunInput,
  DisposeBackendSessionInput,
  ReadBackendStateInput,
  RunBackendTurnInput,
  StartBackendSessionInput,
} from '../agent-backend-adapter-contract.js';
import type {
  BackendSessionRef,
  BackendStageResult,
} from '../../agent_server/types.js';
import type { SessionStreamEvent, SessionUsage } from '../session-types.js';
import { applyGeminiAuthEnvAliases } from './gemini-auth-env.js';
import { normalizeModelProviderUsage } from '../model-provider-usage.js';
import { resolveModelRuntimeConnection } from '../model-runtime-resolver.js';

type GeminiCliAgentConstructor = new (options: Record<string, unknown>) => {
  session(options?: { sessionId?: string }): GeminiSession;
  resumeSession?(sessionId: string): Promise<GeminiSession>;
};

type GeminiSession = {
  id?: string;
  sendStream(prompt: string, signal?: AbortSignal): AsyncIterable<unknown>;
};

type GeminiSessionState = BackendReadableState & {
  workspace: string;
  agent: InstanceType<GeminiCliAgentConstructor>;
  session: GeminiSession;
  abortController?: AbortController;
  disposed?: boolean;
};

export interface GeminiSdkAdapterOptions {
  sdkModule?: string;
  model?: string;
  instructions?: string;
}

const GEMINI_SDK_CAPABILITIES: AgentBackendCapabilities = {
  nativeLoop: true,
  nativeTools: true,
  nativeSandbox: true,
  nativeApproval: false,
  nativeSession: true,
  fileEditing: true,
  streamingEvents: true,
  structuredEvents: true,
  readableState: true,
  abortableRun: true,
  resumableSession: true,
  statusTransparency: 'partial',
  multimodalInput: true,
  longContext: true,
};

export class GeminiSdkAgentBackendAdapter implements AgentBackendAdapter {
  readonly backendId = 'gemini' as const;
  readonly kind = 'agent_backend' as const;
  readonly tier: BackendTier = 'strategic';

  private readonly sessions = new Map<string, GeminiSessionState>();

  constructor(private readonly options: GeminiSdkAdapterOptions = {}) {}

  capabilities(): AgentBackendCapabilities {
    return { ...GEMINI_SDK_CAPABILITIES };
  }

  async startSession(input: StartBackendSessionInput): Promise<BackendSessionRef> {
    applyGeminiAuthEnvAliases();
    const { GeminiCliAgent } = await importGeminiSdk(this.options.sdkModule);
    const modelRuntime = resolveModelRuntimeConnection({
      ...(input.runtimeModel || {}),
      model: input.runtimeModel?.model || this.options.model || process.env.AGENT_SERVER_GEMINI_MODEL,
    });
    const sdkModel = input.runtimeModel?.modelName || input.runtimeModel?.model || this.options.model || process.env.AGENT_SERVER_GEMINI_MODEL || (
      isGeminiNativeProvider(modelRuntime.provider) ? modelRuntime.modelName || undefined : undefined
    );
    const agent = new GeminiCliAgent({
      cwd: input.workspace,
      model: sdkModel,
      instructions: this.options.instructions,
    });
    const session = agent.session();
    const sessionId = session.id || input.agentServerSessionId;
    const sessionRef: BackendSessionRef = {
      id: `gemini-sdk:${sessionId}`,
      backend: this.backendId,
      scope: input.scope,
      resumable: true,
      metadata: {
        ...input.metadata,
        sessionId,
        transport: 'gemini-cli-sdk',
        modelProvider: modelRuntime.provider,
        modelName: sdkModel,
      },
    };
    this.sessions.set(sessionRef.id, {
      sessionRef,
      workspace: input.workspace,
      agent,
      session,
      status: 'idle',
      lastEventAt: nowIso(),
      resumable: true,
      metadata: sessionRef.metadata,
    });
    return sessionRef;
  }

  async *runTurn(input: RunBackendTurnInput): AsyncIterable<AgentBackendEvent> {
    const state = this.requireState(input.sessionRef);
    const startedAt = Date.now();
    const abortController = new AbortController();
    const finalTextParts: string[] = [];
    const toolCalls: BackendStageResult['toolCalls'] = [];
    let finalUsage: SessionUsage | undefined;

    state.status = 'running';
    state.activeRunId = input.handoff.runId;
    state.activeStageId = input.handoff.stageId;
    state.abortController = abortController;
    state.lastEventAt = nowIso();

    try {
      for await (const geminiEvent of state.session.sendStream(renderGeminiPrompt(input), abortController.signal)) {
        state.lastEventAt = nowIso();
        for (const event of normalizeGeminiEvent(geminiEvent, input.handoff.stageId, toolCalls)) {
          if (event.type === 'text-delta') {
            finalTextParts.push(event.text);
          }
          if (event.type === 'usage-update') {
            finalUsage = event.usage;
          }
          yield event;
        }
      }
    } catch (error) {
      state.status = 'failed';
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', stageId: input.handoff.stageId, error: message };
      yield {
        type: 'stage-result',
        stageId: input.handoff.stageId,
        result: buildGeminiStageResult(input, 'failed', finalTextParts.join(''), toolCalls, startedAt, [message], finalUsage),
      };
      return;
    } finally {
      state.abortController = undefined;
      state.activeRunId = undefined;
      state.activeStageId = undefined;
      state.lastEventAt = nowIso();
    }

    state.status = 'idle';
    const result = buildGeminiStageResult(input, 'completed', finalTextParts.join(''), toolCalls, startedAt, [], finalUsage);
    state.lastStage = {
      id: input.handoff.stageId,
      runId: input.handoff.runId,
      type: input.handoff.stageType,
      backend: this.backendId,
      status: result.status,
      dependsOn: [],
      input: input.handoff,
      result,
      metrics: {
        durationMs: Math.max(0, Date.now() - startedAt),
        toolCallCount: result.toolCalls.length,
      },
      audit: {
        backend: this.backendId,
        backendKind: this.kind,
        backendTier: this.tier,
        inputSummary: input.handoff.userRequest.slice(0, 500),
        outputSummary: result.finalText?.slice(0, 500),
        nativeSessionRef: input.sessionRef,
      },
      createdAt: new Date(startedAt).toISOString(),
      completedAt: nowIso(),
    };

    yield {
      type: 'stage-result',
      stageId: input.handoff.stageId,
      result,
    };
  }

  async abort(input: AbortBackendRunInput): Promise<void> {
    const state = this.sessions.get(input.sessionRef.id);
    if (!state) {
      return;
    }
    state.abortController?.abort(input.reason || 'aborted by AgentServer');
    state.status = 'idle';
    state.activeRunId = undefined;
    state.activeStageId = undefined;
    state.lastEventAt = nowIso();
    state.metadata = {
      ...(state.metadata || {}),
      abortReason: input.reason || 'aborted by AgentServer',
    };
  }

  async readState(input: ReadBackendStateInput): Promise<BackendReadableState> {
    const state = this.requireState(input.sessionRef);
    return {
      sessionRef: state.sessionRef,
      status: state.status,
      activeRunId: state.activeRunId,
      activeStageId: state.activeStageId,
      activeToolCall: state.activeToolCall,
      pendingApproval: state.pendingApproval,
      workspaceState: state.workspaceState,
      lastStage: state.lastStage,
      lastEventAt: state.lastEventAt,
      resumable: state.resumable,
      metadata: state.metadata,
    };
  }

  async dispose(input: DisposeBackendSessionInput): Promise<void> {
    const state = this.sessions.get(input.sessionRef.id);
    if (!state) {
      return;
    }
    state.abortController?.abort(input.reason || 'disposed by AgentServer');
    state.status = 'disposed';
    state.disposed = true;
    state.lastEventAt = nowIso();
  }

  private requireState(sessionRef: BackendSessionRef): GeminiSessionState {
    const state = this.sessions.get(sessionRef.id);
    if (!state || state.disposed) {
      throw new Error(`Gemini SDK session is not active: ${sessionRef.id}`);
    }
    return state;
  }
}

function isGeminiNativeProvider(provider: string | null): boolean {
  const normalized = provider?.trim().toLowerCase();
  return normalized === 'gemini'
    || normalized === 'google'
    || normalized === 'google-gemini'
    || normalized === 'vertex'
    || normalized === 'google-vertex'
    || normalized === 'gcp';
}

async function importGeminiSdk(moduleName?: string): Promise<{
  GeminiCliAgent: GeminiCliAgentConstructor;
}> {
  const resolvedModule = resolveGeminiSdkModule(moduleName);
  return await import(resolvedModule) as { GeminiCliAgent: GeminiCliAgentConstructor };
}

function resolveGeminiSdkModule(moduleName?: string): string {
  if (moduleName) {
    return moduleName;
  }
  const envModule = process.env.AGENT_SERVER_GEMINI_SDK_MODULE?.trim();
  if (envModule) {
    return envModule;
  }
  const vendoredDist = resolve('server/backend/gemini/packages/sdk/dist/index.js');
  if (existsSync(vendoredDist)) {
    return pathToFileURL(vendoredDist).href;
  }
  const vendoredSource = resolve('server/backend/gemini/packages/sdk/index.ts');
  if (isTsxRuntime() && existsSync(vendoredSource)) {
    return pathToFileURL(vendoredSource).href;
  }
  return '@google/gemini-cli-sdk';
}

function isTsxRuntime(): boolean {
  return process.execArgv.some((arg) => arg.includes('tsx'));
}

function renderGeminiPrompt(input: RunBackendTurnInput): string {
  return [
    input.handoff.stageInstructions,
    '',
    'AgentServer handoff packet:',
    JSON.stringify(input.handoff, null, 2),
  ].join('\n');
}

function normalizeGeminiEvent(
  geminiEvent: unknown,
  stageId: string,
  toolCalls: BackendStageResult['toolCalls'],
): SessionStreamEvent[] {
  if (!isRecord(geminiEvent)) {
    return [];
  }
  const type = String(geminiEvent.type || '');
  const value = geminiEvent.value;
  if (type === 'content') {
    return [{ type: 'text-delta', stageId, text: String(value || '') }];
  }
  if (type === 'tool_call_request') {
    const toolName = readString(value, 'name') || readString(value, 'toolName') || 'gemini_tool';
    const detail = JSON.stringify(readRecord(value, 'args') || value || {});
    toolCalls.push({ toolName, detail, status: 'unknown' });
    return [{ type: 'tool-call', stageId, toolName, detail }];
  }
  if (type === 'tool_call_response') {
    const toolName = readString(value, 'name') || readString(value, 'toolName') || 'gemini_tool';
    return [{ type: 'tool-result', stageId, toolName, output: JSON.stringify(value || {}) }];
  }
  if (type === 'tool_call_confirmation') {
    return [{
      type: 'permission-request',
      stageId,
      requestId: readString(value, 'callId') || readString(readRecord(value, 'request'), 'callId') || 'gemini-confirmation',
      toolName: readString(readRecord(value, 'request'), 'name') || 'gemini_tool',
      detail: JSON.stringify(value || {}),
    }];
  }
  if (type === 'usage') {
    const usage = normalizeModelProviderUsage(value, {
      provider: 'gemini',
      model: readString(value, 'model'),
    });
    return usage ? [{ type: 'usage-update', stageId, usage }] : [];
  }
  if (type === 'error' || type === 'invalid_stream') {
    return [{ type: 'error', stageId, error: JSON.stringify(value || geminiEvent) }];
  }
  if (type === 'finished') {
    return [{ type: 'status', stageId, status: 'completed', message: 'Gemini turn completed.' }];
  }
  return [];
}

function buildGeminiStageResult(
  input: RunBackendTurnInput,
  status: 'completed' | 'failed',
  finalText: string,
  toolCalls: BackendStageResult['toolCalls'],
  startedAt: number,
  risks: string[],
  usage?: SessionUsage,
): BackendStageResult {
  return {
    status,
    finalText,
    filesChanged: input.handoff.workspaceFacts.dirtyFiles,
    diffSummary: input.handoff.workspaceFacts.lastKnownDiffSummary,
    toolCalls,
    testsRun: [],
    findings: [],
    handoffSummary: finalText.slice(0, 500),
    nextActions: [],
    risks,
    artifacts: [],
    usage,
    nativeSessionRef: input.sessionRef,
  };
}

function readString(value: unknown, key: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return typeof item === 'string' ? item : null;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[key];
  return isRecord(item) ? item : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}
