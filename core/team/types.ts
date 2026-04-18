/**
 * OpenTeam Studio - Team Types
 * Team 配置类型定义
 */

import type { BackendType } from '../runtime/backend-catalog.js';

// ============================================================================
// 配置类型
// ============================================================================

/**
 * 角色类型。
 * coordinator = 协调者，有且只有一个，负责分配任务和汇总结果。
 * executor    = 执行者，可以有多个，负责执行任务并只回复来源。
 */
export type RoleType = 'coordinator' | 'executor';

/**
 * 成员配置
 */
export interface MemberConfig {
  /** Agent ID（本地 ID，不含项目前缀） */
  id: string;
  /** 角色类型（必填） */
  roleType: RoleType;
  /** 角色名称（PM/Dev/Reviewer/QA 等，纯展示用途） */
  roleName?: string;
  /** 显示名称 */
  name?: string;
  /** 默认模型 */
  model?: string;
  /** 可选：显式 provider，优先于从 model 字符串解析 */
  modelProvider?: string;
  /** 可选：显式模型名，优先于从 model 字符串解析 */
  modelName?: string;
  /** 技能列表 */
  skills?: string[];
  /** 是否必需成员 */
  required?: boolean;
}

/**
 * 工作流阶段
 */
export interface WorkflowPhase {
  /** 阶段名称 */
  name: string;
  /** 负责的 agent 或 agent 模式 */
  agent?: string | string[];
  /** 输出文件 */
  output?: string;
  /** 是否并行执行 */
  parallel?: boolean;
}

/**
 * 工作流转换
 */
export interface WorkflowTransition {
  /** 来源 agent */
  from: string;
  /** 目标 agent */
  to: string | string[];
  /** 触发条件 */
  trigger: 'mention' | 'condition' | 'manual';
}

/**
 * 工作流配置
 */
export interface WorkflowConfig {
  /** 阶段列表 */
  phases?: WorkflowPhase[];
  /** 转换规则 */
  transitions?: WorkflowTransition[];
}

/**
 * Team 配置（v2.0 格式）
 *
 * 变化（相对于 v1.0）：
 * - 删除 entry 字段：使用 roleType: 'coordinator' 推导协调者
 * - 删除 communication 字段：硬规则由 MessageRouter 代码层实现
 */
export interface TeamConfig {
  /** 配置格式版本 */
  version: string;
  /** 团队唯一标识 */
  id: string;
  /** 团队显示名称 */
  name: string;
  /** 团队描述 */
  description?: string;
  /** 团队成员列表 */
  members: MemberConfig[];
  /** 工作流配置 */
  workflow?: WorkflowConfig;
  /** Runtime 配置 */
  runtime?: TeamRuntimeConfig;
  /** 额外配置 */
  [key: string]: unknown;
}

// ============================================================================
// 运行时类型
// ============================================================================

/**
 * 成员运行时信息
 */
export interface MemberInfo extends MemberConfig {
  /** 运行时状态 */
  status?: 'idle' | 'working' | 'error';
  /** 当前任务 */
  currentTask?: string;
}

/**
 * 配置验证错误
 */
export interface ValidationError {
  /** 错误字段路径 */
  path: string;
  /** 错误消息 */
  message: string;
  /** 错误级别 */
  severity: 'error' | 'warning';
}

// ============================================================================
// Runtime 类型
// ============================================================================

/**
 * Runtime 类型
 */
export type RuntimeType = BackendType;

/**
 * Runtime 隔离模式
 */
export type RuntimeMode = 'shared' | 'isolated';

/**
 * Runtime transport 配置
 */
export interface RuntimeTransportConfig {
  /** 传输层端口（'auto' 表示自动分配） */
  port?: number | 'auto';
  /** 崩溃后自动重启 */
  restartOnCrash?: boolean;
  /** 最大重启次数 */
  maxRestarts?: number;
  /** 重启间隔（毫秒） */
  restartIntervalMs?: number;
  /** 健康检查间隔（毫秒） */
  healthCheckIntervalMs?: number;
}

/**
 * Team Runtime 配置
 */
export interface TeamRuntimeConfig {
  /** Backend 类型 */
  backend?: RuntimeType;
  /** 兼容旧配置读取；新写入不再使用该字段 */
  type?: RuntimeType;
  /** 隔离模式 */
  mode?: RuntimeMode;
  /** 通用 runtime transport 配置 */
  transport?: RuntimeTransportConfig;
  /** 兼容旧配置读取；新写入优先使用 transport */
  gateway?: RuntimeTransportConfig;
  /** 工具策略 */
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  /** 启动期预热配置 */
  startup?: {
    /** 是否在 web 进程启动后自动预热该 team 的常驻 runtime 会话 */
    prewarmOnBoot?: boolean;
    /** 可选：仅预热指定成员；未填写则预热全部成员 */
    members?: string[];
  };
}

// ============================================================================
// 常量
// ============================================================================

/** 当前配置格式版本 */
export const TEAM_CONFIG_VERSION = '2.0';
