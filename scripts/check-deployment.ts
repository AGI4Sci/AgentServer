import { existsSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { BACKEND_CATALOG } from '../core/runtime/backend-catalog.js';
import {
  getManagedBackendBinDir,
  resolveManagedBackendExecutableForBackend,
} from '../server/runtime/workers/backend-managed-launchers.js';
import { OPENTEAM_CONFIG_PATH, loadOpenTeamConfig } from '../server/utils/openteam-config.js';
import { AGENT_SERVER_DATA_DIR } from '../server/agent_server/paths.js';

function parseEnabledBackends(): Set<string> {
  const raw = process.env.AGENT_SERVER_ENABLED_BACKENDS?.trim();
  if (!raw) {
    return new Set(BACKEND_CATALOG.map((backend) => backend.id));
  }
  return new Set(raw.split(',').map((item) => item.trim()).filter(Boolean));
}

async function ensureWritableDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await access(path, constants.R_OK | constants.W_OK);
}

function pathIsInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child).replace(/\/+$/, '');
  const normalizedParent = resolve(parent).replace(/\/+$/, '');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function allowedRootsContain(path: string, roots: string[] | undefined): boolean {
  return (roots || []).some((root) => pathIsInside(path, root));
}

function isValidHttpEndpoint(endpoint: string): boolean {
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const config = loadOpenTeamConfig();
const enabled = parseEnabledBackends();
const backendBinDir = getManagedBackendBinDir();
const errors: string[] = [];

if (!existsSync(OPENTEAM_CONFIG_PATH)) {
  errors.push(`missing OPENTEAM_CONFIG_PATH: ${OPENTEAM_CONFIG_PATH}`);
}

if (enabled.has('openteam_agent')) {
  const runtimeRoot = resolve('server/backend/openteam_agent/node_modules');
  if (!existsSync(join(runtimeRoot, 'ai', 'dist', 'index.js'))) {
    errors.push(`missing openteam_agent vendored runtime: ${runtimeRoot}`);
  }
}

for (const backend of BACKEND_CATALOG) {
  if (!enabled.has(backend.id)) {
    continue;
  }
  if (!backend.capabilities.managedLauncher) {
    continue;
  }
  if (!resolveManagedBackendExecutableForBackend(backend.id)) {
    errors.push(`missing launcher for ${backend.id} in ${backendBinDir}: ${backend.executables.join(', ')}`);
  }
}

try {
  await ensureWritableDir(AGENT_SERVER_DATA_DIR);
} catch (error) {
  errors.push(`AGENT_SERVER_DATA_DIR is not writable: ${AGENT_SERVER_DATA_DIR} (${error instanceof Error ? error.message : String(error)})`);
}

for (const root of config.runtime.workspace.serverAllowedRoots) {
  if (!existsSync(root)) {
    errors.push(`runtime.workspace.serverAllowedRoots path does not exist: ${root}`);
  }
}

const workerIds = new Set(config.runtime.workspace.workers.map((worker) => worker.id));
const workersById = new Map(config.runtime.workspace.workers.map((worker) => [worker.id, worker]));
for (const workspace of config.runtime.workspace.workspaces) {
  if (!workerIds.has(workspace.ownerWorker)) {
    errors.push(`workspace ${workspace.id} ownerWorker does not exist: ${workspace.ownerWorker}`);
    continue;
  }
  const owner = workersById.get(workspace.ownerWorker);
  if (
    owner
    && (owner.kind === 'server' || owner.kind === 'ssh' || owner.kind === 'client-worker')
    && !allowedRootsContain(workspace.root, owner.allowedRoots)
  ) {
    errors.push(`workspace ${workspace.id} root is outside owner worker ${owner.id} allowedRoots: ${workspace.root}`);
  }
}

for (const worker of config.runtime.workspace.workers) {
  if ((worker.kind === 'server' || worker.kind === 'ssh' || worker.kind === 'client-worker') && (worker.allowedRoots || []).length === 0) {
    errors.push(`worker ${worker.id} (${worker.kind}) must declare allowedRoots`);
  }
  if (worker.kind === 'server') {
    for (const root of worker.allowedRoots || []) {
      if (!existsSync(root)) {
        errors.push(`server worker ${worker.id} allowed root does not exist: ${root}`);
      }
    }
  }
  if (worker.kind === 'ssh' && !worker.host) {
    errors.push(`worker ${worker.id} is ssh but host is missing`);
  }
  if (worker.kind === 'ssh' && worker.identityFile && !existsSync(worker.identityFile)) {
    errors.push(`worker ${worker.id} ssh identityFile does not exist: ${worker.identityFile}`);
  }
  if (worker.kind === 'client-worker') {
    if (!worker.endpoint) {
      errors.push(`worker ${worker.id} is client-worker but endpoint is missing`);
    } else if (!isValidHttpEndpoint(worker.endpoint)) {
      errors.push(`worker ${worker.id} client-worker endpoint must be http(s): ${worker.endpoint}`);
    }
    if (!worker.authToken) {
      errors.push(`worker ${worker.id} client-worker authToken is missing`);
    }
  }
}

console.log(`config=${OPENTEAM_CONFIG_PATH}`);
console.log(`data=${AGENT_SERVER_DATA_DIR}`);
console.log(`backendBin=${backendBinDir}`);
console.log(`enabledBackends=${[...enabled].join(',')}`);
console.log(`workspaceMode=${config.runtime.workspace.mode}`);
console.log(`serverAllowedRoots=${config.runtime.workspace.serverAllowedRoots.join(',') || '(none)'}`);
console.log(`workspaces=${config.runtime.workspace.workspaces.map((workspace) => `${workspace.id}:${workspace.ownerWorker}`).join(',') || '(none)'}`);
console.log(`workers=${config.runtime.workspace.workers.map((worker) => `${worker.id}:${worker.kind}`).join(',') || '(none)'}`);
console.log(`toolRoutingDefault=${config.runtime.workspace.toolRouting ? config.runtime.workspace.toolRouting.default.primary : '(per-workspace-owner)'}`);
console.log(`toolRoutingRules=${(config.runtime.workspace.toolRouting?.rules || []).length}`);
if (config.runtime.workspace.mode !== 'server') {
  console.log('[deployment] note: client/hybrid mode requires configured client-worker routes for workspace tools.');
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`[deployment] ${error}`);
  }
  process.exit(1);
}

console.log('[deployment] ok');
