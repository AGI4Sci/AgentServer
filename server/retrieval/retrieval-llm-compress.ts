import { getTeamRegistry } from '../../core/team/registry.js';
import type { MemberConfig } from '../../core/team/types.js';
import { normalizeConfiguredRuntimeModelIdentifier } from '../runtime/model-spec.js';
import { getSessionRunner } from '../runtime/session-runner-registry.js';
import type { RunSessionOptions, SessionOutput, SessionRunner } from '../runtime/session-types.js';
import type { RetrievalEvidenceHit, RetrievalRequest, RetrievalResult } from './retrieval-types.js';

type EvidenceConfidence = 'low' | 'medium' | 'high';

interface LlmCompressSelection {
  evidence: Array<{
    index: number;
    whyRelevant?: string;
    confidence?: EvidenceConfidence;
  }>;
}

interface ExecuteLlmCompressDeps {
  runner?: SessionRunner;
  now?: () => number;
  randomId?: () => string;
  coordinatorMember?: MemberConfig | undefined;
}

type RetrievalLlmCompressExecutor = (
  request: RetrievalRequest,
  result: RetrievalResult,
  candidates: RetrievalEvidenceHit[],
  deps?: ExecuteLlmCompressDeps,
) => Promise<RetrievalEvidenceHit[] | null>;

let retrievalLlmCompressExecutorOverride: RetrievalLlmCompressExecutor | null = null;

export function setRetrievalLlmCompressExecutorForTests(
  executor: RetrievalLlmCompressExecutor | null,
): void {
  retrievalLlmCompressExecutorOverride = executor;
}

