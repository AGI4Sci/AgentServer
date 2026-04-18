export type HarnessScenarioId = 'coding' | 'research' | 'ppt';

export interface HarnessPerf {
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  modelId?: string;
}

export interface HarnessShellSnapshot {
  defaultRightPanelTab?: string;
  rightPanelTabs: string[];
  topbarModules: string[];
  modals: string[];
}

export interface HarnessConversationSnapshot {
  showCoordinatorOnly: boolean;
  filterInternalMessages: boolean;
  showSharedSessionAsStatus: boolean;
}

export interface HarnessWorkSnapshot {
  adapterId: string;
  primaryObject: string;
  secondaryObjects?: string[];
  summaryModules: string[];
}

export interface HarnessSnapshot {
  scenarioId: HarnessScenarioId;
  shell: HarnessShellSnapshot;
  conversation: HarnessConversationSnapshot;
  work: HarnessWorkSnapshot;
}

export interface TeamMemberSnapshot {
  id: string;
  roleType: 'coordinator' | 'executor';
  roleName?: string;
  name?: string;
  model?: string;
  skills?: string[];
  required?: boolean;
}

export interface TeamSnapshot {
  id: string;
  name: string;
  coordinator: string;
  members: TeamMemberSnapshot[];
}

export type HarnessEvent =
  | {
      type: 'run_started';
      timestamp: number;
      teamId: string;
      scenarioId: HarnessScenarioId;
      requestId: string;
      sourceClientId?: string;
      agentId: string;
      to: string;
      taskType?: string;
      teamSnapshot?: TeamSnapshot;
      harnessSnapshot?: HarnessSnapshot;
      projectId?: string;
    }
  | {
      type: 'message_delivered';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      from: string;
      to: string;
      relation: 'delivery' | 'reply';
      messageId: string;
      inReplyToMessageId?: string | null;
      bodyPreview: string;
      sessionRef?: string;
      isPrivate?: boolean;
      perf?: HarnessPerf;
    }
  | {
      type: 'message_intercepted';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      from: string;
      to: string;
      reason: string;
      perf?: HarnessPerf;
    }
  | {
      type: 'message_replied';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      from: string;
      to: string;
      relation: 'reply';
      messageId: string;
      inReplyToMessageId?: string | null;
      bodyPreview: string;
      sessionRef?: string;
      stale?: boolean;
      isPrivate?: boolean;
      perf?: HarnessPerf;
    }
  | {
      type: 'project_state_changed';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      projectId: string;
      counts: {
        todo: number;
        active: number;
        blocked: number;
        done: number;
      };
      taskIds: string[];
    }
  | {
      type: 'task_status_updated';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      projectId: string;
      taskId: string;
      title: string;
      status: 'todo' | 'active' | 'blocked' | 'done';
      previousStatus?: 'todo' | 'active' | 'blocked' | 'done';
      assignee?: string;
      priority?: string;
    }
  | {
      type: 'artifact_created';
      timestamp: number;
      teamId: string;
      requestId?: string;
      sourceClientId?: string;
      agentId: string;
      projectId: string;
      artifactPath: string;
      artifactType: 'file';
      title: string;
    }
  | {
      type: 'run_completed';
      timestamp: number;
      teamId: string;
      requestId: string;
      result: 'completed' | 'abandoned';
      completedBy: string;
      reason?: string;
    }
  | {
      type: 'completion_signal_updated';
      timestamp: number;
      teamId: string;
      requestId: string;
      result: 'completed' | 'abandoned';
      completedBy: string;
      reason?: string;
    };

export interface RunOutcome {
  completed: boolean;
  completionStatus: 'completed' | 'abandoned' | 'active';
  completionSignal:
    | 'active'
    | 'reply_to_user_fallback'
    | 'coordinator_explicit'
    | 'user_accepted'
    | 'task_closure'
    | 'timeout_abandoned';
  latencyMs: number;
  totalTokens?: number;
  totalLatencyMs?: number;
  agentTokenBreakdown?: Record<string, number>;
  blockedCount: number;
  rerouteCount: number;
  userInterruptCount: number;
  artifactAccepted?: boolean;
  userSatisfied?: boolean;
}

export interface RunReview {
  runId: string;
  createdAt: string;
  verdict: 'healthy' | 'needs_attention' | 'failed';
  summary: string;
  completionStatus: 'completed' | 'abandoned' | 'active';
  completionSignal: RunOutcome['completionSignal'];
  findings: string[];
  recommendations: string[];
  metrics: RunOutcome;
}

export interface HarnessRunRecord {
  runId: string;
  teamId: string;
  scenarioId: HarnessScenarioId;
  requestId: string;
  sourceClientId?: string;
  taskType: string;
  projectId?: string;
  startedAt: string;
  finishedAt?: string;
  teamSnapshot: TeamSnapshot;
  harnessSnapshot: HarnessSnapshot;
  events: HarnessEvent[];
  outcome?: RunOutcome;
  review?: RunReview;
}
