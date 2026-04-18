import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getSharedTeamRuntimeDir } from './backend-paths.js';
import { getOpenTeamInstance } from './instance.js';
import { resolveConfiguredServerPort } from '../../server/utils/openteam-config.js';

export const WORKSPACE_LEASE_FILE = '.openteam-workspace-lease.json';
export const DEFAULT_WORKSPACE_LEASE_TTL_MS = Math.max(
  5 * 60_000,
  Number.parseInt(process.env.OPENTEAM_WORKSPACE_LEASE_TTL_MS || `${15 * 60_000}`, 10) || 15 * 60_000,
);

export interface RuntimeWorkspaceLease {
  version: 1;
  instanceId: string;
  runtimeId: string;
  localAgentId: string;
  pid: number;
  port: string;
  teamId: string | null;
  backend: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getWorkspaceLeasePath(runtimeDir: string): string {
  return join(runtimeDir, WORKSPACE_LEASE_FILE);
}

export function readWorkspaceLease(runtimeDir: string): RuntimeWorkspaceLease | null {
  const leasePath = getWorkspaceLeasePath(runtimeDir);
  if (!existsSync(leasePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(leasePath, 'utf-8'));
    if (!parsed || parsed.version !== 1) {
      return null;
    }
    return parsed as RuntimeWorkspaceLease;
  } catch {
    return null;
  }
}

export function writeWorkspaceLease(params: {
  runtimeDir: string;
  runtimeId: string;
  localAgentId: string;
  teamId?: string | null;
  backend?: string | null;
}): RuntimeWorkspaceLease {
  const now = new Date().toISOString();
  const current = readWorkspaceLease(params.runtimeDir);
  const lease: RuntimeWorkspaceLease = {
    version: 1,
    instanceId: getOpenTeamInstance().getInstanceId(),
    runtimeId: params.runtimeId,
    localAgentId: params.localAgentId,
    pid: process.pid,
    port: String(resolveConfiguredServerPort()),
    teamId: params.teamId ?? current?.teamId ?? null,
    backend: params.backend ?? current?.backend ?? null,
    createdAt: current?.createdAt || now,
    updatedAt: now,
  };
  writeFileSync(getWorkspaceLeasePath(params.runtimeDir), JSON.stringify(lease, null, 2) + '\n', 'utf-8');
  return lease;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isWorkspaceLeaseFresh(
  lease: RuntimeWorkspaceLease | null,
  ttlMs: number = DEFAULT_WORKSPACE_LEASE_TTL_MS,
): boolean {
  if (!lease) {
    return false;
  }
  const updatedAt = Date.parse(lease.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }
  return Date.now() - updatedAt <= ttlMs;
}

export function refreshCurrentInstanceWorkspaceLeases(): number {
  const sharedDir = getSharedTeamRuntimeDir();
  if (!existsSync(sharedDir)) {
    return 0;
  }

  const instanceId = getOpenTeamInstance().getInstanceId();
  let refreshed = 0;
  for (const entry of readdirSync(sharedDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith(`workspace-${instanceId}--`)) {
      continue;
    }
    const runtimeDir = join(sharedDir, entry.name);
    try {
      statSync(runtimeDir);
      const runtimeId = entry.name.slice('workspace-'.length);
      const localAgentId = runtimeId.includes('--') ? runtimeId.split('--').slice(1).join('--') : runtimeId;
      writeWorkspaceLease({
        runtimeDir,
        runtimeId,
        localAgentId,
      });
      refreshed++;
    } catch {
      // Ignore vanished entries.
    }
  }
  return refreshed;
}
