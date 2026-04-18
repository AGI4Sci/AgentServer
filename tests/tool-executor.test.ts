import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { startClientWorkerService } from '../server/runtime/client-worker-service.ts';
import { executeRoutedToolCall } from '../server/runtime/tool-executor.ts';
import type {
  ToolRoutingPolicy,
  WorkerProfile,
  WorkspaceSpec,
} from '../core/runtime/tool-routing.ts';

async function withTempWorkspace<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'agent-server-tool-executor-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function serverWorkers(root: string): WorkerProfile[] {
  return [
    {
      id: 'backend-server',
      kind: 'backend-server',
      capabilities: ['network', 'metadata'],
    },
    {
      id: 'server-local',
      kind: 'server',
      allowedRoots: [root],
      capabilities: ['filesystem', 'shell', 'network', 'metadata'],
    },
  ];
}

async function withClientWorkerServer<T>(
  root: string,
  fn: (endpoint: string, authToken: string) => Promise<T>,
): Promise<T> {
  const authToken = 'test-client-worker-token';
  const service = await startClientWorkerService({
    host: '127.0.0.1',
    port: 0,
    allowedRoots: [root],
    authToken,
  });
  try {
    return await fn(service.endpoint, authToken);
  } finally {
    await service.close();
  }
}

test('executeRoutedToolCall executes workspace tools on an implemented server worker', async () => {
  await withTempWorkspace(async (root) => {
    const workspace: WorkspaceSpec = {
      id: 'server-work',
      root,
      ownerWorker: 'server-local',
    };
    const result = await executeRoutedToolCall({
      toolName: 'write_file',
      toolArgs: {
        path: 'hello.txt',
        content: 'hello from routed executor',
      },
      workspace,
      workers: serverWorkers(root),
    });

    assert.equal(result.ok, true);
    assert.equal(result.workerId, 'server-local');
    assert.equal(result.writeback.status, 'not-needed');
    assert.match(await readFile(join(root, 'hello.txt'), 'utf-8'), /routed executor/);
  });
});

test('executeRoutedToolCall skips non-executable workers and falls back to an executable worker', async () => {
  await withTempWorkspace(async (root) => {
    await writeFile(join(root, 'note.md'), 'fallback worked', 'utf-8');
    const workspace: WorkspaceSpec = {
      id: 'remote-owned',
      root,
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
        allowedRoots: [root],
        capabilities: ['filesystem', 'shell', 'gpu'],
      },
      {
        id: 'server-local',
        kind: 'server',
        allowedRoots: [root],
        capabilities: ['filesystem', 'shell'],
      },
    ];
    const policy: ToolRoutingPolicy = {
      default: {
        primary: 'gpu-a100',
        fallbacks: ['server-local'],
      },
    };

    const result = await executeRoutedToolCall({
      toolName: 'read_file',
      toolArgs: { path: 'note.md' },
      workspace,
      workers,
      policy,
    });

    assert.equal(result.ok, true);
    assert.equal(result.workerId, 'server-local');
    assert.deepEqual(result.attempts.map((attempt) => attempt.status), ['skipped', 'succeeded']);
    assert.match(result.output, /fallback worked/);
  });
});

test('executeRoutedToolCall executes workspace tools on an ssh worker', async () => {
  await withTempWorkspace(async (root) => {
    const fakeSsh = join(root, 'fake-ssh.sh');
    await writeFile(fakeSsh, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'bash -s',
      '',
    ].join('\n'), 'utf-8');
    await chmod(fakeSsh, 0o755);
    const previousSshBin = process.env.AGENT_SERVER_SSH_BIN;
    process.env.AGENT_SERVER_SSH_BIN = fakeSsh;
    try {
      const workspace: WorkspaceSpec = {
        id: 'gpu-exp',
        root,
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
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'gpu'],
        },
      ];

      const writeResult = await executeRoutedToolCall({
        toolName: 'write_file',
        toolArgs: {
          path: 'remote.txt',
          content: 'hello from ssh executor',
        },
        workspace,
        workers,
      });
      assert.equal(writeResult.ok, true);
      assert.equal(writeResult.workerId, 'gpu-a100');

      const readResult = await executeRoutedToolCall({
        toolName: 'read_file',
        toolArgs: { path: 'remote.txt' },
        workspace,
        workers,
      });
      assert.equal(readResult.ok, true);
      assert.equal(readResult.workerId, 'gpu-a100');
      assert.match(readResult.output, /hello from ssh executor/);
    } finally {
      if (previousSshBin === undefined) {
        delete process.env.AGENT_SERVER_SSH_BIN;
      } else {
        process.env.AGENT_SERVER_SSH_BIN = previousSshBin;
      }
    }
  });
});

