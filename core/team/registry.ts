/**
 * OpenTeam Studio - Team Registry
 * Team 配置运行时服务
 *
 * 职责：
 * 1. 加载和管理 Team 配置
 * 2. 成员查询和验证
 * 3. 角色类型判断（coordinator/executor）
 * 4. SOUL.md 通信约束生成
 *
 * 设计文档: docs/communication_design_plan.md
 */

import type {
  TeamConfig,
  MemberConfig,
  MemberInfo,
  ValidationError,
  RoleType,
} from './types.js';
import { TEAM_CONFIG_VERSION } from './types.js';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Dirent } from 'fs';
import { resolveTeamConfigPath } from './team-config-manager.js';

// ============================================================================
// TeamRegistry 类
// ============================================================================

export class TeamRegistry {
  private config: TeamConfig;
  private memberCache: Map<string, MemberConfig>;
  private teamDir: string | null = null;

  constructor(config: TeamConfig, teamDir?: string) {
    // 向后兼容：转换旧格式配置
    this.config = this.normalizeConfig(config);
    this.teamDir = teamDir ?? null;
    this.memberCache = new Map();
    this.buildMemberCache();
  }

  /**
   * 标准化配置（处理旧格式）
   */
  private normalizeConfig(raw: any): TeamConfig {
    // 检查是否需要转换（旧格式特征：成员没有 roleType，或存在 entry 字段）
    const needsConversion = raw.members?.some((m: any) => !m.roleType) || raw.entry;

    if (needsConversion) {
      console.warn(`[TeamRegistry] 检测到旧版配置，已自动转换（team: ${raw.id}）`);
      return this.convertLegacyConfig(raw);
    }

    return raw;
  }

  /**
   * 将旧版 team.config.json 转换为新格式。
   * 旧格式特征：有 communication.coordinator 或 entry 字段，members 无 roleType。
   * 转换规则：
   *   - 旧格式的 entry 或 communication.coordinator 对应的成员 → roleType: 'coordinator'
   *   - 其余成员 → roleType: 'executor'
   *   - 删除 entry 和 communication 整块
   */
  private convertLegacyConfig(raw: any): TeamConfig {
    const coordinatorId = raw.entry
      ?? raw.communication?.coordinator
      ?? null;

    const members = (raw.members ?? []).map((m: any) => ({
      ...m,
      roleType: m.roleType                           // 已有 roleType，保留
        ?? (m.id === coordinatorId ? 'coordinator' : 'executor'),  // 旧格式，推导
      roleName: m.roleName ?? m.role,                 // 兼容旧的 role 字段
    }));

    // 验证有且只有一个协调者
    const coordinators = members.filter((m: any) => m.roleType === 'coordinator');
    if (coordinators.length === 0) {
      throw new Error(`[TeamRegistry] 配置错误：team "${raw.id}" 没有协调者（roleType: 'coordinator'）`);
    }
    if (coordinators.length > 1) {
      throw new Error(`[TeamRegistry] 配置错误：team "${raw.id}" 有多个协调者：${coordinators.map((m: any) => m.id).join(', ')}`);
    }

    // 返回新格式配置（不包含 entry 和 communication）
    const { entry, communication, ...rest } = raw;
    return { ...rest, members };
  }

  // ==========================================================================
  // 静态工厂方法
  // ==========================================================================

  /**
   * 从配置文件加载 Team
   */
  static fromFile(configPath: string): TeamRegistry {
    if (!existsSync(configPath)) {
      throw new Error(`Team config not found: ${configPath}`);
    }

    const content = readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content) as TeamConfig;

    // 自动推导 teamDir（配置文件所在目录）
    const teamDir = join(configPath, '..');

    // 验证配置
    const registry = new TeamRegistry(config, teamDir);
    const errors = registry.validate();

    if (errors.some(e => e.severity === 'error')) {
      const errorMessages = errors
        .filter(e => e.severity === 'error')
        .map(e => `${e.path}: ${e.message}`)
        .join('\n');
      throw new Error(`Invalid team config:\n${errorMessages}`);
    }

