import type { CompletionEvidenceRequirements } from './blackboard-types.js';

export interface TaskEvidenceSource {
  title: string | null;
  url: string | null;
  publishedAt: string | null;
  snippet?: string | null;
  domain?: string | null;
}

export interface TaskEvidenceCommand {
  command: string;
  cwd?: string | null;
  exitCode?: number | null;
  summary?: string | null;
}

export interface TaskEvidenceFileChange {
  path: string;
  status?: string | null;
  summary?: string | null;
}

export interface TaskEvidenceTestResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'unknown';
  summary?: string | null;
}

export interface TaskEvidencePort {
  port: number;
  host?: string | null;
  protocol?: string | null;
  url?: string | null;
  status?: string | null;
}

export interface TaskEvidenceApprovalEvent {
  approvalId?: string | null;
  kind: string;
  decision?: 'approved' | 'rejected' | 'pending' | string | null;
  actor?: string | null;
  reason?: string | null;
}

export interface TaskEvidenceEndpointUsage {
  endpointId: string;
  kind?: string | null;
  transport?: string | null;
  networkMode?: string | null;
  capability?: string | null;
  cwd?: string | null;
  summary?: string | null;
}

export interface TaskEvidencePayload {
  sources?: TaskEvidenceSource[];
  skillsUsed?: string[];
  workspaceId?: string | null;
  endpointsUsed?: string[];
  toolBindings?: TaskEvidenceEndpointUsage[];
  commands?: TaskEvidenceCommand[];
  filesChanged?: TaskEvidenceFileChange[];
  tests?: TaskEvidenceTestResult[];
  ports?: TaskEvidencePort[];
  approvalEvents?: TaskEvidenceApprovalEvent[];
  riskNotes?: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.map((item) => normalizeString(item)).filter((item): item is string => Boolean(item))));
}

function normalizeCommand(value: unknown): TaskEvidenceCommand | null {
  const record = asRecord(value);
  if (!record) return null;
  const command = normalizeString(record.command) ?? normalizeString(record.cmd);
  if (!command) return null;
  const exitCode = typeof record.exitCode === 'number' && Number.isFinite(record.exitCode)
    ? record.exitCode
    : typeof record.exit_code === 'number' && Number.isFinite(record.exit_code)
      ? record.exit_code
      : null;
  return {
    command,
    cwd: normalizeString(record.cwd),
    exitCode,
    summary: normalizeString(record.summary) ?? normalizeString(record.result),
  };
}

function normalizeFileChange(value: unknown): TaskEvidenceFileChange | null {
  const record = asRecord(value);
  if (!record) return null;
  const path = normalizeString(record.path) ?? normalizeString(record.file);
  if (!path) return null;
  return {
    path,
    status: normalizeString(record.status) ?? normalizeString(record.change),
    summary: normalizeString(record.summary),
  };
}

function normalizeTestResult(value: unknown): TaskEvidenceTestResult | null {
  const record = asRecord(value);
  if (!record) return null;
  const name = normalizeString(record.name) ?? normalizeString(record.command) ?? normalizeString(record.id);
  if (!name) return null;
  const rawStatus = normalizeString(record.status)?.toLowerCase();
  const status = rawStatus === 'passed' || rawStatus === 'failed' || rawStatus === 'skipped'
    ? rawStatus
    : 'unknown';
  return {
    name,
    status,
    summary: normalizeString(record.summary) ?? normalizeString(record.output),
  };
}

function normalizePort(value: unknown): TaskEvidencePort | null {
  const record = asRecord(value);
  if (!record) return null;
  const port = typeof record.port === 'number' && Number.isFinite(record.port)
    ? record.port
    : typeof record.port === 'string'
      ? Number(record.port)
      : NaN;
  if (!Number.isFinite(port)) return null;
  return {
    port,
    host: normalizeString(record.host),
    protocol: normalizeString(record.protocol),
    url: normalizeString(record.url),
    status: normalizeString(record.status),
  };
}

function normalizeApprovalEvent(value: unknown): TaskEvidenceApprovalEvent | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = normalizeString(record.kind) ?? normalizeString(record.type);
  if (!kind) return null;
  return {
    approvalId: normalizeString(record.approvalId) ?? normalizeString(record.approval_id),
    kind,
    decision: normalizeString(record.decision),
    actor: normalizeString(record.actor),
    reason: normalizeString(record.reason),
  };
}

