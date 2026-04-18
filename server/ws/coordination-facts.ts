import type { SessionContext } from '../../core/runtime/types.js';
import type { ConversationFactsRecord, ConversationFactsStore } from '../../core/store/conversation-facts-store.js';

export interface CoordinationFacts extends Omit<ConversationFactsRecord, 'updatedAt' | 'source'> {
  updatedAt: number;
}

const PATH_REGEX = /(\/[A-Za-z0-9._~\-\/]+)/g;
const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)[^\s`"'，。；;）)\]]*/gi;

function parsePort(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function extractCoordinationFacts(body: string): Partial<CoordinationFacts> {
  const paths = Array.from(String(body || '').matchAll(PATH_REGEX)).map((match) => match[1]);
  const urls = Array.from(String(body || '').matchAll(URL_REGEX));
  return {
    controlProjectPath: paths.find((item) => /openteam-studio-run/.test(item)),
    targetProjectPath: paths.find((item) => !/openteam-studio-run/.test(item)),
    controlPort: urls[0] ? parsePort(urls[0][1]) : undefined,
    targetPort: urls[1] ? parsePort(urls[1][1]) : urls[0] ? parsePort(urls[0][1]) : undefined,
    controlUrl: urls[0]?.[0],
    targetUrl: urls[1]?.[0] || urls[0]?.[0],
    updatedAt: Date.now(),
  };
}

export function buildSessionContextEnv(
  existing: SessionContext | null,
  facts: Partial<CoordinationFacts>,
  teamId: string,
): Record<string, string | null> {
  const env: Record<string, string | null> = {
    'team.active': teamId,
    'cwd.control': facts.controlProjectPath || existing?.env['cwd.control'] || null,
    'cwd.target': facts.targetProjectPath || existing?.env['cwd.target'] || null,
    'url.control': facts.controlUrl || existing?.env['url.control'] || null,
    'url.target': facts.targetUrl || existing?.env['url.target'] || null,
    'port.control': facts.controlPort != null ? String(facts.controlPort) : (existing?.env['port.control'] || null),
    'port.target': facts.targetPort != null ? String(facts.targetPort) : (existing?.env['port.target'] || null),
    'exec.cwd': facts.targetProjectPath || facts.controlProjectPath || existing?.env['exec.cwd'] || process.cwd(),
  };
  env['exec.url'] = env['url.target'] || env['url.control'];
  env['exec.port'] = env['port.target'] || env['port.control'];
  return env;
}

export function buildSessionContextBlock(sessionContext: SessionContext): string {
  const lines = [
    '[[SESSION_CONTEXT]]',
    `requestId: ${sessionContext.requestId}`,
    `revision: ${sessionContext.revision}`,
  ];
  const workspaceId = sessionContext.env['workspace.id'];
  const workspaceCwd = sessionContext.env['workspace.cwd'] || sessionContext.env['exec.cwd'];
  if (workspaceId || workspaceCwd) {
    lines.push('[[CURRENT_PROJECT_WORKSPACE]]');
    lines.push(`workspaceId: ${workspaceId || 'local'}`);
    lines.push(`transport: ${sessionContext.env['workspace.transport'] || 'local'}`);
    lines.push(`cwd: ${workspaceCwd || process.cwd()}`);
    lines.push(`allowedRoots: ${sessionContext.env['workspace.allowedRoots'] || workspaceCwd || process.cwd()}`);
    lines.push(`artifactsRoot: ${sessionContext.env['workspace.artifactsRoot'] || ''}`);
    lines.push(`networkMode: ${sessionContext.env['workspace.networkMode'] || ''}`);
    lines.push(`defaultExecutionTarget: ${sessionContext.env['workspace.defaultExecutionTarget'] || 'local'}`);
    lines.push(`remoteSessionId: ${sessionContext.env['workspace.remoteSessionId'] || ''}`);
    lines.push('rule: shell/files/git/gpu/ports/logs/build/test default to this workspace unless the user explicitly switches workspace.');
    lines.push('rule: when defaultExecutionTarget=remote, do not run machine-state commands on local process.cwd(); use the bound remote workspace/tool endpoint.');
    lines.push('[[/CURRENT_PROJECT_WORKSPACE]]');
  }
  for (const [envKey, envValue] of Object.entries(sessionContext.env)) {
    lines.push(`${envKey}: ${envValue}`);
  }
  lines.push('[[/SESSION_CONTEXT]]');
  return lines.join('\n');
}

export function getCoordinationFacts(
  conversationFactsStore: ConversationFactsStore,
  coordinationFactsByRequest: Map<string, CoordinationFacts>,
  teamId: string,
  requestKey: string,
  sessionId?: string | null,
): CoordinationFacts | null {
  const byRequest = coordinationFactsByRequest.get(requestKey);
  if (byRequest) return byRequest;
  const persisted = sessionId
    ? conversationFactsStore.getCurrentForSession(teamId, sessionId)
    : conversationFactsStore.getCurrent(teamId, sessionId);
  if (!persisted) return null;
  return {
    ...persisted,
    updatedAt: Date.parse(persisted.updatedAt) || Date.now(),
  };
}
