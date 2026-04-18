import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  classifyTool,
  normalizeToolNameForRouting,
  planToolRoute,
  type ToolRoutePlan,
  type ToolRoutingPolicy,
  type WorkerProfile,
  type WorkspaceSpec,
} from '../../core/runtime/tool-routing.js';
import {
  executeLocalDevPrimitiveCall,
  type LocalDevPrimitiveCall,
  type LocalDevPrimitiveResult,
} from './shared/local-dev-primitives.js';

const MAX_EXECUTOR_OUTPUT_CHARS = 12_000;
const SSH_EXECUTOR_TIMEOUT_MS = 120_000;
const CLIENT_WORKER_TIMEOUT_MS = 120_000;

export interface RoutedToolExecutionAttempt {
  workerId: string;
  status: 'skipped' | 'failed' | 'succeeded';
  reason: string;
}

export interface RoutedToolWriteback {
  status: 'not-needed' | 'written' | 'pending' | 'failed';
  reason: string;
  path?: string;
}

export interface RoutedToolExecutionResult {
  ok: boolean;
  output: string;
  route: ToolRoutePlan;
  workerId?: string;
  attempts: RoutedToolExecutionAttempt[];
  writeback: RoutedToolWriteback;
}

const LOCAL_DEV_PRIMITIVE_TOOLS = new Set<LocalDevPrimitiveCall['toolName']>([
  'append_file',
  'apply_patch',
  'browser_activate',
  'browser_open',
  'grep_search',
  'list_dir',
  'read_file',
  'run_command',
  'web_fetch',
  'web_search',
  'write_file',
]);

function isLocalDevPrimitiveTool(toolName: string): toolName is LocalDevPrimitiveCall['toolName'] {
  return LOCAL_DEV_PRIMITIVE_TOOLS.has(toolName as LocalDevPrimitiveCall['toolName']);
}

function pathIsInside(child: string, parent: string): boolean {
  const normalizedChild = child.replace(/\/+$/, '');
  const normalizedParent = parent.replace(/\/+$/, '');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function workerCanAccessWorkspace(worker: WorkerProfile, workspace: WorkspaceSpec): boolean {
  if (worker.id === workspace.ownerWorker) {
    return true;
  }
  return (worker.allowedRoots || []).some((root) => pathIsInside(workspace.root, root));
}

function workerById(workers: WorkerProfile[]): Map<string, WorkerProfile> {
  return new Map(workers.map((worker) => [worker.id, worker]));
}

function implementedExecutorKind(worker: WorkerProfile): boolean {
  return worker.kind === 'backend-server'
    || worker.kind === 'server'
    || (worker.kind === 'client-worker' && Boolean(worker.endpoint))
    || (worker.kind === 'ssh' && Boolean(worker.host));
}

function executionCwd(worker: WorkerProfile, workspace: WorkspaceSpec, toolName: string): string {
  const classification = classifyTool(toolName);
  if (classification.sideEffectsWorkspace || workerCanAccessWorkspace(worker, workspace)) {
    return workspace.root;
  }
  return process.cwd();
}

function findWorkspaceWriteWorker(workers: WorkerProfile[], workspace: WorkspaceSpec): WorkerProfile | null {
  return workers.find((worker) => {
    return (worker.kind === 'server' || worker.kind === 'ssh' || worker.kind === 'client-worker')
      && worker.capabilities.includes('filesystem')
      && implementedExecutorKind(worker)
      && workerCanAccessWorkspace(worker, workspace);
  }) || null;
}

function safeArtifactSegment(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'tool';
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_EXECUTOR_OUTPUT_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_EXECUTOR_OUTPUT_CHARS)}\n...[truncated ${value.length - MAX_EXECUTOR_OUTPUT_CHARS} chars]`;
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function assertRemotePathAllowed(pathValue: string): void {
  if (/(?:^|\/)\.blackboard(?:\/|$)/.test(pathValue)) {
    throw new Error('Access to .blackboard/* shadow files is forbidden.');
  }
}

function assertRemoteCommandAllowed(command: string): void {
  if (/(?:^|[\s"'`])\.blackboard(?:\/|[\s"'`]|$)/.test(command)) {
    throw new Error('Commands that inspect or mutate .blackboard/* shadow files are forbidden.');
  }
}

