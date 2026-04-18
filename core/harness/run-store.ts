import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../../server/utils/paths.js';
import { getHarnessEventStore } from './events.js';
import { rebuildReview, rebuildRun } from './rebuild.js';
import type { HarnessRunRecord, HarnessScenarioId, RunReview } from './types.js';

const HARNESS_DATA_DIR = join(PROJECT_ROOT, 'data', 'harness');
const RUNS_DIR = join(HARNESS_DATA_DIR, 'runs');
const REVIEWS_DIR = join(HARNESS_DATA_DIR, 'reviews');

function ensureHarnessDirs(): void {
  [HARNESS_DATA_DIR, RUNS_DIR, REVIEWS_DIR].forEach(dir => {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  });
}

function safeParseJson<T>(content: string): T | null {
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

function sortRunsByStartedAtDesc(a: HarnessRunRecord, b: HarnessRunRecord): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

export class HarnessRunStore {
  private readonly eventStore = getHarnessEventStore();

  constructor() {
    ensureHarnessDirs();
  }

  private getRunPath(runId: string): string {
    return join(RUNS_DIR, `${runId}.json`);
  }

  private getReviewPath(runId: string): string {
    return join(REVIEWS_DIR, `${runId}.json`);
  }

  materializeRun(run: HarnessRunRecord): void {
    writeFileSync(this.getRunPath(run.runId), `${JSON.stringify(run, null, 2)}\n`, 'utf-8');
  }

  materializeReview(review: RunReview): void {
    writeFileSync(this.getReviewPath(review.runId), `${JSON.stringify(review, null, 2)}\n`, 'utf-8');
  }

  materializeRunArtifacts(runId: string): HarnessRunRecord {
    const run = rebuildRun(runId);
    this.materializeRun(run);
    if (run.review) {
      this.materializeReview(run.review);
    }
    return run;
  }

  private hasIndexedEvents(runId: string): boolean {
    return this.eventStore.getRunDates(runId).length > 0;
  }

  private readRunFromFile(runId: string): HarnessRunRecord | null {
    const path = this.getRunPath(runId);
    if (!existsSync(path)) return null;
    return safeParseJson<HarnessRunRecord>(readFileSync(path, 'utf-8'));
  }

  private readReviewFromFile(runId: string): RunReview | null {
    const path = this.getReviewPath(runId);
    if (!existsSync(path)) return null;
    return safeParseJson<RunReview>(readFileSync(path, 'utf-8'));
  }

  private tryRebuildRun(runId: string): HarnessRunRecord | null {
    try {
      return rebuildRun(runId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('No events found for run ')) {
        this.eventStore.removeIndexedRunId(runId);
        return null;
      }
      console.warn(`[HarnessRunStore] Failed to rebuild run ${runId}:`, error);
      return null;
    }
  }

  private tryRebuildReview(runId: string): RunReview | null {
    try {
      return rebuildReview(runId);
    } catch (error) {
      console.warn(`[HarnessRunStore] Failed to rebuild review ${runId}:`, error);
      return null;
    }
  }

  getRun(runId: string): HarnessRunRecord | null {
    if (this.hasIndexedEvents(runId)) {
      return this.tryRebuildRun(runId);
    }

    return this.readRunFromFile(runId);
  }

  getReview(runId: string): RunReview | null {
    if (this.hasIndexedEvents(runId)) {
      return this.tryRebuildReview(runId);
    }

    return this.readReviewFromFile(runId);
  }

  private collectRuns(): HarnessRunRecord[] {
    const indexedRunIds = new Set(this.eventStore.getIndexedRunIds());
    const eventBackedRuns = [...indexedRunIds]
      .map(runId => this.tryRebuildRun(runId))
      .filter((run): run is HarnessRunRecord => Boolean(run));

    const fileBackedRuns = readdirSync(RUNS_DIR)
      .filter(filename => filename.endsWith('.json'))
      .map(filename => filename.replace(/\.json$/i, ''))
      .filter(runId => !indexedRunIds.has(runId))
      .map(runId => this.readRunFromFile(runId))
      .filter((run): run is HarnessRunRecord => Boolean(run));

    return [...eventBackedRuns, ...fileBackedRuns].sort(sortRunsByStartedAtDesc);
  }

  findRunByRequest(options: {
    teamId: string;
    requestId: string;
    onlyActive?: boolean;
  }): HarnessRunRecord | null {
    const run = this.collectRuns().find(item => (
      item.teamId === options.teamId &&
      item.requestId === options.requestId &&
      (!options.onlyActive || !item.finishedAt)
    ));

    return run || null;
  }

  findRecentFinishedRuns(options: {
    teamId: string;
    projectId?: string;
    limit?: number;
  }): HarnessRunRecord[] {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    return this.collectRuns()
      .filter(run =>
        run.teamId === options.teamId &&
        Boolean(run.finishedAt) &&
        (!options.projectId || run.projectId === options.projectId)
      )
      .slice(0, limit);
  }

  listRuns(options?: { teamId?: string; limit?: number }): HarnessRunRecord[] {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    const runs = this.collectRuns()
      .filter(run => !options?.teamId || run.teamId === options.teamId)

    return runs.slice(0, limit);
  }

  listReviews(options?: { teamId?: string; limit?: number }): Array<RunReview & { teamId: string; scenarioId: HarnessScenarioId }> {
    const limit = Math.max(1, Math.min(options?.limit ?? 20, 100));
    type ReviewSummary = RunReview & { teamId: string; scenarioId: HarnessScenarioId };

    const indexedRunIds = new Set(this.eventStore.getIndexedRunIds());
    const eventBackedReviews = [...indexedRunIds]
      .map(runId => {
        const run = this.tryRebuildRun(runId);
        if (!run) return null;
        const review = run.review || this.tryRebuildReview(runId);
        return review ? { ...review, teamId: run.teamId, scenarioId: run.scenarioId } : null;
      })
      .filter((review): review is ReviewSummary => review !== null);

    const fileBackedReviews = readdirSync(REVIEWS_DIR)
      .filter(filename => filename.endsWith('.json'))
      .map(filename => filename.replace(/\.json$/i, ''))
      .filter(runId => !indexedRunIds.has(runId))
      .map(runId => {
        const run = this.readRunFromFile(runId);
        if (!run) return null;
        const review = this.readReviewFromFile(run.runId);
        return review ? { ...review, teamId: run.teamId, scenarioId: run.scenarioId } : null;
      })
      .filter((review): review is ReviewSummary => review !== null);

    const reviews = [...eventBackedReviews, ...fileBackedReviews]
      .filter(review => !options?.teamId || review.teamId === options.teamId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    return reviews.slice(0, limit);
  }
}

let runStore: HarnessRunStore | null = null;

export function getHarnessRunStore(): HarnessRunStore {
  if (!runStore) {
    runStore = new HarnessRunStore();
  }
  return runStore;
}
