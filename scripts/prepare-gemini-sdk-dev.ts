import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const geminiRoot = resolve('server/backend/gemini');
const coreDist = join(geminiRoot, 'packages/core/dist');
const sdkIndex = join(geminiRoot, 'packages/sdk/index.ts');
const policySource = join(geminiRoot, 'packages/core/src/policy/policies');
const policyTarget = join(geminiRoot, 'packages/core/dist/src/policy/policies');

await run('npm', ['install', '--ignore-scripts'], { required: true });
await run('npm', ['run', 'generate'], { required: true });
await run('npm', ['run', 'build', '--workspace', '@google/gemini-cli-core'], { required: false });
await run('npm', ['run', 'build', '--workspace', '@google/gemini-cli-sdk'], { required: false });

if (existsSync(policySource)) {
  await mkdir(policyTarget, { recursive: true });
  await cp(policySource, policyTarget, { recursive: true, force: true });
  console.log(`[gemini-sdk-dev] copied policy TOML files to ${policyTarget}`);
}

if (!existsSync(coreDist)) {
  console.error(`[gemini-sdk-dev] missing expected core dist: ${coreDist}`);
  process.exit(1);
}

if (!existsSync(sdkIndex)) {
  console.error(`[gemini-sdk-dev] missing expected SDK source entry: ${sdkIndex}`);
  process.exit(1);
}

console.log('[gemini-sdk-dev] ready for tsx development fallback');
console.log(`[gemini-sdk-dev] sdkSource=${sdkIndex}`);
console.log('[gemini-sdk-dev] note: production should still use a clean upstream build/link of @google/gemini-cli-sdk.');

async function run(
  command: string,
  args: string[],
  options: { required: boolean },
): Promise<void> {
  const label = `${command} ${args.join(' ')}`;
  console.log(`[gemini-sdk-dev] ${label}`);
  try {
    const result = await execFileAsync(command, args, {
      cwd: geminiRoot,
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.stdout.trim()) {
      console.log(result.stdout.trim());
    }
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (options.required) {
      console.error(`[gemini-sdk-dev] required step failed: ${label}`);
      console.error(detail);
      process.exit(1);
    }
    console.warn(`[gemini-sdk-dev] optional step failed and will be treated as upstream build debt: ${label}`);
    console.warn(detail);
  }
}
