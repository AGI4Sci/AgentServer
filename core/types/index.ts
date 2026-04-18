/**
 * OpenTeam Studio - Core Types
 * 核心类型定义
 * 
 * Agent 定义归 OpenTeam 本地存储，Team 只引用 agent IDs
 */

// ============================================================================
// Agent Types
// ============================================================================

export interface SoulConfig {
  // YAML frontmatter 字段
  id?: string;
  role?: string;
  name?: string;
  model?: string;
  temperature?: number;
  language?: string;
  
  // Markdown 内容字段
  identity: string;        // 身份：这个 agent 是谁
  personality: string;     // 个性：行为风格
  mission: string;         // 使命：核心目标
  communication: string;   // 沟通方式：输出格式偏好
  constraints: string;     // 约束：绝对不做的事
  traits: string[];        // 特征标签
}

export type AgentStatus = 'idle' | 'working' | 'done' | 'blocked' | 'offline';

export interface AgentDef {
  id: string;              // 唯一标识，如 "pm-01"
  teamId: string;          // 所属 Team（运行时绑定，agent 可属于多个 team）
  role: string;            // 角色类型：PM / Dev / Reviewer / QA
  name: string;            // 角色名称，如 "Aria"
  
  soul: SoulConfig;        // SOUL.md 配置（从项目内 agents/{id}/SOUL.md 加载）
  skills: string[];        // 启用的技能
  model: string;           // 使用的模型
  
  status: AgentStatus;     // 运行时状态
  currentTask?: string;    // 当前任务
}

// ============================================================================
// Team Types
// ============================================================================

/**
 * Agent 引用类型 - 支持字符串或完整对象
 */
export type AgentRef = string | {
  id: string;
  role?: string;
  name?: string;
  required?: boolean;
  soul?: string;
  skills?: string[];
  model?: string;
  count?: { min: number; max: number };
};

/**
 * Team Manifest - Team 实例配置
 * 
 * 只引用 agent IDs，不定义 agent 细节（agent 定义在项目内 agents/）
 */
export interface TeamManifest {
  id: string;
  name: string;
  type: 'dev' | 'research' | 'business' | 'creative' | 'ops';
  icon: string;
  description: string;
  
  template?: string;       // 来源模板 ID（可选）
  
  // Agent 引用 - 支持字符串 ID 或完整对象
  agents: AgentRef[];      // ['pm-01', { id: 'dev-01', role: 'Dev', ... }]
  
  dashboard?: string;
  skill?: string;
  
  workflow?: {
    phases: WorkflowPhase[];
    transitions: WorkflowTransition[];
  };
  
  config?: {
    defaultModel: string;
    tools: Record<string, string[]>;
    filePatterns: Record<string, string>;
  };
}

export interface WorkflowPhase {
  name: string;
  agent?: string;
  agents?: string[];
  role?: string;
  roles?: string[];
  output?: string;
  parallel?: boolean;
  tag?: string;
  action?: string;
}

export interface WorkflowTransition {
  from: string;
  to: string | string[];
  trigger: 'mention' | 'condition' | 'auto';
}

/**
 * TeamDef - Team 运行时定义
 * 
 * 包含从项目内 agents/ 加载的完整 agent 定义
 */
export interface TeamDef {
  id: string;
  name: string;
  type: string;
  icon: string;
  description: string;
  
  manifest: TeamManifest;
  
  // 运行时加载的完整 agent 定义
  agents: AgentDef[];
  
  // 运行时状态
  projects: ProjectDef[];
  activeProject?: string;
}

