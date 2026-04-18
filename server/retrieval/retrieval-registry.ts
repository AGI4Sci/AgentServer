import type { BackendType } from '../../core/runtime/backend-catalog.js';
import {
  getBackendDescriptor,
  normalizeBackendType,
} from '../../core/runtime/backend-catalog.js';
import { resolveTeamSessionClientType } from '../runtime/session-runner-registry.js';
import type {
  RetrievalMode,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResult,
} from './retrieval-types.js';
import {
  isRetrievalScopeAllowed,
  resolveEffectiveRetrievalScope,
  resolveRetrievalScope,
  shouldAskUserAfterRetrieval,
} from './retrieval-types.js';
import { distillRetrievalResult } from './retrieval-distiller.js';

const providers = new Map<BackendType, RetrievalProvider>();

export function resolveRetrievalBackend(teamId: string, override?: BackendType): BackendType {
  return resolveTeamSessionClientType(teamId, override);
}

export function registerRetrievalProvider(provider: RetrievalProvider): void {
  providers.set(provider.backend, provider);
}

export function getRetrievalProvider(backend: BackendType): RetrievalProvider | null {
  return providers.get(backend) || null;
}

export function describeRetrievalBackend(backend: BackendType): string {
  return getBackendDescriptor(backend).label;
}

export async function performRetrieval(request: RetrievalRequest): Promise<RetrievalResult> {
  const backend = resolveRetrievalBackend(request.teamId, request.backendOverride);
  const scope = request.scope || resolveRetrievalScope(request.mode);
  if (!isRetrievalScopeAllowed(request.mode, scope)) {
    return {
      mode: request.mode,
      backend,
      scope: resolveEffectiveRetrievalScope(request),
      query: request.query,
      hits: [],
      exhausted: true,
      shouldAskUser: shouldAskUserAfterRetrieval(request, []),
      failureReason: `retrieval_scope_unsupported:${request.mode}:${scope}`,
    };
  }
  const provider = getRetrievalProvider(backend);
  if (!provider) {
    return {
      mode: request.mode,
      backend,
      scope: scope,
      query: request.query,
      hits: [],
      exhausted: true,
      shouldAskUser: shouldAskUserAfterRetrieval(request, []),
      failureReason: `retrieval_provider_missing:${backend}`,
    };
  }

  if (!provider.supports(request.mode)) {
    return {
      mode: request.mode,
      backend,
      scope: scope,
      query: request.query,
      hits: [],
      exhausted: true,
      shouldAskUser: shouldAskUserAfterRetrieval(request, []),
      failureReason: `retrieval_mode_unsupported:${backend}:${request.mode}`,
    };
  }

  return await distillRetrievalResult(request, await provider.retrieve(request));
}

export function buildUnsupportedRetrievalResult(args: {
  backend: string;
  mode: RetrievalMode;
  query: string;
}): RetrievalResult {
  const backend = normalizeBackendType(args.backend, 'codex');
  return {
    mode: args.mode,
    backend,
    scope: resolveRetrievalScope(args.mode),
    query: args.query,
    hits: [],
    exhausted: true,
    shouldAskUser: false,
    failureReason: `retrieval_mode_unsupported:${backend}:${args.mode}`,
  };
}
