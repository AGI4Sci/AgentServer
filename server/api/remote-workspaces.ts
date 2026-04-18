import type { IncomingMessage, ServerResponse } from 'http';
import { execFile, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { error, sendJson, success } from '../utils/response.js';
import { listSshTargets } from './workspaces.js';

const execFileAsync = promisify(execFile);

export type RemoteNetworkMode = 'offline' | 'remote-direct' | 'remote-via-local-proxy' | 'local-egress';

export type RemoteSessionState = {
  sessionId: string;
  endpointId: string;
  targetId: string;
  host: string;
  user?: string;
  port?: number;
  root: string;
  status: 'connecting' | 'ready' | 'error' | 'closed';
  networkMode: RemoteNetworkMode;
  workerVersion: string | null;
  worker: {
    version: string | null;
    installDir: string | null;
    installedAt: string | null;
    mode: 'none' | 'node-worker' | 'shell-proxy';
    health: 'unknown' | 'ok' | 'error';
    message?: string | null;
  };
  tunnel: {
    mode: 'none' | 'ssh-tunnel' | 'reverse-ssh';
    localPort?: number | null;
    remotePort?: number | null;
    proxyEnv?: Record<string, string>;
  };
  health: {
    ok: boolean;
    message: string;
    checkedAt: string;
  };
  diagnostics: string[];
  createdAt: string;
  lastActivityAt: string;
};

export type RemoteWorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size?: number | null;
  modifiedAt?: string | null;
};

export type RemotePortEntry = {
  protocol: string;
  address: string;
  port: number | null;
  process?: string | null;
};

const sessions = new Map<string, RemoteSessionState>();
const REMOTE_WORKER_VERSION = '2026.04.17-ssh-proxy-mvp';

function nowIso(): string {
  return new Date().toISOString();
}

function jsonError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function validateSshTargetId(targetId: string): string {
  const normalized = String(targetId || '').trim();
  if (!normalized || /[\0\r\n]/.test(normalized)) {
    throw new Error('Invalid SSH target id');
  }
  return normalized;
}

function normalizeRemotePath(path: string | undefined | null, fallback: string): string {
  const normalized = String(path || '').trim();
  if (!normalized) {
    return fallback;
  }
  if (/[\0\r\n]/.test(normalized)) {
    throw new Error('Invalid remote path');
  }
  return normalized;
}

function remotePathForShell(path: string): string {
  const normalized = normalizeRemotePath(path, '~');
  if (normalized === '~' || normalized === '~/') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return `$HOME/${shellQuote(normalized.slice(2)).slice(1, -1)}`;
  }
  return shellQuote(normalized);
}

function remotePathForDoubleQuotedShell(path: string): string {
  const normalized = normalizeRemotePath(path, '~');
  if (normalized === '~' || normalized === '~/') {
    return '$HOME';
  }
  if (normalized.startsWith('~/')) {
    return `$HOME/${normalized.slice(2).replace(/["\\$`]/g, '\\$&')}`;
  }
  return normalized.replace(/["\\$`]/g, '\\$&');
}

function resolveRemotePath(session: RemoteSessionState, path: string | undefined | null): string {
  const normalized = normalizeRemotePath(path, session.root);
  if (normalized.startsWith('/') || normalized.startsWith('~')) {
    return normalized;
  }
  return `${session.root.replace(/\/$/, '')}/${normalized}`;
}

function remoteWorkerInstallDir(version = REMOTE_WORKER_VERSION): string {
  return `~/.openteam/remote/${version}`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function sshExec(targetId: string, script: string, options?: {
  timeoutMs?: number;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    validateSshTargetId(targetId),
    script,
  ], {
    timeout: options?.timeoutMs || 15_000,
    maxBuffer: options?.maxBuffer || 1024 * 1024,
  });
  return {
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

async function sshWriteStdin(targetId: string, script: string, input: string, timeoutMs = 15_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      validateSshTargetId(targetId),
      script,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Remote write timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `ssh exited with code ${code}`));
      }
    });
    child.stdin.end(input);
  });
}

async function sshWriteBase64File(targetId: string, path: string, content: string, timeoutMs = 20_000): Promise<void> {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  await sshWriteStdin(
    targetId,
    `mkdir -p "$(dirname "${remotePathForDoubleQuotedShell(path)}")" && base64 -d > ${remotePathForShell(path)}`,
    encoded,
    timeoutMs,
  );
}

