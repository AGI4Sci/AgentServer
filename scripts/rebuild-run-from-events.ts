import { getHarnessRunStore } from '../core/harness/run-store.js';
import { pathToFileURL } from 'url';

export function main(): void {
  const runId = process.argv[2];
  if (!runId) {
    console.error('Usage: npm run rebuild:run -- <runId>');
    process.exit(1);
  }

  const store = getHarnessRunStore();
  const run = store.materializeRunArtifacts(runId);

  console.log(
    `[rebuild-run-from-events] Materialized ${runId} with ${run.events.length} events (status=${run.outcome?.completionStatus || 'active'})`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
