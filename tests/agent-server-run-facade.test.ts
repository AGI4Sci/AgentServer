import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentServerService } from '../server/agent_server/service.ts';
import type {
  AgentManifest,
  AgentRunRecord,
  AutonomousAgentRunRequest,
  AutonomousAgentRunResult,
} from '../server/agent_server/types.ts';

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
});
