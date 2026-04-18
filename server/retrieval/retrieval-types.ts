import type { BackendType } from '../../core/runtime/backend-catalog.js';

export const RETRIEVAL_MODES = [
  'memory_recall',
  'workspace_search',
  'web_search',
] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

export type RetrievalScope =
  | 'session'
  | 'agent'
  | 'team'
  | 'path'
  | 'web';

export type RetrievalDistillMode =
  | 'rules_only'
  | 'llm_compress';

export interface RetrievalRequest {
  mode: RetrievalMode;
  query: string;
  teamId: string;
  requestId?: string;
  chatSessionId?: string | null;
  agentId?: string;
  scope?: RetrievalScope;
  path?: string;
  backendOverride?: BackendType;
  cwd?: string;
  limit?: number;
  maxEvidence?: number;
  distillMode?: RetrievalDistillMode;
  required?: boolean;
}

export interface RetrievalEvidenceHit {
  source: string;
  snippet: string;
  title?: string;
  path?: string;
  url?: string;
  score?: number;
  metadata?: Record<
    string,
    string | number | boolean | null | string[] | number[] | boolean[]
  >;
}

export interface RetrievalResult {
  mode: RetrievalMode;
  backend: BackendType;
  scope: RetrievalScope;
  query: string;
  hits: RetrievalEvidenceHit[];
  exhausted: boolean;
  shouldAskUser: boolean;
  distillModeApplied?: RetrievalDistillMode | 'llm_compress_fallback_rules_only';
  failureReason?: string;
}

export interface RetrievalProvider {
  readonly backend: BackendType;
  supports(mode: RetrievalMode): boolean;
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

export function isRetrievalMode(value: unknown): value is RetrievalMode {
  return typeof value === 'string' && RETRIEVAL_MODES.includes(value as RetrievalMode);
}

export function resolveRetrievalScope(mode: RetrievalMode): RetrievalScope {
  if (mode === 'memory_recall') {
    return 'team';
  }
  if (mode === 'workspace_search') {
    return 'path';
  }
  return 'web';
}

export function isRetrievalScopeAllowed(mode: RetrievalMode, scope: RetrievalScope): boolean {
  if (mode === 'memory_recall') {
    return scope === 'session' || scope === 'agent' || scope === 'team';
  }
  if (mode === 'workspace_search') {
    return scope === 'path';
  }
  return scope === 'web';
}

export function resolveEffectiveRetrievalScope(request: RetrievalRequest): RetrievalScope {
  const scope = request.scope || resolveRetrievalScope(request.mode);
  return isRetrievalScopeAllowed(request.mode, scope)
    ? scope
    : resolveRetrievalScope(request.mode);
}

export function shouldAskUserAfterRetrieval(request: RetrievalRequest, hits: RetrievalEvidenceHit[]): boolean {
  return Boolean(request.required && hits.length === 0);
}
