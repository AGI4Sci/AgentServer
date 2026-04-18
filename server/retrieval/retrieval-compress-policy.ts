import type { RetrievalEvidenceHit, RetrievalRequest } from './retrieval-types.js';
import { loadOpenTeamConfig } from '../utils/openteam-config.js';

export interface RetrievalLlmCompressPolicy {
  enabled: boolean;
  minHitCount: number;
  minTotalSnippetChars: number;
  minDistinctSources: number;
  minQueryTokenCountForAmbiguousQuery: number;
  maxSpecificEntitySignalsForAmbiguousQuery: number;
}

export interface RetrievalLlmCompressHeuristic {
  shouldCompress: boolean;
  reasons: string[];
}

// User-editable policy for deciding when retrieval should auto-upgrade
// from rules_only distill to llm_compress. Keep this file small and explicit
// so tuning does not require touching the distill pipeline itself.
export const RETRIEVAL_LLM_COMPRESS_POLICY: RetrievalLlmCompressPolicy = {
  ...loadOpenTeamConfig().retrieval.compressPolicy,
};

function countDistinctSources(hits: RetrievalEvidenceHit[]): number {
  return new Set(hits.map((hit) => hit.source)).size;
}

function countSpecificEntitySignals(query: string): number {
  const trimmed = query.trim();
  if (!trimmed) {
    return 0;
  }
  let count = 0;
  if (/\bT\d{2,}\b/i.test(trimmed)) count += 1;
  if (/\b\d{2,5}\b/.test(trimmed)) count += 1;
  if (/[/.#:_-]/.test(trimmed)) count += 1;
  if (/https?:\/\//i.test(trimmed)) count += 1;
  if (/["'`]/.test(trimmed)) count += 1;
  return count;
}

export function evaluateRetrievalLlmCompressHeuristic(
  request: RetrievalRequest,
  hits: RetrievalEvidenceHit[],
  policy: RetrievalLlmCompressPolicy = RETRIEVAL_LLM_COMPRESS_POLICY,
): RetrievalLlmCompressHeuristic {
  if (!policy.enabled) {
    return {
      shouldCompress: false,
      reasons: ['policy_disabled'],
    };
  }

  const queryTokens = request.query.trim().split(/\s+/).filter(Boolean);
  const totalSnippetChars = hits.reduce((sum, hit) => sum + hit.snippet.length, 0);
  const distinctSources = countDistinctSources(hits);
  const specificEntitySignals = countSpecificEntitySignals(request.query);
  const reasons: string[] = [];

  if (hits.length >= policy.minHitCount) {
    reasons.push(`hit_count>=${policy.minHitCount}`);
  }
  if (totalSnippetChars >= policy.minTotalSnippetChars) {
    reasons.push(`total_chars>=${policy.minTotalSnippetChars}`);
  }
  if (distinctSources >= policy.minDistinctSources) {
    reasons.push(`distinct_sources>=${policy.minDistinctSources}`);
  }
  if (
    queryTokens.length >= policy.minQueryTokenCountForAmbiguousQuery
    && specificEntitySignals <= policy.maxSpecificEntitySignalsForAmbiguousQuery
  ) {
    reasons.push('query_is_ambiguous');
  }

  return {
    shouldCompress: reasons.length >= 2,
    reasons,
  };
}
