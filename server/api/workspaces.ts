import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PROJECT_ROOT } from '../utils/paths.js';
import { error, sendJson, success } from '../utils/response.js';
import { getTeamDir } from './teams/shared.js';

const execFileAsync = promisify(execFile);

export type WorkspaceKind = 'local' | 'ssh' | 'container' | 'remote-runtime';
export type WorkspaceStatus = 'available' | 'disconnected' | 'checking' | 'error' | 'unknown';

export type WorkspaceDescriptor = {
  id: string;
  label: string;
  kind: WorkspaceKind;
  root: string;
  status: WorkspaceStatus;
  source: 'project' | 'team' | 'ssh-config' | 'runtime';
  host?: string;
  user?: string;
  port?: number;
  diagnostics?: string;
};

export type SshTargetDescriptor = {
  id: string;
  label: string;
  host: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFile?: string;
  source: string;
};

export type WorkspaceDirectoryEntry = {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
  modifiedAt?: string;
};

type SshConfigEntry = {
  patterns: string[];
  values: Record<string, string>;
};

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

function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function resolveLocalWorkspaceRoot(workspaceId: string, teamId: string | null): string | null {
  if (workspaceId === 'local:project-root') {
    return PROJECT_ROOT;
  }
  if (teamId && workspaceId === `local:team:${teamId}`) {
    return getTeamDir(teamId);
  }
  return null;
}

function isPathInside(parent: string, child: string): boolean {
  const normalizedParent = join(parent, '.');
  const normalizedChild = join(child, '.');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function parseSshConfig(content: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  let current: SshConfigEntry | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9]+)\s+(.+)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'host') {
      current = { patterns: value.split(/\s+/), values: {} };
      entries.push(current);
      continue;
    }
    if (current) {
      current.values[key] = value;
    }
  }
  return entries;
}

export async function listSshTargets(): Promise<{ targets: SshTargetDescriptor[]; warning?: string }> {
  const configPath = getSshConfigPath();
  if (!existsSync(configPath)) {
    return { targets: [], warning: `SSH config not found at ${configPath}` };
  }

  const content = await readFile(configPath, 'utf-8');
  const targets: SshTargetDescriptor[] = [];
  for (const entry of parseSshConfig(content)) {
    for (const host of entry.patterns) {
      if (!host || host.includes('*') || host.includes('?')) continue;
      targets.push({
        id: host,
        label: entry.values.hostname ? `${host} (${entry.values.hostname})` : host,
        host,
        hostName: entry.values.hostname,
        user: entry.values.user,
        port: entry.values.port ? Number(entry.values.port) : undefined,
        identityFile: entry.values.identityfile,
        source: configPath,
      });
    }
  }

  return { targets };
}

function getSshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

async function buildWorkspacePayload(teamId: string | null): Promise<{
  workspaces: WorkspaceDescriptor[];
  sshTargets: SshTargetDescriptor[];
  total: number;
  warning?: string;
}> {
  const ssh = await listSshTargets();
  const workspaces: WorkspaceDescriptor[] = [
    {
      id: 'local:project-root',
      label: 'Project root',
      kind: 'local',
      root: PROJECT_ROOT,
      status: 'available',
      source: 'project',
      diagnostics: 'Current OpenTeam Studio workspace',
    },
  ];

  if (teamId) {
    const teamDir = getTeamDir(teamId);
    workspaces.push({
      id: `local:team:${teamId}`,
      label: `Team ${teamId}`,
      kind: 'local',
      root: teamDir,
      status: existsSync(teamDir) ? 'available' : 'unknown',
      source: 'team',
      diagnostics: existsSync(teamDir) ? 'Team workspace directory' : 'Team directory has not been created yet',
    });
  }

  for (const target of ssh.targets) {
    workspaces.push({
      id: `ssh:${target.id}`,
      label: target.label,
      kind: 'ssh',
      root: '~',
      status: 'unknown',
      source: 'ssh-config',
      host: target.hostName || target.host,
      user: target.user,
      port: target.port,
      diagnostics: 'Discovered from ~/.ssh/config',
    });
  }

  return {
    workspaces,
    sshTargets: ssh.targets,
    total: workspaces.length,
    warning: ssh.warning,
  };
}

