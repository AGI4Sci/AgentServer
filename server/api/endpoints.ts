import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { PROJECT_ROOT } from '../utils/paths.js';
import { loadOpenTeamConfig, type OpenTeamToolEndpointConfig } from '../utils/openteam-config.js';
import { error, sendJson, success } from '../utils/response.js';
import { getSkillRegistry, normalizeSkillId } from './skill-registry.js';
import { listSshTargets, testSshTarget } from './workspaces.js';

export type ToolEndpointKind =
  | 'local-shell'
  | 'ssh-host'
  | 'remote-worker'
  | 'robot'
  | 'instrument'
  | 'gpu-node'
  | 'database'
  | 'browser'
  | 'simulator'
  | 'code-server'
  | 'http-api'
  | 'mcp-server'
  | 'scp-service';

export type ToolEndpointTransport =
  | 'local'
  | 'ssh'
  | 'ssh-tunnel'
  | 'reverse-ssh'
  | 'http'
  | 'websocket'
  | 'stdio'
  | 'serial'
  | 'ros'
  | 'grpc'
  | 'mcp'
  | 'scp';

export type EndpointNetworkMode = 'local-egress' | 'remote-direct' | 'remote-via-local-proxy' | 'offline';
export type EndpointHealthStatus = 'unknown' | 'available' | 'degraded' | 'error' | 'offline';
export type EndpointRiskClass =
  | 'read'
  | 'write-file'
  | 'run-command'
  | 'network-egress'
  | 'credential-access'
  | 'physical-action'
  | 'destructive'
  | 'long-running';

export type ToolEndpoint = {
  id: string;
  name: string;
  kind: ToolEndpointKind;
  transport: ToolEndpointTransport;
  location: 'local' | 'lan' | 'remote' | 'cloud' | 'lab';
  networkMode: EndpointNetworkMode;
  capabilities: string[];
  permissions: string[];
  enabled: boolean;
  source: string;
  provider: string;
  tags: string[];
  configSchema?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
  workspace?: {
    root?: string;
    read?: boolean;
    write?: boolean;
    shell?: boolean;
    git?: boolean;
  };
  safety: {
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskClasses: EndpointRiskClass[];
    requiresApprovalFor: EndpointRiskClass[];
    allowedCommands?: string[];
    deniedCommands?: string[];
    allowedRoots?: string[];
  };
  evidence: {
    recordCommands: boolean;
    recordFiles: boolean;
    recordTelemetry: boolean;
    recordArtifacts: boolean;
  };
  health: {
    status: EndpointHealthStatus;
    message?: string;
    checkedAt: string;
  };
  diagnostics?: string;
};

export type EndpointRuntimeState = {
  endpointId: string;
  status: 'available' | 'busy' | 'connecting' | 'offline' | 'error' | 'unknown';
  sessionId?: string | null;
  lastSeenAt?: string | null;
  activeTaskIds: string[];
  latencyMs?: number | null;
  version?: string | null;
  networkMode: EndpointNetworkMode;
  diagnostics?: string | null;
};

export type ToolBinding = {
  endpointId: string;
  capability: string;
  cwd?: string;
  networkMode?: EndpointNetworkMode;
  allowedRoots?: string[];
  allowedTools?: string[];
  riskClass?: EndpointRiskClass;
  evidencePolicy?: Partial<ToolEndpoint['evidence']>;
};

type PersistedEndpointState = {
  endpoints?: Record<string, {
    enabled?: boolean;
    networkMode?: EndpointNetworkMode;
    config?: Record<string, unknown>;
    updatedAt?: string;
  }>;
};

