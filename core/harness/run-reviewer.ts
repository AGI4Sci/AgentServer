import type { HarnessRunRecord, HarnessEvent, RunOutcome, RunReview } from './types.js';

interface PerfEventProjection {
  agentId: string;
  perf: {
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    modelId?: string;
  };
}

function countEvents(events: HarnessEvent[], type: HarnessEvent['type']): number {
  return events.filter(event => event.type === type).length;
}

function getLatestProjectStateEvent(events: HarnessEvent[]) {
  return [...events].reverse().find(
    (event): event is Extract<HarnessEvent, { type: 'project_state_changed' }> =>
      event.type === 'project_state_changed'
  );
}

function getTaskStatusUpdates(events: HarnessEvent[]) {
  return events.filter(
    (event): event is Extract<HarnessEvent, { type: 'task_status_updated' }> =>
      event.type === 'task_status_updated'
  );
}

function getArtifactCreatedEvents(events: HarnessEvent[]) {
  return events.filter(
    (event): event is Extract<HarnessEvent, { type: 'artifact_created' }> =>
      event.type === 'artifact_created'
  );
}

function getLatestCompletionEvent(events: HarnessEvent[]) {
  return [...events].reverse().find(
    (
      event,
    ): event is Extract<HarnessEvent, { type: 'run_completed' | 'completion_signal_updated' }> =>
      event.type === 'run_completed' || event.type === 'completion_signal_updated'
  );
}

export function deriveRunOutcome(run: HarnessRunRecord): RunOutcome {
  const startedAt = Date.parse(run.startedAt);
  const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const completionEvent = getLatestCompletionEvent(run.events);
  const blockedCount = countEvents(run.events, 'message_intercepted');
  const rerouteCount = run.events.filter(
    event =>
      event.type === 'message_delivered' &&
      event.from !== 'user' &&
      event.to !== 'user'
  ).length;
  const userInterruptCount = Math.max(
    0,
    run.events.filter(event => event.type === 'message_delivered' && event.from === 'user').length - 1
  );
  const perfEvents = run.events
    .map(event => {
      const candidate = event as HarnessEvent & { agentId?: string; perf?: PerfEventProjection['perf'] };
      return candidate.perf
        ? { agentId: candidate.agentId || 'unknown', perf: candidate.perf }
        : null;
    })
    .filter((event): event is PerfEventProjection => Boolean(event));
  const totalTokens = perfEvents.reduce((sum, event) => sum + (event.perf.totalTokens || 0), 0);
  const totalLatencyMs = perfEvents.reduce((sum, event) => sum + (event.perf.latencyMs || 0), 0);
  const agentTokenBreakdown = perfEvents.reduce<Record<string, number>>((acc, event) => {
    const tokens = event.perf.totalTokens || 0;
    if (tokens <= 0) return acc;
    acc[event.agentId] = (acc[event.agentId] || 0) + tokens;
    return acc;
  }, {});

  return {
    completed: Boolean(run.finishedAt) && completionEvent?.result === 'completed',
    completionStatus: completionEvent?.result || 'active',
    completionSignal:
      completionEvent?.result === 'abandoned'
        ? 'timeout_abandoned'
        : (completionEvent?.reason as RunOutcome['completionSignal']) || 'active',
    latencyMs: Math.max(0, finishedAt - startedAt),
    totalTokens: totalTokens || undefined,
    totalLatencyMs: totalLatencyMs || undefined,
    agentTokenBreakdown: Object.keys(agentTokenBreakdown).length > 0 ? agentTokenBreakdown : undefined,
    blockedCount,
    rerouteCount,
    userInterruptCount,
  };
}

