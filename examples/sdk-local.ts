import { createAgentClient } from '@agi4sci/agent-server';

const client = createAgentClient({
  defaultBackend: 'codex',
  defaultWorkspace: process.cwd(),
  defaultSystemPrompt: 'You are a concise engineering assistant.',
});

const text = await client.runText('List the top-level files in this workspace.', {
  agentId: 'example-local-agent',
  onEvent(event) {
    if (event.type === 'tool-call') {
      console.log(`[tool] ${event.toolName}`);
    }
  },
});

console.log(text);
