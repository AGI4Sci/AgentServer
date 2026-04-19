import { constants } from 'node:fs';
import { access, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const source = resolve('examples/agent-backend-readiness.env.example');
const target = resolve(process.env.AGENT_SERVER_ADAPTER_READINESS_ENV_FILE?.trim() || '.agent-backend-readiness.local.env');

if (await exists(target)) {
  console.log(`[agent-backend-readiness] env file already exists: ${target}`);
  console.log('[agent-backend-readiness] keeping existing file unchanged');
  process.exit(0);
}

await copyFile(source, target);
console.log(`[agent-backend-readiness] created local env file: ${target}`);
console.log('[agent-backend-readiness] fill in real endpoint/auth values, then run npm run check:agent-backend-adapters:ready');

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
