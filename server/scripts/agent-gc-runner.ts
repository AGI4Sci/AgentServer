import { loadProjectEnv } from '../utils/load-env.js';
import { runSafeAgentGc } from '../../core/cleanup/agent-cleanup.js';

loadProjectEnv(process.cwd());

const trigger = process.argv[2] === 'interval' ? 'interval' : 'startup';

try {
  const result = runSafeAgentGc({
    verbose: trigger === 'startup',
  });

  console.log(
    `[AgentGC] trigger=${trigger} total=${result.total} cleaned=${result.cleaned} retained=${result.retained} errors=${result.errors.length}`,
  );

  if (result.errors.length > 0) {
    for (const error of result.errors) {
      console.warn(`[AgentGC] ${error}`);
    }
  }

  process.exit(0);
} catch (error) {
  console.error('[AgentGC] Failed:', error);
  process.exit(1);
}
