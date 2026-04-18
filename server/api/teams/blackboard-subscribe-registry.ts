/**
 * 记录浏览器 / 客户端对黑板更新的「订阅」登记（显式 POST /blackboard/subscribe）。
 * 实际推送仍走既有 WebSocket；此处仅用于观测与将来扩展（如按会话统计）。
 */
const lastInterestByTeam = new Map<string, { sessionId: string | null; subscribedAt: string }>();

export function recordBlackboardSubscribeInterest(teamId: string, sessionId: string | null): { subscribedAt: string } {
  const subscribedAt = new Date().toISOString();
  lastInterestByTeam.set(teamId, { sessionId, subscribedAt });
  return { subscribedAt };
}

export function getBlackboardSubscribeInterest(teamId: string): { sessionId: string | null; subscribedAt: string } | null {
  return lastInterestByTeam.get(teamId) ?? null;
}
