import type { AgentServerService } from './service.js';
import { getAgentServerService } from './runtime.js';

export type AgentServerClient = AgentServerService;

export function getAgentServerClient(): AgentServerClient {
  return getAgentServerService();
}
