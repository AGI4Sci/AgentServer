import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TeamChatStore } from '../../core/store/team-chat-store.js';
import type { TaskFact } from '../../core/runtime/blackboard-types.js';
import {
  normalizeTaskEvidencePayload,
  normalizeTaskEvidenceSource,
  requiresStructuredSourceEvidence,
  type TaskEvidencePayload,
} from '../../core/runtime/task-evidence.js';

interface CompletionSourceRecord {
  title: string | null;
  url: string | null;
  publishedAt: number | null;
  recoverySource?: string | null;
}

export interface TaskEvidenceDiagnostics {
  hasBlock: boolean;
  parseError: string | null;
  rawBlockExcerpt: string | null;
  fallbackUsed?: string | null;
  fallbackSourceCount?: number;
}

function parseAuditEvidence(value: string | null | undefined): Record<string, unknown> | null {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface TaskCompletionEvidenceValidation {
  ok: boolean;
  reasons: string[];
  runtimeToolCallCount: number;
  summaryPath: string | null;
  sourceCount: number;
  linkedSourceCount: number;
  recentSourceCount: number;
  diagnostics?: {
    taskEvidence?: TaskEvidenceDiagnostics;
    summaryFallbackSourceCount?: number;
  };
}

function normalizeCompletionBody(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasDetailedCompletionNarrative(value: string | null | undefined): boolean {
  const normalized = normalizeCompletionBody(value);
  if (!normalized) {
    return false;
  }
  if (normalized.length >= 48) {
    return true;
  }
  return /[：:;；，,、]/.test(normalized) && normalized.length >= 24;
}

function isControlOrUserInputTask(task: Pick<TaskFact, 'requiredCapability'>): boolean {
  return task.requiredCapability === 'coordination'
    || task.requiredCapability === 'retrieval'
    || task.requiredCapability === 'user-input';
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapJsonCodeFence(raw: string): string {
  const normalized = String(raw || '').trim();
  if (!normalized) {
    return '';
  }
  const fenced = normalized.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : normalized;
}

function compactExcerpt(value: string, maxLength = 240): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function formatParseError(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'unknown parse error');
}

export function extractTaskEvidenceBlock(body: string): {
  cleanBody: string;
  payload: TaskEvidencePayload | null;
  hasBlock: boolean;
  diagnostics: TaskEvidenceDiagnostics;
} {
  const raw = String(body || '').trim();
  if (!raw) {
    return {
      cleanBody: '',
      payload: null,
      hasBlock: false,
      diagnostics: {
        hasBlock: false,
        parseError: null,
        rawBlockExcerpt: null,
      },
    };
  }
  const match = raw.match(/\[\[TASK_EVIDENCE\]\]([\s\S]*?)\[\[\/TASK_EVIDENCE\]\]/i);
  if (!match) {
    return {
      cleanBody: raw,
      payload: null,
      hasBlock: false,
      diagnostics: {
        hasBlock: false,
        parseError: null,
        rawBlockExcerpt: null,
      },
    };
  }
  const cleanBody = raw.replace(match[0], '').trim();
  const rawBlock = String(match[1] || '');
  try {
    const parsed = JSON.parse(unwrapJsonCodeFence(rawBlock)) as unknown;
    const record = normalizeTaskEvidencePayload(parsed);
    return {
      cleanBody,
      payload: record,
      hasBlock: true,
      diagnostics: {
        hasBlock: true,
        parseError: null,
        rawBlockExcerpt: compactExcerpt(rawBlock),
      },
    };
  } catch (error) {
    return {
      cleanBody,
      payload: null,
      hasBlock: true,
      diagnostics: {
        hasBlock: true,
        parseError: formatParseError(error),
        rawBlockExcerpt: compactExcerpt(rawBlock),
      },
    };
  }
}

function extractSourcesFromEvidence(evidence: Record<string, unknown> | TaskEvidencePayload | null | undefined): CompletionSourceRecord[] {
  const normalized = normalizeTaskEvidencePayload(evidence);
  const rawSources = Array.isArray(normalized?.sources) ? normalized.sources : [];
  return rawSources
    .map((item): CompletionSourceRecord | null => {
      if (!item) {
        return null;
      }
      return {
        title: item.title,
        url: item.url,
        publishedAt: normalizeTimestamp(item.publishedAt),
      };
    })
    .filter((item): item is CompletionSourceRecord => Boolean(item));
}

function isStructuredTaskEvidenceEvent(evidence: Record<string, unknown> | TaskEvidencePayload | null | undefined): boolean {
  const record = asRecord(evidence);
  if (!record) {
    return Boolean(normalizeTaskEvidencePayload(evidence)?.sources?.length);
  }
  const eventType = typeof record.eventType === 'string' ? record.eventType.trim() : '';
  if (!eventType) {
    return Boolean(normalizeTaskEvidencePayload(record)?.sources?.length);
  }
  return eventType === 'task-result';
}

function extractUrlsFromRuntimeEventDetail(detail: string | null | undefined): string[] {
  const normalized = String(detail || '');
  if (!normalized.trim()) {
    return [];
  }
  const absoluteUrls = normalized.match(/https?:\/\/[^\s"'`<>)}\]]+/g) || [];
  const dedupedAbsolute = [...new Set(absoluteUrls.map((item) => item.trim()).filter(Boolean))];
  if (dedupedAbsolute.length > 0) {
    return dedupedAbsolute;
  }
  const relativeApiUrls = normalized.match(/\/api\/v1\/[^\s"'`<>)}\]]+/g) || [];
  return [...new Set(relativeApiUrls.map((item) => `https://scphub.intern-ai.org.cn${item.trim()}`))];
}

function extractSourcesFromRuntimeEvents(events: Record<string, unknown>[]): CompletionSourceRecord[] {
  return events
    .filter((event) => event.eventType === 'runtime-tool-call')
    .flatMap((event) => extractUrlsFromRuntimeEventDetail(typeof event.detail === 'string' ? event.detail : null))
    .map((url) => normalizeTaskEvidenceSource({
      title: inferTitleFromUrl(url),
      url,
    }))
    .filter(Boolean)
    .map((item) => ({
      title: item!.title,
      url: item!.url,
      publishedAt: normalizeTimestamp(item!.publishedAt),
    }));
}

function extractLinksFromSummary(summaryPath: string | null): string[] {
  if (!summaryPath || !existsSync(summaryPath)) {
    return [];
  }
  const content = readFileSync(summaryPath, 'utf-8');
  const urls = content.match(/https?:\/\/[^\s)\]]+/g) || [];
  return [...new Set(urls.map((item) => item.trim()).filter(Boolean))];
}

function extractFirstUrl(value: string): string | null {
  const match = String(value || '').match(/https?:\/\/[^\s|)\]<>"]+/);
  return match?.[0]?.replace(/[.,;，。；]+$/, '') || null;
}

function normalizeSourceDateCandidate(value: string): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const iso = normalized.match(/\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?/);
  if (iso) {
    const valueWithTime = iso[0].includes(':') ? iso[0] : `${iso[0]}T00:00:00`;
    return valueWithTime.replace(' ', 'T');
  }
  const zh = normalized.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日(?:\s*(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (zh) {
    const [, year, month, day, hour = '00', minute = '00', second = '00'] = zh;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}`;
  }
  return null;
}

function extractDateFromText(value: string): string | null {
  const date = normalizeSourceDateCandidate(value);
  if (date) {
    return date;
  }
  return null;
}

function stripMarkdownLink(value: string): { text: string; url: string | null } {
  const raw = String(value || '').trim();
  const markdownLink = raw.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
  if (!markdownLink) {
    return {
      text: raw,
      url: extractFirstUrl(raw),
    };
  }
  return {
    text: markdownLink[1].trim(),
    url: markdownLink[2].trim(),
  };
}

function inferMarkdownSourceFromLine(line: string): Record<string, unknown> | null {
  const rawLine = String(line || '').trim();
  if (!rawLine || !extractFirstUrl(rawLine)) {
    return null;
  }
  if (/^\|?\s*-{2,}\s*(\|\s*-{2,}\s*)+\|?$/.test(rawLine)) {
    return null;
  }

  if (rawLine.includes('|')) {
    const cells = rawLine
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((item) => item.trim())
      .filter(Boolean);
    const urlCell = cells.find((cell) => extractFirstUrl(cell));
    const url = urlCell ? extractFirstUrl(urlCell) : null;
    if (!url) {
      return null;
    }
    const dateCell = cells.find((cell) => Boolean(extractDateFromText(cell)));
    const titleCell = cells.find((cell) => {
      if (cell === urlCell || cell === dateCell) {
        return false;
      }
      if (/^#?\d+$/.test(cell)) {
        return false;
      }
      if (/^(url|链接|来源|source|发布时间|发布日期|时间|date|published)$/i.test(cell)) {
        return false;
      }
      return cell.length > 1;
    });
    const title = titleCell ? stripMarkdownLink(titleCell).text : inferTitleFromUrl(url);
    return {
      title,
      url,
      publishedAt: dateCell ? extractDateFromText(dateCell) : extractDateFromText(rawLine),
    };
  }

  const link = stripMarkdownLink(rawLine);
  const url = link.url;
  if (!url) {
    return null;
  }
  const withoutBullet = rawLine.replace(/^[-*+]\s*/, '').replace(/^\d+[.)]\s*/, '');
  const title = link.text && link.text !== url
    ? link.text
    : withoutBullet
      .replace(url, '')
      .replace(/\s*[-–—|]\s*\d{4}.*$/, '')
      .trim() || inferTitleFromUrl(url);
  return {
    title,
    url,
    publishedAt: extractDateFromText(rawLine),
  };
}

export function inferTaskEvidenceFromSummaryMarkdown(summaryPath: string | null): TaskEvidencePayload | null {
  if (!summaryPath || !existsSync(summaryPath)) {
    return null;
  }
  const content = readFileSync(summaryPath, 'utf-8');
  const sources = content
    .split(/\r?\n/)
    .map(inferMarkdownSourceFromLine)
    .filter(Boolean);
  const dedupedSources = Array.from(new Map(
    sources.map((item, index) => {
      const record = item as Record<string, unknown>;
      return [
        record.url ? `${record.url}:${record.publishedAt || ''}` : `${record.title || 'source'}:${record.publishedAt || index}`,
        record,
      ];
    }),
  ).values())
    .map((item) => normalizeTaskEvidenceSource(item))
    .filter(Boolean);
  return normalizeTaskEvidencePayload({ sources: dedupedSources });
}

function inferTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split('/').filter(Boolean).pop();
    return tail || parsed.hostname || url;
  } catch {
    return url;
  }
}

export function inferTaskEvidenceFromSummary(summaryPath: string | null): TaskEvidencePayload | null {
  const markdownEvidence = inferTaskEvidenceFromSummaryMarkdown(summaryPath);
  if (markdownEvidence?.sources?.length) {
    return markdownEvidence;
  }
  const links = extractLinksFromSummary(summaryPath);
  if (links.length === 0) {
    return null;
  }
  const sources = links
    .map((url) => normalizeTaskEvidenceSource({
      title: inferTitleFromUrl(url),
      url,
    }))
    .filter(Boolean);
  return normalizeTaskEvidencePayload({ sources });
}

export function validateTaskCompletionEvidence(args: {
  teamChatStore: TeamChatStore;
  teamId: string;
  chatSessionId: string;
  task: TaskFact;
  pendingEvidence?: Array<Record<string, unknown> | TaskEvidencePayload>;
  taskEvidenceProvided?: boolean;
  taskEvidenceDiagnostics?: TaskEvidenceDiagnostics | null;
  completionBody?: string;
}): TaskCompletionEvidenceValidation {
  const requirements = args.task.evidenceRequirements;
  const history = args.teamChatStore.getHistory(args.teamId, args.chatSessionId);
  const summaryPath = join(args.task.executionScope.artifactsRoot, 'summary.md');

  const relatedEvents = history.messages
    .filter((message) => message.requestId === args.task.requestId)
    .map((message) => parseAuditEvidence(message.auditContent))
    .filter((evidence): evidence is Record<string, unknown> => Boolean(evidence))
    .filter((evidence) => {
      const taskId = typeof evidence.taskId === 'string' ? evidence.taskId : null;
      if (taskId && taskId !== args.task.id) {
        return false;
      }
      const runId = typeof evidence.runId === 'string' ? evidence.runId : null;
      if (runId && args.task.currentRunId && runId !== args.task.currentRunId) {
        return false;
      }
      return true;
    });

  const runtimeToolCallCount = relatedEvents.filter((event) => event.eventType === 'runtime-tool-call').length;
  const reasons: string[] = [];
  const sourceEvidenceRequired = requiresStructuredSourceEvidence(requirements);
  const taskEvidenceParseError = args.taskEvidenceDiagnostics?.parseError || null;
  const structuredTaskEvidenceProvided =
    Boolean(args.taskEvidenceProvided && !taskEvidenceParseError)
    || [...relatedEvents, ...(args.pendingEvidence || [])].some((event) => isStructuredTaskEvidenceEvent(event));
  const sourceRecords = [
    ...relatedEvents.flatMap((event) => extractSourcesFromEvidence(event)),
    ...((args.pendingEvidence || []).flatMap((event) => extractSourcesFromEvidence(event))),
  ];
  const inferredRuntimeEventSources = sourceEvidenceRequired
    ? extractSourcesFromRuntimeEvents(relatedEvents)
    : [];
  const inferredSummaryEvidence = sourceEvidenceRequired && (!structuredTaskEvidenceProvided || Boolean(taskEvidenceParseError))
    ? inferTaskEvidenceFromSummary(summaryPath)
    : null;
  const inferredSummarySources = extractSourcesFromEvidence(inferredSummaryEvidence);
  sourceRecords.push(...inferredRuntimeEventSources);
  sourceRecords.push(...inferredSummarySources);
  const dedupedSources = Array.from(new Map(
    sourceRecords.map((item, index) => [
      `${item.url || item.title || 'source'}:${item.publishedAt || index}`,
      item,
    ]),
  ).values());
  const now = Date.now();
  const linkedSources = dedupedSources.filter((item) => Boolean(item.url));
  const recentSources = typeof requirements?.maxSourceAgeHours === 'number'
    ? dedupedSources.filter((item) =>
        typeof item.publishedAt === 'number'
        && item.publishedAt >= now - (requirements.maxSourceAgeHours! * 60 * 60 * 1000),
      )
    : dedupedSources;
  const summaryLinks = extractLinksFromSummary(summaryPath);
  const summaryFallbackSourceCount = inferredSummarySources.length;
  const hasSummaryArtifact = existsSync(summaryPath);
  const hasDetailedNarrative = hasDetailedCompletionNarrative(args.completionBody);
  const hasReviewableCompletionEvidence =
    runtimeToolCallCount > 0
    || hasSummaryArtifact
    || dedupedSources.length > 0
    || hasDetailedNarrative;
  const needsReviewableCompletionEvidence =
    !isControlOrUserInputTask(args.task)
    && (
      (args.task.acceptanceCriteria?.length || 0) > 0
      || Boolean(requirements)
    );

  if (requirements?.requireRuntimeToolCall && runtimeToolCallCount === 0) {
    reasons.push('缺少 runtime-tool-call 执行轨迹');
  }
  if (requirements?.requireSummaryArtifact && !hasSummaryArtifact) {
    reasons.push(`缺少 summary.md 产物: ${summaryPath}`);
  }
  if (sourceEvidenceRequired && !structuredTaskEvidenceProvided && inferredSummarySources.length === 0 && inferredRuntimeEventSources.length === 0) {
    reasons.push('来源型验收任务缺少 [[TASK_EVIDENCE]] 结构化来源块');
  }
  if (typeof requirements?.minSourceCount === 'number' && dedupedSources.length < requirements.minSourceCount) {
    reasons.push(`来源数量不足：至少需要 ${requirements.minSourceCount} 条结构化来源，当前仅 ${dedupedSources.length} 条`);
  }
  if (requirements?.requireSourceLinks && linkedSources.length < (requirements.minSourceCount || dedupedSources.length || summaryLinks.length || 1)) {
    reasons.push(`来源缺少可审查链接：当前仅 ${linkedSources.length} 条结构化来源带链接，summary.md 中检测到 ${summaryLinks.length} 条链接`);
  }
  if (typeof requirements?.maxSourceAgeHours === 'number') {
    const minRecentCount = requirements.minSourceCount || 1;
    if (recentSources.length < minRecentCount) {
      reasons.push(`来源时间窗口不满足：最近 ${requirements.maxSourceAgeHours} 小时内仅 ${recentSources.length} 条来源，至少需要 ${minRecentCount} 条`);
    }
  }
  if (sourceEvidenceRequired && taskEvidenceParseError && reasons.length > 0) {
    const fallbackText = summaryFallbackSourceCount > 0
      ? `已从 summary.md fallback 恢复 ${summaryFallbackSourceCount} 条候选来源`
      : 'summary.md fallback 未恢复到带结构化字段的来源';
    reasons.unshift(`TASK_EVIDENCE JSON 解析失败：${taskEvidenceParseError}；${fallbackText}`);
  }
  if (needsReviewableCompletionEvidence && !hasReviewableCompletionEvidence) {
    reasons.push('任务已声明验收门槛，但未留下可审查的完成证据：至少提供 summary.md、runtime-tool-call、结构化来源或足够具体的结果说明');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    runtimeToolCallCount,
    summaryPath: existsSync(summaryPath) ? summaryPath : null,
    sourceCount: dedupedSources.length,
    linkedSourceCount: linkedSources.length,
    recentSourceCount: recentSources.length,
    diagnostics: {
      taskEvidence: args.taskEvidenceDiagnostics || undefined,
      summaryFallbackSourceCount,
    },
  };
}
