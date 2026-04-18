/**
 * LLM API 路由
 * /api/llm-config, /api/llm-chat
 * 
 * 配置从 openteam.json 读取，也可以通过 API 动态设置
 */

import { IncomingMessage, ServerResponse } from 'http';
import { success, error, sendJson } from '../utils/response.js';
import type { OpenTeamLlmEndpointConfig } from '../utils/openteam-config.js';
import {
  listConfiguredLlmEndpoints,
  loadOpenTeamConfig,
  updateOpenTeamConfig,
} from '../utils/openteam-config.js';

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  fallbacks?: Array<{
    baseUrl: string;
    modelName: string;
    hasApiKey: boolean;
  }>;
}

export interface LLMHealthStatus {
  ok: boolean;
  checkedAt: string;
  baseUrl: string;
  modelsUrl: string;
  chatUrl: string;
  modelName: string;
  probeMode: 'models' | 'chat';
  fallbackUsed?: boolean;
  checkedCandidates?: Array<{ baseUrl: string; modelName: string; ok: boolean; error?: string }>;
  availableModels?: string[];
  modelsCount?: number;
  error?: string;
}

// 运行时配置（延迟初始化，确保 openteam.json 已可读）
let llmConfig: LLMConfig | null = null;
let llmHealthCache: {
  cacheKey: string;
  status: LLMHealthStatus;
  expiresAt: number;
} | null = null;

function resolveModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/models')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/$/, '');
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/**
 * 获取 LLM 配置（延迟初始化）
 */
function getConfig(): LLMConfig {
  if (!llmConfig) {
    const config = loadOpenTeamConfig();
    const fallbacks = listConfiguredLlmEndpoints(config)
      .slice(1)
      .map((endpoint) => ({
        baseUrl: endpoint.baseUrl,
        modelName: endpoint.model,
        hasApiKey: !!endpoint.apiKey,
      }));
    llmConfig = {
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      modelName: config.llm.model,
      ...(fallbacks.length > 0 ? { fallbacks } : {}),
    };
    console.log('[LLM] Config initialized from openteam.json:', {
      baseUrl: llmConfig.baseUrl,
      modelName: llmConfig.modelName,
      hasApiKey: !!llmConfig.apiKey,
      fallbackCount: fallbacks.length,
    });
  }
  return llmConfig;
}

/**
 * 加载 LLM 配置
 */
export function loadLLMConfig(_teamsDir?: string): LLMConfig {
  llmConfig = getConfig();
  return llmConfig!;
}

/**
 * 保存 LLM 配置
 */
export function saveLLMConfig(newConfig: Partial<LLMConfig>): LLMConfig {
  const config = getConfig();
  llmConfig = { ...config, ...newConfig };
    updateOpenTeamConfig((current) => ({
      ...current,
      llm: {
        ...current.llm,
        baseUrl: llmConfig!.baseUrl,
        apiKey: llmConfig!.apiKey,
        model: llmConfig!.modelName,
      },
    }));
  return llmConfig;
}

/**
 * 获取当前配置（给其他模块用）
 */
export function getLLMConfig(): LLMConfig {
  return { ...getConfig() };
}

function applyResolvedLlmEndpoint(primary: OpenTeamLlmEndpointConfig, fallbacks: OpenTeamLlmEndpointConfig[]): void {
  const fb = fallbacks.map((entry) => ({
    baseUrl: entry.baseUrl.trim(),
    modelName: entry.model.trim(),
    hasApiKey: Boolean(entry.apiKey),
  }));
  llmConfig = {
    baseUrl: primary.baseUrl.trim(),
    apiKey: primary.apiKey,
    modelName: primary.model.trim(),
    ...(fb.length > 0 ? { fallbacks: fb } : {}),
  };
  const pairs: Array<[string, string]> = [
    ['MODEL_BACKEND_BASE_URL', primary.baseUrl.trim()],
    ['MODEL_BACKEND_API_KEY', primary.apiKey],
    ['MODEL_BACKEND_MODEL', primary.model.trim()],
    ['OPENAI_BASE_URL', primary.baseUrl.trim()],
    ['OPENAI_API_KEY', primary.apiKey],
    ['OPENAI_MODEL', primary.model.trim()],
    ['LLM_BASE_URL', primary.baseUrl.trim()],
    ['LLM_API_KEY', primary.apiKey],
    ['LLM_MODEL_NAME', primary.model.trim()],
    ['CODEX_API_KEY', primary.apiKey],
    ['API_BASE_URL', primary.baseUrl.trim()],
    ['ANTHROPIC_BASE_URL', primary.baseUrl.trim()],
    ['CLAUDE_CODE_API_BASE_URL', primary.baseUrl.trim()],
    ['ANTHROPIC_API_KEY', primary.apiKey],
    ['OPENTEAM_MODEL', primary.model.trim()],
  ];
  for (const [key, value] of pairs) {
    process.env[key] = value;
  }
  llmHealthCache = null;
}

