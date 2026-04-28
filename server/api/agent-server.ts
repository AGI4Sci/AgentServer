import type { IncomingMessage, ServerResponse } from 'http';
import { sendJson, success, error } from '../utils/response.js';
import type {
  AgentClarificationRecord,
  AgentAutonomyRequest,
  AgentGoalRequest,
  AgentMessageRequest,
  AgentRetrievalRequest,
  AgentTurnLogQuery,
  AgentCurrentWorkRequest,
  ClearMemoryRequest,
  CompactAgentRequest,
  CreateAgentRequest,
  CreateSessionRequest,
  FinalizeSessionRequest,
  ResolveClarificationRequest,
  ResetPersistentRequest,
  AgentWorkspaceSearchRequest,
  AcknowledgeRecoveryRequest,
  ApplyPersistentBudgetRequest,
  AgentServerRunRequest,
  AgentServerRunResult,
  AgentRunRecord,
  AppendMemoryConstraintsRequest,
  AppendMemorySummaryRequest,
  AppendPersistentConstraintsRequest,
  AppendPersistentSummaryRequest,
  AutonomousAgentRunRequest,
  CreateAgentEvolutionProposalRequest,
  ReplaceCurrentWorkRequest,
  ReviveAgentRequest,
  EnsureAutonomousAgentRequest,
  UpdateAgentEvolutionProposalStatusRequest,
} from '../agent_server/types.js';
import { getAgentServerClient } from '../agent_server/client.js';
import { getAgentServerLoopManager } from '../agent_server/runtime.js';
import type { SessionStreamEvent } from '../runtime/session-types.js';

const service = getAgentServerClient();
const loopManager = getAgentServerLoopManager();

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function notFound(res: ServerResponse, detail: string): void {
  sendJson(res, 404, error(detail));
}

function writeStreamEnvelope(res: ServerResponse, payload: unknown): void {
  res.write(`${JSON.stringify(payload)}\n`);
}

function sendStreamError(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const event: SessionStreamEvent = {
    type: 'error',
    error: message,
  };
  writeStreamEnvelope(res, { event });
  writeStreamEnvelope(res, { error: message });
}

const HTTP_TEXT_LIMIT = 8_000;
const HTTP_EVENTS_LIMIT = 200;