function trimJsonFence(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith('```json')) {
    return trimmed.slice(7).replace(/```$/, '').trim();
  }
  if (trimmed.startsWith('```')) {
    return trimmed.slice(3).replace(/```$/, '').trim();
  }
  return trimmed;
}

function extractJsonObject(content: string): string | null {
  const trimmed = trimJsonFence(content);
  if (!trimmed) {
    return null;
  }
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // fall through
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) || trimmed.match(/```([\s\S]*?)```/);
  if (fenced?.[1]) {
    const candidate = fenced[1].trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1).trim();
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  return null;
}

function parseSelection(content: string): LlmCompressSelection | null {
  const json = extractJsonObject(content);
  if (!json) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { evidence?: unknown }).evidence)) {
    return null;
  }

  const evidence = (parsed as { evidence: unknown[] }).evidence
    .map((entry): LlmCompressSelection['evidence'][number] | null => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const index = (entry as { index?: unknown }).index;
      const whyRelevant = (entry as { whyRelevant?: unknown }).whyRelevant;
      const confidence = (entry as { confidence?: unknown }).confidence;
      let normalizedConfidence: EvidenceConfidence | undefined;
      if (confidence === 'low' || confidence === 'medium' || confidence === 'high') {
        normalizedConfidence = confidence;
      }
      return {
        index: typeof index === 'number' ? index : Number.NaN,
        whyRelevant: typeof whyRelevant === 'string' ? whyRelevant.trim() : undefined,
        confidence: normalizedConfidence,
      };
    })
    .filter((entry): entry is LlmCompressSelection['evidence'][number] => (
      entry !== null && Number.isInteger(entry.index) && entry.index >= 0
    ));

  return { evidence };
}

function buildCandidateEnvelope(hit: RetrievalEvidenceHit, index: number) {
  return {
    index,
    source: hit.source,
    title: hit.title || null,
    path: hit.path || null,
    url: hit.url || null,
    snippet: hit.snippet,
    time: typeof hit.metadata?.relativeTime === 'string' || typeof hit.metadata?.absoluteTime === 'string'
      ? {
          relative: typeof hit.metadata?.relativeTime === 'string' ? hit.metadata.relativeTime : null,
          absolute: typeof hit.metadata?.absoluteTime === 'string' ? hit.metadata.absoluteTime : null,
        }
      : null,
    whyRelevant: typeof hit.metadata?.whyRelevant === 'string' ? hit.metadata.whyRelevant : null,
    confidence: typeof hit.metadata?.confidence === 'string' ? hit.metadata.confidence : null,
  };
}

function buildPrompt(request: RetrievalRequest, result: RetrievalResult, candidates: RetrievalEvidenceHit[], limit: number): string {
  return [
    '你是 retrieval evidence 压缩器。',
    '你的任务是从给定候选里挑选最值得保留的证据，不能新增事实，不能改写状态，不能输出结论。',
    '你只能按候选 index 选择；不要生成不存在的 index。',
    `最多保留 ${limit} 条 evidence。`,
    '输出纯 JSON，不要 markdown，不要解释。',
    '返回格式必须严格是：',
    '{"evidence":[{"index":0,"whyRelevant":"为什么相关","confidence":"low|medium|high"}]}',
    '',
    `query: ${request.query}`,
    `mode: ${request.mode}`,
    `scope: ${result.scope}`,
    '',
    '候选 evidence：',
    JSON.stringify(candidates.map(buildCandidateEnvelope), null, 2),
  ].join('\n');
}

function sanitizeSelections(
  selection: LlmCompressSelection,
  candidates: RetrievalEvidenceHit[],
  limit: number,
): RetrievalEvidenceHit[] {
  const seen = new Set<number>();
  const selected: RetrievalEvidenceHit[] = [];
  for (const entry of selection.evidence) {
    if (seen.has(entry.index) || entry.index >= candidates.length) {
      continue;
    }
    seen.add(entry.index);
    const hit = candidates[entry.index];
    const metadata = hit.metadata || {};
    selected.push({
      ...hit,
      metadata: {
        ...metadata,
        whyRelevant: entry.whyRelevant || metadata.whyRelevant || null,
        confidence: entry.confidence || metadata.confidence || null,
      },
    });
    if (selected.length >= limit) {
      break;
    }
  }
  return selected;
}

export async function executeRetrievalLlmCompress(
  request: RetrievalRequest,
  result: RetrievalResult,
  candidates: RetrievalEvidenceHit[],
  deps: ExecuteLlmCompressDeps = {},
): Promise<RetrievalEvidenceHit[] | null> {
  if (retrievalLlmCompressExecutorOverride) {
    return await retrievalLlmCompressExecutorOverride(request, result, candidates, deps);
  }

  if (candidates.length === 0) {
    return [];
  }

  const registry = getTeamRegistry(request.teamId);
  const coordinatorId = registry?.getCoordinator?.() || 'retrieval-distill';
  const coordinatorMember = deps.coordinatorMember ?? registry?.getMember(coordinatorId);
  const model = coordinatorMember
    ? normalizeConfiguredRuntimeModelIdentifier(coordinatorMember as MemberConfig)
    : undefined;
  const runner = deps.runner || getSessionRunner(result.backend);
  const now = deps.now || Date.now;
  const randomId = deps.randomId || (() => Math.random().toString(36).slice(2, 8));
  const limit = Math.max(1, Math.min(request.maxEvidence || request.limit || 5, candidates.length));
  const requestNonce = `${now()}-${randomId()}`;
  const input = {
    task: `压缩检索证据：${request.query}`,
    context: buildPrompt(request, result, candidates, limit),
  };
  const options: RunSessionOptions = {
    backend: result.backend,
    teamId: request.teamId,
    agentId: coordinatorId,
    requestId: `retrieval-distill-${requestNonce}`,
    sessionKey: `retrieval-distill:${request.teamId}:${requestNonce}`,
    sessionMode: 'ephemeral',
    toolMode: 'none',
    timeoutMs: 20_000,
    cwd: request.path || request.cwd,
    model,
  };

  let output: SessionOutput;
  try {
    output = await runner.run(input, options);
  } catch {
    return null;
  }

  if (!output.success) {
    return null;
  }

  const selection = parseSelection(output.result);
  if (!selection) {
    return null;
  }

  return sanitizeSelections(selection, candidates, limit);
}