function touchSession(session: RemoteSessionState): RemoteSessionState {
  session.lastActivityAt = nowIso();
  return session;
}

function requireSession(sessionId: string): RemoteSessionState {
  const session = sessions.get(String(sessionId || '').trim());
  if (!session) {
    throw new Error('Remote session not found');
  }
  return touchSession(session);
}

async function probeRemote(targetId: string, root: string): Promise<{
  ok: boolean;
  message: string;
  cwd: string;
  diagnostics: string[];
}> {
  const script = [
    `cd ${remotePathForShell(root)}`,
    'printf "cwd=%s\\n" "$PWD"',
    'printf "uname=%s\\n" "$(uname -a 2>/dev/null || true)"',
    'printf "shell=%s\\n" "$SHELL"',
    'printf "node=%s\\n" "$(command -v node 2>/dev/null || true)"',
    'printf "python3=%s\\n" "$(command -v python3 2>/dev/null || true)"',
    'printf "git=%s\\n" "$(command -v git 2>/dev/null || true)"',
    'printf "writable=%s\\n" "$([ -w . ] && echo yes || echo no)"',
  ].join(' && ');
  const { stdout } = await sshExec(targetId, script, { timeoutMs: 10_000 });
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cwd = lines.find((line) => line.startsWith('cwd='))?.slice(4) || root;
  const writable = lines.find((line) => line.startsWith('writable='))?.slice('writable='.length) || 'unknown';
  return {
    ok: true,
    message: writable === 'yes' ? 'Remote SSH workspace is ready' : 'Remote SSH workspace is reachable but root may be read-only',
    cwd,
    diagnostics: lines,
  };
}

async function createRemoteSession(input: {
  targetId: string;
  root?: string | null;
  networkMode?: RemoteNetworkMode | null;
}): Promise<RemoteSessionState> {
  const targetId = validateSshTargetId(input.targetId);
  const targets = await listSshTargets().catch(() => ({ targets: [] }));
  const target = targets.targets.find((item) => item.id === targetId);
  const root = normalizeRemotePath(input.root, '~');
  const networkMode = input.networkMode && ['offline', 'remote-direct', 'remote-via-local-proxy', 'local-egress'].includes(input.networkMode)
    ? input.networkMode
    : 'offline';
  const createdAt = nowIso();
  for (const [sessionId, existing] of sessions.entries()) {
    if (existing.targetId === targetId) {
      sessions.delete(sessionId);
    }
  }
  const session: RemoteSessionState = {
    sessionId: `remote:${targetId}:${randomUUID()}`,
    endpointId: `ssh:${targetId}`,
    targetId,
    host: target?.hostName || target?.host || targetId,
    user: target?.user,
    port: target?.port,
    root,
    status: 'connecting',
    networkMode,
    workerVersion: null,
    worker: {
      version: null,
      installDir: null,
      installedAt: null,
      mode: 'none',
      health: 'unknown',
      message: null,
    },
    tunnel: { mode: 'none' },
    health: {
      ok: false,
      message: 'Connecting',
      checkedAt: createdAt,
    },
    diagnostics: [],
    createdAt,
    lastActivityAt: createdAt,
  };
  sessions.set(session.sessionId, session);
  try {
    const probe = await probeRemote(targetId, root);
    session.root = probe.cwd || root;
    session.status = 'ready';
    session.health = {
      ok: probe.ok,
      message: probe.message,
      checkedAt: nowIso(),
    };
    session.diagnostics = probe.diagnostics;
  } catch (err) {
    session.status = 'error';
    session.health = {
      ok: false,
      message: jsonError(err),
      checkedAt: nowIso(),
    };
    session.diagnostics = [jsonError(err)];
  }
  return touchSession(session);
}

