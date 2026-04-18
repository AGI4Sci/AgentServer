import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = resolve(process.cwd());
const backendDir = join(root, 'server', 'backend');
const binDir = resolve(process.env.OPENTEAM_BACKEND_BIN_DIR?.trim() || join(backendDir, 'bin'));
const isWindows = process.platform === 'win32';
const selectedBackendNames = new Set(
  (process.env.AGENT_SERVER_BUILD_BACKENDS || 'codex,claude_code_rust,zeroclaw,claude_code,openclaw,hermes_agent')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean),
);
const pruneAfterBuild = process.env.AGENT_SERVER_PRUNE_AFTER_BUILD !== '0';

type RustBuildTarget = {
  name: string;
  crateDir: string;
  binaryName: string;
  cargoArgs: string[];
};

const rustTargets: RustBuildTarget[] = [
  {
    name: 'openteam_codex',
    crateDir: join(backendDir, 'codex', 'codex-rs'),
    binaryName: 'codex',
    cargoArgs: ['build', '--release', '-p', 'codex-cli', '--bin', 'codex'],
  },
  {
    name: 'openteam_claude_code_rust',
    crateDir: join(backendDir, 'claude_code_rust'),
    binaryName: 'claude',
    cargoArgs: ['build', '--release', '--bin', 'claude'],
  },
  {
    name: 'openteam_zeroclaw',
    crateDir: join(backendDir, 'zeroclaw'),
    binaryName: 'zeroclaw',
    cargoArgs: ['build', '--release', '--bin', 'zeroclaw'],
  },
];

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeExecutable(path: string, content: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, content, 'utf8');
  if (!isWindows) {
    chmodSync(path, 0o755);
  }
}

function renderUnixLauncher(body: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail
${body}
`;
}

function buildRustTargets(): void {
  for (const target of rustTargets) {
    if (!selectedBackendNames.has(target.name.replace(/^openteam_/, ''))) {
      continue;
    }
    console.log(`[build] ${target.name}`);
    run('cargo', target.cargoArgs, target.crateDir);
    const builtBinary = join(
      target.crateDir,
      'target',
      'release',
      `${target.binaryName}${isWindows ? '.exe' : ''}`,
    );
    if (!existsSync(builtBinary)) {
      throw new Error(`Built binary not found: ${builtBinary}`);
    }
    const outputPath = join(binDir, `${target.name}${isWindows ? '.exe' : ''}`);
    copyFileSync(builtBinary, outputPath);
    if (!isWindows) {
      chmodSync(outputPath, 0o755);
    }
  }
}

function buildClaudeCodeLauncher(): void {
  const outputPath = join(binDir, `openteam_claude_code${isWindows ? '.cmd' : ''}`);
  if (isWindows) {
    writeExecutable(
      outputPath,
      [
        '@echo off',
        'setlocal',
        'set "SCRIPT_DIR=%~dp0"',
        'for %%I in ("%SCRIPT_DIR%..\\..\\..") do set "PROJECT_ROOT=%%~fI"',
        'set "ENTRY=%PROJECT_ROOT%\\server\\backend\\claude_code\\openteam-runtime.ts"',
        'node --import tsx "%ENTRY%" %*',
        '',
      ].join('\r\n'),
    );
    return;
  }
  writeExecutable(
    outputPath,
    renderUnixLauncher(`
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENTRY="$PROJECT_ROOT/server/backend/claude_code/openteam-runtime.ts"
if command -v bun >/dev/null 2>&1; then
  exec bun "$ENTRY" "$@"
fi
if node --import tsx --eval '' >/dev/null 2>&1; then
  exec node --import tsx "$ENTRY" "$@"
fi
exec npx tsx "$ENTRY" "$@"
`.trim()),
  );
}

function buildOpenClawLauncher(): void {
  const outputPath = join(binDir, `openteam_openclaw${isWindows ? '.cmd' : ''}`);
  if (isWindows) {
    writeExecutable(
      outputPath,
      [
        '@echo off',
        'setlocal',
        'set "SCRIPT_DIR=%~dp0"',
        'for %%I in ("%SCRIPT_DIR%..\\..\\..") do set "PROJECT_ROOT=%%~fI"',
        'set "DIST=%PROJECT_ROOT%\\server\\backend\\openclaw\\dist\\index.js"',
        'set "DEV=%PROJECT_ROOT%\\server\\backend\\openclaw\\scripts\\run-node.mjs"',
        'if exist "%DIST%" (',
        '  node "%DIST%" %*',
        ') else (',
        '  node "%DEV%" %*',
        ')',
        '',
      ].join('\r\n'),
    );
    return;
  }
  writeExecutable(
    outputPath,
    renderUnixLauncher(`
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST="$PROJECT_ROOT/server/backend/openclaw/dist/index.js"
DEV="$PROJECT_ROOT/server/backend/openclaw/scripts/run-node.mjs"
if [ -f "$DIST" ]; then
  exec node "$DIST" "$@"
fi
exec node "$DEV" "$@"
`.trim()),
  );
}

function buildHermesAgentLauncher(): void {
  const outputPath = join(binDir, `openteam_hermes_agent${isWindows ? '.cmd' : ''}`);
  if (isWindows) {
    writeExecutable(
      outputPath,
      [
        '@echo off',
        'setlocal',
        'set "SCRIPT_DIR=%~dp0"',
        'for %%I in ("%SCRIPT_DIR%..\\..\\..") do set "PROJECT_ROOT=%%~fI"',
        'set "ENTRY=%PROJECT_ROOT%\\server\\backend\\hermes_agent"',
        'set "PYTHONPATH=%ENTRY%;%PYTHONPATH%"',
        'cd /d "%ENTRY%"',
        'python -m acp_adapter %*',
        '',
      ].join('\r\n'),
    );
    return;
  }
  writeExecutable(
    outputPath,
    renderUnixLauncher(`
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
ENTRY="$PROJECT_ROOT/server/backend/hermes_agent"
export PYTHONPATH="$ENTRY:$PYTHONPATH"
cd "$ENTRY"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m acp_adapter "$@"
fi
exec python -m acp_adapter "$@"
`.trim()),
  );
}

function main(): void {
  ensureDir(binDir);
  buildRustTargets();
  if (selectedBackendNames.has('claude_code')) {
    buildClaudeCodeLauncher();
  }
  if (selectedBackendNames.has('openclaw')) {
    buildOpenClawLauncher();
  }
  if (selectedBackendNames.has('hermes_agent')) {
    buildHermesAgentLauncher();
  }
  if (pruneAfterBuild) {
    console.log('[prune] removing backend build artifacts');
    run(process.execPath, ['--import', 'tsx', join(root, 'scripts', 'prune-backend-build-artifacts.ts')], root);
  }
  console.log(`[done] backend launchers are available in ${binDir}`);
}

main();
