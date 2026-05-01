import { requestOpenAICompatibleTextCompletion } from '../model-provider-client.js';
import type { SessionUsage } from '../session-types.js';
import { runLocalDevToolAgentWithRequester } from './local-dev-agent.js';

export async function runOpenTeamAgentLocalDevToolAgent(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  cwd: string;
  hooks?: {
    onToolCall?: (toolName: string, detail?: string) => void;
    onToolResult?: (toolName: string, detail?: string, output?: string) => void;
    onTextDelta?: (text: string) => void;
    onStatus?: (status: 'running' | 'completed' | 'failed', message?: string) => void;
  };
  maxSteps?: number;
  forceSummaryOnBudgetExhausted?: boolean;
}): Promise<{ success: true; result: string; usage?: SessionUsage } | { success: false; error: string; usage?: SessionUsage }> {
  const label = `${params.model} via AgentServer model provider client`;
  return await runLocalDevToolAgentWithRequester({
    modelLabel: label,
    requestTextCompletion: async ({ messages }) => await requestOpenAICompatibleTextCompletion({
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      provider: 'openai-compatible',
      messages,
      stream: false,
    }),
    prompt: params.prompt,
    cwd: params.cwd,
    hooks: params.hooks,
    maxSteps: params.maxSteps,
    forceSummaryOnBudgetExhausted: params.forceSummaryOnBudgetExhausted,
  });
}