export async function getLLMHealth(options?: {
  force?: boolean;
  timeoutMs?: number;
  cacheMs?: number;
  baseUrl?: string;
  apiKey?: string;
  modelName?: string;
  probeMode?: 'models' | 'chat';
}): Promise<LLMHealthStatus> {
  const config = getConfig();
  const rawConfig = loadOpenTeamConfig();
  const timeoutMs = Math.max(200, options?.timeoutMs ?? 1_500);
  const cacheMs = Math.max(0, options?.cacheMs ?? 10_000);
  const probeMode = options?.probeMode ?? 'chat';
  const candidateEndpoints = options?.baseUrl
    ? [{
      baseUrl: (options.baseUrl ?? config.baseUrl).trim(),
      apiKey: options?.apiKey ?? config.apiKey,
      modelName: (options?.modelName ?? config.modelName).trim(),
    }]
    : listConfiguredLlmEndpoints(rawConfig).map((entry) => ({
      baseUrl: entry.baseUrl.trim(),
      apiKey: entry.apiKey,
      modelName: entry.model.trim(),
    }));
  const primaryCandidate = candidateEndpoints[0] || { baseUrl: '', apiKey: '', modelName: '' };
  const baseUrl = primaryCandidate.baseUrl;
  const modelName = primaryCandidate.modelName;
  const now = Date.now();
  const cacheKey = `${baseUrl}::${modelName}::${probeMode}`;

  if (
    !options?.force
    && !options?.baseUrl
    && !options?.apiKey
    && llmHealthCache
    && llmHealthCache.cacheKey === cacheKey
    && llmHealthCache.expiresAt > now
  ) {
    return llmHealthCache.status;
  }

  let status: LLMHealthStatus | null = null;
  const checkedCandidates: NonNullable<LLMHealthStatus['checkedCandidates']> = [];

  for (let index = 0; index < candidateEndpoints.length; index += 1) {
    const candidate = candidateEndpoints[index];
    const candidateBaseUrl = candidate.baseUrl.trim();
    const candidateApiKey = candidate.apiKey ?? '';
    const candidateModelName = candidate.modelName.trim();
    const modelsUrl = resolveModelsUrl(candidateBaseUrl);
    const chatUrl = resolveChatCompletionsUrl(candidateBaseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${candidateApiKey}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = `HTTP ${response.status} ${response.statusText}`;
        checkedCandidates.push({ baseUrl: candidateBaseUrl, modelName: candidateModelName, ok: false, error });
        continue;
      }
      const availableModels = await readAvailableModels(response);
      const modelError = resolveModelAvailabilityError(candidateModelName, availableModels);
      const probeError = !modelError && probeMode === 'chat'
        ? await probeChatCompletions({
          chatUrl,
          apiKey: candidateApiKey,
          modelName: candidateModelName,
          timeoutMs,
        })
        : null;
      const error = modelError ?? probeError ?? undefined;
      const ok = !error;
      checkedCandidates.push({ baseUrl: candidateBaseUrl, modelName: candidateModelName, ok, ...(error ? { error } : {}) });
      if (!ok) {
        continue;
      }
      status = {
        ok: true,
        checkedAt: new Date().toISOString(),
        baseUrl: candidateBaseUrl,
        modelsUrl,
        chatUrl,
        modelName: candidateModelName,
        probeMode,
        fallbackUsed: index > 0,
        checkedCandidates,
        availableModels,
        modelsCount: availableModels.length,
      };
      break;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      checkedCandidates.push({ baseUrl: candidateBaseUrl, modelName: candidateModelName, ok: false, error: detail });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!status) {
    status = {
      ok: false,
      checkedAt: new Date().toISOString(),
      baseUrl,
      modelsUrl: resolveModelsUrl(baseUrl),
      chatUrl: resolveChatCompletionsUrl(baseUrl),
      modelName,
      probeMode,
      checkedCandidates,
      error: checkedCandidates.at(-1)?.error || 'All configured LLM endpoints failed',
    };
  }

  if (!options?.baseUrl && !options?.apiKey) {
    llmHealthCache = {
      cacheKey,
      status,
      expiresAt: now + cacheMs,
    };
  }
  return status;
}

/**
 * 启动时探测各候选 endpoint，将进程内 LLM 与 env 绑定到第一个健康的模型（避免 coordinator 在运行时才发现 404）。
 */