export function buildRunReview(run: HarnessRunRecord): RunReview {
  const metrics = deriveRunOutcome(run);
  const findings: string[] = [];
  const recommendations: string[] = [];
  const latestProjectState = getLatestProjectStateEvent(run.events);
  const taskUpdates = getTaskStatusUpdates(run.events);
  const artifactEvents = getArtifactCreatedEvents(run.events);
  const changedToDone = taskUpdates.filter(event => event.status === 'done');
  const changedToBlocked = taskUpdates.filter(event => event.status === 'blocked');
  const changedToActive = taskUpdates.filter(event => event.status === 'active');

  if (!metrics.completed) {
    if (metrics.completionStatus === 'abandoned') {
      findings.push('本轮 run 因长时间无活动被标记为 abandoned，说明缺少明确收尾信号。');
      recommendations.push('检查协调者是否缺少最终汇总，或补充更可靠的完成/异常结束判定。');
    } else {
      findings.push('本轮 run 仍未完成，缺少明确的最终交付信号。');
    }
  }
  if (metrics.completionSignal === 'coordinator_explicit') {
    findings.push('本轮 run 由协调者的明确收尾语触发完成，完成信号较强。');
  }
  if (metrics.completionSignal === 'user_accepted') {
    findings.push('用户给出了明确采纳/确认信号，可视为结果已被接受。');
  }
  if (metrics.completionSignal === 'task_closure') {
    findings.push('任务对象已形成闭环：PROJECT.md 中不再存在 ACTIVE/BLOCKED 项。');
  }
  if (latestProjectState) {
    findings.push(
      `最新 project state: todo=${latestProjectState.counts.todo}, active=${latestProjectState.counts.active}, blocked=${latestProjectState.counts.blocked}, done=${latestProjectState.counts.done}。`
    );
  }
  if (changedToDone.length > 0) {
    findings.push(`本轮有 ${changedToDone.length} 个任务推进到 done，说明任务闭环正在形成。`);
  }
  if (changedToBlocked.length > 0) {
    findings.push(`本轮有 ${changedToBlocked.length} 个任务进入 blocked，说明阻塞已进入结构化状态记录。`);
    recommendations.push('优先检查 blocked 任务是否缺少依赖、确认步骤或角色切换。');
  }
  if (changedToActive.length > 0 && changedToDone.length === 0 && metrics.completed) {
    findings.push(`本轮记录了 ${changedToActive.length} 个任务进入 active，但缺少对应 done 事件，完成归因仍偏弱。`);
    recommendations.push('补齐任务从 active 到 done 的状态推进，避免完成信号只落在对话收尾。');
  }
  if (artifactEvents.length > 0) {
    const artifactNames = artifactEvents.slice(0, 3).map(event => event.title).join('、');
    findings.push(`本轮新建了 ${artifactEvents.length} 个产物${artifactNames ? `，包括 ${artifactNames}` : ''}。`);
  } else if (metrics.completed && run.scenarioId === 'coding') {
    recommendations.push('对 coding 场景，建议补充 artifact_created 事件，避免“完成”缺少产物支撑。');
  }
  if (metrics.blockedCount > 0) {
    findings.push(`出现 ${metrics.blockedCount} 次路由拦截或投递失败，说明协作链路存在摩擦。`);
    recommendations.push('优先检查 Team 通信规则、目标选择和 replyTo 恢复链路。');
  }
  if (metrics.userInterruptCount > 0) {
    findings.push(`用户在同一 run 内额外发起了 ${metrics.userInterruptCount} 次追问或打断。`);
    recommendations.push('考虑提高阶段性汇报密度，或更早暴露阻塞状态。');
  }
  if (metrics.rerouteCount >= 3) {
    findings.push(`内部转投递次数达到 ${metrics.rerouteCount} 次，团队协作成本偏高。`);
    recommendations.push('评估是否需要收紧执行者之间的协作链路，或让协调者更早汇总。');
  }
  if (findings.length === 0) {
    findings.push('本轮协作链路稳定，没有发现明显的路由或介入异常。');
  }
  if (recommendations.length === 0) {
    recommendations.push('继续观察相似任务，确认当前 Harness 配置是否能稳定复现。');
  }

  const verdict =
    !metrics.completed ? 'failed' :
    metrics.blockedCount > 0 || metrics.userInterruptCount > 1 || changedToBlocked.length > 0 ? 'needs_attention' :
    'healthy';

  return {
    runId: run.runId,
    createdAt: new Date().toISOString(),
    verdict,
    completionStatus: metrics.completionStatus,
    completionSignal: metrics.completionSignal,
    summary: [
      `scenario=${run.scenarioId}`,
      `team=${run.teamId}`,
      `status=${metrics.completionStatus}`,
      `signal=${metrics.completionSignal}`,
      `latencyMs=${metrics.latencyMs}`,
      `totalTokens=${metrics.totalTokens || 0}`,
      `modelLatencyMs=${metrics.totalLatencyMs || 0}`,
      `blocked=${metrics.blockedCount}`,
      `reroute=${metrics.rerouteCount}`,
      `interrupt=${metrics.userInterruptCount}`,
    ].join(' | '),
    findings,
    recommendations,
    metrics,
  };
}
