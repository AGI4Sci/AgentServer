import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { isAbsolute, relative, resolve } from 'path';

import type { BackendType } from '../../core/runtime/backend-catalog.js';

export interface WorkspacePrimitivePathHit {
  relativePath: string;
}

export interface WorkspacePrimitiveContentHit {
  relativePath: string;
  lines: Array<{ line: number; text: string }>;
  token: string;
}

export interface WorkspacePrimitiveFileSlice {
  absolutePath: string;
  relativePath: string;
  content: string;
  absoluteTime: string | null;
}

export interface WorkspaceSearchPrimitiveAdapter {
  readonly id: string;
  readonly invocationMode: 'native_rpc' | 'native_aligned' | 'shell_fallback';
  collectPathCandidates(root: string, tokens: string[], limit: number): Promise<WorkspacePrimitivePathHit[]>;
  collectContentHits(root: string, tokens: string[]): Promise<WorkspacePrimitiveContentHit[]>;
  readFileSlice(root: string, relativePath: string): Promise<WorkspacePrimitiveFileSlice | null>;
}

const DEFAULT_MAX_MATCH_LINES = 4;
const DEFAULT_MAX_CONTEXT_LINES = 2;
const FILE_READ_LIMIT_BYTES = 24_000;

type RgJsonEvent = {
  type: string;
  data?: {
    path?: { text?: string } | null;
    line_number?: number | null;
    lines?: { text?: string } | null;
  } | null;
};

function tokenizeFileList(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatAbsoluteTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resolveWorkspacePath(root: string, candidate: string): string {
  return isAbsolute(candidate) ? candidate : resolve(root, candidate);
}

async function execCollect(command: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolvePromise({
        code: 1,
        stdout,
        stderr: error instanceof Error ? error.message : String(error),
      });
    });
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function statAbsoluteTime(absolutePath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(absolutePath);
    return formatAbsoluteTime(stat.mtime);
  } catch {
    return null;
  }
}

function createShellWorkspacePrimitiveAdapter(args: {
  id: string;
  invocationMode: WorkspaceSearchPrimitiveAdapter['invocationMode'];
  fileListCommand: (root: string) => { command: string; args: string[] };
  contentSearchCommand: (root: string, token: string) => { command: string; args: string[] };
}): WorkspaceSearchPrimitiveAdapter {
  return {
    id: args.id,
    invocationMode: args.invocationMode,
    async collectPathCandidates(root, tokens, limit) {
      const listCommand = args.fileListCommand(root);
      const result = await execCollect(listCommand.command, listCommand.args, root);
      if (result.code !== 0) {
        return [];
      }
      const files = tokenizeFileList(result.stdout);
      return files
        .filter((file) => {
          const normalized = file.toLowerCase();
          return tokens.some((token) => normalized.includes(token.toLowerCase()));
        })
        .slice(0, limit)
        .map((relativePath) => ({ relativePath }));
    },

    async collectContentHits(root, tokens) {
      const hits: WorkspacePrimitiveContentHit[] = [];
      for (const token of tokens) {
        const contentCommand = args.contentSearchCommand(root, token);
        const result = await execCollect(contentCommand.command, contentCommand.args, root);
        if (result.code !== 0 && result.code !== 1) {
          continue;
        }
        const grouped = new Map<string, Array<{ line: number; text: string }>>();
        for (const line of result.stdout.split('\n').filter(Boolean)) {
          let event: RgJsonEvent | null = null;
          try {
            event = JSON.parse(line) as RgJsonEvent;
          } catch {
            event = null;
          }
          if (!event || (event.type !== 'match' && event.type !== 'context')) {
            continue;
          }
          const path = event.data?.path?.text;
          const lineNumber = event.data?.line_number;
          const text = event.data?.lines?.text;
          if (!path || !lineNumber || typeof text !== 'string') {
            continue;
          }
          const existing = grouped.get(path) || [];
          existing.push({ line: lineNumber, text: text.trimEnd() });
          grouped.set(path, existing);
        }
        for (const [relativePath, lines] of grouped.entries()) {
          hits.push({
            relativePath,
            lines: lines.slice(0, DEFAULT_MAX_MATCH_LINES + DEFAULT_MAX_CONTEXT_LINES * 2),
            token,
          });
        }
      }
      return hits;
    },

    async readFileSlice(root, relativePath) {
      const absolutePath = resolveWorkspacePath(root, relativePath);
      try {
        const buffer = await fs.readFile(absolutePath);
        const content = buffer.length > FILE_READ_LIMIT_BYTES
          ? buffer.subarray(0, FILE_READ_LIMIT_BYTES).toString('utf-8')
          : buffer.toString('utf-8');
        return {
          absolutePath,
          relativePath,
          content,
          absoluteTime: await statAbsoluteTime(absolutePath),
        };
      } catch {
        return null;
      }
    },
  };
}

const SHELL_FALLBACK_ADAPTER = createShellWorkspacePrimitiveAdapter({
  id: 'shell_fallback',
  invocationMode: 'shell_fallback',
  fileListCommand(root) {
    return {
      command: 'rg',
      args: ['--files', '--hidden', '--glob', '!node_modules', '--glob', '!.git', root],
    };
  },
  contentSearchCommand(root, token) {
    return {
      command: 'rg',
      args: [
        '--json',
        '-n',
        '-F',
        '--hidden',
        '--no-ignore-vcs',
        '--glob',
        '!node_modules',
        '--glob',
        '!.git',
        '--max-count',
        String(DEFAULT_MAX_MATCH_LINES),
        '--context',
        String(DEFAULT_MAX_CONTEXT_LINES),
        token,
        root,
      ],
    };
  },
});

export function resolveWorkspacePrimitiveAdapter(backend: BackendType): WorkspaceSearchPrimitiveAdapter {
  return SHELL_FALLBACK_ADAPTER;
}

export function absolutizeRelativePath(root: string, relativePath: string): string {
  return resolveWorkspacePath(root, relativePath);
}

export function relativizeWorkspacePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath) || absolutePath;
}
