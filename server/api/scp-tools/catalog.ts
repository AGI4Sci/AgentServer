import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { ScpServiceCategoryInfo, ScpTool, ScpToolCategory, ScpToolsData } from './types.js';

import { loadOpenTeamConfig } from '../../utils/openteam-config.js';

const getScpHubBaseUrlValue = () => loadOpenTeamConfig().integrations.scpHub.baseUrl;
const getScpHubApiKeyValue = () => loadOpenTeamConfig().integrations.scpHub.apiKey;
const CACHE_TTL_MS = 5 * 60 * 1000;

const CATEGORY_CONFIG: Record<string, ScpServiceCategoryInfo> = {
  life_science: { id: 'life_science', label: '生命科学', icon: '🧬', description: '生物信息学、基因组学、蛋白质分析等工具' },
  biology: { id: 'life_science', label: '生命科学', icon: '🧬', description: '生物信息学、基因组学、蛋白质分析等工具' },
  chemistry: { id: 'chemistry', label: '化学', icon: '⚗️', description: '分子模拟、化学信息学、材料计算等工具' },
  physics: { id: 'physics', label: '物理', icon: '⚛️', description: '物理计算、材料科学等工具' },
  earth_science: { id: 'earth_science', label: '地球科学', icon: '🌍', description: '气象、气候、地质等工具' },
  neuroscience: { id: 'neuroscience', label: '神经科学', icon: '🧠', description: '神经科学相关研究工具' },
  general: { id: 'general', label: '通用', icon: '🔧', description: '通用计算、代码执行等工具' },
};

let toolsCache: ScpToolsData | null = null;
let cacheExpiry = 0;

function getProjectRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  let projectRoot = currentDir;
  let searchDir = currentDir;

  for (let i = 0; i < 10; i += 1) {
    const pkgPath = join(searchDir, 'package.json');
    if (existsSync(pkgPath)) {
      projectRoot = searchDir;
      break;
    }
    const parentDir = dirname(searchDir);
    if (parentDir === searchDir) {
      break;
    }
    searchDir = parentDir;
  }

  return projectRoot;
}

export function getScpHubApiKey(): string {
  return getScpHubApiKeyValue();
}

export function getScpHubBaseUrl(): string {
  return getScpHubBaseUrlValue();
}

export function mapDomainToCategory(domain: string): string {
  return CATEGORY_CONFIG[domain?.toLowerCase()]?.id || CATEGORY_CONFIG.general.id;
}

export function getCategoryInfo(domain: string): ScpServiceCategoryInfo {
  return CATEGORY_CONFIG[domain?.toLowerCase()] || CATEGORY_CONFIG.general;
}

export function mapServiceType(type: string): 'database' | 'compute_tool' | 'model_service' {
  const normalized = type?.toLowerCase();
  const typeMap: Record<string, 'database' | 'compute_tool' | 'model_service'> = {
    database: 'database',
    db: 'database',
    compute_tool: 'compute_tool',
    compute: 'compute_tool',
    tool: 'compute_tool',
    model_service: 'model_service',
    model: 'model_service',
    ai: 'model_service',
    api: 'compute_tool',
    service: 'model_service',
  };
  return typeMap[normalized] || 'compute_tool';
}

function getDefaultCategories(): ScpToolCategory[] {
  return [
    CATEGORY_CONFIG.life_science,
    CATEGORY_CONFIG.chemistry,
    CATEGORY_CONFIG.physics,
    CATEGORY_CONFIG.earth_science,
    CATEGORY_CONFIG.neuroscience,
    CATEGORY_CONFIG.general,
  ];
}

function transformService(service: any): ScpTool {
  return {
    id: service.id || service.name?.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
    name: service.name || service.id,
    category: mapDomainToCategory(service.domain || service.category || 'general'),
    type: mapServiceType(service.type),
    description: service.description || '',
    provider: service.provider || '上海人工智能实验室',
    url: service.url || getScpHubBaseUrlValue(),
    tools: service.tools || service.actions || service.functions || [],
  };
}

export async function loadToolsFromFile(): Promise<ScpToolsData | null> {
  try {
    const toolsPath = join(getProjectRoot(), 'teams', 'research', 'package', 'scphub_tools.json');
    if (!existsSync(toolsPath)) {
      console.warn('[SCP-Tools] Tools file not found:', toolsPath);
      return null;
    }
    return JSON.parse(readFileSync(toolsPath, 'utf-8')) as ScpToolsData;
  } catch (err) {
    console.error('[SCP-Tools] Failed to load tools file:', err);
    return null;
  }
}

export async function fetchRemoteServices(): Promise<any[] | null> {
  const apiKey = getScpHubApiKeyValue();
  if (!apiKey) {
    console.warn('[SCP-Tools] No API key configured, cannot fetch from SCP Hub');
    return null;
  }

  try {
    const baseUrl = getScpHubBaseUrlValue();
    const response = await fetch(`${baseUrl}/api/mcp/v1/services`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text();
      if (response.status === 401 && /token expired|A0211/i.test(bodyText)) {
        console.log('[SCP-Tools] SCP Hub token expired, fallback to local skills/catalog.');
        return null;
      }
      console.error('[SCP-Tools] Failed to fetch services:', response.status, bodyText);
      return null;
    }

    const result = await response.json();
    if (result.data && Array.isArray(result.data)) {
      return result.data;
    }
    if (Array.isArray(result)) {
      return result;
    }
    if (result.services && Array.isArray(result.services)) {
      return result.services;
    }
    return null;
  } catch (err) {
    console.error('[SCP-Tools] Failed to fetch from SCP Hub:', err);
    return null;
  }
}

export async function loadToolsFromScpHub(): Promise<ScpToolsData | null> {
  const services = await fetchRemoteServices();
  if (!services) {
    return null;
  }

  return {
    lastUpdated: new Date().toISOString(),
    categories: getDefaultCategories(),
    tools: services.map(transformService),
  };
}

export async function getTools(): Promise<ScpToolsData | null> {
  const now = Date.now();
  if (toolsCache && now < cacheExpiry) {
    return toolsCache;
  }

  toolsCache = await loadToolsFromFile();
  cacheExpiry = now + CACHE_TTL_MS;
  return toolsCache;
}

export async function refreshTools(): Promise<{ success: boolean; data?: ScpToolsData; error?: string }> {
  const remoteData = await loadToolsFromScpHub();
  if (remoteData) {
    toolsCache = remoteData;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return { success: true, data: remoteData };
  }

  const localData = await loadToolsFromFile();
  if (localData) {
    toolsCache = localData;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return { success: true, data: localData };
  }

  return { success: false, error: 'Failed to load tools from both remote and local sources' };
}

export async function getTool(toolId: string): Promise<ScpTool | null> {
  const data = await getTools();
  if (!data) {
    return null;
  }
  return data.tools.find((tool) => tool.id === toolId) || null;
}

export function buildRemoteServicePayload(services: any[]) {
  const categoryMap = new Map<string, ScpServiceCategoryInfo>();
  services.forEach((service) => {
    const domain = service.domain || service.category || 'general';
    if (!categoryMap.has(domain)) {
      categoryMap.set(domain, getCategoryInfo(domain));
    }
  });

  return {
    services: services.map(transformService),
    categories: Array.from(categoryMap.values()),
    total: services.length,
    lastUpdated: new Date().toISOString(),
    source: 'remote' as const,
  };
}
