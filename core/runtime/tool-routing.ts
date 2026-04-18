export type ToolKind = 'workspace' | 'network' | 'compute' | 'metadata';

export type WorkerKind =
  | 'backend-server'
  | 'server'
  | 'client-worker'
  | 'ssh'
  | 'container'
  | 'remote-service';

export type WorkerCapability =
  | 'filesystem'
  | 'shell'
  | 'network'
  | 'gpu'
  | 'metadata';

export interface WorkspaceSpec {
  id: string;
  root: string;
  ownerWorker: string;
  artifactRoot?: string;
}

export interface WorkerProfile {
  id: string;
  kind: WorkerKind;
  capabilities: WorkerCapability[];
  allowedRoots?: string[];
  host?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  endpoint?: string;
  authToken?: string;
}

export interface ToolRouteTarget {
  primary: string;
  fallbacks?: string[];
}

export interface ToolRoutingRule extends ToolRouteTarget {
  tools: string[];
}

export interface ToolRoutingPolicy {
  default: ToolRouteTarget;
  rules?: ToolRoutingRule[];
}

export interface ToolClassification {
  toolName: string;
  kind: ToolKind;
  requiredCapabilities: WorkerCapability[];
  sideEffectsWorkspace: boolean;
}

export interface ToolRouteWorkerPlan {
  workerId: string;
  kind: WorkerKind;
  role: 'primary' | 'fallback';
  executableNow: boolean;
  reason: string;
}

export interface ToolOutputPolicy {
  writeToWorkspace: true;
  workspaceId: string;
  workspaceRoot: string;
  artifactRoot?: string;
}

export interface ToolRoutePlan {
  toolName: string;
  toolKind: ToolKind;
  workspaceId: string;
  primaryWorker: string;
  fallbackWorkers: string[];
  workers: ToolRouteWorkerPlan[];
  outputPolicy: ToolOutputPolicy;
  executableNow: boolean;
  reason: string;
}

const WORKSPACE_TOOLS = new Set([
  'append_file',
  'apply_patch',
  'delete_path',
  'grep_search',
  'list_dir',
  'read_file',
  'stat_path',
  'write_file',
]);

const NETWORK_TOOLS = new Set([
  'browser_open',
  'download_url',
  'web_fetch',
  'web_search',
]);

const COMPUTE_TOOLS = new Set([
  'run_command',
]);

const WORKER_KINDS: WorkerKind[] = [
  'backend-server',
  'server',
  'client-worker',
  'ssh',
  'container',
  'remote-service',
];

const WORKER_CAPABILITIES: WorkerCapability[] = [
  'filesystem',
  'shell',
  'network',
  'gpu',
  'metadata',
];

export function normalizeToolNameForRouting(toolName: string): string {
  return toolName.trim().toLowerCase().replace(/[-\s]+/g, '_');
}

export function isWorkerKind(value: unknown): value is WorkerKind {
  return typeof value === 'string' && WORKER_KINDS.includes(value as WorkerKind);
}

export function normalizeWorkerCapability(value: unknown): WorkerCapability | null {
  return typeof value === 'string' && WORKER_CAPABILITIES.includes(value as WorkerCapability)
    ? value as WorkerCapability
    : null;
}

export function classifyTool(toolName: string): ToolClassification {
  const normalized = normalizeToolNameForRouting(toolName);
  if (WORKSPACE_TOOLS.has(normalized)) {
    return {
      toolName: normalized,
      kind: 'workspace',
      requiredCapabilities: ['filesystem'],
      sideEffectsWorkspace: true,
    };
  }
  if (COMPUTE_TOOLS.has(normalized)) {
    return {
      toolName: normalized,
      kind: 'compute',
      requiredCapabilities: ['filesystem', 'shell'],
      sideEffectsWorkspace: true,
    };
  }
  if (NETWORK_TOOLS.has(normalized)) {
    return {
      toolName: normalized,
      kind: 'network',
      requiredCapabilities: ['network'],
      sideEffectsWorkspace: false,
    };
  }
  return {
    toolName: normalized,
    kind: 'metadata',
    requiredCapabilities: ['metadata'],
    sideEffectsWorkspace: false,
  };
}

export function createDefaultToolRoutingPolicy(workspace: WorkspaceSpec): ToolRoutingPolicy {
  return {
    default: {
      primary: workspace.ownerWorker,
      fallbacks: [],
    },
    rules: [
      {
        tools: ['web_search', 'web_fetch', 'browser_open'],
        primary: 'backend-server',
        fallbacks: [],
      },
    ],
  };
}

