/**
 * Runtime Adapter Types
 *
 * 定义独立于具体 runtime 的 Agent 配置格式，
 * 以及 runtime adapter 接口。
 */

// ============================================================================
// AgentMessage - 系统内流转的消息结构
// ============================================================================

/**
 * 系统内流转的消息结构。
 * 所有经过 MessageRouter 的消息必须符合此结构。
 */
export interface AgentMessage {
  /** 全局唯一 ID，用于去重。建议用 nanoid() 或 crypto.randomUUID() 生成。 */
  id: string;
  /** 发送方 ID。用户固定为字符串 'user'。 */
  from: string;
  /** 接收方 ID，或字符串 'all'（仅协调者可用）。 */
  to: string;
  /** 消息正文。 */
  body: string;
  /** 本条消息是在回复谁的 ID。执行者发消息时必填；协调者和用户可为 null。 */
  replyTo: string | null;
  /** 从 body 中解析出的有效 @mention ID 列表（精确匹配，已验证是团队成员）。 */
  mentions: string[];
  /** Unix 时间戳，Date.now()。 */
  timestamp: number;
  /** Team ID（可选，用于多 team 场景） */
  teamId?: string;
  /** 请求 ID（用于隔离同一 agent 的多轮请求） */
  requestId?: string;
  /** Runtime session key（用于精确关联同一条流式输出） */
  sessionKey?: string;
  /** 发起请求的客户端 ID（共享群聊里用于标识来源） */
  sourceClientId?: string;
  /** 是否为私聊链路 */
  isPrivate?: boolean;
  /** 是否为过期残留输出 */
  stale?: boolean;
  /** 消息平面：业务消息或控制消息 */
  messagePlane?: 'work' | 'control';
}

// ============================================================================
// Session-as-Process Models
// ============================================================================

/**
 * SessionContext - 对话 session 的结构化执行上下文
 *
 * 设计目标：
 * - 用结构化状态承载关键执行事实，而不是依赖自然语言反复转述
 * - 类比操作系统进程的 cwd/env
 */