test('executeRoutedToolCall injects worker env into ssh tools', async () => {
  await withTempWorkspace(async (root) => {
    const fakeSsh = join(root, 'fake-ssh.sh');
    await writeFile(fakeSsh, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'bash -s',
      '',
    ].join('\n'), 'utf-8');
    await chmod(fakeSsh, 0o755);
    const previousSshBin = process.env.AGENT_SERVER_SSH_BIN;
    process.env.AGENT_SERVER_SSH_BIN = fakeSsh;
    try {
      const workspace: WorkspaceSpec = {
        id: 'cpu-network',
        root,
        ownerWorker: 'pjlab-cpu',
      };
      const workers: WorkerProfile[] = [
        {
          id: 'backend-server',
          kind: 'backend-server',
          capabilities: ['network', 'metadata'],
        },
        {
          id: 'pjlab-cpu',
          kind: 'ssh',
          host: 'pjlab',
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'network'],
          env: {
            http_proxy: 'http://proxy.example:3128',
          },
        },
      ];

      const result = await executeRoutedToolCall({
        toolName: 'run_command',
        toolArgs: {
          command: 'printf "%s" "$http_proxy"',
        },
        workspace,
        workers,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workerId, 'pjlab-cpu');
      assert.match(result.output, /http:\/\/proxy\.example:3128/);
    } finally {
      if (previousSshBin === undefined) {
        delete process.env.AGENT_SERVER_SSH_BIN;
      } else {
        process.env.AGENT_SERVER_SSH_BIN = previousSshBin;
      }
    }
  });
});

test('executeRoutedToolCall creates a missing ssh workspace root before executing tools', async () => {
  await withTempWorkspace(async (root) => {
    const fakeSsh = join(root, 'fake-ssh.sh');
    await writeFile(fakeSsh, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'bash -s',
      '',
    ].join('\n'), 'utf-8');
    await chmod(fakeSsh, 0o755);
    const previousSshBin = process.env.AGENT_SERVER_SSH_BIN;
    process.env.AGENT_SERVER_SSH_BIN = fakeSsh;
    try {
      const workspaceRoot = join(root, 'missing-ssh-workspace');
      const workspace: WorkspaceSpec = {
        id: 'gpu-exp-missing-root',
        root: workspaceRoot,
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
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'gpu'],
        },
      ];

      const result = await executeRoutedToolCall({
        toolName: 'write_file',
        toolArgs: {
          path: 'created.txt',
          content: 'created missing ssh root',
        },
        workspace,
        workers,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workerId, 'gpu-a100');
      assert.match(await readFile(join(workspaceRoot, 'created.txt'), 'utf-8'), /missing ssh root/);
    } finally {
      if (previousSshBin === undefined) {
        delete process.env.AGENT_SERVER_SSH_BIN;
      } else {
        process.env.AGENT_SERVER_SSH_BIN = previousSshBin;
      }
    }
  });
});

test('executeRoutedToolCall executes workspace tools on a client worker', async () => {
  await withTempWorkspace(async (root) => {
    await withClientWorkerServer(root, async (endpoint, authToken) => {
      const workspace: WorkspaceSpec = {
        id: 'mac-work',
        root,
        ownerWorker: 'mac-local',
      };
      const workers: WorkerProfile[] = [
        {
          id: 'backend-server',
          kind: 'backend-server',
          capabilities: ['network', 'metadata'],
        },
        {
          id: 'mac-local',
          kind: 'client-worker',
          endpoint,
          authToken,
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'network'],
        },
      ];

      const result = await executeRoutedToolCall({
        toolName: 'write_file',
        toolArgs: {
          path: 'client.txt',
          content: 'hello from client worker',
        },
        workspace,
        workers,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workerId, 'mac-local');
      assert.match(await readFile(join(root, 'client.txt'), 'utf-8'), /client worker/);
    });
  });
});