async function listLocalDirectory(root: string, relPath: string): Promise<WorkspaceDirectoryEntry[]> {
  const target = join(root, relPath || '.');
  if (!isPathInside(root, target)) {
    throw new Error('Path escapes workspace root');
  }
  const entries = await readdir(target, { withFileTypes: true });
  const rows: WorkspaceDirectoryEntry[] = [];
  for (const entry of entries.slice(0, 300)) {
    const fullPath = join(target, entry.name);
    const info = await stat(fullPath).catch(() => null);
    rows.push({
      name: entry.name,
      path: join(relPath || '.', entry.name),
      type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      size: info?.size,
      modifiedAt: info?.mtime ? info.mtime.toISOString() : undefined,
    });
  }
  return rows.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

async function listSshDirectory(targetId: string, relPath: string): Promise<WorkspaceDirectoryEntry[]> {
  const remotePath = relPath && relPath !== '.' ? relPath : '~';
  const cdTarget = remotePath === '~' ? '$HOME' : shellQuote(remotePath);
  const script = [
    `cd ${cdTarget}`,
    'pwd',
    'find . -maxdepth 1 -mindepth 1 -print 2>/dev/null | head -300',
  ].join(' && ');
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    targetId,
    script,
  ], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  const cwd = lines.shift() || remotePath;
  return lines.map((line) => {
    const name = line.replace(/^\.\//, '');
    return {
      name,
      path: `${cwd.replace(/\/$/, '')}/${name}`,
      type: 'other' as const,
    };
  });
}

async function listWorkspaceDirectory(args: {
  workspaceId: string;
  teamId: string | null;
  path: string;
}): Promise<WorkspaceDirectoryEntry[]> {
  const localRoot = resolveLocalWorkspaceRoot(args.workspaceId, args.teamId);
  if (localRoot) {
    return listLocalDirectory(localRoot, args.path || '.');
  }
  if (args.workspaceId.startsWith('ssh:')) {
    return listSshDirectory(args.workspaceId.slice('ssh:'.length), args.path || '~');
  }
  throw new Error(`Unsupported workspace for directory listing: ${args.workspaceId}`);
}

export async function testSshTarget(targetId: string): Promise<{
  targetId: string;
  ok: boolean;
  status: WorkspaceStatus;
  message: string;
  checkedAt: string;
}> {
  if (!targetId || targetId.includes('\n') || targetId.includes('\0')) {
    return {
      targetId,
      ok: false,
      status: 'error',
      message: 'Invalid SSH target id',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    await execFileAsync('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      targetId,
      'true',
    ], { timeout: 8000 });
    return {
      targetId,
      ok: true,
      status: 'available',
      message: 'SSH connection succeeded',
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      targetId,
      ok: false,
      status: 'error',
      message,
      checkedAt: new Date().toISOString(),
    };
  }
}

async function executeWorkspaceCommand(args: {
  workspaceId: string;
  teamId: string | null;
  command: string;
  cwd?: string | null;
}): Promise<{
  workspaceId: string;
  command: string;
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  checkedAt: string;
}> {
  const command = String(args.command || '').trim();
  if (!command) {
    throw new Error('Missing command');
  }
  if (/[\0\r\n]/.test(command)) {
    throw new Error('Command must be a single line');
  }

  try {
    if (args.workspaceId.startsWith('ssh:')) {
      const targetId = args.workspaceId.slice('ssh:'.length);
      const cwdPrefix = args.cwd ? `cd ${shellQuote(args.cwd)} && ` : '';
      const result = await execFileAsync('ssh', [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=5',
        targetId,
        `${cwdPrefix}${command}`,
      ], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return {
        workspaceId: args.workspaceId,
        command,
        ok: true,
        stdout: result.stdout.slice(0, 8_000),
        stderr: result.stderr.slice(0, 8_000),
        exitCode: 0,
        checkedAt: new Date().toISOString(),
      };
    }

    const root = resolveLocalWorkspaceRoot(args.workspaceId, args.teamId);
    if (!root) {
      throw new Error(`Unsupported workspace: ${args.workspaceId}`);
    }
    const cwd = args.cwd ? join(root, args.cwd) : root;
    if (!isPathInside(root, cwd)) {
      throw new Error('cwd escapes workspace root');
    }
    const result = await execFileAsync('/bin/sh', ['-lc', command], { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
    return {
      workspaceId: args.workspaceId,
      command,
      ok: true,
      stdout: result.stdout.slice(0, 8_000),
      stderr: result.stderr.slice(0, 8_000),
      exitCode: 0,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      workspaceId: args.workspaceId,
      command,
      ok: false,
      stdout: String(e.stdout || '').slice(0, 8_000),
      stderr: String(e.stderr || e.message || '').slice(0, 8_000),
      exitCode: typeof e.code === 'number' ? e.code : null,
      checkedAt: new Date().toISOString(),
    };
  }
}

export async function handleWorkspaceRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const parsed = new URL(rawUrl, 'http://localhost');

  if (parsed.pathname === '/api/workspaces' && method === 'GET') {
    try {
      sendJson(res, 200, success(await buildWorkspacePayload(parsed.searchParams.get('teamId'))));
    } catch (err) {
      console.error('[Workspaces] Failed to list workspaces:', err);
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  if (parsed.pathname === '/api/workspaces/ssh-config' && method === 'GET') {
    try {
      const path = getSshConfigPath();
      const content = existsSync(path) ? await readFile(path, 'utf-8') : '';
      sendJson(res, 200, success({ path, content }));
    } catch (err) {
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  if (parsed.pathname === '/api/workspaces/ssh-config' && method === 'PUT') {
    try {
      const body = JSON.parse(await readBody(req)) as { content?: string };
      const content = String(body.content || '');
      const path = getSshConfigPath();
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, 'utf-8');
      sendJson(res, 200, success({ path, updatedAt: new Date().toISOString() }));
    } catch (err) {
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  const directoryMatch = parsed.pathname.match(/^\/api\/workspaces\/(.+)\/files$/);
  if (directoryMatch && method === 'GET') {
    try {
      const workspaceId = decodeURIComponent(directoryMatch[1]);
      const teamId = parsed.searchParams.get('teamId');
      const path = parsed.searchParams.get('path') || '.';
      const entries = await listWorkspaceDirectory({ workspaceId, teamId, path });
      sendJson(res, 200, success({ workspaceId, path, entries, total: entries.length }));
    } catch (err) {
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  if (parsed.pathname === '/api/workspaces/ssh-test' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as { targetId?: string };
      sendJson(res, 200, success(await testSshTarget(body.targetId || '')));
    } catch (err) {
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  if (parsed.pathname === '/api/workspaces/exec' && method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req)) as { workspaceId?: string; teamId?: string; command?: string; cwd?: string };
      sendJson(res, 200, success(await executeWorkspaceCommand({
        workspaceId: body.workspaceId || '',
        teamId: body.teamId || null,
        command: body.command || '',
        cwd: body.cwd || null,
      })));
    } catch (err) {
      sendJson(res, 500, error(err instanceof Error ? err.message : String(err)));
    }
    return true;
  }

  return false;
}