export interface SessionContext {
  sessionId: string;
  requestId: string;
  revision: number;
  env: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/**
 * TaskSpec - 结构化任务定义
 *
 * 最小强类型字段仅保留 objective，其余业务扩展统一通过 meta 透传。
 */
export interface TaskSpec {
  taskId: string;
  requestId: string;
  revision: number;
  owner: string;
  objective: string;
  meta?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'done'
  | 'verified'
  | 'stale';

export interface TaskState {
  taskId: string;
  requestId: string;
  owner: string;
  revision: number;
  status: TaskStatus;
  todos: string[];
  evidence: string[];
  retryCount: number;
  failureCount: number;
  lastFailureStatus?: Extract<TaskStatus, 'blocked' | 'failed' | 'timed_out'> | null;
  lastFailureReason?: string | null;
  lastFailureAt?: string | null;
  replacementHistory: string[];
  updatedAt: string;
}

export type TeamRuntimePhase =
  | 'intaking'
  | 'planning'
  | 'dispatching'
  | 'executing'
  | 'verifying'
  | 'summarizing'
  | 'paused'
  | 'degraded';

export type TeamDegradationMode =
  | 'none'
  | 'reduced_team'
  | 'single_coordinator_fallback'
  | 'no_retrieval_mode'
  | 'manual_confirmation_required';

export type TeamMemberAvailability =
  | 'active'
  | 'idle'
  | 'busy'
  | 'blocked'
  | 'offline';

export type TeamMemberLifecycle =
  | 'spawning'
  | 'active'
  | 'idle'
  | 'waiting_approval'
  | 'blocked'
  | 'paused'
  | 'retired'
  | 'failed';

export interface TeamMemberRuntime {
  agentId: string;
  role: string;
  capabilityTags: string[];
  availability: TeamMemberAvailability;
  lifecycle: TeamMemberLifecycle;
  assignmentTaskId?: string | null;
  lastHeartbeatAt?: string | null;
  lastResultAt?: string | null;
  failureCount: number;
  replacementCandidateIds?: string[];
}

export interface TeamApprovalRecord {
  approvalId: string;
  kind: string;
  reason: string;
  options: string[];
  status: 'pending' | 'approved' | 'rejected' | 'responded';
  requestedAt: string;
  respondedAt?: string | null;
  decision?: string | null;
  note?: string | null;
}

export interface TeamLifecycleEvent {
  id: string;
  agentId: string;
  from: TeamMemberLifecycle | 'unknown';
  to: TeamMemberLifecycle;
  reason: string;
  timestamp: string;
  taskId?: string | null;
}

export interface TeamRuntimeState {
  teamId: string;
  chatSessionId: string;
  scenarioId?: string | null;
  coordinator: {
    agentId: string;
    laneId: string;
    requestOwner: 'user';
    status: 'active' | 'waiting' | 'blocked';
  };
  members: TeamMemberRuntime[];
  approvals: TeamApprovalRecord[];
  lifecycleEvents: TeamLifecycleEvent[];
  workingSetTaskIds?: string[];
  phase: TeamRuntimePhase;
  degradationMode: TeamDegradationMode;
  updatedAt: string;
}

export type WorkMessageKind = 'dispatch' | 'result' | 'summary' | 'question';

export interface WorkMessage extends AgentMessage {
  kind: WorkMessageKind;
  requestId: string;
  taskId?: string | null;
}

export type ControlMessageKind =
  | 'idle'
  | 'ack'
  | 'permission_request'
  | 'approval_response'
  | 'deadline_warning'
  | 'retry_suggested'
  | 'member_unavailable'
  | 'handoff_proposal'
  | 'pause'
  | 'resume'
  | 'shutdown'
  | 'degrade';

export interface ControlMessage {
  id: string;
  kind: ControlMessageKind;
  from: string;
  to: string;
  requestId?: string | null;
  taskId?: string | null;
  payload: Record<string, unknown>;
  timestamp: number;
}

/**
 * Evidence - 任务完成/验收证据
 */
export interface Evidence {
  type: string;
  summary: string;
  timestamp: string;
  refs?: string[];
  data?: Record<string, unknown>;
}

/**
 * ActionSpec - 统一执行入口的最小动作描述
 */
export interface ActionSpec {
  taskId: string;
  revision: number;
  cwd?: string;
  port?: string | number;
  url?: string;
  meta?: Record<string, unknown>;
}

/**
 * ActionResult - 统一执行入口的返回结构
 */
export interface ActionResult<T = unknown> {
  ok: boolean;
  evidence?: Evidence[];
  output?: T;
}

export type ScopeMismatchField = 'revision' | 'cwd' | 'port' | 'url';

/**
 * ScopeMismatchErrorShape - 执行作用域冲突
 */
export interface ScopeMismatchErrorShape {
  code: 'SCOPE_MISMATCH';
  field: ScopeMismatchField;
  expected: string;
  actual: string;
  taskId: string;
}

/**
 * 系统通知（拦截、错误等）
 */
export interface SystemNotification {
  type: 'MESSAGE_BLOCKED' | 'ROUTER_ERROR';
  from: string;
  to: string;
  reason: string;
  timestamp: number;
}

/** @deprecated 使用 AgentMessage 替代 */
export type RoutedMessage = AgentMessage;

/**
 * Router 初始化配置，从 team.config.json 读取后传入。
 * 注意：不包含 maxChainDepth，链深度限制已由硬规则 A 在结构上保证，无需配置。
 */
export interface RouterConfig {
  /** 协调者的 ID，从 members 中 roleType === 'coordinator' 的成员推导 */
  coordinator: string;
  /** 所有成员 ID 列表（包含协调者） */
  members: string[];
}

// ============================================================================
// Soul Config - OpenTeam 独立的 Agent 配置格式
// ============================================================================

/**
 * SoulConfig - Agent 的"灵魂"配置
 * 
 * 这是 OpenTeam 的核心配置格式，独立于任何 runtime。
 * 存储为 agents/{id}/soul.json
 * 
 * 设计原则：
 * - 只包含结构化的机器可读字段
 * - 自然语言内容（身份、能力、使命等）在 Member Profile 文件中定义
 * - Member Profile 文件路径通过 team.config.json 的 members[].soul 字段指定
 */
export interface SoulConfig {
  // === 元数据 ===
  id: string;
  name?: string;
  version?: string;
  
