import type { TaskFact } from '../../core/runtime/blackboard-types.js';
import type { TeamRegistry } from '../../core/team/registry.js';
import { deriveAgentCapabilities } from '../ws/blackboard-dispatcher.js';

/**
 * 检测「pending 任务所需的 requiredCapability 是否被当前 team roster 中
 * 至少一名成员的 deriveAgentCapabilities 并集覆盖」。
 *
 * 若未覆盖，executor 无法认领（tickBlackboardAgent 中 capabilities.includes 失败），
 * 任务会静默卡在 pending —— 本诊断用于 T006 联调与 UI 可见性。
 */
export function deriveCapabilityCoverageGaps(args: {
  registry: TeamRegistry;
  tasks: TaskFact[];
  /** 仅检视该 request 下的 pending；不传则检视 session 内全部 pending */
  requestId?: string | null;
}): {
  pendingNoAgentCapability: Array<{
    taskId: string;
    requestId: string;
    requiredCapability: string;
    hint: string;
  }>;
  rosterCapabilityUnionSample: string[];
} {
  const rosterCaps = new Set<string>();
  for (const member of args.registry.getMembers()) {
    for (const cap of deriveAgentCapabilities(member)) {
      rosterCaps.add(cap);
    }
  }
  const rosterCapabilityUnionSample = [...rosterCaps].sort().slice(0, 48);

  const pendingNoAgentCapability: Array<{
    taskId: string;
    requestId: string;
    requiredCapability: string;
    hint: string;
  }> = [];

  const scopeRequest = args.requestId?.trim() || '';

  for (const task of args.tasks) {
    if (task.status !== 'pending') continue;
    if (scopeRequest && task.requestId !== scopeRequest) continue;

    const req = String(task.requiredCapability || 'general').trim() || 'general';
    if (rosterCaps.has(req)) continue;

    pendingNoAgentCapability.push({
      taskId: task.id,
      requestId: task.requestId,
      requiredCapability: req,
      hint: `当前 team roster 中没有任何成员的 capabilities 包含「${req}」，任务将一直停留在 pending；请调整任务的 requiredCapability、team 成员 skills/role，或让 coordinator 改写派单。`,
    });
  }

  return { pendingNoAgentCapability, rosterCapabilityUnionSample };
}

/**
 * T006 阶段 B：当前 roster 上所有成员 id + `deriveAgentCapabilities` 并集（排序），
 * 供 coordinator 将 `requiredCapability` 约束在可认领命名空间内（与 `[[TEAM_ROSTER_CAPABILITIES]]` 同源枚举）。
 */
export function deriveRosterCapabilityAllowlist(registry: TeamRegistry): string[] {
  const out = new Set<string>();
  for (const member of registry.getMembers()) {
    out.add(member.id);
    for (const cap of deriveAgentCapabilities(member)) {
      out.add(cap);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
