export type TaskFactSource = 'user' | 'system' | 'agent';
export type TaskFactStability = 'stable' | 'derived' | 'ephemeral';
export type TaskFactOperation = 'asserted' | 'corrected';

export interface TaskFactEntry {
  key: string;
  value: string | number | boolean;
  source: TaskFactSource;
  stability: TaskFactStability;
  operation?: TaskFactOperation;
  updatedAt: string;
  invalidatedAt?: string;
}

export interface TaskFactTimelineEntry extends TaskFactEntry {
  status: 'active' | 'invalidated';
}

export interface ConversationFactsRecord {
  controlProjectPath?: string;
  controlPort?: number;
  controlUrl?: string;
  targetProjectPath?: string;
  targetPort?: number;
  targetUrl?: string;
  updatedAt: string;
  source: TaskFactSource;
}

function key(teamId: string, sessionId: string): string {
  return `${teamId}:${sessionId}`;
}

function deriveCurrent(entries: TaskFactEntry[]): ConversationFactsRecord | null {
  const current: Partial<ConversationFactsRecord> = {};
  let source: TaskFactSource = 'system';
  let updatedAt = new Date().toISOString();
  for (const entry of entries.filter((item) => !item.invalidatedAt)) {
    (current as Record<string, unknown>)[entry.key] = entry.value;
    source = entry.source;
    updatedAt = entry.updatedAt;
  }
  if (Object.keys(current).length === 0) {
    return null;
  }
  return {
    ...current,
    updatedAt,
    source,
  };
}

export class ConversationFactsStore {
  private readonly entries = new Map<string, TaskFactEntry[]>();

  getCurrent(teamId: string, sessionId?: string | null): ConversationFactsRecord | null {
    if (!sessionId) return null;
    return deriveCurrent(this.entries.get(key(teamId, sessionId)) || []);
  }

  getCurrentForSession(teamId: string, sessionId: string): ConversationFactsRecord | null {
    return this.getCurrent(teamId, sessionId);
  }

  getActiveFacts(teamId: string, options?: { includeEphemeral?: boolean }, sessionId?: string | null): TaskFactEntry[] {
    if (!sessionId) return [];
    const includeEphemeral = options?.includeEphemeral === true;
    return (this.entries.get(key(teamId, sessionId)) || []).filter((entry) => {
      if (entry.invalidatedAt) return false;
      if (!includeEphemeral && entry.stability === 'ephemeral') return false;
      return true;
    });
  }

  getActiveFactsForSession(teamId: string, sessionId: string, options?: { includeEphemeral?: boolean }): TaskFactEntry[] {
    return this.getActiveFacts(teamId, options, sessionId);
  }

  getFactTimeline(teamId: string, factKey?: string, sessionId?: string | null): TaskFactTimelineEntry[] {
    if (!sessionId) return [];
    return (this.entries.get(key(teamId, sessionId)) || [])
      .filter((entry) => !factKey || entry.key === factKey)
      .map((entry) => ({
        ...entry,
        status: entry.invalidatedAt ? 'invalidated' : 'active',
      }));
  }

  getFactTimelineForSession(teamId: string, sessionId: string, factKey?: string): TaskFactTimelineEntry[] {
    return this.getFactTimeline(teamId, factKey, sessionId);
  }

  upsertFacts(teamId: string, input: {
    source: TaskFactSource;
    stability: TaskFactStability;
    operation?: TaskFactOperation;
    facts: Record<string, string | number | boolean | undefined>;
    updatedAt?: string;
  }, sessionId?: string | null): ConversationFactsRecord | null {
    if (!sessionId) {
      return null;
    }
    const list = [...(this.entries.get(key(teamId, sessionId)) || [])];
    const updatedAt = input.updatedAt || new Date().toISOString();
    for (const [factKey, factValue] of Object.entries(input.facts)) {
      if (factValue === undefined) continue;
      for (const item of list) {
        if (item.key === factKey && !item.invalidatedAt) {
          item.invalidatedAt = updatedAt;
        }
      }
      list.push({
        key: factKey,
        value: factValue,
        source: input.source,
        stability: input.stability,
        operation: input.operation,
        updatedAt,
      });
    }
    this.entries.set(key(teamId, sessionId), list);
    return deriveCurrent(list);
  }

  clear(teamId: string, sessionId?: string | null): void {
    if (sessionId) {
      this.entries.delete(key(teamId, sessionId));
      return;
    }
    for (const entryKey of Array.from(this.entries.keys())) {
      if (entryKey.startsWith(`${teamId}:`)) {
        this.entries.delete(entryKey);
      }
    }
  }
}

let store: ConversationFactsStore | null = null;

export function getConversationFactsStore(): ConversationFactsStore {
  if (!store) {
    store = new ConversationFactsStore();
  }
  return store;
}
