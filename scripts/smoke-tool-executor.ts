import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startClientWorkerService } from '../server/runtime/client-worker-service.js';
import { executeRoutedToolCall } from '../server/runtime/tool-executor.js';
import type { WorkerProfile, WorkspaceSpec } from '../core/runtime/tool-routing.js';

async function withClientWorkerServer(root: string, fn: (endpoint: string) => Promise<void>): Promise<void> {
  const authToken = 'tool-executor-smoke-token';
  const service = await startClientWorkerService({
    host: '127.0.0.1',
    port: 0,
    allowedRoots: [root],
    authToken,
  });
  try {
    await fn(service.endpoint);
  } finally {
    await service.close();
  }
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-server-tool-executor-smoke-'));
  try {
    const workspace: WorkspaceSpec = {
      id: 'server-smoke',
      root,
      artifactRoot: join(root, 'artifacts'),
      ownerWorker: 'server-local',
    };
    const workers: WorkerProfile[] = [
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

    const writeResult = await executeRoutedToolCall({
      toolName: 'write_file',
      toolArgs: {
        path: 'smoke.txt',
        content: 'tool executor smoke',
      },
      workspace,
      workers,
    });
    if (!writeResult.ok || writeResult.workerId !== 'server-local') {
      throw new Error(`write_file route failed: ${writeResult.output}`);
    }

    const networkResult = await executeRoutedToolCall({
      toolName: 'web_fetch',
      toolArgs: {
        url: 'data:text/plain,tool-executor-network-smoke',
      },
      workspace,
      workers,
    });
    if (!networkResult.ok || networkResult.workerId !== 'backend-server') {
      throw new Error(`web_fetch route failed: ${networkResult.output}`);
    }
    if (networkResult.writeback.status !== 'written' || !networkResult.writeback.path) {
      throw new Error(`web_fetch writeback failed: ${networkResult.writeback.reason}`);
    }
    const artifact = await readFile(networkResult.writeback.path, 'utf-8');
    if (!artifact.includes('tool-executor-network-smoke')) {
      throw new Error('web_fetch artifact did not contain the fetched output');
    }

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
      const sshWorkspace: WorkspaceSpec = {
        id: 'ssh-smoke',
        root,
        ownerWorker: 'gpu-a100',
      };
      const sshWorkers: WorkerProfile[] = [
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
      const sshResult = await executeRoutedToolCall({
        toolName: 'run_command',
        toolArgs: {
          command: 'pwd && printf "\\nssh executor smoke\\n"',
        },
        workspace: sshWorkspace,
        workers: sshWorkers,
      });
      if (!sshResult.ok || sshResult.workerId !== 'gpu-a100' || !sshResult.output.includes('ssh executor smoke')) {
        throw new Error(`ssh route failed: ${sshResult.output}`);
      }
    } finally {
      if (previousSshBin === undefined) {
        delete process.env.AGENT_SERVER_SSH_BIN;
      } else {
        process.env.AGENT_SERVER_SSH_BIN = previousSshBin;
      }
    }

    await withClientWorkerServer(root, async (endpoint) => {
      const clientWorkspace: WorkspaceSpec = {
        id: 'client-smoke',
        root,
        ownerWorker: 'mac-local',
      };
      const clientWorkers: WorkerProfile[] = [
        {
          id: 'backend-server',
          kind: 'backend-server',
          capabilities: ['network', 'metadata'],
        },
        {
          id: 'mac-local',
          kind: 'client-worker',
          endpoint,
          authToken: 'tool-executor-smoke-token',
          allowedRoots: [root],
          capabilities: ['filesystem', 'shell', 'network'],
        },
      ];
      const clientResult = await executeRoutedToolCall({
        toolName: 'write_file',
        toolArgs: {
          path: 'client-worker-smoke.txt',
          content: 'client worker executor smoke',
        },
        workspace: clientWorkspace,
        workers: clientWorkers,
      });
      if (!clientResult.ok || clientResult.workerId !== 'mac-local') {
        throw new Error(`client-worker route failed: ${clientResult.output}`);
      }
      const clientOutput = await readFile(join(root, 'client-worker-smoke.txt'), 'utf-8');
      if (!clientOutput.includes('client worker executor smoke')) {
        throw new Error('client-worker output was not written to workspace');
      }
    });

    console.log('PASSED routed tool executor smoke: server, backend-server, ssh, and client-worker routes execute expected tools');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
