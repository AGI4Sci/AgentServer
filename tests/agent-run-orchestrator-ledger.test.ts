import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentServerService } from '../server/agent_server/service.ts';
import {
  buildRuleBasedOrchestratorLedger,
  buildStageDependencyGraph,
  buildStageHandoffPacket,
  executeMultiStagePlan,
  resolveStageFailureAction,
  selectRuleBasedStagePlanKind,
} from '../server/agent_server/orchestrator.ts';
import type { AgentRunStageRecord } from '../server/agent_server/types.ts';

test('rule-based orchestrator builds single and multi-stage plans', () => {
  assert.equal(selectRuleBasedStagePlanKind('please implement this change'), 'implement-only');
  assert.equal(selectRuleBasedStagePlanKind('please review this change'), 'implement-review');
  assert.equal(selectRuleBasedStagePlanKind('diagnose and fix this flaky test'), 'diagnose-implement-verify');

  const reviewLedger = buildRuleBasedOrchestratorLedger({
    runId: 'run-review',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please review this change',
    createdAt: '2026-04-19T00:00:00.000Z',
  });

  assert.equal(reviewLedger.mode, 'multi_stage');
  assert.deepEqual(reviewLedger.stageOrder, [
    'run-review-stage-implement-1',
    'run-review-stage-review-2',
  ]);
  assert.equal(reviewLedger.plan[0]?.backend, 'claude-code');
  assert.equal(reviewLedger.plan[1]?.backend, 'codex');
  assert.deepEqual(reviewLedger.plan[1]?.dependsOn, ['run-review-stage-implement-1']);
});

test('stage dependency graph groups independent read stages and splits same-workspace serial writes', () => {
  const graph = buildStageDependencyGraph([
    {
      stageId: 'review-a',
      type: 'review',
      backend: 'codex',
      dependsOn: [],
      reason: 'independent review',
      ownership: {
        workspaceId: '/tmp/workspace',
        writeMode: 'none',
      },
    },
    {
      stageId: 'review-b',
      type: 'review',
      backend: 'gemini',
      dependsOn: [],
      reason: 'independent review',
      ownership: {
        workspaceId: '/tmp/workspace',
        writeMode: 'none',
      },
    },
    {
      stageId: 'write-a',
      type: 'implement',
      backend: 'claude-code',
      dependsOn: [],
      reason: 'serial write',
      ownership: {
        workspaceId: '/tmp/workspace',
        writeMode: 'serial',
      },
    },
    {
      stageId: 'write-b',
      type: 'implement',
      backend: 'self-hosted-agent',
      dependsOn: [],
      reason: 'serial write',
      ownership: {
        workspaceId: '/tmp/workspace',
        writeMode: 'serial',
      },
    },
  ]);

  assert.deepEqual(graph.blockedStageIds, []);
  assert.deepEqual(graph.waves.map((wave) => wave.stageIds), [
    ['review-a', 'review-b', 'write-a'],
    ['write-b'],
  ]);
  assert.equal(graph.waves[0]?.canRunInParallel, true);
  assert.equal(graph.waves[1]?.canRunInParallel, false);
});

test('stage dependency graph reports blocked cyclic plans', () => {
  const graph = buildStageDependencyGraph([
    {
      stageId: 'a',
      type: 'review',
      backend: 'codex',
      dependsOn: ['b'],
      reason: 'cycle',
    },
    {
      stageId: 'b',
      type: 'verify',
      backend: 'gemini',
      dependsOn: ['a'],
      reason: 'cycle',
    },
  ]);

  assert.deepEqual(graph.blockedStageIds, ['a', 'b']);
  assert.match(graph.diagnostics.join('\n'), /dependency cycle/);
});

