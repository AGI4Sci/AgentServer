import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentServerService,
  shouldRouteModelEndpointThroughSupervisor,
} from '../server/agent_server/service.ts';
import type {
  AgentManifest,
  AgentRunRecord,
  AgentServerRunResult,
  AutonomousAgentRunRequest,
  AutonomousAgentRunResult,
} from '../server/agent_server/types.ts';
import { compactAgentServerRunResultForHttp } from '../server/api/agent-server.ts';

class CapturingAgentServerService extends AgentServerService {
  captured?: AutonomousAgentRunRequest;

  override async runAutonomousTask(request: AutonomousAgentRunRequest): Promise<AutonomousAgentRunResult> {
    this.captured = request;
    const agent = {
      id: request.agent.id || 'agent-test',
      name: request.agent.name || 'Agent Test',
      backend: request.agent.backend || 'claude-code',
      workingDirectory: request.agent.workingDirectory,
      runtimeTeamId: request.agent.runtimeTeamId || 'agent-server',
      runtimeAgentId: request.agent.runtimeAgentId || request.agent.id || 'agent-test',
      runtimePersistentKey: `agent-server:${request.agent.id || 'agent-test'}`,
      systemPrompt: request.agent.systemPrompt || 'test prompt',
      status: 'active',
      autonomy: {
        enabled: false,
        intervalMs: 60_000,
        autoReflect: false,
        maxConsecutiveErrors: 3,
      },
      runtime: {
        isRunning: false,
        pendingGoalCount: 0,
        consecutiveErrors: 0,
      },
      activeSessionId: 'session-test',
      metadata: request.agent.metadata,
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    } as AgentManifest;
    const run = {
      id: 'run-test',
      agentId: agent.id,
      sessionId: agent.activeSessionId,
      status: 'completed',
      request: {
        message: request.message.message,
        context: 'captured context',
      },
      output: {
        success: true,
        result: 'ok',
      },
      events: [],
      metadata: request.message.metadata,
      createdAt: '2026-04-18T00:00:00.000Z',
      completedAt: '2026-04-18T00:00:01.000Z',
    } as AgentRunRecord;
    return {
      agent,
      run,
      recoveryActions: [],
      retried: false,
    };
  }
}

test('runTask maps generic run request to autonomous hosted run', async () => {
  const service = new CapturingAgentServerService();
  const result = await service.runTask({
    agent: {
      id: 'agent-generic',
      name: 'Generic Agent',
      backend: 'codex',
      workspace: '/tmp/generic-workspace',
      runtimeTeamId: 'runtime-team',
      runtimeAgentId: 'runtime-agent',
      metadata: {
        roleId: 'dev-01',
      },
    },
    input: {
      text: 'Do the task',
      metadata: {
        taskId: 'task-1',
      },
    },
    runtime: {
      modelProvider: 'openai-compatible',
      modelName: 'cpu-brain-smoke-model',
      llmEndpoint: {
        baseUrl: 'http://127.0.0.1:18766/v1',
        apiKey: 'cpu-brain-smoke-key',
        modelName: 'cpu-brain-smoke-model',
        provider: 'openai-compatible',
      },
      metadata: {
        endpointId: 'local',
      },
    },
    metadata: {
      project: 'test-project',
    },
  });

  assert.equal(service.captured?.agent.id, 'agent-generic');
  assert.equal(service.captured?.agent.backend, 'codex');
  assert.equal(service.captured?.agent.workingDirectory, '/tmp/generic-workspace');
  assert.equal(service.captured?.message.message, 'Do the task');
  assert.equal(service.captured?.message.modelProvider, 'openai-compatible');
  assert.equal(service.captured?.message.modelName, 'cpu-brain-smoke-model');
  assert.deepEqual(service.captured?.message.llmEndpoint, {
    baseUrl: 'http://127.0.0.1:18766/v1',
    apiKey: 'cpu-brain-smoke-key',
    modelName: 'cpu-brain-smoke-model',
    provider: 'openai-compatible',
  });
  assert.deepEqual(service.captured?.message.metadata, {
    project: 'test-project',
    input: {
      taskId: 'task-1',
    },
    runtime: {
      endpointId: 'local',
    },
    agent: {
      roleId: 'dev-01',
    },
  });
  assert.equal(result.run.metadata?.project, 'test-project');
  assert.equal(result.metadata?.project, 'test-project');
  assert.deepEqual(service.captured?.message.contextPolicy, {
    includeCurrentWork: false,
    includeRecentTurns: false,
    includePersistent: false,
    includeMemory: false,
    persistRunSummary: false,
    persistExtractedConstraints: false,
  });
});

