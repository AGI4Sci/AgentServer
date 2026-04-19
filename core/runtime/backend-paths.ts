import { mkdirSync } from 'fs';
import { join } from 'path';

export type ManagedBackendName =
  | 'claude_code'
  | 'codex'
  | 'hermes_agent'
  | 'openclaw'
  | 'runtime_supervisor';

export function getBackendRootDir(backend: ManagedBackendName): string {
  return join(process.cwd(), 'server', 'backend', backend);
}

export function getBackendStateDir(backend: ManagedBackendName): string {
  const stateRoot = process.env.AGENT_SERVER_BACKEND_STATE_DIR?.trim();
  if (stateRoot) {
    return join(stateRoot, backend);
  }
  return join(getBackendRootDir(backend), 'openteam-local');
}

export function getSharedTeamRuntimeDir(): string {
  return join(getBackendStateDir('runtime_supervisor'), 'team-workspaces');
}

export function getBackendConfigPath(backend: ManagedBackendName): string {
  return join(getBackendStateDir(backend), 'config.json');
}

export function ensureBackendStateDirs(
  backend: ManagedBackendName,
  extraDirs: string[] = [],
): {
  rootDir: string;
  stateDir: string;
} {
  const rootDir = getBackendRootDir(backend);
  const stateDir = getBackendStateDir(backend);
  mkdirSync(stateDir, { recursive: true });
  for (const dir of extraDirs) {
    mkdirSync(join(stateDir, dir), { recursive: true });
  }
  return { rootDir, stateDir };
}

export function ensureSharedTeamRuntimeDir(): string {
  const stateDir = getSharedTeamRuntimeDir();
  mkdirSync(stateDir, { recursive: true });
  return stateDir;
}