function buildRemoteWorkerBundle(): Array<{ path: string; content: string; mode?: string }> {
  const manifest = {
    name: 'openteam-remote-worker',
    version: REMOTE_WORKER_VERSION,
    protocol: 'ssh-proxy-mvp',
    capabilities: ['health', 'files', 'exec', 'git', 'ports-probe'],
    network: 'offline-installable',
    createdAt: nowIso(),
  };
  const workerMjs = `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { platform, arch, release } from 'node:os';

const version = ${JSON.stringify(REMOTE_WORKER_VERSION)};
const command = process.argv[2] || 'health';

function json(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\\n');
}

if (command === 'health') {
  const cwd = process.cwd();
  json({
    ok: true,
    name: 'openteam-remote-worker',
    version,
    protocol: 'ssh-proxy-mvp',
    cwd,
    platform: platform(),
    arch: arch(),
    release: release(),
    git: (() => { try { return execFileSync('git', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } })(),
    writable: (() => { try { return statSync(cwd).isDirectory(); } catch { return false; } })(),
  });
  process.exit(0);
}

if (command === 'stat') {
  const target = process.argv[3] || '.';
  json({ ok: existsSync(target), path: target, stat: existsSync(target) ? statSync(target) : null });
  process.exit(0);
}

json({ ok: false, error: 'unknown command', command });
process.exit(2);
`;
  const workerSh = `#!/bin/sh
set -eu
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/worker.mjs" "$@"
fi
if [ "\${1:-health}" = "health" ]; then
  printf '{"ok":true,"name":"openteam-remote-worker","version":"%s","protocol":"shell-proxy","node":null,"cwd":"%s"}\\n' "${REMOTE_WORKER_VERSION}" "$(pwd)"
  exit 0
fi
printf '{"ok":false,"error":"node unavailable for command"}\\n'
exit 2
`;
  return [
    { path: 'manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'worker.mjs', content: workerMjs, mode: '755' },
    { path: 'worker.sh', content: workerSh, mode: '755' },
    { path: 'README.md', content: `# OpenTeam Remote Worker\n\nVersion: ${REMOTE_WORKER_VERSION}\n\nInstalled by local OpenTeam Studio over SSH. No remote internet is required.\n` },
  ];
}

async function installRemoteWorker(session: RemoteSessionState, force = false): Promise<RemoteSessionState> {
  const installDir = remoteWorkerInstallDir();
  const check = await sshExec(session.targetId, `[ -f ${shellQuote(`${installDir}/manifest.json`)} ] && cat ${shellQuote(`${installDir}/manifest.json`)} || true`, {
    timeoutMs: 10_000,
    maxBuffer: 256 * 1024,
  }).catch(() => ({ stdout: '', stderr: '' }));
  if (!force && check.stdout.includes(`"version": "${REMOTE_WORKER_VERSION}"`)) {
    session.workerVersion = REMOTE_WORKER_VERSION;
    session.worker = {
      version: REMOTE_WORKER_VERSION,
      installDir,
      installedAt: session.worker.installedAt || nowIso(),
      mode: session.worker.mode === 'none' ? 'shell-proxy' : session.worker.mode,
      health: 'unknown',
      message: 'Worker already installed',
    };
    return touchSession(session);
  }

  await sshExec(session.targetId, `mkdir -p ${shellQuote(installDir)}`, { timeoutMs: 10_000 });
  for (const file of buildRemoteWorkerBundle()) {
    const targetPath = `${installDir}/${file.path}`;
    await sshWriteBase64File(session.targetId, targetPath, file.content, 25_000);
    if (file.mode) {
      await sshExec(session.targetId, `chmod ${file.mode} ${shellQuote(targetPath)}`, { timeoutMs: 10_000 });
    }
  }
  session.workerVersion = REMOTE_WORKER_VERSION;
  session.worker = {
    version: REMOTE_WORKER_VERSION,
    installDir,
    installedAt: nowIso(),
    mode: 'shell-proxy',
    health: 'unknown',
    message: 'Worker bundle uploaded',
  };
  return touchSession(session);
}

async function checkRemoteWorker(session: RemoteSessionState): Promise<RemoteSessionState> {
  const installDir = session.worker.installDir || remoteWorkerInstallDir(session.worker.version || REMOTE_WORKER_VERSION);
  const { stdout } = await sshExec(session.targetId, `cd ${shellQuote(installDir)} && ./worker.sh health`, {
    timeoutMs: 10_000,
    maxBuffer: 512 * 1024,
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  const protocol = String(parsed?.protocol || '').trim();
  session.workerVersion = String(parsed?.version || session.worker.version || REMOTE_WORKER_VERSION);
  session.worker = {
    version: session.workerVersion,
    installDir,
    installedAt: session.worker.installedAt,
    mode: protocol === 'ssh-proxy-mvp' ? 'node-worker' : 'shell-proxy',
    health: parsed?.ok === true ? 'ok' : 'error',
    message: stdout.trim().slice(0, 1000),
  };
  session.health = {
    ok: session.worker.health === 'ok',
    message: session.worker.health === 'ok' ? `Remote worker ${session.worker.version} ready` : 'Remote worker health failed',
    checkedAt: nowIso(),
  };
  return touchSession(session);
}

async function listRemoteDirectory(session: RemoteSessionState, path?: string | null): Promise<{
  cwd: string;
  entries: RemoteWorkspaceDirectoryEntry[];
}> {
  const targetPath = resolveRemotePath(session, path);
  const script = [
    `cd ${remotePathForShell(targetPath)}`,
    'printf "__OPENTEAM_CWD__\\t%s\\n" "$PWD"',
    'find . -maxdepth 1 -mindepth 1 -print 2>/dev/null | sed "s#^./##" | head -300 | while IFS= read -r name; do',
    '  [ -z "$name" ] && continue',
    '  if [ -d "$name" ]; then type=directory; elif [ -f "$name" ]; then type=file; else type=other; fi',
    '  size=$(wc -c < "$name" 2>/dev/null | tr -d " " || printf "")',
    '  mtime=$(date -r "$name" -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || printf "")',
    '  printf "%s\\t%s\\t%s\\t%s\\n" "$type" "$name" "$size" "$mtime"',
    'done',
  ].join('\n');
  const { stdout } = await sshExec(session.targetId, script, { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });
  const rows = stdout.split(/\r?\n/).filter(Boolean);
  const cwdRow = rows.find((row) => row.startsWith('__OPENTEAM_CWD__\t'));
  const cwd = cwdRow?.split('\t')[1] || targetPath;
  const entries = rows
    .filter((row) => !row.startsWith('__OPENTEAM_CWD__\t'))
    .map((row) => {
      const [type, name, size, modifiedAt] = row.split('\t');
      return {
        name: name || row,
        path: `${cwd.replace(/\/$/, '')}/${name || row}`,
        type: type === 'directory' || type === 'file' ? type : 'other',
        size: size ? Number(size) : null,
        modifiedAt: modifiedAt || null,
      } satisfies RemoteWorkspaceDirectoryEntry;
    })
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  return { cwd, entries };
}

async function readRemoteFile(session: RemoteSessionState, path?: string | null): Promise<{
  path: string;
  content: string;
  encoding: 'utf-8';
}> {
  const targetPath = resolveRemotePath(session, path);
  const { stdout } = await sshExec(session.targetId, `base64 < ${remotePathForShell(targetPath)}`, {
    timeoutMs: 15_000,
    maxBuffer: 12 * 1024 * 1024,
  });
  return {
    path: targetPath,
    content: Buffer.from(stdout.replace(/\s+/g, ''), 'base64').toString('utf-8'),
    encoding: 'utf-8',
  };
}

async function writeRemoteFile(session: RemoteSessionState, path: string, content: string): Promise<{
  path: string;
  bytes: number;
  updatedAt: string;
}> {
  const targetPath = resolveRemotePath(session, path);
  const encoded = Buffer.from(String(content || ''), 'utf-8').toString('base64');
  await sshWriteStdin(
    session.targetId,
    `mkdir -p "$(dirname "${remotePathForDoubleQuotedShell(targetPath)}")" && base64 -d > ${remotePathForShell(targetPath)}`,
    encoded,
    20_000,
  );
  return {
    path: targetPath,
    bytes: Buffer.byteLength(String(content || ''), 'utf-8'),
    updatedAt: nowIso(),
  };
}

async function makeRemoteDirectory(session: RemoteSessionState, path: string): Promise<{ path: string; updatedAt: string }> {
  const targetPath = resolveRemotePath(session, path);
  await sshExec(session.targetId, `mkdir -p ${remotePathForShell(targetPath)}`, { timeoutMs: 15_000 });
  return { path: targetPath, updatedAt: nowIso() };
}

async function renameRemotePath(session: RemoteSessionState, oldPath: string, newPath: string): Promise<{ oldPath: string; newPath: string; updatedAt: string }> {
  const source = resolveRemotePath(session, oldPath);
  const target = resolveRemotePath(session, newPath);
  await sshExec(session.targetId, `mv ${remotePathForShell(source)} ${remotePathForShell(target)}`, { timeoutMs: 15_000 });
  return { oldPath: source, newPath: target, updatedAt: nowIso() };
}

async function deleteRemotePath(session: RemoteSessionState, path: string): Promise<{ path: string; updatedAt: string }> {
  const targetPath = resolveRemotePath(session, path);
  if (targetPath === '/' || targetPath === '~' || targetPath === session.root) {
    throw new Error('Refusing to delete remote workspace root');
  }
  await sshExec(session.targetId, `rm -rf -- ${remotePathForShell(targetPath)}`, { timeoutMs: 20_000 });
  return { path: targetPath, updatedAt: nowIso() };
}

async function executeRemoteCommand(session: RemoteSessionState, command: string, cwd?: string | null): Promise<{
  command: string;
  cwd: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  checkedAt: string;
}> {
  const normalizedCommand = String(command || '').trim();
  if (!normalizedCommand || /[\0\r\n]/.test(normalizedCommand)) {
    throw new Error('Command must be a single line');
  }
  const targetCwd = resolveRemotePath(session, cwd || session.root);
  try {
    const result = await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      session.targetId,
      `cd ${remotePathForShell(targetCwd)} && ${normalizedCommand}`,
    ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
    return {
      command: normalizedCommand,
      cwd: targetCwd,
      ok: true,
      stdout: String(result.stdout || '').slice(0, 16_000),
      stderr: String(result.stderr || '').slice(0, 16_000),
      exitCode: 0,
      checkedAt: nowIso(),
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      command: normalizedCommand,
      cwd: targetCwd,
      ok: false,
      stdout: String(e.stdout || '').slice(0, 16_000),
      stderr: String(e.stderr || e.message || '').slice(0, 16_000),
      exitCode: typeof e.code === 'number' ? e.code : null,
      checkedAt: nowIso(),
    };
  }
}

async function listRemotePorts(session: RemoteSessionState): Promise<RemotePortEntry[]> {
  const script = [
    '(command -v ss >/dev/null 2>&1 && ss -ltnp 2>/dev/null)',
    '|| (command -v netstat >/dev/null 2>&1 && netstat -ltnp 2>/dev/null)',
    '|| (command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null)',
    '|| true',
  ].join(' ');
  const { stdout } = await sshExec(session.targetId, script, { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
  return stdout.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^State\s|^Proto\s|^COMMAND\s/i.test(line))
    .map((line) => {
      const endpoint = line.match(/((?:\d{1,3}\.){3}\d{1,3}|\[[^\]]+\]|\*|0\.0\.0\.0|127\.0\.0\.1|::|\S+):(\d{2,5})/);
      const port = endpoint ? Number(endpoint[2]) : null;
      const processMatch = line.match(/users:\(\("([^"]+)"/) || line.match(/\s(\S+\/\S+)\s*$/);
      return {
        protocol: /udp/i.test(line) ? 'udp' : 'tcp',
        address: endpoint?.[1] || line,
        port: Number.isFinite(port) ? port : null,
        process: processMatch?.[1] || null,
      } satisfies RemotePortEntry;
    })
    .filter((entry, index, all) => entry.port !== null && all.findIndex((item) => item.port === entry.port && item.address === entry.address) === index)
    .slice(0, 100);
}

async function tailRemoteLog(session: RemoteSessionState, path: string, lines = 160): Promise<{
  path: string;
  tail: string;
  checkedAt: string;
}> {
  const targetPath = resolveRemotePath(session, path);
  const boundedLines = Math.max(1, Math.min(1000, Number(lines) || 160));
  const { stdout } = await sshExec(session.targetId, `tail -n ${boundedLines} -- ${remotePathForShell(targetPath)} 2>/dev/null || tail -n ${boundedLines} ${remotePathForShell(targetPath)}`, {
    timeoutMs: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return {
    path: targetPath,
    tail: stdout.slice(-64_000),
    checkedAt: nowIso(),
  };
}

export async function handleRemoteWorkspaceRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const parsed = new URL(req.url || '/', 'http://localhost');

  if (parsed.pathname === '/api/remote/sessions' && method === 'GET') {
    sendJson(res, 200, success({ sessions: [...sessions.values()], total: sessions.size }));
    return true;
  }

  if (parsed.pathname === '/api/remote/sessions/connect' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as { targetId?: string; root?: string; networkMode?: RemoteNetworkMode };
      sendJson(res, 200, success(await createRemoteSession({
        targetId: body.targetId || '',
        root: body.root || '~',
        networkMode: body.networkMode || 'offline',
      })));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const bootstrapMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/bootstrap$/);
  if (bootstrapMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(bootstrapMatch[1]));
      const probe = await probeRemote(session.targetId, session.root);
      session.root = probe.cwd || session.root;
      session.status = 'ready';
      session.health = { ok: probe.ok, message: probe.message, checkedAt: nowIso() };
      session.diagnostics = probe.diagnostics;
      sendJson(res, 200, success(session));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const workerInstallMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/worker\/install$/);
  if (workerInstallMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(workerInstallMatch[1]));
      const body = JSON.parse(await readBody(req) || '{}') as { force?: boolean };
      const installed = await installRemoteWorker(session, body.force === true);
      const checked = await checkRemoteWorker(installed).catch(() => installed);
      sendJson(res, 200, success(checked));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const workerHealthMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/worker\/health$/);
  if (workerHealthMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(workerHealthMatch[1]));
      sendJson(res, 200, success(await checkRemoteWorker(session)));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const fileListMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/files$/);
  if (fileListMatch && method === 'GET') {
    try {
      const session = requireSession(decodeURIComponent(fileListMatch[1]));
      const listed = await listRemoteDirectory(session, parsed.searchParams.get('path'));
      sendJson(res, 200, success({ sessionId: session.sessionId, path: listed.cwd, entries: listed.entries, total: listed.entries.length }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const fileMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/file$/);
  if (fileMatch && method === 'GET') {
    try {
      const session = requireSession(decodeURIComponent(fileMatch[1]));
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await readRemoteFile(session, parsed.searchParams.get('path'))) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }
  if (fileMatch && method === 'PUT') {
    try {
      const session = requireSession(decodeURIComponent(fileMatch[1]));
      const body = JSON.parse(await readBody(req)) as { path?: string; content?: string };
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await writeRemoteFile(session, body.path || '', body.content || '')) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const mkdirMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/mkdir$/);
  if (mkdirMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(mkdirMatch[1]));
      const body = JSON.parse(await readBody(req)) as { path?: string };
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await makeRemoteDirectory(session, body.path || '')) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const renameMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/rename$/);
  if (renameMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(renameMatch[1]));
      const body = JSON.parse(await readBody(req)) as { oldPath?: string; newPath?: string };
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await renameRemotePath(session, body.oldPath || '', body.newPath || '')) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const deleteMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/delete$/);
  if (deleteMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(deleteMatch[1]));
      const body = JSON.parse(await readBody(req)) as { path?: string };
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await deleteRemotePath(session, body.path || '')) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const execMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/exec$/);
  if (execMatch && method === 'POST') {
    try {
      const session = requireSession(decodeURIComponent(execMatch[1]));
      const body = JSON.parse(await readBody(req)) as { command?: string; cwd?: string };
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await executeRemoteCommand(session, body.command || '', body.cwd || session.root)) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const portsMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/ports$/);
  if (portsMatch && method === 'GET') {
    try {
      const session = requireSession(decodeURIComponent(portsMatch[1]));
      const ports = await listRemotePorts(session);
      sendJson(res, 200, success({ sessionId: session.sessionId, ports, total: ports.length, checkedAt: nowIso() }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const logsMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/logs\/tail$/);
  if (logsMatch && method === 'GET') {
    try {
      const session = requireSession(decodeURIComponent(logsMatch[1]));
      sendJson(res, 200, success({ sessionId: session.sessionId, ...(await tailRemoteLog(
        session,
        parsed.searchParams.get('path') || '',
        Number(parsed.searchParams.get('lines') || 160),
      )) }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const disconnectMatch = parsed.pathname.match(/^\/api\/remote\/sessions\/(.+)\/disconnect$/);
  if (disconnectMatch && method === 'POST') {
    const sessionId = decodeURIComponent(disconnectMatch[1]);
    const session = sessions.get(sessionId) || null;
    if (session) {
      session.status = 'closed';
      session.health = { ok: false, message: 'Disconnected', checkedAt: nowIso() };
      touchSession(session);
    }
    sessions.delete(sessionId);
    sendJson(res, 200, success({ sessionId, disconnected: true }));
    return true;
  }

  return false;
}
