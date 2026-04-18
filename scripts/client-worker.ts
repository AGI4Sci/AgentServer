import { startClientWorkerService } from '../server/runtime/client-worker-service.js';

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedRoots(): string[] {
  const raw = process.env.AGENT_SERVER_CLIENT_WORKER_ROOTS
    || process.env.AGENT_SERVER_CLIENT_WORKER_ROOT
    || process.cwd();
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
}

const service = await startClientWorkerService({
  host: process.env.AGENT_SERVER_CLIENT_WORKER_HOST?.trim() || '127.0.0.1',
  port: parsePort(process.env.AGENT_SERVER_CLIENT_WORKER_PORT, 3457),
  allowedRoots: parseAllowedRoots(),
  authToken: process.env.AGENT_SERVER_CLIENT_WORKER_TOKEN?.trim() || undefined,
});

console.log(`AgentServer client-worker listening at ${service.endpoint}`);
console.log(`Allowed roots: ${parseAllowedRoots().join(', ')}`);
console.log(`Auth required: ${process.env.AGENT_SERVER_CLIENT_WORKER_TOKEN?.trim() ? 'yes' : 'no'}`);

function shutdown(signal: string): void {
  service.close()
    .then(() => {
      console.log(`AgentServer client-worker stopped by ${signal}`);
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : error);
      process.exit(1);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
