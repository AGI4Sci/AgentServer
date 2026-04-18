import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function assertClientModeRejected(configWorkspace: Record<string, unknown>, label: string): Promise<void> {
  const configDir = await mkdtemp(join(tmpdir(), `agent-server-workspace-policy-${label}-config-`));
  const workspace = await mkdtemp(join(tmpdir(), `agent-server-workspace-policy-${label}-workspace-`));
  const configPath = join(configDir, 'openteam.json');

  try {
    await writeFile(
      configPath,
      JSON.stringify({
        llm: {
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'workspace-policy-key',
          model: 'workspace-policy-model',
          fallbacks: [],
        },
        runtime: {
          workspace: configWorkspace,
        },
      }, null, 2),
      'utf8',
    );
    await writeFile(join(workspace, 'README.md'), '# workspace policy smoke\n', 'utf8');

    await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        `
          const { AgentServerService } = await import('./server/agent_server/service.js');
          const service = new AgentServerService();
          try {
            await service.runTask({
              agent: {
                id: ${JSON.stringify(`workspace-policy-smoke-${label}`)},
                backend: 'openteam_agent',
                workspace: process.env.WORKSPACE_POLICY_SMOKE_WORKSPACE,
                reconcileExisting: true,
              },
              input: {
                text: 'List files.',
              },
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('runtime.workspace.mode is "client"')) {
              process.exit(0);
            }
            throw error;
          }
          throw new Error(${JSON.stringify(`workspace policy smoke failed: runTask unexpectedly succeeded in ${label} client mode`)});
        `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENTEAM_CONFIG_PATH: configPath,
          WORKSPACE_POLICY_SMOKE_WORKSPACE: workspace,
        },
      },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
}

await assertClientModeRejected({ mode: 'client' }, 'mode');
await assertClientModeRejected({ executionMode: 'client' }, 'legacy-execution-mode');
console.log('PASSED workspace policy smoke: client mode rejected server-side workspace tools');
