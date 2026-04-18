import type { IncomingMessage, ServerResponse } from 'http';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { error, sendJson, success } from '../utils/response.js';

const execFileAsync = promisify(execFile);

function isSafeRoot(root: string): boolean {
  const normalized = String(root || '').trim();
  return Boolean(normalized) && existsSync(normalized) && !normalized.includes('\0');
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return String(stdout || '').trim();
}

function parsePorcelain(raw: string): Array<{ path: string; status: string; staged: boolean }> {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const status = line.slice(0, 2);
      const path = line.slice(3).trim();
      if (!path) return null;
      return {
        path,
        status,
        staged: status[0] !== ' ' && status[0] !== '?',
      };
    })
    .filter((item): item is { path: string; status: string; staged: boolean } => Boolean(item));
}

async function getRepoStatus(root: string): Promise<{
  root: string;
  repoRoot: string;
  branch: string;
  changes: Array<{ path: string; status: string; staged: boolean }>;
  diffStat: string;
  ok: boolean;
  error?: string;
}> {
  try {
    const repoRoot = await git(['rev-parse', '--show-toplevel'], root);
    const branch = await git(['branch', '--show-current'], repoRoot).catch(() => 'HEAD');
    const status = await git(['status', '--porcelain=v1'], repoRoot);
    const diffStat = await git(['diff', '--stat'], repoRoot).catch(() => '');
    return {
      root,
      repoRoot,
      branch: branch || 'HEAD',
      changes: parsePorcelain(status),
      diffStat,
      ok: true,
    };
  } catch (err) {
    return {
      root,
      repoRoot: root,
      branch: 'unknown',
      changes: [],
      diffStat: '',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function handleScmRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const parsed = new URL(rawUrl, 'http://localhost');
  if (parsed.pathname !== '/api/scm/status' || method !== 'GET') {
    return false;
  }

  const roots = parsed.searchParams.getAll('root')
    .map((root) => decodeURIComponent(root))
    .filter(isSafeRoot)
    .slice(0, 8);
  if (roots.length === 0) {
    sendJson(res, 400, error('At least one valid root is required'));
    return true;
  }

  const statuses = await Promise.all(roots.map((root) => getRepoStatus(join(root, '.'))));
  sendJson(res, 200, success({
    checkedAt: new Date().toISOString(),
    repositories: statuses,
  }));
  return true;
}