function normalizeEndpointUsage(value: unknown): TaskEvidenceEndpointUsage | null {
  if (typeof value === 'string') {
    const endpointId = normalizeString(value);
    return endpointId ? { endpointId } : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const endpointId = normalizeString(record.endpointId)
    ?? normalizeString(record.endpoint_id)
    ?? normalizeString(record.id);
  if (!endpointId) return null;
  return {
    endpointId,
    kind: normalizeString(record.kind),
    transport: normalizeString(record.transport),
    networkMode: normalizeString(record.networkMode) ?? normalizeString(record.network_mode),
    capability: normalizeString(record.capability),
    cwd: normalizeString(record.cwd),
    summary: normalizeString(record.summary),
  };
}

function normalizeArray<T>(value: unknown, normalize: (item: unknown) => T | null): T[] {
  return Array.isArray(value)
    ? value.map((item) => normalize(item)).filter((item): item is T => Boolean(item))
    : [];
}

function deriveDomain(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function requiresStructuredSourceEvidence(
  requirements: CompletionEvidenceRequirements | null | undefined,
): boolean {
  return typeof requirements?.minSourceCount === 'number'
    || typeof requirements?.maxSourceAgeHours === 'number'
    || Boolean(requirements?.requireSourceLinks);
}

export function normalizeTaskEvidenceSource(value: unknown): TaskEvidenceSource | null {
  const source = asRecord(value);
  if (!source) {
    return null;
  }
  const title =
    normalizeString(source.title)
    ?? normalizeString(source.name);
  const url =
    normalizeString(source.url)
    ?? normalizeString(source.link)
    ?? normalizeString(source.href);
  const publishedAt =
    normalizeTimestamp(source.publishedAt)
    ?? normalizeTimestamp(source.published_at)
    ?? normalizeTimestamp(source.timestamp)
    ?? normalizeTimestamp(source.fetchedAt)
    ?? normalizeTimestamp(source.collectedAt);
  const snippet =
    normalizeString(source.snippet)
    ?? normalizeString(source.excerpt)
    ?? normalizeString(source.quote);
  const domain =
    normalizeString(source.domain)
    ?? deriveDomain(url);

  if (!title && !url && !publishedAt && !snippet) {
    return null;
  }

  return {
    title,
    url,
    publishedAt,
    snippet,
    domain,
  };
}

export function normalizeTaskEvidencePayload(value: unknown): TaskEvidencePayload | null {
  const payload = asRecord(value);
  if (!payload) {
    return null;
  }
  const normalizedSources = Array.isArray(payload.sources)
    ? payload.sources
      .map((item) => normalizeTaskEvidenceSource(item))
      .filter((item): item is TaskEvidenceSource => Boolean(item))
    : [];

  const skillsUsed = normalizeStringArray(payload.skillsUsed ?? payload.skills_used);
  const workspaceId = normalizeString(payload.workspaceId) ?? normalizeString(payload.workspace_id);
  const endpointsUsed = normalizeStringArray(payload.endpointsUsed ?? payload.endpoints_used);
  const toolBindings = normalizeArray(payload.toolBindings ?? payload.tool_bindings, normalizeEndpointUsage);
  const commands = normalizeArray(payload.commands, normalizeCommand);
  const filesChanged = normalizeArray(payload.filesChanged ?? payload.files_changed, normalizeFileChange);
  const tests = normalizeArray(payload.tests, normalizeTestResult);
  const ports = normalizeArray(payload.ports, normalizePort);
  const approvalEvents = normalizeArray(payload.approvalEvents ?? payload.approval_events, normalizeApprovalEvent);
  const riskNotes = normalizeStringArray(payload.riskNotes ?? payload.risk_notes);

  if (
    normalizedSources.length === 0
    && skillsUsed.length === 0
    && !workspaceId
    && endpointsUsed.length === 0
    && toolBindings.length === 0
    && commands.length === 0
    && filesChanged.length === 0
    && tests.length === 0
    && ports.length === 0
    && approvalEvents.length === 0
    && riskNotes.length === 0
  ) {
    return null;
  }

  const dedupedSources = Array.from(new Map(
    normalizedSources.map((item, index) => [
      `${item.url || item.title || 'source'}:${item.publishedAt || index}`,
      item,
    ]),
  ).values());

  const result: TaskEvidencePayload = {};
  if (dedupedSources.length) result.sources = dedupedSources;
  if (skillsUsed.length) result.skillsUsed = skillsUsed;
  if (workspaceId) result.workspaceId = workspaceId;
  if (endpointsUsed.length) result.endpointsUsed = endpointsUsed;
  if (toolBindings.length) result.toolBindings = toolBindings;
  if (commands.length) result.commands = commands;
  if (filesChanged.length) result.filesChanged = filesChanged;
  if (tests.length) result.tests = tests;
  if (ports.length) result.ports = ports;
  if (approvalEvents.length) result.approvalEvents = approvalEvents;
  if (riskNotes.length) result.riskNotes = riskNotes;
  return result;
}