    return registry;
  }

  /**
   * 从 JSON 对象创建 Team
   */
  static fromJson(config: unknown): TeamRegistry {
    if (!this.isValidConfig(config)) {
      throw new Error('Invalid team config format');
    }
    return new TeamRegistry(config);
  }

  /**
   * 类型守卫：检查是否为有效的 TeamConfig
   */
  private static isValidConfig(config: unknown): config is TeamConfig {
    if (typeof config !== 'object' || config === null) return false;

    const c = config as Record<string, unknown>;
    return (
      typeof c.version === 'string' &&
      typeof c.id === 'string' &&
      typeof c.name === 'string' &&
      Array.isArray(c.members)
    );
  }

  // ==========================================================================
  // 配置访问
  // ==========================================================================

  /** 获取完整配置 */
  get raw(): Readonly<TeamConfig> {
    return this.config;
  }

  /** 获取团队 ID */
  get id(): string {
    return this.config.id;
  }

  /** 获取团队名称 */
  get name(): string {
    return this.config.name;
  }

  /** 获取团队目录 */
  getTeamDir(): string | null {
    return this.teamDir;
  }

  /**
   * 获取协调者 ID。
   * 如果没有协调者（配置错误），抛出异常而不是返回 null，
   * 因为没有协调者的 team 无法正常工作。
   */
  getCoordinator(): string {
    const coordinator = this.getMembers().find(m => m.roleType === 'coordinator');
    if (!coordinator) {
      throw new Error(`[TeamRegistry] team "${this.id}" 没有协调者`);
    }
    return coordinator.id;
  }

  // ==========================================================================
  // 成员管理
  // ==========================================================================

  /**
   * 检查是否为团队成员
   */
  isMember(agentId: string): boolean {
    return this.memberCache.has(agentId);
  }

  /**
   * 获取成员配置
   */
  getMember(agentId: string): MemberConfig | undefined {
    return this.memberCache.get(agentId);
  }

  /**
   * 获取所有成员
   */
  getMembers(): MemberConfig[] {
    return Array.from(this.memberCache.values());
  }

  /**
   * 获取成员运行时信息
   */
  getMemberInfo(agentId: string): MemberInfo | undefined {
    const member = this.memberCache.get(agentId);
    if (!member) return undefined;
    return { ...member };
  }

  // ==========================================================================
  // 角色类型判断
  // ==========================================================================

  /**
   * 获取指定成员的角色类型。
   * 返回 null 表示该 ID 不是团队成员（包括 'user'）。
   */
  getRoleType(agentId: string): RoleType | null {
    const member = this.memberCache.get(agentId);
    return member?.roleType ?? null;
  }

  /**
   * 判断指定成员是否为协调者。
   */
  isCoordinator(agentId: string): boolean {
    return this.getRoleType(agentId) === 'coordinator';
  }

  /**
   * 判断指定成员是否为执行者。
   */
  isExecutor(agentId: string): boolean {
    return this.getRoleType(agentId) === 'executor';
  }

  /**
   * 按角色名称获取成员（PM/Dev/Reviewer/QA 等）
   */
  getMembersByRoleName(roleName: string): MemberConfig[] {
    return this.getMembers().filter(m => m.roleName === roleName);
  }

  /**
   * 按角色类型获取成员（coordinator/executor）
   */
  getMembersByRoleType(roleType: RoleType): MemberConfig[] {
    return this.getMembers().filter(m => m.roleType === roleType);
  }

  /**
   * 获取所有角色名称列表
   */
  getRoleNames(): string[] {
    const roleNames = new Set(this.getMembers().map(m => m.roleName).filter(Boolean) as string[]);
    return Array.from(roleNames);
  }

  // ==========================================================================
  // SOUL.md 通信约束生成
  // ==========================================================================

  /**
   * 生成动态通信约束，注入到 SOUL.md。
   *
   * 重要：
   * - 协调者：获得完整成员列表 + 分配/汇总职责说明
   * - 执行者：不获得成员列表，只告知"回复给叫你的人"
   *
   * @param agentId 要生成约束的成员 ID
   */
  generateCommunicationConstraints(agentId: string): string {
    const roleType = this.getRoleType(agentId);
    const member = this.getMember(agentId);
    const skillSet = new Set(member?.skills || []);
    if (!roleType) {
      throw new Error(`[TeamRegistry] 无法为非成员生成通信约束：${agentId}`);
    }

    if (roleType === 'coordinator') {
      const members = this.getMembers().filter(m => m.id !== agentId);
      const memberList = members
        .map(m => `@${m.id}${m.name ? `  ← ${m.roleName ?? '成员'}，${m.name}` : ''}`)
        .join('\n');

      return `
# 通信规则（系统生成，禁止修改）

你是团队的**协调者**。你的职责是分配任务和汇总结果，不是执行任务本身。

## 团队成员（可联系的完整列表）

${memberList}

## 行为规则

- 收到用户请求时：拆解任务，优先使用结构化派工协议，而不是只写自然语言 @mention
- 收到用户请求时：基于黑板事实拆解任务，优先输出结构化 \`[[COORDINATOR_OUTPUT]]\`，不要回退到旧的纯文本派工协议
- 用户要求“调试 / 修复 / 更新文件 / 跑网页 / 验证页面 / 修改 PROJECT.md”时，必须派给具备对应技能的执行者去真实操作，不能自己代替执行，也不能接受“只做推测分析”的口头回复
- 正式协调输出时，使用以下格式：
  \`[[COORDINATOR_OUTPUT]] { ...valid JSON... } [[/COORDINATOR_OUTPUT]]\`
- 用 \`proposals\` 表达新增下游工作；每个 proposal 只对应一个可 materialize 的候选任务，\`suggestedAssignee\` 必须是上方成员完整 ID
- 派工内容要落到结构化字段里，不要再输出旧的逐成员文本块；共享上下文只保留真正未被 \`SESSION_CONTEXT\` / \`TASK_SPEC\` 覆盖的增量信息
- 收到执行者结果时：汇总后回复用户，不要把结果原样转发给另一个执行者
- 只接受带真实证据的执行结果：例如实际读取到的文件内容、真实命令输出、真实页面现象、真实修改结果；如果执行者只给计划、猜测、伪造工具调用、或“我无法访问 localhost 所以改为静态分析”，必须要求其重做或改派
- 需要新增下游任务时写 \`proposals\`；需要批准/拒绝/改写 proposal 时写 \`decisions\`；如果缺少用户信息，也要表达成 \`need_user_input\` proposal，而不是旧的控制字段
- **禁止使用名字或缩写**：@Kai、@dev、@pm 等格式无效，只能使用上方列出的完整 @ID
  `.trim();
    }

    // 执行者：故意不提供成员列表
    const toolRules: string[] = [];

    if (skillSet.has('files')) {
      toolRules.push('- 涉及文件、代码、PROJECT.md、设计文档时，必须先真实读取相关文件，再下结论；不要假装已经读过文件');
      toolRules.push('- 如果任务要求修改文件，必须真实修改目标文件后再汇报；不要只写建议中的 diff、伪代码或“应当这样改”');
    }
    if (skillSet.has('shell')) {
      toolRules.push('- 涉及命令、构建、测试、日志、端口、tmux、服务状态时，优先真实运行 shell 命令或检查输出；不要编造命令结果');
    }
    if (skillSet.has('browser')) {
      toolRules.push('- 涉及网页、localhost、UI、控制台、交互、验收时，必须先真实访问页面或使用可用浏览器能力验证；不要用“我是 AI 不能访问 localhost”作为默认借口');
    }

    return `
# 通信规则（系统生成，禁止修改）

你是团队的**执行者**。你的职责是执行分配给你的任务。

## 行为规则

- 当有人 @你时，执行任务，完成后**只回复给叫你的那个人**
- 当你收到 \`[[BLACKBOARD_TASK]]\` 时，只围绕当前 \`taskId\` 执行并回报；不要发散到其他成员或其他任务
- 默认先执行，再汇报；不要把“计划执行什么”伪装成“已经完成了什么”
- 回报结果时，直接给出最小必要事实：\`taskId\`、完成结论或阻塞原因、关键证据、剩余风险；除非当前任务明确要求，否则不要再发明 \`[[RESULT]]\` / \`[[EVIDENCE]]\` / \`[[BLOCKER]]\` 之类旧文本协议
- 禁止伪造证据：不要编造文件内容、网页状态、命令输出、控制台报错、测试结果，也不要写伪工具调用（如 \`read_file(...)\`、\`write_file(...)\`、\`list_directory(...)\`）来冒充真实执行
- 如果任务不明确，直接说明缺什么信息、卡在什么地方、建议下一步；不要自行决策或联系其他人
- **禁止主动 @任何其他成员**
- **禁止使用 @all**
- 你不需要知道团队里还有谁
- 不要额外发明协议；默认使用简洁自然语言、可核验事实和明确结论
- 如果缺少工具、权限、页面打不开、服务没启动、路径不存在，请明确写出阻塞原因，不要降级成纯脑补分析
${toolRules.join('\n')}
`.trim();
  }

  // ==========================================================================
  // 配置验证
  // ==========================================================================

  /**
   * 验证配置完整性
   */
  validate(): ValidationError[] {
    const errors: ValidationError[] = [];

    // 检查版本
    if (this.config.version !== '2.0') {
      errors.push({
        path: 'version',
        message: `版本已升级为 2.0，当前: ${this.config.version}`,
        severity: 'warning',
      });
    }

    // 检查 ID
    if (!this.config.id || !/^[\w-]+$/.test(this.config.id)) {
      errors.push({
        path: 'id',
        message: '团队 ID 必须只包含字母、数字、下划线和连字符',
        severity: 'error',
      });
    }

    // 检查成员
    const memberIds = new Set<string>();
    let coordinatorCount = 0;

    for (const member of this.config.members) {
      if (!member.id) {
        errors.push({
          path: 'members',
          message: '成员必须包含 id 字段',
          severity: 'error',
        });
        continue;
      }

      if (memberIds.has(member.id)) {
        errors.push({
          path: `members.${member.id}`,
          message: `重复的成员 ID: ${member.id}`,
          severity: 'error',
        });
      }
      memberIds.add(member.id);

      if (!member.roleType) {
        errors.push({
          path: `members.${member.id}.roleType`,
          message: '成员必须指定 roleType（coordinator 或 executor）',
          severity: 'error',
        });
      } else if (member.roleType === 'coordinator') {
        coordinatorCount++;
      }
    }

    // 检查协调者数量
    if (coordinatorCount === 0) {
      errors.push({
        path: 'members',
        message: '团队必须有且只有一个协调者（roleType: coordinator）',
        severity: 'error',
      });
    } else if (coordinatorCount > 1) {
      errors.push({
        path: 'members',
        message: `团队只能有一个协调者，当前有 ${coordinatorCount} 个`,
        severity: 'error',
      });
    }

    return errors;
  }

  // ==========================================================================
  // 私有方法
  // ==========================================================================

  /**
   * 构建成员缓存
   */
  private buildMemberCache(): void {
    this.memberCache.clear();
    for (const member of this.config.members) {
      this.memberCache.set(member.id, member);
    }
  }
}