test('runTask preserves explicit context policy overrides', async () => {
  const service = new CapturingAgentServerService();
  await service.runTask({
    agent: {
      id: 'agent-context-policy',
      backend: 'codex',
      workspace: '/tmp/generic-workspace',
    },
    input: {
      text: 'Do the task with memory',
    },
    contextPolicy: {
      includeMemory: true,
      includePersistent: true,
      persistRunSummary: true,
    },
  });

  assert.deepEqual(service.captured?.message.contextPolicy, {
    includeMemory: true,
    includePersistent: true,
    persistRunSummary: true,
  });
});

test('OpenAI-compatible request model routes through supervisor tool bridge', () => {
  assert.equal(shouldRouteModelEndpointThroughSupervisor({
    modelProvider: 'qwen',
    modelName: 'qwen3.6-plus',
    llmEndpoint: {
      provider: 'qwen',
      baseUrl: 'https://dashscope.example.test/compatible-mode/v1',
      apiKey: 'test-key',
      modelName: 'qwen3.6-plus',
    },
  }), true);
  assert.equal(shouldRouteModelEndpointThroughSupervisor({
    modelProvider: 'native',
    modelName: 'local-model',
    llmEndpoint: {
      provider: 'native',
      baseUrl: '',
      modelName: 'local-model',
    },
  }), false);
});

test('HTTP run result compaction omits huge context while preserving output', () => {
  const largeContext = 'context '.repeat(2000);
  const result = {
    agent: {
      id: 'agent-test',
      name: 'Agent Test',
      backend: 'codex',
      workingDirectory: '/tmp/generic-workspace',
      runtimeTeamId: 'agent-server',
      runtimeAgentId: 'agent-test',
      runtimePersistentKey: 'agent-server:agent-test',
      systemPrompt: 'test prompt',
      status: 'active',
      autonomy: {
        enabled: false,
        intervalMs: 60_000,
        autoReflect: false,
        maxConsecutiveErrors: 3,
      },
      runtime: {
        isRunning: false,
        pendingGoalCount: 0,
        consecutiveErrors: 0,
      },
      activeSessionId: 'session-test',
      createdAt: '2026-04-18T00:00:00.000Z',
      updatedAt: '2026-04-18T00:00:00.000Z',
    },
    run: {
      id: 'run-test',
      agentId: 'agent-test',
      sessionId: 'session-test',
      status: 'completed',
      request: {
        message: 'Generate task',
        context: largeContext,
      },
      output: {
        success: true,
        result: '{"taskFiles":[],"entrypoint":"task.py"}',
      },
      events: Array.from({ length: 250 }, (_, index) => ({
        type: 'status',
        message: `event ${index}`,
      })),
      stages: [{
        id: 'stage-test',
        runId: 'run-test',
        type: 'implement',
        backend: 'codex',
        status: 'completed',
        dependsOn: [],
        input: {
          runId: 'run-test',
          stageId: 'stage-test',
          stageType: 'implement',
          goal: 'Generate task',
          userRequest: 'Generate task',
          canonicalContext: {
            goal: 'Generate task',
            plan: [],
            decisions: [],
            constraints: [largeContext],
            workspaceState: { root: '/tmp/generic-workspace', dirtyFiles: [] },
            artifacts: [],
            backendRunRecords: [],
            openQuestions: [],
          },
          stageInstructions: 'do work',
          constraints: [],
          workspaceFacts: { root: '/tmp/generic-workspace', dirtyFiles: [] },
          priorStageSummaries: [],
          openQuestions: [],
        },
        result: {
          status: 'completed',
          finalText: 'done',
        },
        audit: {
          backend: 'codex',
          inputSummary: largeContext,
          outputSummary: 'done',
        },
        createdAt: '2026-04-18T00:00:00.000Z',
        completedAt: '2026-04-18T00:00:01.000Z',
      }],
      createdAt: '2026-04-18T00:00:00.000Z',
      completedAt: '2026-04-18T00:00:01.000Z',
    },
    recoveryActions: [],
    retried: false,
  } as AgentServerRunResult;

  const compacted = compactAgentServerRunResultForHttp(result);
  assert.equal(compacted.run.output.result, result.run.output.result);
  assert.ok(compacted.run.request.context.length < largeContext.length);
  assert.equal(compacted.run.events.length, 200);
  assert.equal(compacted.run.stages?.[0]?.input.canonicalContext, '[omitted from AgentServer HTTP response; full value remains in run store]');
  assert.doesNotThrow(() => JSON.stringify(compacted));
});