function clipText(value: unknown, limit = HTTP_TEXT_LIMIT): unknown {
  if (typeof value !== 'string' || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 120))}\n...[truncated ${value.length - limit} chars for AgentServer HTTP response; full value remains in run store]`;
}

function compactRecordForHttp<T>(value: T): T {
  if (typeof value === 'string') return clipText(value) as T;
  if (Array.isArray(value)) return value.slice(-HTTP_EVENTS_LIMIT).map((item) => compactRecordForHttp(item)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'context' || key === 'assembledContext') {
      out[key] = clipText(item, 2_000);
    } else if (key === 'events' && Array.isArray(item)) {
      out[key] = item.slice(-HTTP_EVENTS_LIMIT).map((entry) => compactRecordForHttp(entry));
      if (item.length > HTTP_EVENTS_LIMIT) out.eventCount = item.length;
    } else if (key === 'input' && item && typeof item === 'object' && 'canonicalContext' in item) {
      const input = item as Record<string, unknown>;
      out[key] = {
        ...input,
        canonicalContext: '[omitted from AgentServer HTTP response; full value remains in run store]',
        metadata: compactRecordForHttp(input.metadata),
      };
    } else if (key === 'canonicalContext') {
      out[key] = '[omitted from AgentServer HTTP response; full value remains in run store]';
    } else {
      out[key] = compactRecordForHttp(item);
    }
  }
  return out as T;
}

export function compactAgentServerRunResultForHttp(result: AgentServerRunResult): AgentServerRunResult {
  return {
    ...result,
    agent: compactRecordForHttp(result.agent),
    run: compactRecordForHttp(result.run) as AgentRunRecord,
    recoveryActions: compactRecordForHttp(result.recoveryActions),
    metadata: compactRecordForHttp(result.metadata),
  };
}

export async function handleAgentServerRoutes(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  const parsedUrl = new URL(url, 'http://127.0.0.1');

  try {
    if (pathname === '/api/agent-server/runs' && method === 'POST') {
      const body = await readJsonBody<AgentServerRunRequest>(req);
      const result = await service.runTask(body);
      if (result.agent.autonomy.enabled && result.agent.status === 'active') {
        loopManager.ensureLoop(result.agent.id, 250);
      }
      sendJson(res, 200, success(compactAgentServerRunResultForHttp(result)));
      return true;
    }

    if (pathname === '/api/agent-server/runs/stream' && method === 'POST') {
      const body = await readJsonBody<AgentServerRunRequest>(req);
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      try {
        const result = await service.runTask(body, {
          onEvent(event) {
            writeStreamEnvelope(res, { event });
          },
        });
        if (result.agent.autonomy.enabled && result.agent.status === 'active') {
          loopManager.ensureLoop(result.agent.id, 250);
        }
        writeStreamEnvelope(res, { result: compactAgentServerRunResultForHttp(result) });
      } catch (err) {
        sendStreamError(res, err);
      } finally {
        res.end();
      }
      return true;
    }

    const runMatch = pathname.match(/^\/api\/agent-server\/runs\/([^/]+)$/);
    if (runMatch && method === 'GET') {
      sendJson(res, 200, success(await service.getRun(runMatch[1])));
      return true;
    }

    if (pathname === '/api/agent-server/evolution/proposals' && method === 'GET') {
      sendJson(res, 200, success(await service.listEvolutionProposals()));
      return true;
    }

    if (pathname === '/api/agent-server/evolution/proposals' && method === 'POST') {
      const body = await readJsonBody<CreateAgentEvolutionProposalRequest>(req);
      sendJson(res, 200, success(await service.createEvolutionProposal(body)));
      return true;
    }

    const proposalMatch = pathname.match(/^\/api\/agent-server\/evolution\/proposals\/([^/]+)$/);
    if (proposalMatch && method === 'GET') {
      sendJson(res, 200, success(await service.getEvolutionProposal(proposalMatch[1])));
      return true;
    }

    const proposalTransitionMatch = pathname.match(/^\/api\/agent-server\/evolution\/proposals\/([^/]+)\/(approve|reject|apply|rollback)$/);
    if (proposalTransitionMatch && method === 'POST') {
      const body = await readJsonBody<UpdateAgentEvolutionProposalStatusRequest>(req);
      const [, proposalId, action] = proposalTransitionMatch;
      const proposal = action === 'approve'
        ? await service.approveEvolutionProposal(proposalId, body)
        : action === 'reject'
          ? await service.rejectEvolutionProposal(proposalId, body)
          : action === 'apply'
            ? await service.applyEvolutionProposal(proposalId, body)
            : await service.rollbackEvolutionProposal(proposalId, body);
      sendJson(res, 200, success(proposal));
      return true;
    }

    if (pathname === '/api/agent-server/autonomous/ensure' && method === 'POST') {
      const body = await readJsonBody<EnsureAutonomousAgentRequest>(req);
      const agent = await service.ensureAutonomousAgent(body);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      }
      sendJson(res, 200, success(agent));
      return true;
    }

    if (pathname === '/api/agent-server/autonomous/run' && method === 'POST') {
      const body = await readJsonBody<AutonomousAgentRunRequest>(req);
      const result = await service.runAutonomousTask(body);
      if (result.agent.autonomy.enabled && result.agent.status === 'active') {
        loopManager.ensureLoop(result.agent.id, 250);
      }
      sendJson(res, 200, success(result));
      return true;
    }

    if (pathname === '/api/agent-server/agents' && method === 'GET') {
      sendJson(res, 200, success(await service.listAgents()));
      return true;
    }

    if (pathname === '/api/agent-server/agents' && method === 'POST') {
      const body = await readJsonBody<CreateAgentRequest>(req);
      const agent = await service.createAgent(body);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      }
      sendJson(res, 200, success(agent));
      return true;
    }

    const agentMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)$/);
    if (agentMatch && method === 'GET') {
      sendJson(res, 200, success(await service.getAgent(agentMatch[1])));
      return true;
    }

    const runsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/runs$/);
    if (runsMatch && method === 'GET') {
      sendJson(res, 200, success(await service.listRuns(runsMatch[1])));
      return true;
    }

    const currentWorkMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/work\/current$/);
    if (currentWorkMatch && method === 'GET') {
      const query: AgentCurrentWorkRequest = {
        sessionId: parsedUrl.searchParams.get('sessionId') || undefined,
      };
      sendJson(res, 200, success(await service.getCurrentWork(currentWorkMatch[1], query)));
      return true;
    }

    if (currentWorkMatch && method === 'POST') {
      const body = await readJsonBody<ReplaceCurrentWorkRequest>(req);
      sendJson(res, 200, success(await service.replaceCurrentWork(currentWorkMatch[1], body)));
      return true;
    }

    const turnsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/turns$/);
    if (turnsMatch && method === 'GET') {
      const query: AgentTurnLogQuery = {
        sessionId: parsedUrl.searchParams.get('sessionId') || undefined,
        startTurn: parsedUrl.searchParams.get('startTurn')
          ? Number(parsedUrl.searchParams.get('startTurn'))
          : undefined,
        endTurn: parsedUrl.searchParams.get('endTurn')
          ? Number(parsedUrl.searchParams.get('endTurn'))
          : undefined,
        limit: parsedUrl.searchParams.get('limit')
          ? Number(parsedUrl.searchParams.get('limit'))
          : undefined,
      };
      sendJson(res, 200, success(await service.getTurns(turnsMatch[1], query)));
      return true;
    }

    const contextMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/context$/);
    if (contextMatch && method === 'GET') {
      sendJson(res, 200, success(await service.getContextSnapshot(contextMatch[1])));
      return true;
    }

    const recoveryMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/recovery$/);
    if (recoveryMatch && method === 'GET') {
      sendJson(res, 200, success(await service.getRecoverySnapshot(recoveryMatch[1])));
      return true;
    }

    const acknowledgeRecoveryMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/recovery\/acknowledge$/);
    if (acknowledgeRecoveryMatch && method === 'POST') {
      const body = await readJsonBody<AcknowledgeRecoveryRequest>(req);
      const snapshot = await service.acknowledgeRecovery(acknowledgeRecoveryMatch[1], body);
      const agent = await service.getAgent(acknowledgeRecoveryMatch[1]);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      }
      sendJson(res, 200, success(snapshot));
      return true;
    }

    const workspaceSearchMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/workspace-search$/);
    if (workspaceSearchMatch && method === 'POST') {
      const body = await readJsonBody<AgentWorkspaceSearchRequest>(req);
      sendJson(res, 200, success(await service.searchWorkspace(workspaceSearchMatch[1], body)));
      return true;
    }

    const sessionsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/sessions$/);
    if (sessionsMatch && method === 'POST') {
      const body = await readJsonBody<CreateSessionRequest>(req);
      sendJson(res, 200, success(await service.startNewSession(sessionsMatch[1], body)));
      return true;
    }

    const finalizeSessionMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/sessions\/finalize$/);
    if (finalizeSessionMatch && method === 'POST') {
      const body = await readJsonBody<FinalizeSessionRequest>(req);
      sendJson(res, 200, success(await service.finalizeSession(finalizeSessionMatch[1], body)));
      return true;
    }

    const finalizeSessionPreviewMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/sessions\/finalize\/preview$/);
    if (finalizeSessionPreviewMatch && method === 'POST') {
      const body = await readJsonBody<FinalizeSessionRequest>(req);
      sendJson(res, 200, success(await service.previewFinalizeSession(finalizeSessionPreviewMatch[1], body)));
      return true;
    }

    const messagesMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'POST') {
      const body = await readJsonBody<AgentMessageRequest>(req);
      sendJson(res, 200, success(await service.sendMessage(messagesMatch[1], body)));
      return true;
    }

    const clarificationsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/clarifications$/);
    if (clarificationsMatch && method === 'GET') {
      sendJson(res, 200, success(await service.listClarifications(clarificationsMatch[1])));
      return true;
    }

    const resolveClarificationMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/clarifications\/resolve$/);
    if (resolveClarificationMatch && method === 'POST') {
      const body = await readJsonBody<ResolveClarificationRequest>(req);
      const clarification = await service.resolveClarification(resolveClarificationMatch[1], body);
      const agent = await service.getAgent(resolveClarificationMatch[1]);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      }
      sendJson(res, 200, success(clarification));
      return true;
    }

    const retrieveMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/retrieve$/);
    if (retrieveMatch && method === 'POST') {
      const body = await readJsonBody<AgentRetrievalRequest>(req);
      sendJson(res, 200, success(await service.retrieveContext(retrieveMatch[1], body)));
      return true;
    }

    const goalsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/goals$/);
    if (goalsMatch && method === 'POST') {
      const body = await readJsonBody<AgentGoalRequest>(req);
      sendJson(res, 200, success(await service.enqueueGoal(goalsMatch[1], body)));
      return true;
    }

    const autonomyMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/autonomy$/);
    if (autonomyMatch && method === 'POST') {
      const body = await readJsonBody<AgentAutonomyRequest>(req);
      const agent = await service.updateAutonomy(autonomyMatch[1], body);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      } else {
        loopManager.stopLoop(agent.id);
      }
      sendJson(res, 200, success(agent));
      return true;
    }

    const compactMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/compact$/);
    if (compactMatch && method === 'POST') {
      const body = await readJsonBody<CompactAgentRequest>(req);
      sendJson(res, 200, success(await service.compactAgent(compactMatch[1], body)));
      return true;
    }

    const compactPreviewMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/compact\/preview$/);
    if (compactPreviewMatch && method === 'POST') {
      const body = await readJsonBody<CompactAgentRequest>(req);
      sendJson(res, 200, success(await service.previewCompaction(compactPreviewMatch[1], body)));
      return true;
    }

    const clearMemoryMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/memory\/clear$/);
    if (clearMemoryMatch && method === 'POST') {
      const body = await readJsonBody<ClearMemoryRequest>(req);
      sendJson(res, 200, success(await service.clearMemory(clearMemoryMatch[1], body)));
      return true;
    }

    const resetPersistentMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/persistent\/reset$/);
    if (resetPersistentMatch && method === 'POST') {
      const body = await readJsonBody<ResetPersistentRequest>(req);
      sendJson(res, 200, success(await service.resetPersistent(resetPersistentMatch[1], body)));
      return true;
    }

    const memorySummaryMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/memory\/summary$/);
    if (memorySummaryMatch && method === 'POST') {
      const body = await readJsonBody<AppendMemorySummaryRequest>(req);
      sendJson(res, 200, success(await service.appendMemorySummary(memorySummaryMatch[1], body)));
      return true;
    }

    const memoryConstraintsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/memory\/constraints$/);
    if (memoryConstraintsMatch && method === 'POST') {
      const body = await readJsonBody<AppendMemoryConstraintsRequest>(req);
      sendJson(res, 200, success(await service.appendMemoryConstraints(memoryConstraintsMatch[1], body)));
      return true;
    }

    const persistentSummaryMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/persistent\/summary$/);
    if (persistentSummaryMatch && method === 'POST') {
      const body = await readJsonBody<AppendPersistentSummaryRequest>(req);
      sendJson(res, 200, success(await service.appendPersistentSummary(persistentSummaryMatch[1], body)));
      return true;
    }

    const persistentConstraintsMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/persistent\/constraints$/);
    if (persistentConstraintsMatch && method === 'POST') {
      const body = await readJsonBody<AppendPersistentConstraintsRequest>(req);
      sendJson(res, 200, success(await service.appendPersistentConstraints(persistentConstraintsMatch[1], body)));
      return true;
    }

    const persistentRecoveryPreviewMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/persistent\/recovery\/preview$/);
    if (persistentRecoveryPreviewMatch && method === 'GET') {
      sendJson(res, 200, success(await service.previewPersistentBudgetRecovery(persistentRecoveryPreviewMatch[1])));
      return true;
    }

    const persistentRecoveryApplyMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/persistent\/recovery\/apply$/);
    if (persistentRecoveryApplyMatch && method === 'POST') {
      const body = await readJsonBody<ApplyPersistentBudgetRequest>(req);
      sendJson(res, 200, success(await service.applyPersistentBudgetRecovery(persistentRecoveryApplyMatch[1], body)));
      return true;
    }

    const reviveMatch = pathname.match(/^\/api\/agent-server\/agents\/([^/]+)\/revive$/);
    if (reviveMatch && method === 'POST') {
      const body = await readJsonBody<ReviveAgentRequest>(req);
      const agent = await service.reviveAgent(reviveMatch[1], body);
      if (agent.autonomy.enabled && agent.status === 'active') {
        loopManager.ensureLoop(agent.id, 250);
      }
      sendJson(res, 200, success(agent));
      return true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lowered = message.toLowerCase();
    if (lowered.includes('not found')) {
      notFound(res, message);
      return true;
    }
    sendJson(res, 500, error(message));
    return true;
  }

  return false;
}
