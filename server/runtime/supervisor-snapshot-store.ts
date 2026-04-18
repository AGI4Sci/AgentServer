import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ensureBackendStateDirs } from '../../core/runtime/backend-paths.js';
import type { WorkerRuntimeType, WorkerSessionStatus } from './team-worker-types.js';
import type { RuntimeSessionMode } from './session-types.js';

export interface RuntimeSessionSnapshotEntry {
  runtime: WorkerRuntimeType;
  teamId: string;
  agentId: string;
  projectScope: string | null;
  cwd: string | null;
  model: string | null;
  modelProvider: string | null;
  modelName: string | null;
  sessionMode: RuntimeSessionMode;
  persistentKey: string | null;
  status: WorkerSessionStatus['status'];
  updatedAt: string;
}

export interface RuntimeSessionSnapshotFile {
  version: 1;
  updatedAt: string;
  sessions: RuntimeSessionSnapshotEntry[];
}

function getSnapshotPath(): string {
  const { stateDir } = ensureBackendStateDirs('runtime_supervisor', ['snapshots']);
  return join(stateDir, 'snapshots', 'session-snapshots.json');
}

export function loadRuntimeSessionSnapshot(): RuntimeSessionSnapshotFile {
  const path = getSnapshotPath();
  if (!existsSync(path)) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      sessions: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeSessionSnapshotFile>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.filter((entry): entry is RuntimeSessionSnapshotEntry => {
          return Boolean(
            entry
            && typeof entry.runtime === 'string'
            && typeof entry.teamId === 'string'
            && typeof entry.agentId === 'string',
          );
        })
        : [],
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      sessions: [],
    };
  }
}

export function saveRuntimeSessionSnapshot(sessions: WorkerSessionStatus[]): RuntimeSessionSnapshotFile {
  const snapshot: RuntimeSessionSnapshotFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    sessions: sessions
      .filter((session) => session.status !== 'offline')
      .filter((session) => session.sessionMode === 'persistent')
      .map((session) => ({
        runtime: session.runtime,
        teamId: session.teamId,
        agentId: session.agentId,
        projectScope: session.projectScope ?? null,
        cwd: session.cwd,
        model: session.model,
        modelProvider: session.modelProvider ?? null,
        modelName: session.modelName ?? null,
        sessionMode: 'persistent',
        persistentKey: session.persistentKey ?? null,
        status: session.status,
        updatedAt: new Date().toISOString(),
      })),
  };

  writeFileSync(getSnapshotPath(), JSON.stringify(snapshot, null, 2));
  return snapshot;
}