const ENDPOINT_STATE_PATH = join(PROJECT_ROOT, '.openteam', 'endpoint-state.json');
const ENDPOINT_KINDS: ToolEndpointKind[] = [
  'local-shell',
  'ssh-host',
  'remote-worker',
  'robot',
  'instrument',
  'gpu-node',
  'database',
  'browser',
  'simulator',
  'code-server',
  'http-api',
  'mcp-server',
  'scp-service',
];
const ENDPOINT_TRANSPORTS: ToolEndpointTransport[] = [
  'local',
  'ssh',
  'ssh-tunnel',
  'reverse-ssh',
  'http',
  'websocket',
  'stdio',
  'serial',
  'ros',
  'grpc',
  'mcp',
  'scp',
];
const ENDPOINT_NETWORK_MODES: EndpointNetworkMode[] = ['local-egress', 'remote-direct', 'remote-via-local-proxy', 'offline'];
const ENDPOINT_RISK_CLASSES: EndpointRiskClass[] = [
  'read',
  'write-file',
  'run-command',
  'network-egress',
  'credential-access',
  'physical-action',
  'destructive',
  'long-running',
];

function nowIso(): string {
  return new Date().toISOString();
}

function jsonError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function readPersistedEndpointState(): Promise<PersistedEndpointState> {
  if (!existsSync(ENDPOINT_STATE_PATH)) {
    return { endpoints: {} };
  }
  try {
    const parsed = JSON.parse(await readFile(ENDPOINT_STATE_PATH, 'utf-8')) as PersistedEndpointState;
    return parsed && typeof parsed === 'object' ? parsed : { endpoints: {} };
  } catch {
    return { endpoints: {} };
  }
}

