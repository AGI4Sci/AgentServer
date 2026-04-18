import { AgentServerService } from './service.js';

export class AgentLoopManager {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly inFlight = new Set<string>();
  private bootstrapped = false;

  constructor(private readonly service: AgentServerService) {}

  bootstrap(): void {
    if (this.bootstrapped) {
      return;
    }
    this.bootstrapped = true;
    void this.syncEnabledAgents();
  }

  async syncEnabledAgents(): Promise<void> {
    const agents = await this.service.listAgents();
    for (const agent of agents) {
      if (agent.autonomy.enabled && agent.status === 'active') {
        this.ensureLoop(agent.id, 250);
      }
    }
  }

  ensureLoop(agentId: string, delayMs = 0): void {
    this.clearLoop(agentId);
    const timer = setTimeout(() => {
      void this.tick(agentId);
    }, delayMs);
    this.timers.set(agentId, timer);
  }

  stopLoop(agentId: string): void {
    this.clearLoop(agentId);
  }

  private clearLoop(agentId: string): void {
    const existing = this.timers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(agentId);
    }
  }

  private async tick(agentId: string): Promise<void> {
    if (this.inFlight.has(agentId)) {
      return;
    }
    this.inFlight.add(agentId);
    try {
      const agent = await this.service.getAgent(agentId);
      if (!agent.autonomy.enabled || agent.status !== 'active') {
        this.stopLoop(agentId);
        return;
      }
      if (agent.runtime.isRunning) {
        this.ensureLoop(agentId, agent.autonomy.intervalMs);
        return;
      }
      if (agent.autonomy.autoReflect && agent.runtime.pendingGoalCount === 0) {
        await this.service.enqueueReflection(agentId);
      }
      await this.service.runNextGoal(agentId);
      const refreshed = await this.service.getAgent(agentId);
      if (refreshed.autonomy.enabled && refreshed.status === 'active') {
        this.ensureLoop(agentId, refreshed.autonomy.intervalMs);
      }
    } catch (error) {
      console.error(`[agent-server] autonomous tick failed for ${agentId}:`, error);
      this.ensureLoop(agentId, 30_000);
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}