test('stage handoff packet carries prior summaries and latest workspace facts', () => {
  const packet = buildStageHandoffPacket({
    runId: 'run-handoff',
    stage: {
      stageId: 'stage-review-2',
      type: 'review',
      backend: 'codex',
      dependsOn: ['stage-implement-1'],
      reason: 'review',
    },
    goal: 'ship change',
    userRequest: 'review the implementation',
    canonicalContext: {
      goal: 'ship change',
      plan: ['implement', 'review'],
      decisions: ['use adapter-first path'],
      constraints: ['do not edit upstream backend source'],
      workspaceState: {
        root: '/tmp/old',
        dirtyFiles: [],
      },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    stageInstructions: 'review carefully',
    constraints: ['do not edit upstream backend source'],
    workspaceFacts: {
      root: '/tmp/workspace',
      branch: 'main',
      dirtyFiles: ['src/a.ts'],
      lastKnownDiffSummary: 'src/a.ts | 2 +-',
    },
    priorStageSummaries: [{
      runId: 'run-handoff',
      stageId: 'stage-implement-1',
      backend: 'claude-code',
      summary: 'implemented change',
      filesChanged: ['src/a.ts'],
      testsRun: ['npm test: passed'],
      risks: [],
    }],
    openQuestions: ['confirm rollout'],
  });

  assert.equal(packet.stageId, 'stage-review-2');
  assert.equal(packet.stageType, 'review');
  assert.equal(packet.workspaceFacts.root, '/tmp/workspace');
  assert.deepEqual(packet.priorStageSummaries.map((item) => item.stageId), ['stage-implement-1']);
  assert.deepEqual(packet.canonicalContext.backendRunRecords.map((item) => item.backend), ['claude-code']);
  assert.deepEqual(packet.canonicalContext.openQuestions, ['confirm rollout']);
});

test('stage failure policy resolves fail, retry, and fallback actions', () => {
  const ledger = buildRuleBasedOrchestratorLedger({
    runId: 'run-failure',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please implement this change',
    createdAt: '2026-04-19T00:00:00.000Z',
    planKind: 'implement-only',
  });
  const stage = ledger.plan[0]!;

  assert.equal(resolveStageFailureAction({
    stage,
    policy: ledger.policy,
    retryCount: 0,
    failureReason: 'tool failed',
  }).type, 'fail_run');

  assert.deepEqual(resolveStageFailureAction({
    stage,
    policy: {
      ...ledger.policy,
      failureStrategy: 'retry_stage',
    },
    retryCount: 0,
    maxRetries: 2,
    failureReason: 'timeout',
  }), {
    type: 'retry_stage',
    stageId: stage.stageId,
    retryCount: 1,
    reason: 'Retrying stage after failure: timeout',
  });

  assert.deepEqual(resolveStageFailureAction({
    stage,
    policy: {
      ...ledger.policy,
      failureStrategy: 'fallback_backend',
    },
    retryCount: 0,
    fallbackBackend: 'codex',
    failureReason: 'edit failed',
  }), {
    type: 'fallback_backend',
    stageId: stage.stageId,
    backend: 'codex',
    reason: 'Falling back from claude-code after failure: edit failed',
  });
});

test('multi-stage execution loop passes prior summaries through handoff packets', async () => {
  const ledger = buildRuleBasedOrchestratorLedger({
    runId: 'run-multi',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please review this change',
    createdAt: '2026-04-19T00:00:00.000Z',
  });
  const seenPriorSummaryCounts: number[] = [];
  const result = await executeMultiStagePlan({
    runId: 'run-multi',
    ledger,
    goal: 'review change',
    userRequest: 'please review this change',
    canonicalContext: {
      goal: 'review change',
      plan: [],
      decisions: [],
      constraints: [],
      workspaceState: {
        root: '/tmp/agent-server-ledger-test',
        dirtyFiles: [],
      },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    constraints: [],
    openQuestions: [],
    getWorkspaceFacts: () => ({
      root: '/tmp/agent-server-ledger-test',
      dirtyFiles: [],
    }),
    renderStageInstructions: (stage) => `instructions for ${stage.type}`,
    runStage: (handoff, stage) => {
      seenPriorSummaryCounts.push(handoff.priorStageSummaries.length);
      return {
        id: stage.stageId,
        runId: handoff.runId,
        type: stage.type,
        backend: stage.backend,
        status: 'completed',
        dependsOn: [...stage.dependsOn],
        ownership: stage.ownership,
        input: handoff,
        result: {
          status: 'completed',
          finalText: `${stage.type} done`,
          filesChanged: stage.type === 'implement' ? ['src/a.ts'] : [],
          toolCalls: [],
          testsRun: [],
          findings: [],
          handoffSummary: `${stage.type} summary`,
          nextActions: [],
          risks: [],
          artifacts: [],
        },
        audit: {
          backend: stage.backend,
          inputSummary: handoff.userRequest,
          outputSummary: `${stage.type} done`,
        },
        createdAt: '2026-04-19T00:00:00.000Z',
        completedAt: '2026-04-19T00:00:01.000Z',
      } satisfies AgentRunStageRecord;
    },
  });

  assert.deepEqual(result.stages.map((stage) => stage.type), ['implement', 'review']);
  assert.deepEqual(seenPriorSummaryCounts, [0, 1]);
  assert.deepEqual(result.ledger.completedStageIds, [
    'run-multi-stage-implement-1',
    'run-multi-stage-review-2',
  ]);
  assert.equal(result.ledger.stageSummaries[1]?.summary, 'review summary');
});

test('multi-stage execution loop applies retry and fallback failure policy', async () => {
  const retryLedger = buildRuleBasedOrchestratorLedger({
    runId: 'run-retry',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please implement this change',
    createdAt: '2026-04-19T00:00:00.000Z',
    planKind: 'implement-only',
  });
  retryLedger.policy.failureStrategy = 'retry_stage';
  const attempts: number[] = [];
  const retried = await executeMultiStagePlan({
    runId: 'run-retry',
    ledger: retryLedger,
    goal: 'implement',
    userRequest: 'implement',
    canonicalContext: {
      goal: 'implement',
      plan: [],
      decisions: [],
      constraints: [],
      workspaceState: { root: '/tmp/agent-server-ledger-test', dirtyFiles: [] },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    constraints: [],
    openQuestions: [],
    maxRetries: 1,
    getWorkspaceFacts: () => ({ root: '/tmp/agent-server-ledger-test', dirtyFiles: [] }),
    renderStageInstructions: () => 'implement',
    runStage: (handoff, stage, attempt) => {
      attempts.push(attempt);
      return makeStageRecord(handoff, stage, attempt === 0 ? 'failed' : 'completed');
    },
  });

  assert.deepEqual(attempts, [0, 1]);
  assert.equal(retried.failureAction, undefined);
  assert.deepEqual(retried.ledger.completedStageIds, ['run-retry-stage-implement-1']);

  const fallbackLedger = buildRuleBasedOrchestratorLedger({
    runId: 'run-fallback',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please implement this change',
    createdAt: '2026-04-19T00:00:00.000Z',
    planKind: 'implement-only',
  });
  fallbackLedger.policy.failureStrategy = 'fallback_backend';
  const fallbackBackends: string[] = [];
  const fallback = await executeMultiStagePlan({
    runId: 'run-fallback',
    ledger: fallbackLedger,
    goal: 'implement',
    userRequest: 'implement',
    canonicalContext: {
      goal: 'implement',
      plan: [],
      decisions: [],
      constraints: [],
      workspaceState: { root: '/tmp/agent-server-ledger-test', dirtyFiles: [] },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    constraints: [],
    openQuestions: [],
    fallbackBackend: 'codex',
    getWorkspaceFacts: () => ({ root: '/tmp/agent-server-ledger-test', dirtyFiles: [] }),
    renderStageInstructions: () => 'implement',
    runStage: (handoff, stage) => {
      fallbackBackends.push(stage.backend);
      return makeStageRecord(handoff, stage, stage.backend === 'codex' ? 'completed' : 'failed');
    },
  });

  assert.deepEqual(fallbackBackends, ['claude-code', 'codex']);
  assert.equal(fallback.failureAction, undefined);
  assert.deepEqual(fallback.ledger.failedStageIds, ['run-fallback-stage-implement-1']);
  assert.deepEqual(fallback.ledger.completedStageIds, ['run-fallback-stage-implement-1-fallback-codex']);
});

test('agent server multi-stage service path executes stages with handoff summaries', async () => {
  const service = new AgentServerService() as unknown as {
    runMultiStageBackendTurns(input: {
      agent: {
        id: string;
        backend: 'claude-code';
        workingDirectory: string;
        activeSessionId: string;
        runtimeTeamId: string;
        runtimeAgentId: string;
        runtimePersistentKey: string;
      };
      session: { id: string };
      runId: string;
      message: string;
      executionContext: string;
      ledger: ReturnType<typeof buildRuleBasedOrchestratorLedger>;
      canonicalContext: Parameters<typeof executeMultiStagePlan>[0]['canonicalContext'];
      constraints: string[];
      openQuestions: string[];
      runStartedAtMs: number;
      emitEvent: (event: unknown) => void;
    }): Promise<{
      output: { success: true; result: string } | { success: false; error: string };
      stages: AgentRunStageRecord[];
      ledger: ReturnType<typeof buildRuleBasedOrchestratorLedger>;
    }>;
    runSingleStageBackendTurn(input: {
      backend: string;
      handoffPacket: { stageType: string };
      emitEvent: (event: unknown) => void;
    }): Promise<{
      output: { success: true; result: string };
      adapterStageResult: NonNullable<AgentRunStageRecord['result']>;
      nativeSessionRef: NonNullable<NonNullable<AgentRunStageRecord['result']>['nativeSessionRef']>;
      executionPath: 'agent_backend_adapter';
    }>;
    collectWorkspaceFacts(): Promise<{ root: string; dirtyFiles: string[] }>;
  };
  service.collectWorkspaceFacts = async () => ({
    root: '/tmp/agent-server-service-multi-stage-test',
    dirtyFiles: [],
  });
  service.runSingleStageBackendTurn = async (input) => {
    const finalText = `${input.backend} ${input.handoffPacket.stageType} ok`;
    input.emitEvent({ type: 'text-delta', text: finalText });
    return {
      output: { success: true, result: finalText },
      adapterStageResult: {
        status: 'completed',
        finalText,
        filesChanged: [],
        toolCalls: [],
        testsRun: [],
        findings: [],
        handoffSummary: finalText,
        nextActions: [],
        risks: [],
        artifacts: [],
      },
      nativeSessionRef: {
        id: `fake:${input.backend}`,
        backend: input.backend as 'claude-code',
        scope: 'stage',
        resumable: true,
      },
      executionPath: 'agent_backend_adapter',
    };
  };

  const ledger = buildRuleBasedOrchestratorLedger({
    runId: 'run-service-multi',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-service-multi-stage-test',
    requestText: 'please review this change',
    createdAt: '2026-04-19T00:00:00.000Z',
  });
  const events: unknown[] = [];
  const result = await service.runMultiStageBackendTurns({
    agent: {
      id: 'agent-service-multi',
      backend: 'claude-code',
      workingDirectory: '/tmp/agent-server-service-multi-stage-test',
      activeSessionId: 'session-service-multi',
      runtimeTeamId: 'agent-server',
      runtimeAgentId: 'agent-service-multi',
      runtimePersistentKey: 'agent-service-multi',
    },
    session: { id: 'session-service-multi' },
    runId: 'run-service-multi',
    message: 'please review this change',
    executionContext: 'context',
    ledger,
    canonicalContext: {
      goal: 'please review this change',
      plan: [],
      decisions: [],
      constraints: [],
      workspaceState: {
        root: '/tmp/agent-server-service-multi-stage-test',
        dirtyFiles: [],
      },
      artifacts: [],
      backendRunRecords: [],
      openQuestions: [],
    },
    constraints: [],
    openQuestions: [],
    runStartedAtMs: Date.now(),
    emitEvent: (event) => events.push(event),
  });

  assert.equal(result.output.success, true);
  assert.equal(result.stages.length, 2);
  assert.deepEqual(result.stages.map((stage) => stage.type), ['implement', 'review']);
  assert.equal(result.stages[1]?.input.priorStageSummaries.length, 1);
  assert.equal(result.stages[1]?.audit.executionPath, 'agent_backend_adapter');
  assert.deepEqual(result.ledger.completedStageIds, [
    'run-service-multi-stage-implement-1',
    'run-service-multi-stage-review-2',
  ]);
  assert.ok(events.some((event) => (
    typeof event === 'object'
    && event !== null
    && 'type' in event
    && event.type === 'stage-result'
  )));
});

test('agent server completes a rule-based orchestrator ledger for the default single stage path', () => {
  const service = new AgentServerService() as unknown as {
    completeOrchestratorLedger(
      ledger: NonNullable<import('../server/agent_server/types.ts').AgentRunRecord['orchestrator']>,
      stages: AgentRunStageRecord[],
    ): NonNullable<import('../server/agent_server/types.ts').AgentRunRecord['orchestrator']>;
  };
  const ledger = buildRuleBasedOrchestratorLedger({
    runId: 'run-test',
    primaryBackend: 'claude-code',
    workspace: '/tmp/agent-server-ledger-test',
    requestText: 'please implement this change',
    createdAt: '2026-04-19T00:00:00.000Z',
    planKind: 'implement-only',
  });

  assert.equal(ledger.version, 1);
  assert.equal(ledger.mode, 'single_stage');
  assert.equal(ledger.policy.planner, 'rule_based');
  assert.deepEqual(ledger.stageOrder, ['run-test-stage-implement-1']);
  assert.equal(ledger.plan[0]?.backend, 'claude-code');

  const completed = service.completeOrchestratorLedger(ledger, [
    {
      id: 'run-test-stage-implement-1',
      runId: 'run-test',
      type: 'implement',
      backend: 'claude-code',
      status: 'completed',
      dependsOn: [],
      input: {
        runId: 'run-test',
        stageId: 'run-test-stage-implement-1',
        stageType: 'implement',
        goal: 'test',
        userRequest: 'test',
        canonicalContext: {
          goal: 'test',
          plan: [],
          decisions: [],
          constraints: [],
          workspaceState: {
            root: '/tmp/agent-server-ledger-test',
            dirtyFiles: [],
          },
          artifacts: [],
          backendRunRecords: [],
          openQuestions: [],
        },
        stageInstructions: 'test',
        constraints: [],
        workspaceFacts: {
          root: '/tmp/agent-server-ledger-test',
          dirtyFiles: [],
        },
        priorStageSummaries: [],
        openQuestions: [],
      },
      result: {
        status: 'completed',
        finalText: 'done',
        filesChanged: ['src/example.ts'],
        toolCalls: [],
        testsRun: [{
          command: 'npm test',
          status: 'passed',
        }],
        findings: [],
        handoffSummary: 'Implemented the requested change.',
        nextActions: [],
        risks: [],
        artifacts: [],
      },
      audit: {
        backend: 'claude-code',
        inputSummary: 'test',
        outputSummary: 'done',
      },
      createdAt: '2026-04-19T00:00:00.000Z',
      completedAt: '2026-04-19T00:00:01.000Z',
    },
  ]);

  assert.deepEqual(completed.completedStageIds, ['run-test-stage-implement-1']);
  assert.deepEqual(completed.failedStageIds, []);
  assert.equal(completed.stageSummaries[0]?.summary, 'Implemented the requested change.');
  assert.deepEqual(completed.stageSummaries[0]?.testsRun, ['npm test: passed']);
});

function makeStageRecord(
  handoff: Parameters<NonNullable<Parameters<typeof executeMultiStagePlan>[0]['runStage']>>[0],
  stage: Parameters<NonNullable<Parameters<typeof executeMultiStagePlan>[0]['runStage']>>[1],
  status: 'completed' | 'failed',
): AgentRunStageRecord {
  return {
    id: stage.stageId,
    runId: handoff.runId,
    type: stage.type,
    backend: stage.backend,
    status,
    dependsOn: [...stage.dependsOn],
    ownership: stage.ownership,
    input: handoff,
    result: {
      status,
      finalText: status,
      filesChanged: [],
      toolCalls: [],
      testsRun: [],
      findings: [],
      handoffSummary: `${stage.backend} ${status}`,
      nextActions: [],
      risks: status === 'failed' ? ['failed'] : [],
      artifacts: [],
    },
    audit: {
      backend: stage.backend,
      inputSummary: handoff.userRequest,
      outputSummary: status,
      failureReason: status === 'failed' ? 'failed' : undefined,
    },
    createdAt: '2026-04-19T00:00:00.000Z',
    completedAt: '2026-04-19T00:00:01.000Z',
  };
}
