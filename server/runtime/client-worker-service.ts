import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import {
  executeLocalDevPrimitiveCall,
  type LocalDevPrimitiveCall,
  type LocalDevPrimitiveResult,
} from './shared/local-dev-primitives.js';

export interface ClientWorkerServiceOptions {
  host?: string;
  port?: number;
  allowedRoots: string[];
  authToken?: string;
}

export interface ClientWorkerToolCallRequest {
  workerId?: string;
  workspace?: {
    id?: string;
    root?: string;
    ownerWorker?: string;
    artifactRoot?: string;
  };
  cwd?: string;
  toolName?: LocalDevPrimitiveCall['toolName'];
  args?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ClientWorkerService {
  server: Server;
  host: string;
  port: number;
  endpoint: string;
  close(): Promise<void>;
}

function normalizeAllowedRoots(roots: string[]): string[] {
  return roots.map((root) => resolve(root)).filter(Boolean);
}

function pathIsInside(child: string, parent: string): boolean {
  const normalizedChild = resolve(child).replace(/\/+$/, '');
  const normalizedParent = resolve(parent).replace(/\/+$/, '');
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

function assertPathInAllowedRoots(pathValue: string, allowedRoots: string[]): void {
  const resolved = resolve(pathValue);
  if (!allowedRoots.some((root) => pathIsInside(resolved, root))) {
    throw new Error(`Path is outside allowed roots: ${resolved}`);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: string[] = [];
  request.setEncoding('utf-8');
  for await (const chunk of request) {
    chunks.push(String(chunk));
  }
  const body = chunks.join('');
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body) as unknown;
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

function requestToken(request: IncomingMessage): string | null {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice('bearer '.length).trim();
  }
  const headerToken = request.headers['x-agent-server-token'];
  if (typeof headerToken === 'string') {
    return headerToken.trim();
  }
  if (Array.isArray(headerToken)) {
    return headerToken[0]?.trim() || null;
  }
  return null;
}

function assertAuthorized(request: IncomingMessage, authToken?: string): void {
  if (!authToken) {
    return;
  }
  if (requestToken(request) !== authToken) {
    const error = new Error('Unauthorized client-worker request.');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
}

function normalizeToolCallPayload(payload: unknown): ClientWorkerToolCallRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Request body must be a JSON object.');
  }
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.workerId === 'string' ? { workerId: record.workerId } : {}),
    ...(record.workspace && typeof record.workspace === 'object' && !Array.isArray(record.workspace)
      ? { workspace: record.workspace as ClientWorkerToolCallRequest['workspace'] }
      : {}),
    ...(typeof record.cwd === 'string' ? { cwd: record.cwd } : {}),
    ...(typeof record.toolName === 'string' ? { toolName: record.toolName as LocalDevPrimitiveCall['toolName'] } : {}),
    ...(record.args && typeof record.args === 'object' && !Array.isArray(record.args)
      ? { args: Object.fromEntries(Object.entries(record.args).map(([key, value]) => [key, String(value ?? '')])) }
      : {}),
    ...(record.env && typeof record.env === 'object' && !Array.isArray(record.env)
      ? { env: Object.fromEntries(Object.entries(record.env).map(([key, value]) => [key, String(value ?? '')])) }
      : {}),
  };
}

async function handleToolCall(
  request: IncomingMessage,
  response: ServerResponse,
  allowedRoots: string[],
): Promise<void> {
  const payload = normalizeToolCallPayload(await readJsonBody(request));
  if (!payload.toolName) {
    throw new Error('toolName is required.');
  }
  const workspaceRoot = typeof payload.workspace?.root === 'string' && payload.workspace.root.trim()
    ? payload.workspace.root.trim()
    : null;
  const cwd = resolve(payload.cwd || workspaceRoot || process.cwd());
  assertPathInAllowedRoots(cwd, allowedRoots);
  if (workspaceRoot) {
    assertPathInAllowedRoots(workspaceRoot, allowedRoots);
  }
  const result: LocalDevPrimitiveResult = await executeLocalDevPrimitiveCall({
    toolName: payload.toolName,
    args: payload.args || {},
  }, {
    cwd,
    env: payload.env,
  });
  writeJson(response, result.ok ? 200 : 500, result);
}

export function createClientWorkerServer(options: ClientWorkerServiceOptions): Server {
  const allowedRoots = normalizeAllowedRoots(options.allowedRoots);
  const authToken = options.authToken?.trim();
  if (allowedRoots.length === 0) {
    throw new Error('Client worker requires at least one allowed root.');
  }
  return createServer((request, response) => {
    void (async () => {
      if (request.method === 'GET' && request.url === '/health') {
        writeJson(response, 200, {
          ok: true,
          kind: 'client-worker',
          authRequired: Boolean(authToken),
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/capabilities') {
        assertAuthorized(request, authToken);
        writeJson(response, 200, {
          ok: true,
          kind: 'client-worker',
          capabilities: ['filesystem', 'shell', 'network'],
          tools: [
            'append_file',
            'apply_patch',
            'browser_open',
            'grep_search',
            'list_dir',
            'read_file',
            'run_command',
            'web_fetch',
            'web_search',
            'write_file',
          ],
          allowedRoots,
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/tool-call') {
        assertAuthorized(request, authToken);
        await handleToolCall(request, response, allowedRoots);
        return;
      }
      writeJson(response, 404, {
        ok: false,
        error: 'not found',
      });
    })().catch((error) => {
      const statusCode = typeof (error as Error & { statusCode?: unknown }).statusCode === 'number'
        ? (error as Error & { statusCode: number }).statusCode
        : 500;
      writeJson(response, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export async function startClientWorkerService(options: ClientWorkerServiceOptions): Promise<ClientWorkerService> {
  const host = options.host || '127.0.0.1';
  const port = options.port || 3457;
  const server = createClientWorkerServer(options);
  await new Promise<void>((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolveReady());
  });
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : port;
  return {
    server,
    host,
    port: actualPort,
    endpoint: `http://${host}:${actualPort}`,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}
