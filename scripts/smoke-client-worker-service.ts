import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startClientWorkerService } from '../server/runtime/client-worker-service.js';

const root = await mkdtemp(join(tmpdir(), 'agent-server-client-worker-smoke-'));

try {
  const service = await startClientWorkerService({
    host: '127.0.0.1',
    port: 0,
    allowedRoots: [root],
    authToken: 'smoke-token',
  });
  try {
    const health = await fetch(`${service.endpoint}/health`);
    if (!health.ok) {
      throw new Error(`client-worker health failed: ${health.status}`);
    }
    const unauthenticatedCapabilities = await fetch(`${service.endpoint}/capabilities`);
    if (unauthenticatedCapabilities.status !== 401) {
      throw new Error(`client-worker capabilities should require auth, got ${unauthenticatedCapabilities.status}`);
    }
    const capabilities = await fetch(`${service.endpoint}/capabilities`, {
      headers: {
        authorization: 'Bearer smoke-token',
      },
    });
    if (!capabilities.ok) {
      throw new Error(`client-worker capabilities failed: ${capabilities.status}`);
    }

    const writeResponse = await fetch(`${service.endpoint}/tool-call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer smoke-token',
      },
      body: JSON.stringify({
        workerId: 'mac-local',
        workspace: {
          id: 'mac-smoke',
          root,
          ownerWorker: 'mac-local',
        },
        cwd: root,
        toolName: 'write_file',
        args: {
          path: 'client-worker-service.txt',
          content: 'client worker service smoke',
        },
      }),
    });
    const writePayload = await writeResponse.json() as { ok?: boolean; output?: string };
    if (!writeResponse.ok || writePayload.ok !== true) {
      throw new Error(`client-worker write_file failed: ${writePayload.output || writeResponse.status}`);
    }
    const content = await readFile(join(root, 'client-worker-service.txt'), 'utf-8');
    if (!content.includes('client worker service smoke')) {
      throw new Error('client-worker did not write expected file content');
    }

    const blockedResponse = await fetch(`${service.endpoint}/tool-call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer smoke-token',
      },
      body: JSON.stringify({
        workerId: 'mac-local',
        workspace: {
          id: 'outside',
          root: '/tmp',
          ownerWorker: 'mac-local',
        },
        cwd: '/tmp',
        toolName: 'list_dir',
        args: {
          path: '.',
        },
      }),
    });
    if (blockedResponse.ok) {
      throw new Error('client-worker allowed a cwd outside allowed roots');
    }

    const unauthenticatedToolCall = await fetch(`${service.endpoint}/tool-call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        cwd: root,
        toolName: 'list_dir',
        args: { path: '.' },
      }),
    });
    if (unauthenticatedToolCall.status !== 401) {
      throw new Error(`client-worker tool-call should require auth, got ${unauthenticatedToolCall.status}`);
    }

    console.log('PASSED client-worker service smoke: health, auth, capabilities, tool-call, and allowed-root guard work');
  } finally {
    await service.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