test('executeRoutedToolCall writes network tool output to workspace artifacts when a server writer exists', async () => {
  await withTempWorkspace(async (root) => {
    const workspace: WorkspaceSpec = {
      id: 'server-work',
      root,
      artifactRoot: join(root, 'artifacts'),
      ownerWorker: 'server-local',
    };
    const result = await executeRoutedToolCall({
      toolName: 'web_fetch',
      toolArgs: {
        url: 'data:text/plain,routed-network-result',
      },
      workspace,
      workers: serverWorkers(root),
    });

    assert.equal(result.ok, true);
    assert.equal(result.workerId, 'backend-server');
    assert.equal(result.writeback.status, 'written');
    assert.ok(result.writeback.path);
    const artifact = await readFile(result.writeback.path!, 'utf-8');
    assert.match(artifact, /routed-network-result/);
    assert.match(artifact, /backend-server/);
  });
});

test('executeRoutedToolCall writes backend network results back to an ssh-owned workspace', async () => {
  await withTempWorkspace(async (root) => {
    const fakeSsh = join(root, 'fake-ssh.sh');
    await writeFile(fakeSsh, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'bash -s',
      '',
    ].join('\n'), 'utf-8');
    await chmod(fakeSsh, 0o755);
    const previousSshBin = process.env.AGENT_SERVER_SSH_BIN;
    process.env.AGENT_SERVER_SSH_BIN = fakeSsh;
    try {
      const workspace: WorkspaceSpec = {
        id: 'gpu-exp',
        root,
        artifactRoot: join(root, 'artifacts'),
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
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'gpu'],
        },
      ];

      const result = await executeRoutedToolCall({
        toolName: 'web_fetch',
        toolArgs: {
          url: 'data:text/plain,backend-network-to-ssh-workspace',
        },
        workspace,
        workers,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workerId, 'backend-server');
      assert.equal(result.writeback.status, 'written');
      assert.ok(result.writeback.path);
      const artifact = await readFile(result.writeback.path!, 'utf-8');
      assert.match(artifact, /backend-network-to-ssh-workspace/);
      assert.match(artifact, /gpu-exp/);
    } finally {
      if (previousSshBin === undefined) {
        delete process.env.AGENT_SERVER_SSH_BIN;
      } else {
        process.env.AGENT_SERVER_SSH_BIN = previousSshBin;
      }
    }
  });
});

test('executeRoutedToolCall writes backend network results back to a client-owned workspace', async () => {
  await withTempWorkspace(async (root) => {
    await withClientWorkerServer(root, async (endpoint, authToken) => {
      const workspace: WorkspaceSpec = {
        id: 'mac-work',
        root,
        artifactRoot: join(root, 'artifacts'),
        ownerWorker: 'mac-local',
      };
      const workers: WorkerProfile[] = [
        {
          id: 'backend-server',
          kind: 'backend-server',
          capabilities: ['network', 'metadata'],
        },
        {
          id: 'mac-local',
          kind: 'client-worker',
          endpoint,
          authToken,
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'network'],
        },
      ];

      const result = await executeRoutedToolCall({
        toolName: 'web_fetch',
        toolArgs: {
          url: 'data:text/plain,backend-network-to-client-workspace',
        },
        workspace,
        workers,
      });

      assert.equal(result.ok, true);
      assert.equal(result.workerId, 'backend-server');
      assert.equal(result.writeback.status, 'written');
      assert.ok(result.writeback.path);
      const artifact = await readFile(result.writeback.path!, 'utf-8');
      assert.match(artifact, /backend-network-to-client-workspace/);
      assert.match(artifact, /mac-work/);
    });
  });
});
