import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.cwd());
const backendDir = join(root, 'server', 'backend');

const DEFAULT_PRUNE_PATHS = [
  'codex/codex-rs/target',
  'hermes_agent/web/node_modules',
  'hermes_agent/**/__pycache__',
  'openclaw/.next',
];

function expandPattern(pattern: string): string[] {
  if (!pattern.includes('**')) {
    return [join(backendDir, pattern)];
  }
  const [prefix, suffixRaw] = pattern.split('**');
  const suffix = suffixRaw.replace(/^\//, '');
  const base = join(backendDir, prefix);
  const out: string[] = [];
  function walk(dir: string): void {
    if (!existsSync(dir)) {
      return;
    }
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (full.endsWith(suffix)) {
          out.push(full);
        }
        walk(full);
      }
    }
  }
  walk(base);
  return out;
}

const patterns = process.env.AGENT_SERVER_PRUNE_PATHS?.trim()
  ? process.env.AGENT_SERVER_PRUNE_PATHS.split(',').map((item) => item.trim()).filter(Boolean)
  : DEFAULT_PRUNE_PATHS;

let removed = 0;
for (const pattern of patterns) {
  for (const target of expandPattern(pattern)) {
    if (!existsSync(target)) {
      continue;
    }
    rmSync(target, { recursive: true, force: true });
    removed += 1;
    console.log(`[prune] removed ${target}`);
  }
}

console.log(`[prune] complete removed=${removed}`);
