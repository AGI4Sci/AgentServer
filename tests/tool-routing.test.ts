import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTool,
  createDefaultToolRoutingPolicy,
  planToolRoute,
  type ToolRoutingPolicy,
  type WorkerProfile,
  type WorkspaceSpec,
} from '../core/runtime/tool-routing.ts';

const gpuWorkspace: WorkspaceSpec = {
  id: 'gpu-exp',
  root: '/home/ubuntu/experiments/run-001',
  artifactRoot: '/home/ubuntu/experiments/run-001/artifacts',
  ownerWorker: 'gpu-a100',
};

const workers: WorkerProfile[] = [
  {
    id: 'backend-server',
    kind: 'backend-server',
    capabilities: ['network', 'metadata'],
  },
  {
    id: 'gpu-a100',
    kind: 'ssh',
    host: 'gpu.example.com',
    allowedRoots: ['/home/ubuntu/experiments'],
    capabilities: ['filesystem', 'shell', 'gpu'],
  },
  {
    id: 'mac-local',
    kind: 'client-worker',
    endpoint: 'http://127.0.0.1:3457',
    allowedRoots: ['/Applications/workspace'],
    capabilities: ['filesystem', 'shell', 'network'],
  },
  {
    id: 'server-local',
    kind: 'server',
    allowedRoots: ['/opt/agent-server/workspaces'],
    capabilities: ['filesystem', 'shell', 'network', 'metadata'],
  },
];

test('classifyTool separates workspace, compute, and network tools', () => {
  assert.deepEqual(classifyTool('read_file'), {
    toolName: 'read_file',
    kind: 'workspace',
    requiredCapabilities: ['filesystem'],
    sideEffectsWorkspace: true,
  });
  assert.deepEqual(classifyTool('run-command'), {
    toolName: 'run_command',
    kind: 'compute',
    requiredCapabilities: ['filesystem', 'shell'],
    sideEffectsWorkspace: true,
  });
  assert.deepEqual(classifyTool('web_search'), {
    toolName: 'web_search',
    kind: 'network',
    requiredCapabilities: ['network'],
    sideEffectsWorkspace: false,
  });
});

test('default routing keeps workspace side-effect tools on the workspace owner worker', () => {
  const plan = planToolRoute({
    toolName: 'run_command',
    workspace: gpuWorkspace,
    workers,
  });
  assert.equal(plan.primaryWorker, 'gpu-a100');
  assert.deepEqual(plan.fallbackWorkers, []);
  assert.equal(plan.workers[0]?.kind, 'ssh');
  assert.equal(plan.workers[0]?.executableNow, true);
  assert.deepEqual(plan.outputPolicy, {
    writeToWorkspace: true,
    workspaceId: 'gpu-exp',
    workspaceRoot: '/home/ubuntu/experiments/run-001',
    artifactRoot: '/home/ubuntu/experiments/run-001/artifacts',
  });
});

test('default routing lets backend-server proxy network tools for GPU workspaces', () => {
  const plan = planToolRoute({
    toolName: 'web_search',
    workspace: gpuWorkspace,
    workers,
  });
  assert.equal(plan.primaryWorker, 'backend-server');
  assert.equal(plan.toolKind, 'network');
  assert.equal(plan.executableNow, true);
  assert.equal(plan.outputPolicy.workspaceId, 'gpu-exp');
});

test('routing supports explicit network fallback workers', () => {
  const policy: ToolRoutingPolicy = {
    default: {
      primary: 'gpu-a100',
    },
    rules: [
      {
        tools: ['web_search', 'web_fetch'],
        primary: 'backend-server',
        fallbacks: ['mac-local'],
      },
    ],
  };
  const plan = planToolRoute({
    toolName: 'web_fetch',
    workspace: gpuWorkspace,
    workers,
    policy,
  });
  assert.equal(plan.primaryWorker, 'backend-server');
  assert.deepEqual(plan.fallbackWorkers, ['mac-local']);
  assert.equal(plan.workers[1]?.role, 'fallback');
  assert.equal(plan.workers[1]?.kind, 'client-worker');
});

test('workspace side-effect fallback must access the same workspace', () => {
  const policy: ToolRoutingPolicy = {
    default: {
      primary: 'gpu-a100',
      fallbacks: ['mac-local'],
    },
  };
  assert.throws(
    () => planToolRoute({
      toolName: 'apply_patch',
      workspace: gpuWorkspace,
      workers,
      policy,
    }),
    /cannot access workspace gpu-exp/,
  );
});

test('server workspace routes can execute immediately', () => {
  const workspace: WorkspaceSpec = {
    id: 'server-main',
    root: '/opt/agent-server/workspaces/project',
    ownerWorker: 'server-local',
  };
  const plan = planToolRoute({
    toolName: 'read_file',
    workspace,
    workers,
    policy: createDefaultToolRoutingPolicy(workspace),
  });
  assert.equal(plan.primaryWorker, 'server-local');
  assert.equal(plan.workers[0]?.kind, 'server');
  assert.equal(plan.executableNow, true);
});
