import type { ProposalFactKind, ProposalFactPayload } from '../../core/runtime/blackboard-types.js';

export interface ExtractedTaskProposalBlock {
  hasBlock: boolean;
  cleanBody: string;
  proposals: Array<{
    kind: ProposalFactKind;
    payload: ProposalFactPayload;
  }>;
  diagnostics: {
    parseError: string | null;
    rawBlockExcerpt: string | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const ALLOWED_KINDS = new Set<ProposalFactKind>([
  'split',
  'handoff',
  'need_review',
  'need_qa',
  'need_user_input',
  'blocked_replan',
]);

function normalizeProposalCandidate(value: unknown): {
  kind: ProposalFactKind;
  payload: ProposalFactPayload;
} | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }
  const kind = String(record.kind || '').trim() as ProposalFactKind;
  if (!ALLOWED_KINDS.has(kind)) {
    return null;
  }
  const goal = String(record.goal || '').trim();
  const requiredCapability = String(record.requiredCapability || '').trim();
  const reason = String(record.reason || '').trim();
  if (!goal || !requiredCapability || !reason) {
    return null;
  }
  const suggestedAssignee = record.suggestedAssignee == null
    ? undefined
    : String(record.suggestedAssignee || '').trim() || null;
  const requires = Array.isArray(record.requires)
    ? record.requires.map((item) => String(item || '').trim()).filter(Boolean)
    : undefined;
  const acceptanceCriteria = Array.isArray(record.acceptanceCriteria)
    ? record.acceptanceCriteria.map((item) => String(item || '').trim()).filter(Boolean)
    : undefined;
  const evidenceRequirements = record.evidenceRequirements && typeof record.evidenceRequirements === 'object'
    ? record.evidenceRequirements as ProposalFactPayload['evidenceRequirements']
    : undefined;
  const executionScope = record.executionScope && typeof record.executionScope === 'object'
    ? record.executionScope as ProposalFactPayload['executionScope']
    : undefined;
  const endpointHints = Array.isArray(record.endpointHints)
    ? record.endpointHints.filter((item) => item && typeof item === 'object') as ProposalFactPayload['endpointHints']
    : undefined;
  const toolBindings = Array.isArray(record.toolBindings)
    ? record.toolBindings.filter((item) => item && typeof item === 'object') as ProposalFactPayload['toolBindings']
    : undefined;
  const networkMode = typeof record.networkMode === 'string'
    ? record.networkMode.trim() as ProposalFactPayload['networkMode']
    : undefined;
  const riskClass = typeof record.riskClass === 'string'
    ? record.riskClass.trim() as ProposalFactPayload['riskClass']
    : undefined;
  return {
    kind,
    payload: {
      goal,
      requiredCapability,
      reason,
      suggestedAssignee,
      requires,
      acceptanceCriteria,
      evidenceRequirements,
      endpointHints,
      toolBindings,
      networkMode,
      riskClass,
      executionScope,
    },
  };
}

export function extractTaskProposalBlock(body: string): ExtractedTaskProposalBlock {
  const raw = String(body || '').trim();
  if (!raw) {
    return { hasBlock: false, cleanBody: '', proposals: [], diagnostics: { parseError: null, rawBlockExcerpt: null } };
  }
  const match = raw.match(/\[\[TASK_PROPOSALS\]\]([\s\S]*?)\[\[\/TASK_PROPOSALS\]\]/i);
  if (!match) {
    return { hasBlock: false, cleanBody: raw, proposals: [], diagnostics: { parseError: null, rawBlockExcerpt: null } };
  }
  const cleanBody = raw.replace(match[0], '').trim();
  const content = String(match[1] || '').trim();
  if (!content) {
    return { hasBlock: true, cleanBody, proposals: [], diagnostics: { parseError: null, rawBlockExcerpt: null } };
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    const arrayPayload = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(asRecord(parsed)?.proposals) ? (asRecord(parsed)!.proposals as unknown[]) : []);
    const proposals = arrayPayload
      .map(normalizeProposalCandidate)
      .filter((item): item is NonNullable<typeof item> => Boolean(item));
    return {
      hasBlock: true,
      cleanBody,
      proposals,
      diagnostics: {
        parseError: null,
        rawBlockExcerpt: content.replace(/\s+/g, ' ').trim().slice(0, 240),
      },
    };
  } catch (error) {
    return {
      hasBlock: true,
      cleanBody,
      proposals: [],
      diagnostics: {
        parseError: error instanceof Error ? error.message : String(error || 'unknown parse error'),
        rawBlockExcerpt: content.replace(/\s+/g, ' ').trim().slice(0, 240),
      },
    };
  }
}
