import type { IncomingMessage, ServerResponse } from 'http';
import { existsSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { AGENT_SKILLS_DIR, PROJECT_ROOT } from '../utils/paths.js';
import { error, sendJson, success } from '../utils/response.js';
import { loadToolsFromFile } from './scp-tools/catalog.js';
import type { ScpTool } from './scp-tools/types.js';
import { getTeamConfigPath } from './teams/shared.js';

export type SkillSource = 'local' | 'scp' | 'mcp' | 'builtin' | 'agent-capability';
export type SkillHealthStatus = 'ok' | 'warning' | 'error' | 'unknown';

export type SkillDescriptor = {
  id: string;
  name: string;
  source: SkillSource;
  provider: string;
  description: string;
  enabled: boolean;
  tools: string[];
  category?: string;
  path?: string;
  agentIds?: string[];
  configSchema?: Record<string, unknown> | null;
  config?: Record<string, unknown>;
  permissions: string[];
  health: {
    status: SkillHealthStatus;
    message?: string;
    checkedAt: string;
  };
};

export type SkillRuntimeState = {
  skillId: string;
  enabled: boolean;
  health: SkillDescriptor['health'];
  boundAgents: string[];
  lastUsedAt?: string | null;
  config?: Record<string, unknown>;
};

type TeamMemberSkillBinding = {
  agentId: string;
  skillId: string;
};

type PersistedSkillState = {
  skills?: Record<string, {
    enabled?: boolean;
    config?: Record<string, unknown>;
    updatedAt?: string;
  }>;
};

const SKILL_STATE_PATH = join(PROJECT_ROOT, '.openteam', 'skill-state.json');

function jsonError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function normalizeSkillId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

async function readPersistedSkillState(): Promise<PersistedSkillState> {
  if (!existsSync(SKILL_STATE_PATH)) {
    return { skills: {} };
  }
  try {
    const parsed = JSON.parse(await readFile(SKILL_STATE_PATH, 'utf-8')) as PersistedSkillState;
    return parsed && typeof parsed === 'object' ? parsed : { skills: {} };
  } catch {
    return { skills: {} };
  }
}

async function writePersistedSkillState(state: PersistedSkillState): Promise<void> {
  await mkdir(dirname(SKILL_STATE_PATH), { recursive: true });
  await writeFile(SKILL_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

async function updatePersistedSkillState(skillId: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<PersistedSkillState> {
  const normalized = normalizeSkillId(skillId);
  const state = await readPersistedSkillState();
  const skills = { ...(state.skills || {}) };
  skills[normalized] = {
    ...(skills[normalized] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const next = { ...state, skills };
  await writePersistedSkillState(next);
  return next;
}

function isValidLocalSkillId(skillId: string): boolean {
  const normalized = skillId.trim();
  if (!normalized || normalized.includes('..')) return false;
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return false;
  return parts.every((part) => /^[a-z0-9][a-z0-9._-]*$/i.test(part));
}

async function installLocalSkill(args: {
  id: string;
  name?: string;
  description?: string;
  body?: string;
}): Promise<SkillDescriptor> {
  const id = normalizeSkillId(args.id);
  if (!isValidLocalSkillId(id)) {
    throw new Error('Invalid skill id');
  }
  const skillDir = join(AGENT_SKILLS_DIR, ...id.split('/'));
  const skillFile = join(skillDir, 'SKILL.md');
  if (existsSync(skillFile)) {
    throw new Error(`Skill already exists: ${id}`);
  }
  const name = args.name?.trim() || basename(id);
  const description = args.description?.trim() || 'Local OpenTeam skill.';
  const body = args.body?.trim() || [
    '---',
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description)}`,
    'tools: []',
    'permissions: ["read_workspace", "write_workspace", "run_commands"]',
    'configSchema: {}',
    '---',
    '',
    '# Instructions',
    '',
    'Describe when to use this skill, what inputs it expects, and what evidence it should produce.',
    '',
  ].join('\n');
  await mkdir(skillDir, { recursive: true });
  await writeFile(skillFile, body.endsWith('\n') ? body : `${body}\n`, 'utf-8');
  return readLocalSkill(id, skillDir);
}

function parseScalarFrontmatterValue(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
    || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || trimmed === 'true'
    || trimmed === 'false'
    || trimmed === 'null'
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^['"]|['"]$/g, '').trim();
    }
  }
  return trimmed.replace(/^['"]|['"]$/g, '').trim();
}

function parseFrontmatter(content: string): Record<string, unknown> {
  if (!content.startsWith('---')) {
    return {};
  }
  const end = content.indexOf('\n---', 3);
  if (end < 0) {
    return {};
  }
  const raw = content.slice(3, end).trim();
  const result: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    result[key] = parseScalarFrontmatterValue(value);
  }
  return result;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

async function readLocalSkill(skillId: string, skillPath: string): Promise<SkillDescriptor> {
  const skillFile = join(skillPath, 'SKILL.md');
  const checkedAt = new Date().toISOString();
  let name = skillId;
  let description = '';
  let tools: string[] = [];
  let permissions = ['read_workspace', 'write_workspace', 'run_commands'];
  let configSchema: Record<string, unknown> | null = null;
  let status: SkillHealthStatus = existsSync(skillFile) ? 'ok' : 'warning';
  let message = existsSync(skillFile) ? 'Ready' : 'Missing SKILL.md';

  if (existsSync(skillFile)) {
    try {
      const content = await readFile(skillFile, 'utf-8');
      const frontmatter = parseFrontmatter(content);
      if (typeof frontmatter.name === 'string') name = frontmatter.name;
      if (typeof frontmatter.description === 'string') description = frontmatter.description;
      tools = stringList(frontmatter.tools);
      permissions = stringList(frontmatter.permissions);
      if (permissions.length === 0) {
        permissions = ['read_workspace', 'write_workspace', 'run_commands'];
      }
      configSchema = objectValue(frontmatter.configSchema);
    } catch (err) {
      status = 'error';
      message = `Failed to read SKILL.md: ${jsonError(err)}`;
    }
  }

  return {
    id: skillId,
    name,
    source: skillId.startsWith('scp/') ? 'scp' : 'local',
    provider: skillId.startsWith('scp/') ? 'SCP local skill' : 'Local skill',
    description,
    enabled: true,
    tools,
    path: skillPath,
    configSchema,
    permissions,
    health: { status, message, checkedAt },
  };
}

async function listLocalSkills(): Promise<SkillDescriptor[]> {
  if (!existsSync(AGENT_SKILLS_DIR)) {
    return [];
  }

  const skills: SkillDescriptor[] = [];
  const entries = await readdir(AGENT_SKILLS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(AGENT_SKILLS_DIR, entry.name);
    if (entry.name === 'scp') {
      const scpEntries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
      for (const sub of scpEntries) {
        if (!sub.isDirectory()) continue;
        skills.push(await readLocalSkill(`scp/${sub.name}`, join(entryPath, sub.name)));
      }
      continue;
    }
    skills.push(await readLocalSkill(entry.name, entryPath));
  }
  return skills;
}

function scpToolToSkill(tool: ScpTool): SkillDescriptor {
  const id = `scp/${normalizeSkillId(tool.id || tool.name)}`;
  return {
    id,
    name: tool.name || tool.id,
    source: 'scp',
    provider: tool.provider || 'SCP Hub',
    description: tool.description || '',
    enabled: true,
    tools: tool.tools || [],
    category: tool.category,
    permissions: ['network', 'invoke_tool'],
    health: {
      status: tool.tools?.length ? 'ok' : 'warning',
      message: tool.tools?.length ? 'Available from SCP catalog' : 'SCP service has no advertised tools',
      checkedAt: new Date().toISOString(),
    },
  };
}

async function listScpSkills(): Promise<SkillDescriptor[]> {
  const data = await loadToolsFromFile();
  return (data?.tools || []).map(scpToolToSkill);
}

async function readTeamSkillBindings(teamId: string | null): Promise<TeamMemberSkillBinding[]> {
  if (!teamId) return [];
  const configPath = getTeamConfigPath(teamId);
  if (!existsSync(configPath)) return [];
  try {
    const config = JSON.parse(await readFile(configPath, 'utf-8')) as {
      members?: Array<{ id?: string; skills?: string[] }>;
    };
    const bindings: TeamMemberSkillBinding[] = [];
    for (const member of config.members || []) {
      if (!member.id) continue;
      for (const rawSkill of member.skills || []) {
        const skillId = normalizeSkillId(rawSkill);
        if (!skillId) continue;
        bindings.push({ agentId: member.id, skillId });
      }
    }
    return bindings;
  } catch {
    return [];
  }
}

function mergeSkillDescriptors(
  descriptors: SkillDescriptor[],
  bindings: TeamMemberSkillBinding[],
  persistedState: PersistedSkillState,
): SkillDescriptor[] {
  const byId = new Map<string, SkillDescriptor>();
  for (const descriptor of descriptors) {
    const existing = byId.get(descriptor.id);
    if (!existing) {
      byId.set(descriptor.id, { ...descriptor, agentIds: descriptor.agentIds ? [...descriptor.agentIds] : [] });
      continue;
    }
    byId.set(descriptor.id, {
      ...existing,
      name: existing.name || descriptor.name,
      provider: existing.provider || descriptor.provider,
      description: existing.description || descriptor.description,
      tools: Array.from(new Set([...existing.tools, ...descriptor.tools])),
      path: existing.path || descriptor.path,
      permissions: Array.from(new Set([...existing.permissions, ...descriptor.permissions])),
      health: existing.health.status === 'ok' ? existing.health : descriptor.health,
    });
  }

  for (const binding of bindings) {
    const candidates = [
      binding.skillId,
      `scp/${binding.skillId}`,
      normalizeSkillId(binding.skillId.replace(/^scp\//, '')),
    ];
    const matched = candidates.map((id) => byId.get(id)).find(Boolean);
    if (matched) {
      matched.agentIds = Array.from(new Set([...(matched.agentIds || []), binding.agentId]));
      continue;
    }
    const syntheticId = binding.skillId;
    const current = byId.get(syntheticId);
    if (current) {
      current.agentIds = Array.from(new Set([...(current.agentIds || []), binding.agentId]));
    } else {
      byId.set(syntheticId, {
        id: syntheticId,
        name: basename(syntheticId),
        source: 'agent-capability',
        provider: 'team.config.json',
        description: 'Declared on a team member but not backed by a local SKILL.md or SCP catalog entry yet.',
        enabled: true,
        tools: [],
        agentIds: [binding.agentId],
        permissions: [],
        health: {
          status: 'warning',
          message: 'Capability declaration only',
          checkedAt: new Date().toISOString(),
        },
      });
    }
  }

  const persistedSkills = persistedState.skills || {};
  for (const skill of byId.values()) {
    const persisted = persistedSkills[skill.id];
    if (!persisted) continue;
    if (typeof persisted.enabled === 'boolean') {
      skill.enabled = persisted.enabled;
    }
    if (persisted.config) {
      skill.config = persisted.config;
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const sourceOrder = ['local', 'scp', 'mcp', 'builtin', 'agent-capability'];
    const diff = sourceOrder.indexOf(a.source) - sourceOrder.indexOf(b.source);
    return diff || a.name.localeCompare(b.name);
  });
}

export async function getSkillRegistry(teamId: string | null, filters: { q?: string | null; source?: string | null; enabled?: string | null } = {}): Promise<{
  skills: SkillDescriptor[];
  runtime: SkillRuntimeState[];
  total: number;
  sources: Partial<Record<SkillSource, number>>;
}> {
  const [localSkills, scpSkills, bindings, persistedState] = await Promise.all([
    listLocalSkills(),
    listScpSkills(),
    readTeamSkillBindings(teamId),
    readPersistedSkillState(),
  ]);
  let skills = mergeSkillDescriptors([...localSkills, ...scpSkills], bindings, persistedState);
  const q = filters.q?.trim().toLowerCase();
  const source = filters.source?.trim();
  const enabled = filters.enabled?.trim();
  if (q) {
    skills = skills.filter((skill) => [
      skill.id,
      skill.name,
      skill.provider,
      skill.description,
      skill.category || '',
      ...(skill.tools || []),
    ].join('\n').toLowerCase().includes(q));
  }
  if (source) {
    skills = skills.filter((skill) => skill.source === source);
  }
  if (enabled === 'true' || enabled === 'false') {
    const enabledValue = enabled === 'true';
    skills = skills.filter((skill) => skill.enabled === enabledValue);
  }
  const sources = skills.reduce((acc, skill) => {
    acc[skill.source] = (acc[skill.source] || 0) + 1;
    return acc;
  }, {} as Partial<Record<SkillSource, number>>);
  return {
    skills,
    runtime: skills.map((skill) => ({
      skillId: skill.id,
      enabled: skill.enabled,
      health: skill.health,
      boundAgents: skill.agentIds || [],
      lastUsedAt: null,
      config: persistedState.skills?.[skill.id]?.config || {},
    })),
    total: skills.length,
    sources,
  };
}

export function expandSkillDispatchAliases(skillId: string): string[] {
  const normalized = normalizeSkillId(skillId);
  if (!normalized) {
    return [];
  }
  const aliases = new Set([normalized]);
  if (normalized.startsWith('scp/')) {
    aliases.add(normalized.slice(4));
  } else {
    aliases.add(`scp/${normalized}`);
  }
  return [...aliases];
}

export async function getEnabledSkillAliasesForTeam(teamId: string | null): Promise<Set<string>> {
  const registry = await getSkillRegistry(teamId);
  const aliases = new Set<string>();
  for (const skill of registry.skills) {
    if (!skill.enabled) continue;
    for (const alias of expandSkillDispatchAliases(skill.id)) {
      aliases.add(alias);
    }
  }
  return aliases;
}

export async function handleSkillRegistryRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const rawUrl = req.url || '/';
  const parsed = new URL(rawUrl, 'http://localhost');

  const configMatch = parsed.pathname.match(/^\/api\/skills\/registry\/(.+)\/config$/);
  if (configMatch && method === 'POST') {
    try {
      const skillId = decodeURIComponent(configMatch[1]);
      const body = JSON.parse(await new Promise<string>((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      })) as { enabled?: boolean; config?: Record<string, unknown> };
      const patch: { enabled?: boolean; config?: Record<string, unknown> } = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) patch.config = body.config;
      await updatePersistedSkillState(skillId, patch);
      sendJson(res, 200, success({ skillId: normalizeSkillId(skillId), ...patch }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  if (parsed.pathname === '/api/skills/registry/install' && method === 'POST') {
    try {
      const body = JSON.parse(await new Promise<string>((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
          raw += chunk;
        });
        req.on('end', () => resolve(raw));
        req.on('error', reject);
      })) as { id?: string; name?: string; description?: string; body?: string };
      const skill = await installLocalSkill({
        id: body.id || '',
        name: body.name,
        description: body.description,
        body: body.body,
      });
      sendJson(res, 200, success({ skill }));
    } catch (err) {
      sendJson(res, 500, error(jsonError(err)));
    }
    return true;
  }

  if (parsed.pathname !== '/api/skills/registry') {
    return false;
  }

  if (method !== 'GET') {
    sendJson(res, 405, error('Method not allowed'));
    return true;
  }

  try {
    const teamId = parsed.searchParams.get('teamId');
    sendJson(res, 200, success(await getSkillRegistry(teamId, {
      q: parsed.searchParams.get('q'),
      source: parsed.searchParams.get('source'),
      enabled: parsed.searchParams.get('enabled'),
    })));
  } catch (err) {
    console.error('[Skill Registry] Failed to build registry:', err);
    sendJson(res, 500, error(jsonError(err)));
  }
  return true;
}