function uniqueHereDocDelimiter(prefix: string, content: string): string {
  let delimiter = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  while (content.includes(delimiter)) {
    delimiter = `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
  return delimiter;
}

function remotePathScript(rawPath: string): string {
  return [
    `raw_path=${shellQuote(rawPath)}`,
    'case "$raw_path" in',
    '  /*) target_path="$raw_path" ;;',
    '  *) target_path="$PWD/$raw_path" ;;',
    'esac',
  ].join('\n');
}

function buildSshPrimitiveScript(call: LocalDevPrimitiveCall, cwd: string): string {
  const header = [
    'set -euo pipefail',
    `cd ${shellQuote(cwd)}`,
  ];

  if (call.toolName === 'read_file') {
    const path = call.args.path || '';
    assertRemotePathAllowed(path);
    return [
      ...header,
      remotePathScript(path),
      'printf "path=%s\\n" "$target_path"',
      'cat "$target_path"',
    ].join('\n');
  }

  if (call.toolName === 'append_file' || call.toolName === 'write_file') {
    const path = call.args.path || '';
    const content = call.args.content || '';
    assertRemotePathAllowed(path);
    const redirect = call.toolName === 'append_file' ? '>>' : '>';
    return [
      ...header,
      remotePathScript(path),
      'mkdir -p "$(dirname "$target_path")"',
      `printf %s ${shellQuote(content)} ${redirect} "$target_path"`,
      `printf "${call.toolName === 'append_file' ? 'appended' : 'wrote'} %s bytes to %s\\n" ${Buffer.byteLength(content, 'utf-8')} "$target_path"`,
    ].join('\n');
  }

  if (call.toolName === 'list_dir') {
    const path = call.args.path || '.';
    assertRemotePathAllowed(path);
    return [
      ...header,
      remotePathScript(path),
      'printf "path=%s\\n" "$target_path"',
      'for entry in "$target_path"/* "$target_path"/.[!.]* "$target_path"/..?*; do',
      '  [ -e "$entry" ] || continue',
      '  name="${entry##*/}"',
      '  if [ -d "$entry" ]; then printf "dir %s\\n" "$name"; else printf "file %s\\n" "$name"; fi',
      'done',
    ].join('\n');
  }

  if (call.toolName === 'grep_search') {
    const path = call.args.path || '.';
    const pattern = call.args.pattern?.trim();
    if (!pattern) {
      throw new Error('grep_search requires <pattern>.');
    }
    assertRemotePathAllowed(path);
    return [
      ...header,
      remotePathScript(path),
      `pattern=${shellQuote(pattern)}`,
      'if command -v rg >/dev/null 2>&1; then',
      '  rg -n --hidden --no-ignore-vcs --glob "!node_modules" --glob "!.git" -- "$pattern" "$target_path"',
      'else',
      '  grep -RIn --exclude-dir=node_modules --exclude-dir=.git -- "$pattern" "$target_path"',
      'fi',
    ].join('\n');
  }

  if (call.toolName === 'run_command') {
    const command = call.args.command?.trim();
    if (!command) {
      throw new Error('run_command requires <command>.');
    }
    assertRemoteCommandAllowed(command);
    return [
      ...header,
      `bash -lc ${shellQuote(command)}`,
    ].join('\n');
  }

  if (call.toolName === 'apply_patch') {
    const patch = call.args.patch || '';
    if (!patch.trim()) {
      throw new Error('apply_patch requires <patch>.');
    }
    const delimiter = uniqueHereDocDelimiter('AGENT_SERVER_PATCH', patch);
    return [
      ...header,
      `patch -p0 <<'${delimiter}'`,
      patch,
      delimiter,
    ].join('\n');
  }

  if (call.toolName === 'web_fetch') {
    const url = call.args.url?.trim();
    if (!url) {
      throw new Error('web_fetch requires <url>.');
    }
    return [
      ...header,
      `url=${shellQuote(url)}`,
      'if command -v curl >/dev/null 2>&1; then',
      '  curl -L --max-time 30 -sS "$url"',
      'elif command -v wget >/dev/null 2>&1; then',
      '  wget -T 30 -qO- "$url"',
      'else',
      '  echo "web_fetch requires curl or wget on ssh worker" >&2',
      '  exit 127',
      'fi',
    ].join('\n');
  }

  throw new Error(`SSH executor does not support ${call.toolName}`);
}

function buildSshArgs(worker: WorkerProfile): string[] {
  if (!worker.host) {
    throw new Error(`SSH worker ${worker.id} requires host.`);
  }
  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
  ];
  if (worker.port) {
    sshArgs.push('-p', String(worker.port));
  }
  if (worker.identityFile) {
    sshArgs.push('-i', worker.identityFile);
  }
  const host = worker.user ? `${worker.user}@${worker.host}` : worker.host;
  sshArgs.push(host, 'bash', '-s');
  return sshArgs;
}

async function executeSshPrimitiveCall(
  worker: WorkerProfile,
  call: LocalDevPrimitiveCall,
  cwd: string,
): Promise<LocalDevPrimitiveResult> {
  const script = buildSshPrimitiveScript(call, cwd);
  const sshBin = process.env.AGENT_SERVER_SSH_BIN?.trim() || 'ssh';
  const sshArgs = buildSshArgs(worker);
  return await new Promise((resolve, reject) => {
    const child = spawn(sshBin, sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(SSH_EXECUTOR_TIMEOUT_MS),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      const output = truncateOutput([stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n'));
      resolve({
        ok: code === 0,
        output: output || `ssh exited with code ${code}`,
      });
    });
    child.stdin.end(script);
  });
}

async function executeClientWorkerPrimitiveCall(args: {
  worker: WorkerProfile;
  call: LocalDevPrimitiveCall;
  workspace: WorkspaceSpec;
  cwd: string;
}): Promise<LocalDevPrimitiveResult> {
  if (!args.worker.endpoint) {
    throw new Error(`Client worker ${args.worker.id} requires endpoint.`);
  }
  const endpoint = args.worker.endpoint.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (args.worker.authToken) {
    headers.authorization = `Bearer ${args.worker.authToken}`;
  }
  const response = await fetch(`${endpoint}/tool-call`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workerId: args.worker.id,
      workspace: args.workspace,
      cwd: args.cwd,
      toolName: args.call.toolName,
      args: args.call.args,
    }),
    signal: AbortSignal.timeout(CLIENT_WORKER_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error
      : text;
    return {
      ok: false,
      output: truncateOutput(`client-worker ${args.worker.id} failed with status ${response.status}: ${detail}`),
    };
  }
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      output: truncateOutput(`client-worker ${args.worker.id} returned non-JSON response: ${text}`),
    };
  }
  const record = payload as { ok?: unknown; output?: unknown; error?: unknown };
  return {
    ok: record.ok === true,
    output: truncateOutput(
      typeof record.output === 'string'
        ? record.output
        : typeof record.error === 'string'
          ? record.error
          : JSON.stringify(record),
    ),
  };
}

async function executeWorkerPrimitiveCall(args: {
  worker: WorkerProfile;
  call: LocalDevPrimitiveCall;
  workspace: WorkspaceSpec;
  toolName: string;
}): Promise<LocalDevPrimitiveResult> {
  const cwd = executionCwd(args.worker, args.workspace, args.toolName);
  if (args.worker.kind === 'ssh') {
    return await executeSshPrimitiveCall(args.worker, args.call, cwd);
  }
  if (args.worker.kind === 'client-worker') {
    return await executeClientWorkerPrimitiveCall({
      worker: args.worker,
      call: args.call,
      workspace: args.workspace,
      cwd,
    });
  }
  return await executeLocalDevPrimitiveCall(args.call, { cwd });
}

async function writeNetworkToolArtifact(args: {
  toolName: string;
  workspace: WorkspaceSpec;
  workers: WorkerProfile[];
  workerId: string;
  result: LocalDevPrimitiveResult;
  route: ToolRoutePlan;
}): Promise<RoutedToolWriteback> {
  const classification = classifyTool(args.toolName);
  if (classification.kind !== 'network') {
    return {
      status: 'not-needed',
      reason: `${classification.kind} tool result stays in the normal tool-result event`,
    };
  }

  const writer = findWorkspaceWriteWorker(args.workers, args.workspace);
  if (!writer) {
    return {
      status: 'pending',
      reason: `No implemented workspace writer can write artifacts for workspace ${args.workspace.id}`,
    };
  }

  const artifactRoot = args.workspace.artifactRoot || join(args.workspace.root, '.agent-server', 'tool-results');
  const fileName = `${Date.now()}-${safeArtifactSegment(args.toolName)}-${safeArtifactSegment(args.workerId)}.json`;
  const artifactPath = join(artifactRoot, fileName);
  const payload = {
    toolName: args.toolName,
    workerId: args.workerId,
    workspaceId: args.workspace.id,
    ok: args.result.ok,
    output: args.result.output,
    route: {
      primaryWorker: args.route.primaryWorker,
      fallbackWorkers: args.route.fallbackWorkers,
      reason: args.route.reason,
    },
  };

  if (writer.kind === 'ssh') {
    try {
      const remoteWrite = await executeSshPrimitiveCall(writer, {
        toolName: 'write_file',
        args: {
          path: artifactPath,
          content: `${JSON.stringify(payload, null, 2)}\n`,
        },
      }, args.workspace.root);
      if (!remoteWrite.ok) {
        return {
          status: 'failed',
          reason: remoteWrite.output,
          path: artifactPath,
        };
      }
      return {
        status: 'written',
        reason: `network tool result written via ${writer.id}`,
        path: artifactPath,
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        path: artifactPath,
      };
    }
  }

  if (writer.kind === 'client-worker') {
    try {
      const clientWrite = await executeClientWorkerPrimitiveCall({
        worker: writer,
        call: {
          toolName: 'write_file',
          args: {
            path: artifactPath,
            content: `${JSON.stringify(payload, null, 2)}\n`,
          },
        },
        workspace: args.workspace,
        cwd: args.workspace.root,
      });
      if (!clientWrite.ok) {
        return {
          status: 'failed',
          reason: clientWrite.output,
          path: artifactPath,
        };
      }
      return {
        status: 'written',
        reason: `network tool result written via ${writer.id}`,
        path: artifactPath,
      };
    } catch (error) {
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        path: artifactPath,
      };
    }
  }

  try {
    await mkdir(artifactRoot, { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    return {
      status: 'written',
      reason: `network tool result written via ${writer.id}`,
      path: artifactPath,
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      path: artifactPath,
    };
  }
}

export async function executeRoutedToolCall(args: {
  toolName: string;
  toolArgs?: Record<string, string>;
  workspace: WorkspaceSpec;
  workers: WorkerProfile[];
  policy?: ToolRoutingPolicy;
}): Promise<RoutedToolExecutionResult> {
  const normalizedToolName = normalizeToolNameForRouting(args.toolName);
  const route = planToolRoute({
    toolName: normalizedToolName,
    workspace: args.workspace,
    workers: args.workers,
    policy: args.policy,
  });
  const attempts: RoutedToolExecutionAttempt[] = [];

  if (!isLocalDevPrimitiveTool(normalizedToolName)) {
    return {
      ok: false,
      output: `Tool ${normalizedToolName} is routable but has no implemented local primitive executor.`,
      route,
      attempts,
      writeback: {
        status: 'not-needed',
        reason: 'tool did not execute',
      },
    };
  }

  const workers = workerById(args.workers);
  const call: LocalDevPrimitiveCall = {
    toolName: normalizedToolName,
    args: args.toolArgs || {},
  };
  let lastOutput = '';
  let lastWorkerId: string | undefined;

  for (const plannedWorker of route.workers) {
    const worker = workers.get(plannedWorker.workerId);
    if (!worker) {
      attempts.push({
        workerId: plannedWorker.workerId,
        status: 'skipped',
        reason: 'worker is not configured',
      });
      continue;
    }
    if (!plannedWorker.executableNow || !implementedExecutorKind(worker)) {
      attempts.push({
        workerId: worker.id,
        status: 'skipped',
        reason: plannedWorker.reason,
      });
      continue;
    }

    lastWorkerId = worker.id;
    try {
      const result = await executeWorkerPrimitiveCall({
        worker,
        call,
        workspace: args.workspace,
        toolName: normalizedToolName,
      });
      if (!result.ok) {
        lastOutput = result.output;
        attempts.push({
          workerId: worker.id,
          status: 'failed',
          reason: result.output,
        });
        continue;
      }

      attempts.push({
        workerId: worker.id,
        status: 'succeeded',
        reason: 'tool executed',
      });
      const writeback = await writeNetworkToolArtifact({
        toolName: normalizedToolName,
        workspace: args.workspace,
        workers: args.workers,
        workerId: worker.id,
        result,
        route,
      });
      return {
        ok: writeback.status !== 'failed',
        output: result.output,
        route,
        workerId: worker.id,
        attempts,
        writeback,
      };
    } catch (error) {
      lastOutput = error instanceof Error ? error.message : String(error);
      attempts.push({
        workerId: worker.id,
        status: 'failed',
        reason: lastOutput,
      });
    }
  }

  return {
    ok: false,
    output: lastOutput || `No executable worker completed ${normalizedToolName}.`,
    route,
    workerId: lastWorkerId,
    attempts,
    writeback: {
      status: 'not-needed',
      reason: 'tool did not complete',
    },
  };
}