export async function primeLlmRuntimeFromHealth(): Promise<LLMHealthStatus> {
  llmConfig = null;
  getConfig();
  const status = await getLLMHealth({ force: true, timeoutMs: 4_000 });
  if (!status.ok || !status.baseUrl?.trim() || !status.modelName?.trim()) {
    console.warn('[LLM] primeLlmRuntimeFromHealth: no healthy endpoint; keeping openteam.json primary');
    return status;
  }
  const endpoints = listConfiguredLlmEndpoints(loadOpenTeamConfig());
  const idx = endpoints.findIndex(
    (e) => e.baseUrl.trim() === status.baseUrl.trim() && e.model.trim() === status.modelName.trim(),
  );
  if (idx < 0) {
    console.warn('[LLM] primeLlmRuntimeFromHealth: health result did not match any configured endpoint');
    return status;
  }
  applyResolvedLlmEndpoint(endpoints[idx], endpoints.slice(idx + 1));
  console.log(
    '[LLM] Runtime bound to healthy endpoint:',
    status.modelName,
    '@',
    status.baseUrl,
    idx > 0 ? '(fallback)' : '',
  );
  return status;
}

async function readAvailableModels(response: Response): Promise<string[]> {
  try {
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(payload?.data)) {
      return [];
    }
    return payload.data
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((item): item is string => item.length > 0);
  } catch {
    return [];
  }
}

function resolveModelAvailabilityError(modelName: string, availableModels: string[]): string | null {
  if (availableModels.length === 0) {
    return 'models endpoint returned no available models';
  }
  if (modelName && !availableModels.includes(modelName)) {
    return `configured model "${modelName}" is not present in models list`;
  }
  return null;
}

