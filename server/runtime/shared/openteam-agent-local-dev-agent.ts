import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LocalDevChatMessage } from './local-dev-agent.js';
import { runLocalDevToolAgentWithRequester } from './local-dev-agent.js';

type GenerateText = (params: {
  model: unknown;
  messages: LocalDevChatMessage[];
  maxRetries?: number;
}) => Promise<{ text?: string; content?: Array<{ type?: string; text?: string }> }>;

type CreateOpenAICompatible = (settings: {
  name: string;
  baseURL: string;
  apiKey?: string;
}) => {
  chatModel?: (modelId: string) => unknown;
  languageModel?: (modelId: string) => unknown;
  (modelId: string): unknown;
};

type OpenTeamSdkRuntime = {
  generateText: GenerateText;
  createOpenAICompatible: CreateOpenAICompatible;
  runtimeRoot: string;
};

function getBundledRuntimeRoot(): string {
  return join(process.cwd(), 'server', 'backend', 'openteam_agent', 'node_modules');
}

function getBundledPackageEntry(runtimeRoot: string, packageName: string): string {
  if (packageName.startsWith('@ai-sdk/')) {
    const [, packageDir] = packageName.split('/');
    return join(runtimeRoot, '@ai-sdk', packageDir, 'dist', 'index.js');
  }
  return join(runtimeRoot, packageName, 'dist', 'index.js');
}

async function importBundledPackage(runtimeRoot: string, packageName: string): Promise<Record<string, unknown>> {
  const distEntry = getBundledPackageEntry(runtimeRoot, packageName);
  if (!existsSync(distEntry)) {
    throw new Error([
      `Bundled OpenTeam Agent SDK package is missing: ${distEntry}`,
      'The service should include server/backend/openteam_agent/node_modules with the vendored SDK runtime.',
    ].join(' '));
  }
  return await import(pathToFileURL(distEntry).href) as Record<string, unknown>;
}

async function loadOpenTeamSdkRuntime(): Promise<OpenTeamSdkRuntime> {
  const runtimeRoot = getBundledRuntimeRoot();
  try {
    const ai = await importBundledPackage(runtimeRoot, 'ai');
    const openaiCompatible = await importBundledPackage(runtimeRoot, '@ai-sdk/openai-compatible');
    if (typeof ai.generateText === 'function' && typeof openaiCompatible.createOpenAICompatible === 'function') {
      return {
        generateText: ai.generateText as GenerateText,
        createOpenAICompatible: openaiCompatible.createOpenAICompatible as CreateOpenAICompatible,
        runtimeRoot,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to load bundled OpenTeam Agent SDK runtime: ${detail}`);
  }

  throw new Error([
    'OpenTeam Agent requires its bundled SDK runtime.',
    `Expected runtime root: ${runtimeRoot}`,
  ].join(' '));
}

function normalizeAiSdkText(result: Awaited<ReturnType<GenerateText>>): string {
  const text = typeof result.text === 'string' ? result.text : '';
  if (text.trim()) {
    return text;
  }
  if (Array.isArray(result.content)) {
    return result.content
      .map((part) => part?.type === 'text' && typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();
  }
  return '';
}

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
}): Promise<{ success: true; result: string } | { success: false; error: string }> {
  const openTeamSdk = await loadOpenTeamSdkRuntime();
  const provider = openTeamSdk.createOpenAICompatible({
    name: 'agent-server-openteam_agent',
    baseURL: params.baseUrl,
    apiKey: params.apiKey,
  });
  const languageModel = provider.chatModel?.(params.model)
    ?? provider.languageModel?.(params.model)
    ?? provider(params.model);
  const label = `${params.model} via bundled OpenTeam Agent SDK`;

  return runLocalDevToolAgentWithRequester({
    modelLabel: label,
    requestTextCompletion: async ({ messages }) => {
      const result = await openTeamSdk.generateText({
        model: languageModel,
        messages,
        maxRetries: 2,
      });
      const text = normalizeAiSdkText(result);
      if (!text) {
        throw new Error(`AI SDK response missing text content: ${JSON.stringify(result)}`);
      }
      return text;
    },
    prompt: params.prompt,
    cwd: params.cwd,
    hooks: params.hooks,
    maxSteps: params.maxSteps,
    forceSummaryOnBudgetExhausted: params.forceSummaryOnBudgetExhausted,
  });
}
