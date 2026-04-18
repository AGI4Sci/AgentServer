import type { EndpointNetworkMode, EndpointRiskClass, ProposalFactKind, ProposalFactPayload, TaskEndpointHint, ToolBinding } from './blackboard-types.js';
import type { BlockedBy, CompletionEvidenceRequirements } from './blackboard-types.js';

export interface CoordinatorDecision {
  proposalId: string;
  decision: 'approve' | 'reject' | 'amend';
  note?: string;
  amendedPayload?: ProposalFactPayload;
}

export interface CoordinatorProposal {
  proposalId?: string;
  taskId?: string;
  kind: ProposalFactKind;
  goal: string;
  requiredCapability: string;
  suggestedAssignee?: string | null;
  requires?: string[];
  supersedesTaskId?: string;
  reason: string;
  acceptanceCriteria?: string[];
  evidenceRequirements?: CompletionEvidenceRequirements;
  workspaceId?: string;
  cwd?: string;
  allowedRoots?: string[];
  artifactsRoot?: string;
  allowedTools?: string[];
  endpointHints?: TaskEndpointHint[];
  toolBindings?: ToolBinding[];
  networkMode?: EndpointNetworkMode;
  riskClass?: EndpointRiskClass;
}

export interface CoordinatorOutput {
  proposals?: CoordinatorProposal[];
  decisions?: CoordinatorDecision[];
  summary?: string;
  userReply?: string;
}