async function writePersistedEndpointState(state: PersistedEndpointState): Promise<void> {
  await mkdir(dirname(ENDPOINT_STATE_PATH), { recursive: true });
  await writeFile(ENDPOINT_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

async function updatePersistedEndpointState(
  endpointId: string,
  patch: { enabled?: boolean; networkMode?: EndpointNetworkMode; config?: Record<string, unknown> },
): Promise<void> {
  const state = await readPersistedEndpointState();
  const endpoints = { ...(state.endpoints || {}) };
  endpoints[endpointId] = {
    ...(endpoints[endpointId] || {}),
    ...patch,
    updatedAt: nowIso(),
  };
  await writePersistedEndpointState({ ...state, endpoints });
}

function withPersistedState(endpoint: ToolEndpoint, state: PersistedEndpointState): ToolEndpoint {
  const persisted = state.endpoints?.[endpoint.id];
  if (!persisted) return endpoint;
  return {
    ...endpoint,
    enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : endpoint.enabled,
    networkMode: persisted.networkMode || endpoint.networkMode,
    config: persisted.config || endpoint.config,
  };
}

function localShellEndpoint(teamId: string | null): ToolEndpoint {
  return {
    id: 'local:shell',
    name: 'Local Shell',
    kind: 'local-shell',
    transport: 'local',
    location: 'local',
    networkMode: 'local-egress',
    capabilities: ['files', 'shell', 'git', 'build', 'test', 'local-network'],
    permissions: ['read_workspace', 'write_workspace', 'run_commands', 'network'],
    enabled: true,
    source: teamId ? `team:${teamId}` : 'project',
    provider: 'OpenTeam Studio',
    tags: ['local', 'workspace', 'agent-execution'],
    workspace: {
      root: PROJECT_ROOT,
      read: true,
      write: true,
      shell: true,
      git: true,
    },
    safety: {
      riskLevel: 'medium',
      riskClasses: ['read', 'write-file', 'run-command', 'network-egress', 'destructive', 'long-running'],
      requiresApprovalFor: ['credential-access', 'destructive', 'long-running'],
      deniedCommands: ['rm -rf /', 'sudo rm -rf /'],
      allowedRoots: [PROJECT_ROOT],
    },
    evidence: {
      recordCommands: true,
      recordFiles: true,
      recordTelemetry: false,
      recordArtifacts: true,
    },
    health: {
      status: 'available',
      message: 'Local OpenTeam Studio process',
      checkedAt: nowIso(),
    },
  };
}

function sshEndpoint(target: Awaited<ReturnType<typeof listSshTargets>>['targets'][number]): ToolEndpoint {
  return {
    id: `ssh:${target.id}`,
    name: target.label,
    kind: 'ssh-host',
    transport: 'ssh',
    location: 'remote',
    networkMode: 'offline',
    capabilities: ['files', 'shell', 'git', 'build', 'test', 'remote-workspace'],
    permissions: ['read_remote_workspace', 'write_remote_workspace', 'run_remote_commands'],
    enabled: true,
    source: target.source,
    provider: 'SSH config',
    tags: ['ssh', 'remote-host'],
    configSchema: {
      targetId: target.id,
      host: target.hostName || target.host,
      user: target.user,
      port: target.port,
      identityFile: target.identityFile,
    },
    workspace: {
      root: '~',
      read: true,
      write: true,
      shell: true,
      git: true,
    },
    safety: {
      riskLevel: 'high',
      riskClasses: ['read', 'write-file', 'run-command', 'network-egress', 'credential-access', 'destructive', 'long-running'],
      requiresApprovalFor: ['network-egress', 'credential-access', 'destructive', 'long-running'],
      deniedCommands: ['rm -rf /', 'sudo rm -rf /'],
    },
    evidence: {
      recordCommands: true,
      recordFiles: true,
      recordTelemetry: false,
      recordArtifacts: true,
    },
    health: {
      status: 'unknown',
      message: 'Discovered from SSH config; run health check to verify',
      checkedAt: nowIso(),
    },
    diagnostics: `${target.user ? `${target.user}@` : ''}${target.hostName || target.host}${target.port ? `:${target.port}` : ''}`,
  };
}

function serviceEndpointFromSkill(skill: Awaited<ReturnType<typeof getSkillRegistry>>['skills'][number]): ToolEndpoint {
  const isScp = skill.source === 'scp' || skill.id.startsWith('scp/');
  return {
    id: `${isScp ? 'scp' : 'skill'}:${normalizeSkillId(skill.id.replace(/^scp\//, ''))}`,
    name: skill.name,
    kind: isScp ? 'scp-service' : 'mcp-server',
    transport: isScp ? 'scp' : 'mcp',
    location: 'cloud',
    networkMode: 'local-egress',
    capabilities: Array.from(new Set([skill.id, skill.source, skill.category || '', ...skill.tools].filter(Boolean))),
    permissions: skill.permissions || [],
    enabled: skill.enabled,
    source: skill.source,
    provider: skill.provider,
    tags: ['service', skill.source, skill.category || 'tool'].filter(Boolean),
    configSchema: skill.configSchema || null,
    config: skill.config,
    safety: {
      riskLevel: 'medium',
      riskClasses: ['read', 'network-egress'],
      requiresApprovalFor: ['credential-access'],
    },
    evidence: {
      recordCommands: false,
      recordFiles: false,
      recordTelemetry: true,
      recordArtifacts: true,
    },
    health: {
      status: skill.health.status === 'ok' ? 'available' : skill.health.status === 'error' ? 'error' : 'degraded',
      message: skill.health.message,
      checkedAt: skill.health.checkedAt,
    },
    diagnostics: skill.description || skill.provider,
  };
}

function configuredEndpointFromConfig(config: OpenTeamToolEndpointConfig): ToolEndpoint | null {
  if (!ENDPOINT_KINDS.includes(config.kind as ToolEndpointKind) || !ENDPOINT_TRANSPORTS.includes(config.transport as ToolEndpointTransport)) {
    return null;
  }
  const riskClasses = (config.safety?.riskClasses || [])
    .filter((item): item is EndpointRiskClass => ENDPOINT_RISK_CLASSES.includes(item as EndpointRiskClass));
  const requiresApprovalFor = (config.safety?.requiresApprovalFor || [])
    .filter((item): item is EndpointRiskClass => ENDPOINT_RISK_CLASSES.includes(item as EndpointRiskClass));
  const networkMode = ENDPOINT_NETWORK_MODES.includes(config.networkMode as EndpointNetworkMode)
    ? config.networkMode as EndpointNetworkMode
    : 'offline';
  return {
    id: config.id,
    name: config.name || config.id,
    kind: config.kind as ToolEndpointKind,
    transport: config.transport as ToolEndpointTransport,
    location: config.location || 'remote',
    networkMode,
    capabilities: Array.from(new Set((config.capabilities || [config.kind]).filter(Boolean))),
    permissions: config.permissions || [],
    enabled: config.enabled !== false,
    source: config.source || 'openteam.json',
    provider: config.provider || 'configured',
    tags: config.tags || ['configured', config.kind],
    config: config.config,
    workspace: config.workspace,
    safety: {
      riskLevel: config.safety?.riskLevel || (config.kind === 'robot' || config.kind === 'instrument' ? 'critical' : 'medium'),
      riskClasses: riskClasses.length ? riskClasses : ['read'],
      requiresApprovalFor: requiresApprovalFor.length
        ? requiresApprovalFor
        : (config.kind === 'robot' || config.kind === 'instrument' ? ['physical-action', 'destructive'] : ['credential-access']),
      allowedCommands: config.safety?.allowedCommands,
      deniedCommands: config.safety?.deniedCommands,
      allowedRoots: config.safety?.allowedRoots,
    },
    evidence: {
      recordCommands: config.evidence?.recordCommands === true,
      recordFiles: config.evidence?.recordFiles === true,
      recordTelemetry: config.evidence?.recordTelemetry !== false,
      recordArtifacts: config.evidence?.recordArtifacts !== false,
    },
    health: {
      status: 'unknown',
      message: 'Configured endpoint; provider-specific health check is not implemented yet',
      checkedAt: nowIso(),
    },
    diagnostics: config.diagnostics,
  };
}

function listConfiguredEndpoints(): { endpoints: ToolEndpoint[]; warning?: string } {
  try {
    return {
      endpoints: loadOpenTeamConfig().integrations.toolEndpoints
        .map(configuredEndpointFromConfig)
        .filter((endpoint): endpoint is ToolEndpoint => Boolean(endpoint)),
    };
  } catch (err) {
    return { endpoints: [], warning: jsonError(err) };
  }
}

export async function getEndpointRegistry(teamId: string | null, filters: {
  q?: string | null;
  kind?: string | null;
  enabled?: string | null;
} = {}): Promise<{
  endpoints: ToolEndpoint[];
  runtime: EndpointRuntimeState[];
  total: number;
  kinds: Partial<Record<ToolEndpointKind, number>>;
  transports: Partial<Record<ToolEndpointTransport, number>>;
  networkModes: Partial<Record<EndpointNetworkMode, number>>;
  warnings: string[];
}> {
  const [ssh, skills, persistedState] = await Promise.all([
    listSshTargets().catch((err) => ({ targets: [], warning: jsonError(err) })),
    getSkillRegistry(teamId).catch(() => ({ skills: [], runtime: [], total: 0, sources: {} })),
    readPersistedEndpointState(),
  ]);
  const configured = listConfiguredEndpoints();
  const endpoints = [
    localShellEndpoint(teamId),
    ...configured.endpoints,
    ...ssh.targets.map(sshEndpoint),
    ...skills.skills.filter((skill) => skill.source === 'scp' || skill.source === 'mcp').map(serviceEndpointFromSkill),
  ].map((endpoint) => withPersistedState(endpoint, persistedState));

  let filtered = endpoints;
  const q = filters.q?.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((endpoint) => [
      endpoint.id,
      endpoint.name,
      endpoint.kind,
      endpoint.transport,
      endpoint.provider,
      endpoint.source,
      endpoint.diagnostics || '',
      ...endpoint.capabilities,
      ...endpoint.tags,
    ].join('\n').toLowerCase().includes(q));
  }
  const kind = filters.kind?.trim();
  if (kind) {
    filtered = filtered.filter((endpoint) => endpoint.kind === kind);
  }
  const enabled = filters.enabled?.trim();
  if (enabled === 'true' || enabled === 'false') {
    filtered = filtered.filter((endpoint) => endpoint.enabled === (enabled === 'true'));
  }

  const kinds = filtered.reduce((acc, endpoint) => {
    acc[endpoint.kind] = (acc[endpoint.kind] || 0) + 1;
    return acc;
  }, {} as Partial<Record<ToolEndpointKind, number>>);
  const transports = filtered.reduce((acc, endpoint) => {
    acc[endpoint.transport] = (acc[endpoint.transport] || 0) + 1;
    return acc;
  }, {} as Partial<Record<ToolEndpointTransport, number>>);
  const networkModes = filtered.reduce((acc, endpoint) => {
    acc[endpoint.networkMode] = (acc[endpoint.networkMode] || 0) + 1;
    return acc;
  }, {} as Partial<Record<EndpointNetworkMode, number>>);

  return {
    endpoints: filtered,
    runtime: filtered.map((endpoint) => ({
      endpointId: endpoint.id,
      status: endpoint.enabled
        ? endpoint.health.status === 'available' ? 'available' : endpoint.health.status === 'error' ? 'error' : 'unknown'
        : 'offline',
      sessionId: null,
      lastSeenAt: endpoint.health.checkedAt,
      activeTaskIds: [],
      latencyMs: null,
      version: null,
      networkMode: endpoint.networkMode,
      diagnostics: endpoint.diagnostics || endpoint.health.message || null,
    })),
    total: filtered.length,
    kinds,
    transports,
    networkModes,
    warnings: [ssh.warning, configured.warning].filter((item): item is string => Boolean(item)),
  };
}

async function checkEndpoint(endpointId: string): Promise<{
  endpointId: string;
  ok: boolean;
  status: EndpointHealthStatus;
  message: string;
  checkedAt: string;
}> {
  if (endpointId === 'local:shell') {
    return {
      endpointId,
      ok: true,
      status: 'available',
      message: 'Local shell is available',
      checkedAt: nowIso(),
    };
  }
  if (endpointId.startsWith('ssh:')) {
    const result = await testSshTarget(endpointId.slice('ssh:'.length));
    return {
      endpointId,
      ok: result.ok,
      status: result.ok ? 'available' : 'error',
      message: result.message,
      checkedAt: result.checkedAt,
    };
  }
  return {
    endpointId,
    ok: true,
    status: 'available',
    message: 'Service endpoint is registered; provider-specific health check is not implemented yet',
    checkedAt: nowIso(),
  };
}

export async function handleEndpointRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const parsed = new URL(req.url || '/', 'http://localhost');

  if (parsed.pathname === '/api/endpoints' && method === 'GET') {
    try {
      sendJson(res, 200, success(await getEndpointRegistry(parsed.searchParams.get('teamId'), {
        q: parsed.searchParams.get('q'),
        kind: parsed.searchParams.get('kind'),
        enabled: parsed.searchParams.get('enabled'),
      })));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const configMatch = parsed.pathname.match(/^\/api\/endpoints\/(.+)\/config$/);
  if (configMatch && method === 'POST') {
    try {
      const endpointId = decodeURIComponent(configMatch[1]);
      const body = JSON.parse(await readBody(req)) as {
        enabled?: boolean;
        networkMode?: EndpointNetworkMode;
        config?: Record<string, unknown>;
      };
      const patch: { enabled?: boolean; networkMode?: EndpointNetworkMode; config?: Record<string, unknown> } = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.networkMode && ['local-egress', 'remote-direct', 'remote-via-local-proxy', 'offline'].includes(body.networkMode)) {
        patch.networkMode = body.networkMode;
      }
      if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
        patch.config = body.config;
      }
      await updatePersistedEndpointState(endpointId, patch);
      sendJson(res, 200, success({ endpointId, ...patch }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const checkMatch = parsed.pathname.match(/^\/api\/endpoints\/(.+)\/check$/);
  if (checkMatch && method === 'POST') {
    try {
      sendJson(res, 200, success(await checkEndpoint(decodeURIComponent(checkMatch[1]))));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  const connectMatch = parsed.pathname.match(/^\/api\/endpoints\/(.+)\/connect$/);
  if (connectMatch && method === 'POST') {
    try {
      const endpointId = decodeURIComponent(connectMatch[1]);
      const checked = await checkEndpoint(endpointId);
      sendJson(res, 200, success({
        endpointId,
        connected: checked.ok,
        status: checked.status,
        message: checked.message,
        checkedAt: checked.checkedAt,
        sessionId: checked.ok ? `${endpointId}:session:${Date.now()}` : null,
      }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  return false;
}
