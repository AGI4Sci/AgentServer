import { getTeamRegistry, loadTeamsFromDirectory } from '../../core/team/registry.js';
import { TEAMS_DIR } from '../utils/paths.js';
import { drainBlackboardDispatch, type BlackboardDispatchPlanItem } from './blackboard-dispatcher.js';

export interface BlackboardDispatchTriggerInput {
  teamId: string;
  requestId: string;
  chatSessionId: string;
}

export type BlackboardDispatchRunner = (input: BlackboardDispatchTriggerInput) => Promise<BlackboardDispatchPlanItem[]>;
export type BlackboardDispatchListener = (input: BlackboardDispatchTriggerInput, plan: BlackboardDispatchPlanItem[]) => void;

let customRunner: BlackboardDispatchRunner | null = null;
let listener: BlackboardDispatchListener | null = null;

async function defaultRunner(input: BlackboardDispatchTriggerInput): Promise<BlackboardDispatchPlanItem[]> {
  let registry = getTeamRegistry(input.teamId);
  if (!registry) {
    loadTeamsFromDirectory(TEAMS_DIR);
    registry = getTeamRegistry(input.teamId);
  }
  if (!registry) {
    return [];
  }
  return drainBlackboardDispatch({
    teamId: input.teamId,
    requestId: input.requestId,
    chatSessionId: input.chatSessionId,
    registry,
  });
}

export function setBlackboardDispatchRunner(runner: BlackboardDispatchRunner | null): void {
  customRunner = runner;
}

export function setBlackboardDispatchListener(nextListener: BlackboardDispatchListener | null): void {
  listener = nextListener;
}

export async function triggerBlackboardDispatch(input: BlackboardDispatchTriggerInput): Promise<BlackboardDispatchPlanItem[]> {
  const plan = await (customRunner || defaultRunner)(input);
  listener?.(input, plan);
  return plan;
}