export interface CoordinatorOutputDiagnostics {
  hasBlock: boolean;
  parseError: string | null;
  rawBlockExcerpt: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasActionablePlan(output: CoordinatorOutput): boolean {
  return Boolean(
    output.proposals?.length
    || output.decisions?.length
  );
}

function normalizeProposalShape(output: CoordinatorOutput): CoordinatorOutput {
  const next = { ...output };
  if (!Array.isArray(output.proposals) || output.proposals.length === 0) {
    return next;
  }
  next.proposals = output.proposals
    .map((proposal, index) => {
      const raw = proposal as unknown as Record<string, unknown>;
      const kind = String(raw.kind || '').trim() as ProposalFactKind;
      if (!['split', 'handoff', 'retry', 'need_review', 'need_qa', 'need_user_input', 'blocked_replan'].includes(kind)) {
        return null;
      }
      const goal = String(raw.goal || '').trim();
      const requiredCapability = String(raw.requiredCapability || '').trim();
      const reason = String(raw.reason || '').trim();
      if (!goal || !requiredCapability || !reason) {
        return null;
      }
      return {
        proposalId: typeof raw.proposalId === 'string' ? raw.proposalId.trim() : undefined,
        taskId: typeof raw.taskId === 'string' ? raw.taskId.trim() : undefined,
        kind,
        goal,
        requiredCapability,
        suggestedAssignee: raw.suggestedAssignee == null ? undefined : String(raw.suggestedAssignee || '').trim() || null,
        requires: Array.isArray(raw.requires)
          ? raw.requires.map((item) => String(item || '').trim()).filter(Boolean)
          : undefined,
        supersedesTaskId: typeof raw.supersedesTaskId === 'string' ? raw.supersedesTaskId.trim() : undefined,
        reason,
        acceptanceCriteria: Array.isArray(raw.acceptanceCriteria)
          ? raw.acceptanceCriteria.map((item) => String(item || '').trim()).filter(Boolean)
          : undefined,
        evidenceRequirements: raw.evidenceRequirements && typeof raw.evidenceRequirements === 'object'
          ? raw.evidenceRequirements as CompletionEvidenceRequirements
          : undefined,
        workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId.trim() : undefined,
        cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : undefined,
        allowedRoots: Array.isArray(raw.allowedRoots)
          ? raw.allowedRoots.map((item) => String(item || '').trim()).filter(Boolean)
          : undefined,
        artifactsRoot: typeof raw.artifactsRoot === 'string' ? raw.artifactsRoot.trim() : undefined,
        allowedTools: Array.isArray(raw.allowedTools)
          ? raw.allowedTools.map((item) => String(item || '').trim()).filter(Boolean)
          : undefined,
        endpointHints: Array.isArray(raw.endpointHints)
          ? raw.endpointHints.filter((item) => item && typeof item === 'object') as TaskEndpointHint[]
          : undefined,
        toolBindings: Array.isArray(raw.toolBindings)
          ? raw.toolBindings.filter((item) => item && typeof item === 'object') as ToolBinding[]
          : undefined,
        networkMode: typeof raw.networkMode === 'string' ? raw.networkMode.trim() as EndpointNetworkMode : undefined,
        riskClass: typeof raw.riskClass === 'string' ? raw.riskClass.trim() as EndpointRiskClass : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return next;
}

function normalizeMissingContextText(value: string | null | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unwrapJsonCodeFence(value: string): string {
  const normalized = String(value || '').trim();
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() || normalized;
}

function extractFirstJsonCodeFence(value: string): string | null {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return null;
  }
  const fenced = normalized.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return fenced?.[1]?.trim() || null;
}

function extractFirstBalancedJsonObject(value: string): string | null {
  const normalized = String(value || '');
  const start = normalized.indexOf('{');
  if (start === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < normalized.length; index += 1) {
    const ch = normalized[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return normalized.slice(start, index + 1).trim();
      }
    }
  }

  return null;
}

function looksLikeMissingContextPrompt(text: string): boolean {
  const normalized = normalizeMissingContextText(text).toLowerCase();
  if (!normalized) {
    return false;
  }
  const cues = [
    '请补充',
    '请提供',
    '需要更多信息',
    '需要更多上下文',
    '缺少',
    '无法继续',
    '请先确认',
    '还需要',
    '需要你确认',
    'need more information',
    'need more context',
    'missing information',
    'missing context',
    'please provide',
    'please clarify',
    'before i continue',
    'cannot continue',
  ];
  if (cues.some((cue) => normalized.includes(cue))) {
    return true;
  }
  return /[?？]\s*$/.test(normalized);
}

function normalizeDecisionShape(output: CoordinatorOutput): CoordinatorOutput {
  const next = { ...output };
  if (!Array.isArray(output.decisions) || output.decisions.length === 0) {
    return next;
  }
  next.decisions = output.decisions
    .map((decision) => {
      const raw = decision as unknown as Record<string, unknown>;
      const proposalId = String(raw.proposalId || '').trim();
      const decisionValue = String(raw.decision || '').trim().toLowerCase();
      if (!proposalId || !['approve', 'reject', 'amend'].includes(decisionValue)) {
        return null;
      }
      const amendedPayloadRaw = asRecord(raw.amendedPayload);
      const amendedPayload = amendedPayloadRaw
        ? {
            goal: String(amendedPayloadRaw.goal || '').trim(),
            requiredCapability: String(amendedPayloadRaw.requiredCapability || '').trim(),
            suggestedAssignee: amendedPayloadRaw.suggestedAssignee == null ? undefined : String(amendedPayloadRaw.suggestedAssignee || '').trim() || null,
            requires: Array.isArray(amendedPayloadRaw.requires)
              ? amendedPayloadRaw.requires.map((item) => String(item || '').trim()).filter(Boolean)
              : undefined,
            supersedesTaskId: typeof amendedPayloadRaw.supersedesTaskId === 'string' ? amendedPayloadRaw.supersedesTaskId.trim() : undefined,
            reason: String(amendedPayloadRaw.reason || '').trim(),
          }
        : undefined;
      return {
        proposalId,
        decision: decisionValue as CoordinatorDecision['decision'],
        note: typeof raw.note === 'string' ? raw.note.trim() : undefined,
        amendedPayload: amendedPayload && amendedPayload.goal && amendedPayload.requiredCapability && amendedPayload.reason
          ? amendedPayload
          : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return next;
}

function normalizeMissingContextShape(output: CoordinatorOutput): CoordinatorOutput {
  const next = { ...output };
  const raw = output as unknown as Record<string, unknown>;
  const legacyQuestion = typeof raw.question === 'string'
    ? raw.question
    : (typeof raw.prompt === 'string' ? raw.prompt : null);
  const legacyMissingFacts = Array.isArray(raw.missingFacts)
    ? raw.missingFacts.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const textCandidates = [
    legacyQuestion,
    typeof next.userReply === 'string' ? next.userReply : null,
    typeof next.summary === 'string' ? next.summary : null,
  ]
    .map((item) => normalizeMissingContextText(item))
    .filter(Boolean);

  if (hasActionablePlan(next)) {
    return next;
  }

  const inferredReason = textCandidates.find(looksLikeMissingContextPrompt) || null;
  if (!inferredReason && legacyMissingFacts.length === 0) {
    return next;
  }

  const reason = inferredReason || `缺失信息: ${legacyMissingFacts.join(' / ')}`;
  next.proposals = [
    ...(next.proposals || []),
    {
      proposalId: 'proposal-missing-context',
      taskId: 'waiting-user:missing-context',
      kind: 'need_user_input',
      goal: reason,
      requiredCapability: 'user-input',
      reason,
    },
  ];
  return next;
}

function normalizeCoordinatorOutput(
  output: CoordinatorOutput,
  options?: { allowMissingContextInference?: boolean },
): CoordinatorOutput {
  const decisionNormalized = normalizeDecisionShape(output);
  const missingContextNormalized = options?.allowMissingContextInference === false
    ? decisionNormalized
    : normalizeMissingContextShape(decisionNormalized);
  return normalizeProposalShape(missingContextNormalized);
}

export function isValidRetrievalQuery(query: string | null | undefined): boolean {
  const normalized = String(query || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }
  if (normalized.length > 400) {
    return false;
  }
  return !/\[\[[A-Z_]+/.test(normalized);
}

function looksLikeMissingInfoPrompt(raw: string): boolean {
  const normalized = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }
  return /请提供|需要确认|缺少|任务内容|验收标准|涉及文件|详细描述|无法分解|无法继续|补充/.test(normalized);
}

function buildFallbackUserInputProposal(raw: string): CoordinatorOutput | null {
  const normalized = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!looksLikeMissingInfoPrompt(normalized)) {
    return null;
  }
  return {
    proposals: [{
      proposalId: 'proposal-missing-context',
      taskId: 'waiting-user:missing-context',
      kind: 'need_user_input',
      goal: normalized.slice(0, 800),
      requiredCapability: 'user-input',
      reason: normalized.slice(0, 800),
    }],
    summary: normalized.slice(0, 800),
  };
}

export function extractCoordinatorOutput(body: string): {
  output: CoordinatorOutput | null;
  cleanBody: string;
  diagnostics: CoordinatorOutputDiagnostics;
} {
  const raw = String(body || '').trim();
  if (!raw) {
    return {
      output: null,
      cleanBody: '',
      diagnostics: {
        hasBlock: false,
        parseError: null,
        rawBlockExcerpt: null,
      },
    };
  }

  const tagged = raw.match(/\[\[COORDINATOR_OUTPUT\]\]([\s\S]*?)\[\[\/COORDINATOR_OUTPUT\]\]/i);
  const taggedBody = tagged?.[1]?.trim() || null;
  let firstParseError: string | null = null;
  const rawBlockExcerpt = (taggedBody || raw).replace(/\s+/g, ' ').trim().slice(0, 240) || null;
  const parseCandidates = [
    { value: taggedBody ? unwrapJsonCodeFence(taggedBody) : null, allowMissingContextInference: false },
    { value: taggedBody ? extractFirstJsonCodeFence(taggedBody) : null, allowMissingContextInference: false },
    { value: taggedBody ? extractFirstBalancedJsonObject(taggedBody) : null, allowMissingContextInference: false },
    { value: unwrapJsonCodeFence(raw), allowMissingContextInference: true },
    { value: extractFirstJsonCodeFence(raw), allowMissingContextInference: true },
    { value: extractFirstBalancedJsonObject(raw), allowMissingContextInference: true },
  ]
    .map((item) => ({ ...item, value: String(item.value || '').trim() }))
    .filter((item) => Boolean(item.value));

  const seen = new Set<string>();
  for (const candidate of parseCandidates) {
    const candidateValue = candidate.value;
    if (seen.has(candidateValue)) {
      continue;
    }
    seen.add(candidateValue);
    try {
      const output = normalizeCoordinatorOutput(JSON.parse(candidateValue) as CoordinatorOutput, {
        allowMissingContextInference: candidate.allowMissingContextInference,
      });
      return {
        output,
        cleanBody: tagged ? raw.replace(tagged[0], '').trim() : raw,
        diagnostics: {
          hasBlock: Boolean(tagged),
          parseError: null,
          rawBlockExcerpt,
        },
      };
    } catch (error) {
      firstParseError ||= error instanceof Error ? error.message : String(error || 'unknown parse error');
      continue;
    }
  }

  if (!tagged) {
    const fallback = buildFallbackUserInputProposal(raw);
    if (fallback) {
      return {
        output: fallback,
        cleanBody: raw,
        diagnostics: {
          hasBlock: false,
          parseError: firstParseError,
          rawBlockExcerpt,
        },
      };
    }
  }

  return {
    output: null,
    cleanBody: raw,
    diagnostics: {
      hasBlock: Boolean(tagged),
      parseError: firstParseError || (tagged ? 'COORDINATOR_OUTPUT block did not contain parseable JSON' : null),
      rawBlockExcerpt,
    },
  };
}

export function formatCoordinatorOutputForDisplay(
  output: CoordinatorOutput,
  options?: { blockedReason?: string | null },
): string {
  const lines: string[] = [];

  if (output.userReply?.trim()) {
    lines.push(output.userReply.trim());
  } else if (output.summary?.trim()) {
    lines.push(output.summary.trim());
  }

  if (output.proposals?.length) {
    lines.push(`已提出 ${output.proposals.length} 条 coordinator proposal。`);
  }
  if (output.decisions?.length) {
    lines.push(`已给出 ${output.decisions.length} 条 proposal 决策。`);
  }
  if (options?.blockedReason?.trim()) {
    lines.push(`协调输出被拦截：${options.blockedReason.trim()}`);
  }

  return lines.filter(Boolean).join('\n');
}
