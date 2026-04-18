import type {
  RetrievalDistillMode,
  RetrievalEvidenceHit,
  RetrievalRequest,
  RetrievalResult,
  RetrievalScope,
} from './retrieval-types.js';
import { evaluateRetrievalLlmCompressHeuristic } from './retrieval-compress-policy.js';
import { executeRetrievalLlmCompress } from './retrieval-llm-compress.js';
import { focusRetrievalHitSnippet } from './retrieval-snippet-window.js';

function scoreScope(scope: RetrievalScope): number {
  switch (scope) {
    case 'session':
      return 500;
    case 'path':
      return 400;
    case 'agent':
      return 300;
    case 'team':
      return 250;
    case 'web':
      return 200;
    default:
      return 0;
  }
}

function scoreSource(source: string): number {
  switch (source) {
    case 'chat_history':
      return 120;
    case 'archived':
      return 100;
    case 'agent_recall':
      return 60;
    default:
      return 40;
  }
}

function scoreRecency(hit: RetrievalEvidenceHit): number {
  const archivedAt = typeof hit.metadata?.archivedAt === 'string'
    ? hit.metadata.archivedAt
    : null;
  if (!archivedAt) {
    return 0;
  }
  const parsed = Date.parse(archivedAt);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  const ageHours = Math.abs(Date.now() - parsed) / 3_600_000;
  if (ageHours <= 1) return 80;
  if (ageHours <= 6) return 60;
  if (ageHours <= 24) return 40;
  if (ageHours <= 72) return 20;
  return 0;
}

function buildWhyRelevant(query: string, hit: RetrievalEvidenceHit): string {
  const snippet = hit.snippet.trim();
  const normalizedSnippet = snippet.toLowerCase();
  const queryTokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matchedTokens = queryTokens.filter((token) => normalizedSnippet.includes(token));
  if (matchedTokens.length > 0) {
    return `命中 query 关键词：${matchedTokens.slice(0, 4).join(', ')}`;
  }
  if (hit.path) {
    return `命中路径范围：${hit.path}`;
  }
  if (hit.url) {
    return `命中 URL：${hit.url}`;
  }
  return `命中 ${hit.source} 范围内的相关片段`;
}

function buildConfidence(score: number): 'low' | 'medium' | 'high' {
  if (score >= 700) return 'high';
  if (score >= 350) return 'medium';
  return 'low';
}

function dedupeHits(hits: RetrievalEvidenceHit[]): RetrievalEvidenceHit[] {
  const seen = new Set<string>();
  const deduped: RetrievalEvidenceHit[] = [];
  for (const hit of hits) {
    const key = [
      hit.source,
      hit.path || '',
      hit.url || '',
      hit.title || '',
      hit.snippet.trim(),
    ].join('::');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hit);
  }
  return deduped;
}

function distillRulesOnly(
  request: RetrievalRequest,
  hits: RetrievalEvidenceHit[],
  scope: RetrievalScope,
  limitOverride?: number,
): RetrievalEvidenceHit[] {
  const limit = Math.max(1, Math.min(limitOverride || request.maxEvidence || request.limit || 5, 12));
  return dedupeHits(hits)
    .map((hit) => {
      const focusedHit = focusRetrievalHitSnippet(request.query, hit);
      const metadata = focusedHit.metadata || {};
      const baseScore = typeof hit.score === 'number' ? hit.score : 0;
      const totalScore = baseScore + scoreScope(scope) + scoreSource(hit.source) + scoreRecency(hit);
      return {
        ...focusedHit,
        score: totalScore,
        metadata: {
          ...metadata,
          whyRelevant: typeof metadata.whyRelevant === 'string'
            ? metadata.whyRelevant
            : buildWhyRelevant(request.query, focusedHit),
          confidence: buildConfidence(totalScore),
        },
      };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
}

export async function distillRetrievalResult(request: RetrievalRequest, result: RetrievalResult): Promise<RetrievalResult> {
  const requestedMode: RetrievalDistillMode | undefined = request.distillMode;
  const heuristicHits = dedupeHits(result.hits);
  const distilledHits = distillRulesOnly(request, result.hits, result.scope);
  const heuristic = evaluateRetrievalLlmCompressHeuristic(request, heuristicHits);
  const mode: RetrievalDistillMode = requestedMode || (heuristic.shouldCompress ? 'llm_compress' : 'rules_only');

  if (mode === 'llm_compress') {
    const llmCandidateLimit = Math.max(distilledHits.length, Math.min((request.maxEvidence || request.limit || 5) * 2, 10));
    const llmCandidates = distillRulesOnly(request, result.hits, result.scope, llmCandidateLimit);
    const llmCompressedHits = await executeRetrievalLlmCompress(request, result, llmCandidates);
    if (llmCompressedHits) {
      return {
        ...result,
        hits: llmCompressedHits,
        distillModeApplied: 'llm_compress',
      };
    }
    return {
      ...result,
      hits: distilledHits,
      distillModeApplied: 'llm_compress_fallback_rules_only',
    };
  }

  return {
    ...result,
    hits: distilledHits,
    distillModeApplied: 'rules_only',
  };
}
