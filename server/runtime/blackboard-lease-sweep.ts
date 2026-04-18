import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getBlackboardStore } from '../../core/store/blackboard-store.js';

const DATA_DIR = join(process.cwd(), 'data', 'blackboard');

export type BlackboardLeaseSweepBatch = {
  teamId: string;
  sessionId: string;
  resets: number;
};

/**
 * 扫描所有 team/session 黑板文件，对过期租约执行 lease_expired_reset（与 BlackboardStore.scanExpiredLeases 一致）。
 */
export function sweepExpiredBlackboardLeases(): BlackboardLeaseSweepBatch[] {
  if (!existsSync(DATA_DIR)) {
    return [];
  }
  const board = getBlackboardStore();
  const out: BlackboardLeaseSweepBatch[] = [];
  for (const teamId of readdirSync(DATA_DIR)) {
    const teamDir = join(DATA_DIR, teamId);
    try {
      if (!statSync(teamDir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    for (const file of readdirSync(teamDir)) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const sessionId = file.replace(/\.json$/i, '');
      const resets = board.scanExpiredLeases(teamId, sessionId);
      if (resets.length > 0) {
        out.push({ teamId, sessionId, resets: resets.length });
      }
    }
  }
  return out;
}