function routeTargetFor(toolName: string, policy: ToolRoutingPolicy): ToolRouteTarget {
  const normalized = normalizeToolNameForRouting(toolName);
  for (const rule of policy.rules || []) {
    const tools = new Set(rule.tools.map(normalizeToolNameForRouting));
    if (tools.has(normalized)) {
      return {
        primary: rule.primary,
        fallbacks: rule.fallbacks || [],
      };
    }
  }
  return policy.default;
}

function workerById(workers: WorkerProfile[]): Map<string, WorkerProfile> {
  return new Map(workers.map((worker) => [worker.id, worker]));
}

function pathIsInside(child: string, parent: string): boolean {
  const normalizedChild = child.replace(/\/+$/, '');
  const normalizedParent = parent.replace(/\/+$/, '');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function workerCanAccessWorkspace(worker: WorkerProfile, workspace: WorkspaceSpec): boolean {
  if (worker.id === workspace.ownerWorker) {
    return true;
  }
  return (worker.allowedRoots || []).some((root) => pathIsInside(workspace.root, root));
}

function assertWorkerCanRun(
  worker: WorkerProfile,
  workspace: WorkspaceSpec,
  classification: ToolClassification,
): void {
  const missing = classification.requiredCapabilities.filter((capability) => !worker.capabilities.includes(capability));
  if (missing.length > 0) {
    throw new Error(`Worker ${worker.id} cannot run ${classification.toolName}: missing capabilities ${missing.join(',')}`);
  }
  if (classification.sideEffectsWorkspace && !workerCanAccessWorkspace(worker, workspace)) {
    throw new Error(`Worker ${worker.id} cannot run ${classification.toolName}: it cannot access workspace ${workspace.id}`);
  }
}

function executableNow(worker: WorkerProfile): boolean {
  return worker.kind === 'backend-server'
    || worker.kind === 'server'
    || (worker.kind === 'client-worker' && Boolean(worker.endpoint))
    || (worker.kind === 'ssh' && Boolean(worker.host));
}

function workerPlan(
  worker: WorkerProfile,
  role: ToolRouteWorkerPlan['role'],
): ToolRouteWorkerPlan {
  const canExecute = executableNow(worker);
  return {
    workerId: worker.id,
    kind: worker.kind,
    role,
    executableNow: canExecute,
    reason: canExecute
      ? `${worker.id} can execute via ${worker.kind}`
      : worker.kind === 'ssh'
        ? `${worker.id} requires ssh host`
        : worker.kind === 'client-worker'
          ? `${worker.id} requires client-worker endpoint`
        : `${worker.id} requires ${worker.kind} executor support`,
  };
}

export function planToolRoute(args: {
  toolName: string;
  workspace: WorkspaceSpec;
  workers: WorkerProfile[];
  policy?: ToolRoutingPolicy;
}): ToolRoutePlan {
  const classification = classifyTool(args.toolName);
  const policy = args.policy || createDefaultToolRoutingPolicy(args.workspace);
  const target = routeTargetFor(classification.toolName, policy);
  const workers = workerById(args.workers);
  const primary = workers.get(target.primary);
  if (!primary) {
    throw new Error(`Primary worker not found for ${classification.toolName}: ${target.primary}`);
  }
  assertWorkerCanRun(primary, args.workspace, classification);

  const fallbackWorkers = (target.fallbacks || []).map((workerId) => {
    const worker = workers.get(workerId);
    if (!worker) {
      throw new Error(`Fallback worker not found for ${classification.toolName}: ${workerId}`);
    }
    assertWorkerCanRun(worker, args.workspace, classification);
    return worker;
  });

  const plannedWorkers = [
    workerPlan(primary, 'primary'),
    ...fallbackWorkers.map((worker) => workerPlan(worker, 'fallback')),
  ];
  return {
    toolName: classification.toolName,
    toolKind: classification.kind,
    workspaceId: args.workspace.id,
    primaryWorker: primary.id,
    fallbackWorkers: fallbackWorkers.map((worker) => worker.id),
    workers: plannedWorkers,
    outputPolicy: {
      writeToWorkspace: true,
      workspaceId: args.workspace.id,
      workspaceRoot: args.workspace.root,
      ...(args.workspace.artifactRoot ? { artifactRoot: args.workspace.artifactRoot } : {}),
    },
    executableNow: plannedWorkers.some((worker) => worker.executableNow),
    reason: `${classification.toolName} routes to ${primary.id}${fallbackWorkers.length ? ` with fallback ${fallbackWorkers.map((worker) => worker.id).join(',')}` : ''}`,
  };
}
