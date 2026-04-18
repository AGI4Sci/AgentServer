import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configPath = join(process.cwd(), 'openteam.json');

if (!existsSync(configPath)) {
  await writeFile(
    configPath,
    JSON.stringify({
      llm: {
        baseUrl: 'http://127.0.0.1:3888/v1',
        apiKey: 'smoke-test-key',
        model: 'smoke-test-model',
        fallbacks: [],
      },
    }, null, 2),
    'utf8',
  );
}

const { AgentServerService } = await import('../server/agent_server/service.js');

const workspace = await mkdtemp(join(tmpdir(), 'agent-server-smoke-'));

try {
  const service = new AgentServerService();
  const agent = await service.createAgent({
    name: 'smoke-agent',
    backend: 'claude-code',
    workingDirectory: workspace,
    systemPrompt: 'You are a smoke-test agent.',
  });
  const fetched = await service.getAgent(agent.id);
  const snapshot = await service.getContextSnapshot(agent.id);

  if (fetched.id !== agent.id) {
    throw new Error(`Agent lookup returned wrong id: ${fetched.id}`);
  }
  if (snapshot.agent.id !== agent.id) {
    throw new Error(`Context snapshot returned wrong id: ${snapshot.agent.id}`);
  }

  console.log(`ok agent=${agent.id} backend=${agent.backend} workspace=${workspace}`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
