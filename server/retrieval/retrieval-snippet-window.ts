import type { RetrievalEvidenceHit } from './retrieval-types.js';

const DEFAULT_MAX_CHARS = 1600;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_WINDOWS = 3;

function normalizeQueryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function findMatchingLineIndexes(lines: string[], tokens: string[]): number[] {
  if (tokens.length === 0) {
    return [];
  }
  const matches: number[] = [];
  lines.forEach((line, index) => {
    const normalized = line.toLowerCase();
    if (tokens.some((token) => normalized.includes(token))) {
      matches.push(index);
    }
  });
  return matches;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  if (ranges.length === 0) {
    return [];
  }
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function fallbackHeadTailSnippet(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const headBudget = Math.floor(maxChars * 0.65);
  const tailBudget = Math.max(120, maxChars - headBudget - 32);
  const head = content.slice(0, headBudget).trimEnd();
  const tail = content.slice(-tailBudget).trimStart();
  return `${head}\n...[truncated ${content.length - head.length - tail.length} chars]...\n${tail}`;
}

export function buildFocusedSnippet(args: {
  query: string;
  content: string;
  maxChars?: number;
  contextLines?: number;
  maxWindows?: number;
}): { snippet: string; truncated: boolean; lineRanges: string[] } {
  const content = String(args.content || '');
  const maxChars = args.maxChars || DEFAULT_MAX_CHARS;
  if (content.length <= maxChars) {
    return { snippet: content, truncated: false, lineRanges: [] };
  }

  const lines = content.split('\n');
  const tokens = normalizeQueryTokens(args.query);
  const matchingIndexes = findMatchingLineIndexes(lines, tokens);
  if (matchingIndexes.length === 0) {
    return {
      snippet: fallbackHeadTailSnippet(content, maxChars),
      truncated: true,
      lineRanges: [],
    };
  }

  const contextLines = args.contextLines ?? DEFAULT_CONTEXT_LINES;
  const maxWindows = args.maxWindows ?? DEFAULT_MAX_WINDOWS;
  const mergedRanges = mergeRanges(
    matchingIndexes.map((index) => ({
      start: Math.max(0, index - contextLines),
      end: Math.min(lines.length - 1, index + contextLines),
    })),
  ).slice(0, maxWindows);

  const renderedWindows: string[] = [];
  const lineRanges: string[] = [];
  let consumedChars = 0;
  for (const range of mergedRanges) {
    const header = `L${range.start + 1}-L${range.end + 1}:`;
    const body = lines.slice(range.start, range.end + 1).join('\n').trim();
    const nextChunk = `${header}\n${body}`.trim();
    const separator = renderedWindows.length > 0 ? '\n...\n' : '';
    if (consumedChars + separator.length + nextChunk.length > maxChars) {
      break;
    }
    renderedWindows.push(nextChunk);
    lineRanges.push(`${range.start + 1}-${range.end + 1}`);
    consumedChars += separator.length + nextChunk.length;
  }

  if (renderedWindows.length === 0) {
    return {
      snippet: fallbackHeadTailSnippet(content, maxChars),
      truncated: true,
      lineRanges: [],
    };
  }

  return {
    snippet: renderedWindows.join('\n...\n'),
    truncated: true,
    lineRanges,
  };
}

export function focusRetrievalHitSnippet(query: string, hit: RetrievalEvidenceHit, maxChars = DEFAULT_MAX_CHARS): RetrievalEvidenceHit {
  const metadata = hit.metadata || {};
  const originalContent = typeof metadata.originalContent === 'string'
    ? metadata.originalContent
    : hit.snippet;
  const focused = buildFocusedSnippet({
    query,
    content: originalContent,
    maxChars,
  });
  return {
    ...hit,
    snippet: focused.snippet,
    metadata: {
      ...metadata,
      snippetTruncated: focused.truncated,
      lineRanges: focused.lineRanges,
    },
  };
}