// ============================================================================
// 全局注册表
// ============================================================================

const registries = new Map<string, TeamRegistry>();

/**
 * 注册 Team
 */
export function registerTeam(registry: TeamRegistry): void {
  registries.set(registry.id, registry);
}

/**
 * 获取 Team 注册表
 */
export function getTeamRegistry(teamId: string): TeamRegistry | undefined {
  return registries.get(teamId);
}

/**
 * 获取所有 Team
 */
export function getAllTeams(): TeamRegistry[] {
  return Array.from(registries.values());
}

export function reloadTeamRegistry(teamId: string): TeamRegistry | undefined {
  const configPath = resolveTeamConfigPath(teamId);
  if (!configPath || !existsSync(configPath)) {
    registries.delete(teamId);
    return undefined;
  }
  const registry = TeamRegistry.fromFile(configPath);
  registerTeam(registry);
  return registry;
}

/**
 * 清空注册表（用于测试）
 */
export function clearRegistries(): void {
  registries.clear();
}

/**
 * 从目录加载所有 Team 配置
 */
export function loadTeamsFromDirectory(teamsDir: string): TeamRegistry[] {
  const loaded: TeamRegistry[] = [];

  if (!existsSync(teamsDir)) {
    console.warn(`[TeamRegistry] Teams directory not found: ${teamsDir}`);
    return loaded;
  }

  const teamDirs = readdirSync(teamsDir, { withFileTypes: true })
    .filter((d: Dirent) => d.isDirectory())
    .map((d: Dirent) => d.name);

  for (const teamId of teamDirs) {
    const configPath = join(teamsDir, teamId, 'team.config.json');

    if (existsSync(configPath)) {
      try {
        const registry = TeamRegistry.fromFile(configPath);
        registerTeam(registry);
        loaded.push(registry);
        console.log(`[TeamRegistry] Loaded team: ${registry.name} (${teamId}) with ${registry.getMembers().length} members`);
      } catch (err) {
        console.error(`[TeamRegistry] Failed to load team ${teamId}:`, err);
      }
    }
  }

  return loaded;
}