async function probeChatCompletions(params: {
  chatUrl: string;
  apiKey: string;
  modelName: string;
  timeoutMs: number;
}): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetch(params.chatUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.modelName,
        messages: [
          {
            role: 'user',
            content: 'Reply with OK.',
          },
        ],
        max_tokens: 1,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await readResponseSnippet(response);
      return `chat.completions probe failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`;
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `chat.completions probe failed: ${detail}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseSnippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (!text) {
      return '';
    }
    return text.length > 200 ? `${text.slice(0, 200)}...` : text;
  } catch {
    return '';
  }
}

/**
 * 处理 LLM 相关 API 请求
 */
export async function handleLLMRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _teamsDir: string
): Promise<boolean> {
  const rawUrl = req.url || '/';
  const url = new URL(rawUrl, 'http://127.0.0.1').pathname;
  const method = req.method || 'GET';

  // GET /api/llm-config - 获取配置
  if (url === '/api/llm-config' && method === 'GET') {
    await handleGetLLMConfig(req, res);
    return true;
  }

  // GET /api/llm-health - 探测当前 LLM backend 可用性
  if (url === '/api/llm-health' && method === 'GET') {
    await handleGetLLMHealth(req, res);
    return true;
  }

  // POST /api/llm-config - 更新配置
  if (url === '/api/llm-config' && method === 'POST') {
    await handleSetLLMConfig(req, res);
    return true;
  }

  // POST /api/llm-chat - 发送消息
  if (url === '/api/llm-chat' && method === 'POST') {
    await handleLLMChat(req, res);
    return true;
  }

  // POST /api/llm-generate-soul - 生成 SOUL.md 内容
  if (url === '/api/llm-generate-soul' && method === 'POST') {
    await handleLLMGenerateSoul(req, res);
    return true;
  }

  return false;
}

/**
 * GET /api/llm-config
 */
async function handleGetLLMConfig(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const config = loadLLMConfig();
    // 掩码 API Key
    const maskedConfig = {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ? `${config.apiKey.slice(0, 8)}...${config.apiKey.slice(-4)}` : '',
      modelName: config.modelName,
      hasApiKey: !!config.apiKey,
      fallbacks: (config.fallbacks || []).map((entry) => ({
        baseUrl: entry.baseUrl,
        modelName: entry.modelName,
        hasApiKey: entry.hasApiKey,
      })),
    };
    sendJson(res, 200, success(maskedConfig));
  } catch (err) {
    console.error('[API] Failed to get LLM config:', err);
    sendJson(res, 500, error(String(err)));
  }
}

async function handleGetLLMHealth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const requestUrl = new URL(req.url || '/api/llm-health', 'http://127.0.0.1');
    const force = requestUrl.searchParams.get('force') === '1';
    const probeMode = requestUrl.searchParams.get('probe') === 'models' ? 'models' : 'chat';
    const health = await getLLMHealth({ force, probeMode });
    sendJson(res, 200, success(health));
  } catch (err) {
    console.error('[API] Failed to get LLM health:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/llm-config
 */
async function handleSetLLMConfig(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const config = JSON.parse(body) as Partial<LLMConfig>;
    
    // 如果 apiKey 被掩码，保留原值
    if (!config.apiKey || config.apiKey.includes('...')) {
      const existing = loadLLMConfig();
      config.apiKey = existing.apiKey;
    }
    
    const updated = saveLLMConfig(config);
    console.log(`[API] Updated LLM config: ${updated.baseUrl}, model=${updated.modelName}`);
    
    sendJson(res, 200, success({
      baseUrl: updated.baseUrl,
      modelName: updated.modelName,
      hasApiKey: !!updated.apiKey,
    }));
  } catch (err) {
    console.error('[API] Failed to set LLM config:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/llm-generate-soul - 根据描述生成 SOUL.md 内容
 */
async function handleLLMGenerateSoul(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const { description, agentId } = JSON.parse(body);
    
    if (!description || typeof description !== 'string') {
      sendJson(res, 400, error('Description is required'));
      return;
    }

    const config = loadLLMConfig();
    
    if (!config.apiKey) {
      sendJson(res, 400, error('LLM API key not configured'));
      return;
    }

    const systemPrompt = `你是一个 AI Agent 配置专家。根据用户提供的描述，生成 Agent 的 SOUL.md 配置。

请严格按照以下 JSON 格式输出，不要包含任何其他内容：
{
  "identity": "Agent 的身份描述（谁、是什么角色）",
  "personality": "Agent 的个性特点（性格、工作风格）",
  "mission": "Agent 的核心使命和目标",
  "communication": "Agent 的沟通风格",
  "constraints": "Agent 的约束和限制（不做什么）",
  "traits": ["特征标签1", "特征标签2", ...]
}

要求：
1. 每个字段内容要具体、有特色，避免泛泛而谈
2. traits 数组包含 3-5 个标签
3. 所有字段使用中文
4. 输出纯 JSON，不要 markdown 代码块`;

    const userPrompt = `Agent ID: ${agentId || 'unknown'}

描述：
${description}

请根据以上描述生成 SOUL.md 配置。`;

    console.log(`[LLM] Generating SOUL for ${agentId || 'new agent'}`);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 2048,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[LLM] API error:', errorText);
      sendJson(res, response.status, error(`LLM API error: ${response.status}`));
      return;
    }

    const data = await response.json() as any;
    let content = data.choices?.[0]?.message?.content || '';
    
    // 尝试解析 JSON（移除可能的 markdown 代码块）
    content = content.trim();
    if (content.startsWith('```json')) {
      content = content.slice(7);
    } else if (content.startsWith('```')) {
      content = content.slice(3);
    }
    if (content.endsWith('```')) {
      content = content.slice(0, -3);
    }
    content = content.trim();

    let soulData;
    try {
      soulData = JSON.parse(content);
    } catch (e) {
      console.error('[LLM] Failed to parse response:', content);
      sendJson(res, 500, error('Failed to parse LLM response as JSON'));
      return;
    }

    // 验证必要字段
    const requiredFields = ['identity', 'personality', 'mission', 'communication', 'constraints', 'traits'];
    for (const field of requiredFields) {
      if (!(field in soulData)) {
        soulData[field] = '';
      }
    }
    
    // 确保 traits 是数组
    if (!Array.isArray(soulData.traits)) {
      soulData.traits = [];
    }

    console.log(`[LLM] SOUL generated successfully for ${agentId || 'new agent'}`);
    
    sendJson(res, 200, success({
      soul: soulData,
      model: config.modelName,
      usage: data.usage,
    }));
  } catch (err) {
    console.error('[API] Failed to generate SOUL:', err);
    sendJson(res, 500, error(String(err)));
  }
}

/**
 * POST /api/llm-chat
 */
async function handleLLMChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);
    const { messages, agent } = JSON.parse(body);
    
    const config = loadLLMConfig();
    
    if (!config.apiKey) {
      sendJson(res, 400, error('LLM API key not configured'));
      return;
    }

    console.log(`[LLM] Sending request to ${config.modelName}`);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.modelName,
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[LLM] API error:', errorText);
      sendJson(res, response.status, error(`LLM API error: ${response.status}`));
      return;
    }

    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content || '';
    
    console.log(`[LLM] Response received, ${content.length} chars`);
    
    sendJson(res, 200, success({
      content,
      model: config.modelName,
      usage: data.usage,
    }));
  } catch (err) {
    console.error('[API] Failed to call LLM:', err);
    sendJson(res, 500, error(String(err)));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
