import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { StrategicAgentBackend } from '../core/runtime/backend-catalog.js';
import { listAvailableAgentBackendAdapters } from '../server/runtime/agent-backend-adapter-registry.js';
import { loadOpenTeamConfig } from '../server/utils/openteam-config.js';
import { startSmokeModelServer, type SmokeModelServer } from './lib/smoke-model-server.js';
import { resolveAdapterLlmEndpointOverride } from '../server/runtime/adapters/llm-endpoint-override.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const STRATEGIC_BACKENDS: StrategicAgentBackend[] = [
  'codex',
  'claude-code',
  'gemini',
  'self-hosted-agent',
];
const selectedBackends = parseSelectedBackends(process.env.AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS);
const config = loadOpenTeamConfig();
const checks: CheckResult[] = [];
let smokeModelServer: SmokeModelServer | undefined;
const STRICT = process.env.AGENT_SERVER_ADAPTER_PREFLIGHT_STRICT === '1';

type CheckResult = {
  backend: StrategicAgentBackend | 'shared';
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
};

async function main(): Promise<void> {
  try {
    if (process.env.AGENT_SERVER_ADAPTER_PREFLIGHT_SMOKE_LLM === '1') {
      smokeModelServer = await startSmokeModelServer();
      config.llm.baseUrl = smokeModelServer.baseUrl;
      config.llm.apiKey = 'agent-server-smoke-key';
      config.llm.model = 'agent-server-smoke-model';
      config.llm.fallbacks = [];
      checks.push({
        backend: 'shared',
        name: 'smoke-llm-endpoint',
        status: 'ok',
        detail: `using temporary smoke LLM endpoint ${smokeModelServer.baseUrl}`,
      });
    }

    for (const adapter of listAvailableAgentBackendAdapters()) {
      if (!selectedBackends.includes(adapter.id)) {
        continue;
      }
      checks.push({
        backend: adapter.id,
        name: 'adapter-registration',
        status: 'ok',
        detail: `registered productionComplete=${adapter.productionComplete}`,
      });
    }

    for (const backend of selectedBackends) {
      if (!listAvailableAgentBackendAdapters().some((adapter) => adapter.id === backend)) {
        checks.push({
          backend,
          name: 'adapter-registration',
          status: 'fail',
          detail: 'adapter is not registered',
        });
      }
    }

    if (selectedBackends.includes('codex')) {
      const command = process.env.AGENT_SERVER_CODEX_APP_SERVER_COMMAND || 'codex';
      await checkCommand('codex', 'codex-command', command, [
        `Install Codex CLI/app-server or set AGENT_SERVER_CODEX_APP_SERVER_COMMAND.`,
        `Expected command to support: ${command} app-server --listen stdio://`,
      ].join(' '));
      await checkCodexAppServerHandshake(command);
    }

    if (selectedBackends.includes('claude-code') || selectedBackends.includes('self-hosted-agent')) {
      await checkLlmEndpoint();
    }

    if (selectedBackends.includes('gemini')) {
      await checkGeminiSdk();
    }

    for (const check of checks) {
      console.log(`${check.status.toUpperCase()} ${check.backend} ${check.name}: ${check.detail.replace(/\s+/g, ' ').slice(0, 300)}`);
    }

    const failed = checks.filter((check) => check.status === 'fail');
    const warnings = checks.filter((check) => check.status === 'warn');
    console.log(`SUMMARY backends=${selectedBackends.join(',')} ok=${checks.length - failed.length - warnings.length} warn=${warnings.length} failed=${failed.length} strict=${STRICT}`);
    if (failed.length > 0 || (STRICT && warnings.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await smokeModelServer?.close().catch(() => undefined);
  }
}

async function checkCommand(
  backend: StrategicAgentBackend,
  name: string,
  command: string,
  failureHint: string,
): Promise<void> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${shellQuote(command)}`], { timeout: 5_000 });
    checks.push({
      backend,
      name,
      status: 'ok',
      detail: `${command} is available`,
    });
  } catch {
    checks.push({
      backend,
      name,
      status: 'fail',
      detail: `${command} is not on PATH. ${failureHint}`,
    });
  }
}

async function checkLlmEndpoint(): Promise<void> {
  const override = resolveAdapterLlmEndpointOverride();
  const primaryEndpoint = override
    ? {
        label: 'env-override',
        baseUrl: override.baseUrl || config.llm.baseUrl,
        apiKey: override.apiKey || config.llm.apiKey,
        model: override.modelName || config.llm.model,
      }
    : {
        label: 'primary',
        baseUrl: config.llm.baseUrl,
        apiKey: config.llm.apiKey,
        model: config.llm.model,
      };
  const endpoints = [
    primaryEndpoint,
    ...(override ? [] : (config.llm.fallbacks || []).map((endpoint, index) => ({
      label: endpoint.label || `fallback-${index + 1}`,
      baseUrl: endpoint.baseUrl,
      apiKey: endpoint.apiKey,
      model: endpoint.model,
    }))),
  ];
  if (endpoints.length === 0) {
    checks.push({
      backend: 'shared',
      name: 'llm-endpoint',
      status: 'fail',
      detail: 'no LLM endpoint configured',
    });
    return;
  }
  const results = await Promise.all(endpoints.map(async (endpoint) => {
    const probe = await probeOpenAiCompatibleEndpoint(endpoint.baseUrl, endpoint.apiKey);
    return { ...endpoint, ...probe };
  }));
  for (const result of results) {
    checks.push({
      backend: 'shared',
      name: `llm-endpoint:${result.label}`,
      status: result.reachable ? 'ok' : 'fail',
      detail: result.reachable
        ? `${result.baseUrl} reachable model=${result.model} status=${result.statusCode}`
        : [
          `${result.baseUrl} unreachable model=${result.model}: ${result.error}`,
          'Start/configure this endpoint or set AGENT_SERVER_ADAPTER_LLM_BASE_URL/API_KEY/MODEL for Claude Code and self-hosted live checks.',
        ].join(' '),
    });
  }
}

async function checkGeminiSdk(): Promise<void> {
  const moduleName = process.env.AGENT_SERVER_GEMINI_SDK_MODULE || '@google/gemini-cli-sdk';
  try {
    const resolved = require.resolve(moduleName);
    checks.push({
      backend: 'gemini',
      name: 'gemini-sdk-module',
      status: 'ok',
      detail: `${moduleName} resolves to ${resolved}`,
    });
    await checkGeminiSdkShape(pathToFileUrl(resolved));
    checkGeminiAuthInputs();
    return;
  } catch {
    // Fall through to the vendored source check below.
  }

  const envModule = process.env.AGENT_SERVER_GEMINI_SDK_MODULE?.trim();
  if (envModule && existsSync(envModule)) {
    checks.push({
      backend: 'gemini',
      name: 'gemini-sdk-module',
      status: 'ok',
      detail: `AGENT_SERVER_GEMINI_SDK_MODULE points to existing path ${envModule}`,
    });
    await checkGeminiSdkShape(pathToFileUrl(envModule));
    checkGeminiAuthInputs();
    return;
  }

  const vendoredPackage = resolve('server/backend/gemini/packages/sdk/package.json');
  const vendoredDist = resolve('server/backend/gemini/packages/sdk/dist/index.js');
  const vendoredSource = resolve('server/backend/gemini/packages/sdk/src/agent.ts');
  if (existsSync(vendoredDist)) {
    checks.push({
      backend: 'gemini',
      name: 'gemini-sdk-module',
      status: 'ok',
      detail: `@google/gemini-cli-sdk is not installed in AgentServer root, but adapter can use vendored dist at ${vendoredDist}.`,
    });
    await checkGeminiSdkShape(pathToFileUrl(vendoredDist));
    checkGeminiAuthInputs();
    return;
  }
  const vendoredIndex = resolve('server/backend/gemini/packages/sdk/index.ts');
  if (isTsxRuntime() && existsSync(vendoredIndex)) {
    const importResult = await probeGeminiSdkShape(pathToFileUrl(vendoredIndex));
    checks.push({
      backend: 'gemini',
      name: 'gemini-sdk-module',
      status: importResult.ok ? 'ok' : 'fail',
      detail: importResult.ok
        ? `tsx runtime can import vendored Gemini SDK source at ${vendoredIndex}. This is a development fallback; production should still build/link dist.`
        : `vendored Gemini SDK source exists at ${vendoredIndex}, but import failed: ${importResult.error}`,
    });
    checkGeminiAuthInputs();
    return;
  }
  if (existsSync(vendoredPackage) && existsSync(vendoredSource)) {
    checks.push({
      backend: 'gemini',
      name: 'gemini-sdk-module',
      status: 'fail',
      detail: [
        '@google/gemini-cli-sdk is not resolvable from AgentServer root.',
        `Vendored Gemini SDK source exists at ${vendoredSource}, but dist is missing.`,
        'Build/link the Gemini SDK package or set AGENT_SERVER_GEMINI_SDK_MODULE to a resolvable SDK module before live smoke.',
      ].join(' '),
    });
    return;
  }
  checks.push({
    backend: 'gemini',
    name: 'gemini-sdk-module',
    status: 'fail',
    detail: '@google/gemini-cli-sdk is not resolvable and vendored Gemini SDK source was not found.',
  });
}

async function checkGeminiSdkShape(moduleSpecifier: string): Promise<void> {
  const probe = await probeGeminiSdkShape(moduleSpecifier);
  checks.push({
    backend: 'gemini',
    name: 'gemini-sdk-shape',
    status: probe.ok ? 'ok' : 'fail',
    detail: probe.ok
      ? `GeminiCliAgent constructor and session.sendStream are available from ${moduleSpecifier}`
      : `Gemini SDK module shape is incompatible with AgentServer adapter expectations: ${probe.error}`,
  });
}

function checkGeminiAuthInputs(): void {
  const geminiApiKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  const googleApiKey = Boolean(process.env.GOOGLE_API_KEY?.trim());
  const googleCredentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const googleCredentialsExists = Boolean(googleCredentialsPath && existsSync(googleCredentialsPath));
  const geminiCliHome = process.env.GEMINI_CLI_HOME?.trim() || homedir();
  const oauthPath = join(geminiCliHome, '.gemini', 'oauth_creds.json');
  const oauthFileExists = existsSync(oauthPath);
  checks.push({
    backend: 'gemini',
    name: 'gemini-auth-inputs',
    status: geminiApiKey || googleApiKey || googleCredentialsExists || oauthFileExists ? 'ok' : 'warn',
    detail: [
      `GEMINI_API_KEY=${geminiApiKey ? 'set' : 'missing'}`,
      `GOOGLE_API_KEY=${googleApiKey ? 'set' : 'missing'}`,
      `GOOGLE_APPLICATION_CREDENTIALS=${googleCredentialsPath ? (googleCredentialsExists ? 'exists' : 'missing-file') : 'missing'}`,
      `oauthFile=${oauthFileExists ? 'exists' : 'missing'}:${oauthPath}`,
      'Set one Gemini/Google auth source before running Gemini live smoke.',
    ].join(' '),
  });
}

async function probeGeminiSdkShape(moduleSpecifier: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-server-gemini-shape-'));
  try {
    const sdk = await import(moduleSpecifier) as Record<string, unknown>;
    const AgentExport = sdk.GeminiCliAgent;
    if (typeof AgentExport !== 'function') {
      return { ok: false, error: 'missing GeminiCliAgent export' };
    }
    const Agent = AgentExport as new (options: Record<string, unknown>) => { session?: () => unknown };
    const agent = new Agent({
      cwd: workspace,
      model: process.env.AGENT_SERVER_GEMINI_MODEL || 'gemini-agentserver-preflight',
      instructions: 'AgentServer preflight shape check.',
    });
    if (typeof agent.session !== 'function') {
      return { ok: false, error: 'GeminiCliAgent.session is not a function' };
    }
    const session = agent.session() as { id?: unknown; sendStream?: unknown };
    if (!session || typeof session !== 'object') {
      return { ok: false, error: 'GeminiCliAgent.session did not return an object' };
    }
    if (typeof session.sendStream !== 'function') {
      return { ok: false, error: 'Gemini session missing sendStream(prompt, signal)' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function checkCodexAppServerHandshake(command: string): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-server-codex-preflight-'));
  let client: JsonRpcProbeClient | undefined;
  try {
    client = JsonRpcProbeClient.spawn(command);
    await withTimeout(client.request('initialize', {
      clientInfo: {
        name: 'agent_server_preflight',
        title: 'AgentServer Preflight',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    }), 8_000, 'codex initialize');
    client.notify('initialized');
    const response = await withTimeout(client.request('thread/start', {
      cwd: workspace,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }), 8_000, 'codex thread/start');
    const threadId = readNestedString(response, ['thread', 'id']);
    checks.push({
      backend: 'codex',
      name: 'codex-app-server-handshake',
      status: threadId ? 'ok' : 'warn',
      detail: threadId
        ? `app-server initialized and started thread ${threadId}`
        : `app-server responded to thread/start but no thread.id was found: ${JSON.stringify(response).slice(0, 200)}`,
    });
    await checkCodexAuthStatus(client);
    await checkCodexAccount(client);
    await checkCodexModels(client);
    await checkCodexRateLimits(client);
  } catch (error) {
    checks.push({
      backend: 'codex',
      name: 'codex-app-server-handshake',
      status: 'fail',
      detail: `Codex app-server JSON-RPC handshake failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    await client?.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
}

async function checkCodexAccount(client: JsonRpcProbeClient): Promise<void> {
  try {
    const response = await withTimeout(client.request('account/read', {
      refreshToken: false,
    }), 8_000, 'codex account/read');
    const account = readRecord(response, 'account');
    const accountType = readString(account, 'type') || 'none';
    const planType = readString(account, 'planType') || 'unknown';
    const requiresOpenaiAuth = readBoolean(response, 'requiresOpenaiAuth');
    checks.push({
      backend: 'codex',
      name: 'codex-account',
      status: requiresOpenaiAuth === true && accountType === 'none' ? 'warn' : 'ok',
      detail: `accountType=${accountType} planType=${planType} requiresOpenaiAuth=${requiresOpenaiAuth ?? 'unknown'} email=redacted`,
    });
  } catch (error) {
    checks.push({
      backend: 'codex',
      name: 'codex-account',
      status: 'warn',
      detail: `Codex app-server did not return account summary: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function checkCodexAuthStatus(client: JsonRpcProbeClient): Promise<void> {
  try {
    const response = await withTimeout(client.request('getAuthStatus', {
      includeToken: false,
      refreshToken: false,
    }), 8_000, 'codex getAuthStatus');
    const authMethod = readString(response, 'authMethod') || 'none';
    const requiresOpenaiAuth = readBoolean(response, 'requiresOpenaiAuth');
    checks.push({
      backend: 'codex',
      name: 'codex-auth-status',
      status: requiresOpenaiAuth === true && authMethod === 'none' ? 'warn' : 'ok',
      detail: `authMethod=${authMethod} requiresOpenaiAuth=${requiresOpenaiAuth ?? 'unknown'} token=not_requested`,
    });
  } catch (error) {
    checks.push({
      backend: 'codex',
      name: 'codex-auth-status',
      status: 'warn',
      detail: `Codex app-server did not return auth status: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function checkCodexModels(client: JsonRpcProbeClient): Promise<void> {
  try {
    const response = await withTimeout(client.request('model/list', {
      includeHidden: false,
      limit: 50,
    }), 8_000, 'codex model/list');
    const models = readArray(response, 'data');
    const visibleModels = models
      .map((item) => readString(item, 'id') || readString(item, 'model'))
      .filter((item): item is string => Boolean(item));
    const defaultModel = models.find((item) => readBoolean(item, 'isDefault') === true);
    checks.push({
      backend: 'codex',
      name: 'codex-model-list',
      status: visibleModels.length > 0 ? 'ok' : 'warn',
      detail: visibleModels.length > 0
        ? `models=${visibleModels.slice(0, 6).join(',')} count=${visibleModels.length} default=${readString(defaultModel, 'id') || readString(defaultModel, 'model') || 'unknown'}`
        : `model/list returned no visible models: ${JSON.stringify(response).slice(0, 200)}`,
    });
  } catch (error) {
    checks.push({
      backend: 'codex',
      name: 'codex-model-list',
      status: 'warn',
      detail: `Codex app-server did not return model list: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function checkCodexRateLimits(client: JsonRpcProbeClient): Promise<void> {
  try {
    const response = await withTimeout(client.request('account/rateLimits/read'), 8_000, 'codex account/rateLimits/read');
    const rateLimits = readRecord(response, 'rateLimits');
    const primary = readRecord(rateLimits, 'primary');
    const secondary = readRecord(rateLimits, 'secondary');
    const reached = readString(rateLimits, 'rateLimitReachedType') || 'none';
    checks.push({
      backend: 'codex',
      name: 'codex-rate-limits',
      status: reached === 'none' ? 'ok' : 'warn',
      detail: [
        `reached=${reached}`,
        `primaryUsed=${readNumber(primary, 'usedPercent') ?? 'unknown'}`,
        `secondaryUsed=${readNumber(secondary, 'usedPercent') ?? 'none'}`,
      ].join(' '),
    });
  } catch (error) {
    checks.push({
      backend: 'codex',
      name: 'codex-rate-limits',
      status: 'warn',
      detail: `Codex app-server did not return rate limits: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function probeOpenAiCompatibleEndpoint(baseUrl: string, apiKey: string): Promise<{
  reachable: boolean;
  statusCode?: number;
  error?: string;
}> {
  const normalized = baseUrl.replace(/\/+$/, '');
  const url = `${normalized}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: controller.signal,
    });
    return {
      reachable: response.status < 500,
      statusCode: response.status,
      error: response.status >= 500 ? `HTTP ${response.status}` : undefined,
    };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function parseSelectedBackends(value: string | undefined): StrategicAgentBackend[] {
  if (!value) {
    return STRATEGIC_BACKENDS;
  }
  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    return STRATEGIC_BACKENDS;
  }
  const invalid = parsed.filter((item) => !STRATEGIC_BACKENDS.includes(item as StrategicAgentBackend));
  if (invalid.length > 0) {
    throw new Error(`Unknown strategic backend(s) in AGENT_SERVER_LIVE_ADAPTER_SMOKE_BACKENDS: ${invalid.join(', ')}`);
  }
  return [...new Set(parsed)] as StrategicAgentBackend[];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathToFileUrl(path: string): string {
  return pathToFileURL(path).href;
}

function isTsxRuntime(): boolean {
  return process.execArgv.some((arg) => arg.includes('tsx'));
}

class JsonRpcProbeClient {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private readonly readline;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.readline = createInterface({ input: child.stdout });
    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr.on('data', () => undefined);
    child.on('exit', (code, signal) => {
      const error = new Error(`process exited: code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.on('error', (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  static spawn(command: string): JsonRpcProbeClient {
    return new JsonRpcProbeClient(spawn(command, ['app-server', '--listen', 'stdio://'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close(): Promise<void> {
    this.readline.close();
    if (!this.child.killed) {
      this.child.kill('SIGTERM');
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    let message: { id?: number; result?: unknown; error?: { message?: string; code?: number } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `JSON-RPC error ${message.error.code ?? ''}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function readNestedString(value: unknown, path: string[]): string | undefined {
  let current = value;
  for (const part of path) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return item && typeof item === 'object' && !Array.isArray(item)
    ? item as Record<string, unknown>
    : undefined;
}

function readArray(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return [];
  }
  const item = (value as Record<string, unknown>)[key];
  return Array.isArray(item)
    ? item.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry))
    : [];
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'boolean' ? item : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) {
    return undefined;
  }
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'number' ? item : undefined;
}

await main();
