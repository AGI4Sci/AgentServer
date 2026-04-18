import { AgentLoopManager } from './loop-manager.js';
import { AgentServerService } from './service.js';

const service = new AgentServerService();
const loopManager = new AgentLoopManager(service);

let bootstrapped = false;

export function getAgentServerService(): AgentServerService {
  return service;
}

export function getAgentServerLoopManager(): AgentLoopManager {
  if (!bootstrapped) {
    loopManager.bootstrap();
    bootstrapped = true;
  }
  return loopManager;
}