  // === 运行时配置 ===
  runtime?: RuntimeConfig;
  
  // === Team 上下文（可选） ===
  team?: TeamContext;
  
  // === 以下字段已废弃，保留用于向后兼容 ===
  /** @deprecated 身份定义已迁移到 Member Profile 文件 */
  identity?: string;
  /** @deprecated 个性描述已迁移到 Member Profile 文件 */
  personality?: string;
  /** @deprecated 使命已迁移到 Member Profile 文件 */
  mission?: string;
  /** @deprecated 沟通方式已迁移到 Member Profile 文件 */
  communication?: string;
  /** @deprecated 约束已迁移到 Member Profile 文件 */
  constraints?: string;
  /** @deprecated 特征标签已迁移到 Member Profile 文件 */
  traits?: string[];
}

/**
 * TeamContext - Agent 所属的 Team 上下文
 */
export interface TeamContext {
  /** Team ID */
  teamId: string;
  /** Team 名称 */
  teamName?: string;
  /** Team 成员列表（本地 ID） */
  members: TeamMember[];
  /** Team Skill 路径（用于团队协作规则） */
  skillPath?: string;
  /** 当前 agent 在团队中的角色 */
  myRole?: string;
}

/**
 * TeamMember - Team 成员信息
 */
export interface TeamMember {
  id: string;
  /** 角色名称（PM/Dev/Reviewer/QA 等），可选 */
  role?: string;
  name?: string;
}

/**
 * RuntimeConfig - 运行时配置
 * 
 * 这些配置会被翻译成目标 runtime 的格式
 */
export interface RuntimeConfig {
  /** 默认模型（可被 runtime 覆盖） */
  model?: string;
  /** 温度参数 */
  temperature?: number;
  /** 语言 */
  language?: string;
  /** 启用的 skills */
  skills?: string[];
  /** 心跳间隔 */
  heartbeatInterval?: string;
  /** 工具权限 */
  tools?: {
    allow?: string[];
    deny?: string[];
    alsoAllow?: string[];
  };
  /** 群聊配置 */
  groupChat?: {
    mentionPatterns?: string[];
  };
}

// ============================================================================
// Skill Config - OpenTeam 独立的 Skill 配置格式
// ============================================================================

/**
 * SkillConfig - Skill 配置
 * 
 * 存储为 agents/{id}/skills/{skillId}.yaml
 * 或 skills/{skillId}/SKILL.yaml
 */
export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  
  /** Skill 类型 */
  type: 'prompt' | 'tool' | 'workflow';
  
  /** Prompt 类型的内容 */
  prompt?: string;
  
  /** 工具配置 */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  
  /** 依赖的其他 skills */
  dependencies?: string[];
  
  /** 环境变量需求 */
  env?: Record<string, { required: boolean; description: string }>;
}

// ============================================================================
// Runtime Adapter Interface
// ============================================================================

/**
 * AgentRuntimeAdapter - Agent Runtime 适配器接口
 * 
 * 抽象不同 agent runtime（OpenClaw, Codex, Claude Code, OpenCode 等）
 * 的差异，让 OpenTeam 可以切换底层 runtime。
 */
export interface AgentRuntimeAdapter {
  /** Runtime 名称 */
  readonly name: string;
  
  // === 生命周期 ===
  
  /**
   * 初始化 adapter（如连接到 runtime）
   */
  init(): Promise<void>;
  
  /**
   * 关闭 adapter
   */
  shutdown(): Promise<void>;
  
  // === Agent 管理 ===
  
  /**
   * 创建 agent
   * 在 runtime 中注册一个"空白"agent
   */
  createAgent(id: string, options?: CreateAgentOptions): Promise<void>;
  
  /**
   * 删除 agent
   */
  deleteAgent(id: string): Promise<void>;
  
  /**
   * 检查 agent 是否存在
   */
  hasAgent(id: string): Promise<boolean>;
  
  /**
   * 列出所有 agents
   */
  listAgents(): Promise<string[]>;
  
  // === 配置注入 ===
  
