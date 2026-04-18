import { BACKEND_IDS, type BackendType } from '../../core/runtime/backend-catalog.js';
import type {
  RetrievalEvidenceHit,
  RetrievalProvider,
  RetrievalRequest,
  RetrievalResult,
} from './retrieval-types.js';
import { registerRetrievalProvider } from './retrieval-registry.js';
import {
  absolutizeRelativePath,
  resolveWorkspacePrimitiveAdapter,
  type WorkspacePrimitiveContentHit,
} from './workspace-search-primitives.js';

const DEFAULT_MAX_FILES = 12;
const DEFAULT_MAX_HITS = 8;

function resolveSearchRoot(request: RetrievalRequest): string {
  const raw = String(request.path || request.cwd || process.cwd()).trim();
  if (!raw) {
    return process.cwd();
  }
  return raw;
}

function tokenizeQuery(query: string): string[] {
  return query
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function formatContentSnippet(hit: WorkspacePrimitiveContentHit): string {
  return hit.lines
    .map((entry) => `L${entry.line}: ${entry.text}`)
    .join('\n')
    .trim();
}

function dedupeWorkspaceHits(hits: RetrievalEvidenceHit[]): RetrievalEvidenceHit[] {
  const seen = new Set<string>();
  const deduped: RetrievalEvidenceHit[] = [];
  for (const hit of hits) {
    const key = `${hit.source}::${hit.path || hit.title || ''}::${hit.snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(hit);
    if (deduped.length >= DEFAULT_MAX_HITS) {
      break;
    }
  }
  return deduped;
}

export function createWorkspaceSearchProvider(backend: BackendType): RetrievalProvider {
  return {
    backend,
    supports(mode) {
      return mode === 'workspace_search';
    },
    async retrieve(request): Promise<RetrievalResult> {
      const root = resolveSearchRoot(request);
      const tokens = tokenizeQuery(request.query);
      if (tokens.length === 0) {
        return {
          mode: request.mode,
          backend,
          scope: 'path',
          query: request.query,
          hits: [],
          exhausted: true,
          shouldAskUser: Boolean(request.required),
          failureReason: 'empty_query',
        };
      }

      const adapter = resolveWorkspacePrimitiveAdapter(backend);
      const [pathCandidates, contentHits] = await Promise.all([
        adapter.collectPathCandidates(root, tokens, DEFAULT_MAX_FILES),
        adapter.collectContentHits(root, tokens),
      ]);

      const pathHits: RetrievalEvidenceHit[] = pathCandidates.map((hit) => {
        const absolutePath = absolutizeRelativePath(root, hit.relativePath);
        return {
          source: 'workspace_path',
          title: hit.relativePath,
          path: absolutePath,
          snippet: hit.relativePath,
          score: 1,
          metadata: {
            path: hit.relativePath,
            originalContent: hit.relativePath,
            primitiveAdapter: adapter.id,
            primitiveInvocationMode: adapter.invocationMode,
          },
        };
      });

      const contentEvidenceHits: RetrievalEvidenceHit[] = await Promise.all(contentHits.map(async (hit) => {
        const fileSlice = await adapter.readFileSlice(root, hit.relativePath);
        const absolutePath = fileSlice?.absolutePath || absolutizeRelativePath(root, hit.relativePath);
        const snippet = formatContentSnippet(hit);
        return {
          source: 'workspace_content',
          title: hit.relativePath,
          path: absolutePath,
          snippet,
          score: 1,
          metadata: {
            path: hit.relativePath,
            token: hit.token,
            lineRanges: hit.lines.length > 0 ? [`${hit.lines[0]?.line}-${hit.lines[hit.lines.length - 1]?.line}`] : [],
            absoluteTime: fileSlice?.absoluteTime || null,
            originalContent: fileSlice?.content || snippet,
            primitiveAdapter: adapter.id,
            primitiveInvocationMode: adapter.invocationMode,
          },
        };
      }));

      const hits = dedupeWorkspaceHits([...pathHits, ...contentEvidenceHits]);
      return {
        mode: request.mode,
        backend,
        scope: 'path',
        query: request.query,
        hits,
        exhausted: true,
        shouldAskUser: Boolean(request.required && hits.length === 0),
        failureReason: hits.length > 0 ? undefined : 'no_workspace_match',
      };
    },
  };
}

let workspaceProvidersRegistered = false;

export function registerWorkspaceSearchProviders(): void {
  if (workspaceProvidersRegistered) {
    return;
  }
  workspaceProvidersRegistered = true;
  for (const backend of BACKEND_IDS) {
    registerRetrievalProvider(createWorkspaceSearchProvider(backend));
  }
}
