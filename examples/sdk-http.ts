import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  baseUrl: process.env.AGENT_SERVER_URL || 'http://127.0.0.1:8787',
  defaultBackend: 'codex',
  defaultWorkspace: process.cwd(),
});

const agent = await client.createAgent({
  id: 'example-http-agent',
  name: 'Example HTTP Agent',
  backend: 'codex',
  workingDirectory: process.cwd(),
  systemPrompt: 'You are a concise engineering assistant.',
});

const text = await client.runText('Summarize this project in one paragraph.', {
  agentId: agent.id,
});

console.log(text);