  /**
   * 注入配置到 agent
   * 
   * 这是核心方法。在 agent 会话启动前，
   * 将 SoulConfig + Skills 翻译成目标 runtime 的格式并注入。
   * 
   * 不同 runtime 的实现方式：
   * - OpenClaw: 写入 workspace bootstrap 文件（SOUL.md / TOOLS.md / SESSION_CONTEXT.md）
   * - Codex: 生成 AGENTS.md + CLAUDE.md
   * - Claude Code: 生成 CLAUDE.md + .claude/instructions
   * - OpenCode: 生成配置文件
   */
  injectConfig(id: string, soul: SoulConfig, skills: SkillConfig[]): Promise<void>;
  
  // === 通信 ===
  
  /**
   * 发送消息给 agent
   */
  sendMessage(to: string, message: string): Promise<void>;
  
  /**
   * 注册消息回调
   */
  onMessage(callback: MessageCallback): void;
  
  /**
   * 注销消息回调
   */
  offMessage(callback: MessageCallback): void;
  
  // === 状态 ===
  
  /**
   * 获取 agent 状态
   */
  getAgentStatus(id: string): Promise<AgentRuntimeStatus>;
  
  /**
   * 获取连接状态
   */
  isConnected(): boolean;
}

/**
 * CreateAgentOptions - 创建 agent 的选项
 */
export interface CreateAgentOptions {
  /** 工作目录 */
  workspace?: string;
  /** 初始配置 */
  soul?: SoulConfig;
  /** 初始 skills */
  skills?: string[];
}

/**
 * AgentRuntimeStatus - Agent 在 runtime 中的状态
 */
export type AgentRuntimeStatus = 
  | 'idle'       // 空闲
  | 'working'    // 工作中
  | 'error'      // 错误
  | 'offline';   // 离线

/**
 * AgentSessionStatus - Agent 会话详细状态（#T051-1）
 * 
 * 用于区分不同层级的状态，避免混淆"已配置"和"在线"
 */
export interface AgentSessionStatus {
  /** 本地 ID */
  id: string;
  
  /** 配置状态：运行时目录是否已创建 */
  configured: boolean;
  
  /** 会话状态：是否有活跃的 session */
  sessionReady: boolean;
  
  /** 在线状态：是否在最近有响应（心跳或消息） */
  online: boolean;
  
  /** 运行时状态：idle/working/error/offline */
  runtimeStatus: AgentRuntimeStatus;
  
  /** 最后心跳时间（毫秒时间戳） */
  lastHeartbeat?: number;
  
  /** 最后响应时间（毫秒时间戳） */
  lastResponse?: number;
  
  /** 最近错误（如果有） */
  lastError?: string;
  
  /** 详细状态描述 */
  statusDetail: 'not_configured' | 'configured_offline' | 'session_ready' | 'online' | 'working' | 'error';
}

/**
 * MessageCallback - 消息回调类型
 */
export type MessageCallback = (from: string, to: string | null, message: string, metadata?: MessageMetadata) => void;

/**
 * MessageMetadata - 消息元数据
 */
export interface MessageMetadata {
  /** 消息类型 */
  type: 'reply' | 'thinking' | 'status' | 'error';
  /** 使用的模型 */
  model?: string;
  /** Token 使用 */
  tokens?: { input: number; output: number };
  /** 耗时（毫秒） */
  duration?: number;
}

// ============================================================================
// Adapter Registry
// ============================================================================

/**
 * RuntimeAdapterFactory - Runtime Adapter 工厂函数类型
 */
export type RuntimeAdapterFactory = () => AgentRuntimeAdapter;

/**
 * 全局 adapter 注册表
 */
const adapterRegistry = new Map<string, RuntimeAdapterFactory>();

/**
 * 注册 runtime adapter
 */
export function registerRuntimeAdapter(name: string, factory: RuntimeAdapterFactory): void {
  adapterRegistry.set(name, factory);
}

/**
 * 获取 runtime adapter
 */
export function getRuntimeAdapter(name: string): AgentRuntimeAdapter | null {
  const factory = adapterRegistry.get(name);
  if (!factory) return null;
  return factory();
}

/**
 * 列出已注册的 runtime 名称
 */
export function listRuntimes(): string[] {
  return Array.from(adapterRegistry.keys());
}