export interface ProjectDef {
  id: string;
  name: string;
  teamId: string;
  path: string;
  
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// Message Types
// ============================================================================

export interface InboundMessage {
  type: 'user-message';
  to: string;              // agentId 或 @mention
  body: string;            // 消息内容
  context: MessageContext;
  replyTo?: string;
  requestId?: string;
  sessionId?: string;
  timestamp: string;
}

export interface OutboundMessage {
  type: 'user-message' | 'agent-stream' | 'agent-chat-final' | 'agent-reply' | 'agent-result' | 'agent-dispatch' | 'agent-status' | 'agent-thinking' | 'agent-outbound' | 'agent-intercept' | 'agent-blocked' | 'runtime-tool-call' | 'runtime-permission-request' | 'round-usage-summary' | 'control-event' | 'system-event' | 'team-status' | 'team-init-required' | 'team-ready' | 'session-init' | 'error';
  messageId?: string;
  from?: string;           // agentId
  to?: string;             // 目标 agentId (agent-outbound/agent-intercept 专用)
  body?: string;           // 回复内容
  thinking?: string;       // 思考内容 (agent-thinking 专用)
  metadata?: MessageMetadata;
  status?: AgentStatus;
  currentTask?: string;
  error?: string;
  timestamp: string;
  requestId?: string;
  sessionId?: string;
  sessionKey?: string;
  stale?: boolean;
  sourceClientId?: string;
  isPrivate?: boolean;
  // session-init 专用字段
  teamId?: string;
  teamSkillPath?: string;
  message?: string;
  clientId?: string;
  sharedChatMode?: boolean;
  // team-ready / session-init 专用字段
  teamReady?: boolean;
  members?: string[];
  initializedMembers?: string[];
  roundUsage?: RoundUsageSummary;
  evidence?: Record<string, unknown>;
}

export interface MessageContext {
  teamId: string;
  projectId: string;
  userId?: string;
  currentProjectWorkspace?: {
    workspaceId: string;
    transport: 'local' | 'ssh' | 'container' | 'robot' | 'tool-endpoint';
    cwd: string;
    allowedRoots?: string[];
    artifactsRoot?: string;
    networkMode?: string;
    defaultExecutionTarget?: 'local' | 'remote';
    remoteSessionId?: string;
    checkedAt?: string;
  };
}

export interface MessageMetadata {
  model?: string;
  tokens?: { input: number; output: number };
  duration?: number;
  estimated?: boolean;
  blocked?: boolean;
  reason?: string;
  fullContent?: string;
  auditContent?: string;
  tags?: string[];
  messageSubtype?: 'dispatch' | 'result' | 'final-answer' | 'progress' | 'hint' | 'chat-final';
  traceKind?: string;
  ruleViolation?: boolean;
  messagePlane?: 'work' | 'control';
  controlKind?: string;
  // team-init-required 专用
  teamId?: string;
  uninitializedMembers?: string[];
  initializedMembers?: string[];
}

export interface RoundUsageModuleSummary {
  module: 'user_intake' | 'coordinator_planning' | 'dispatch_fanout' | 'worker_execution' | 'tool_execution' | 'coordinator_synthesis';
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  dispatchCount: number;
  estimated: boolean;
}

export interface RoundUsageWorkerSummary {
  agentId: string;
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  llmCalls: number;
  toolCalls: number;
  estimated: boolean;
}

export interface RoundUsageToolSummary {
  agentId: string;
  toolName: string;
  count: number;
}

export interface RoundUsageSummary {
  requestId: string;
  startedAt: string;
  completedAt: string;
  wallClockMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalDurationMs: number;
  mostExpensiveModule: RoundUsageModuleSummary['module'] | null;
  slowestModule: RoundUsageModuleSummary['module'] | null;
  modules: RoundUsageModuleSummary[];
  workers: RoundUsageWorkerSummary[];
  tools: RoundUsageToolSummary[];
}

export interface SessionUsageModuleAggregate {
  module: RoundUsageModuleSummary['module'];
  totalTokens: number;
  totalDurationMs: number;
  avgTokensPerRequest: number;
  avgDurationMsPerRequest: number;
  requestCount: number;
}

export interface SessionUsageSummary {
  sessionId: string;
  requestCount: number;
  totalTokens: number;
  totalDurationMs: number;
  avgTokensPerRequest: number;
  avgDurationMsPerRequest: number;
  mostExpensiveModule: RoundUsageModuleSummary['module'] | null;
  fastestGrowingModule: RoundUsageModuleSummary['module'] | null;
  modules: SessionUsageModuleAggregate[];
}

// ============================================================================
// WebSocket Types
// ============================================================================

import type { WebSocket as NodeWebSocket } from 'ws';

export interface WebSocketClient {
  id: string;
  teamId: string;
  projectId?: string;
  sessionId?: string;
  ws: NodeWebSocket;
  connectedAt: string;
}

export interface BroadcastMessage {
  teamId: string;
  projectId?: string;
  message: OutboundMessage;
  excludeClientId?: string;
}

// ============================================================================
// Store Types
// ============================================================================

export interface TeamState {
  teamId: string;
  agents: Map<string, AgentDef>;
  projects: Map<string, ProjectDef>;
  activeProjectId?: string;
}

export interface AppState {
  teams: Map<string, TeamState>;
  clients: Map<string, WebSocketClient>;
}

// ============================================================================
// Task Queue Types
// ============================================================================

/**
 * 任务状态
 */
export type TaskStatus = 
  | 'pending'      // 待分配
  | 'assigned'     // 已分配，等待 dev 启动
  | 'in_progress'  // 进行中
  | 'blocked'      // 阻塞
  | 'review'       // 待验证
  | 'completed'    // 已完成
  | 'failed';      // 失败

/**
 * 任务优先级
 */
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * 任务定义
 */
export interface Task {
  id: string;                    // 任务 ID，如 T020-dev-01
  parentTask?: string;           // 父任务 ID
  title: string;                 // 任务标题
  description?: string;          // 任务描述
  assignee: string;              // 分配给谁
  priority: TaskPriority;        // 优先级
  status: TaskStatus;            // 状态
  dependencies: string[];        // 依赖的任务 ID
  files: string[];               // 涉及的文件
  tags: string[];                // 标签
  createdAt: string;             // 创建时间
  updatedAt: string;             // 更新时间
  startedAt?: string;            // 开始时间
  completedAt?: string;          // 完成时间
  blockedReason?: string;        // 阻塞原因
  metadata?: Record<string, any>; // 自定义元数据
}

/**
 * 任务队列
 */
export interface TaskQueue {
  version: number;               // 版本号（乐观锁）
  teamId: string;                // Team ID
  tasks: Task[];                 // 任务列表
  lastPollTime: Record<string, string>;  // agent 最后轮询时间
}

/**
 * 任务队列配置（manifest.json 中定义）
 */
export interface TaskQueueConfig {
  roles: Record<string, {
    agents: string[];
    permissions: ('create' | 'assign' | 'update' | 'delete' | 'poll' | 'update_own')[];
  }>;
  states: TaskStatus[];
  transitions: Record<TaskStatus, TaskStatus[]>;
  taskTypes: string[];
  priorities: TaskPriority[];
  pollInterval: Record<string, number>;
}

/**
 * 任务创建请求
 */
export interface CreateTaskRequest {
  id?: string;
  parentTask?: string;
  title: string;
  description?: string;
  assignee: string;
  priority?: TaskPriority;
  dependencies?: string[];
  files?: string[];
  tags?: string[];
  metadata?: Record<string, any>;
}

/**
 * 任务更新请求
 */
export interface UpdateTaskRequest {
  status?: TaskStatus;
  title?: string;
  description?: string;
  assignee?: string;
  priority?: TaskPriority;
  dependencies?: string[];
  files?: string[];
  tags?: string[];
  blockedReason?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, any>;
}

/**
 * WebSocket 任务消息
 */
export type TaskWsMessage =
  | { type: 'task_created'; task: Task }
  | { type: 'task_updated'; taskId: string; changes: Partial<Task> }
  | { type: 'task_deleted'; taskId: string }
  | { type: 'queue_reset'; queue: TaskQueue };
