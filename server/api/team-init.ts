/**
 * Team API Routes
 * 
 * 团队管理：状态查询、成员初始化
 */

import { IncomingMessage, ServerResponse } from 'http';
import { getTeamRegistry, getAllTeams } from '../../core/team/registry.js';
import { getTeamInitializer, type InitResult } from '../../core/team/initializer.js';
import { resolveRuntimeBackend } from '../runtime/session-runner-registry.js';
import { resolveBackendModelSelection } from '../runtime/backend-model-contract.js';
import {
  supportsRuntimeSupervisor,
} from '../runtime/team-worker-manager.js';
import {
  disposeSupervisorSession,
  ensureSupervisorSession,
  listSupervisorSessions,
  shutdownSupervisorSessions,
} from '../runtime/supervisor-client.js';

function normalizeSupervisorModel(
  runtime: string,
  config: { model?: string; modelProvider?: string; modelName?: string },
): string | null {
  if (!supportsRuntimeSupervisor(runtime)) {
    return null;
  }
  return resolveBackendModelSelection(runtime, config).modelIdentifier;
}

async function readJsonBody<T extends object>(
  req: IncomingMessage,
): Promise<Partial<T>> {
  const body = await new Promise<string>((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as Partial<T>;
  } catch {
    return {};
  }
}

/**
 * 处理 Team API 请求
 */
export async function handleTeamInitRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  _teamsDir: string
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  // GET /api/team - 获取所有团队
  if (url === '/api/team' && method === 'GET') {
    return await handleGetAllTeams(req, res);
  }

  // GET /api/team/:teamId/status - 获取团队初始化状态
  const statusMatch = url.match(/^\/api\/team\/([^\/]+)\/status$/);
  if (statusMatch && method === 'GET') {
    return await handleGetTeamStatus(req, res, statusMatch[1]);
  }
  
  // GET /api/team/:teamId/session-status - 获取团队详细会话状态（#T051-1）
  const sessionStatusMatch = url.match(/^\/api\/team\/([^\/]+)\/session-status$/);
  if (sessionStatusMatch && method === 'GET') {
    return await handleGetTeamSessionStatus(req, res, sessionStatusMatch[1]);
  }

  const runtimeStartMatch = url.match(/^\/api\/team\/([^\/]+)\/runtime\/start$/);
  if (runtimeStartMatch && method === 'POST') {
    return await handleStartTeamRuntime(req, res, runtimeStartMatch[1]);
  }

  const runtimeStopMatch = url.match(/^\/api\/team\/([^\/]+)\/runtime\/stop$/);
  if (runtimeStopMatch && method === 'POST') {
    return await handleStopTeamRuntime(req, res, runtimeStopMatch[1]);
  }

  const runtimeSessionsMatch = url.match(/^\/api\/team\/([^\/]+)\/runtime\/sessions$/);
  if (runtimeSessionsMatch && method === 'GET') {
    return await handleListTeamRuntimeSessions(req, res, runtimeSessionsMatch[1]);
  }

  // POST /api/team/:teamId/init - 初始化团队
  const initMatch = url.match(/^\/api\/team\/([^\/]+)\/init$/);
  if (initMatch && method === 'POST') {
    return await handleInitTeam(req, res, initMatch[1]);
  }

  // POST /api/team/:teamId/init/:memberId - 初始化单个成员
  const initMemberMatch = url.match(/^\/api\/team\/([^\/]+)\/init\/([^\/]+)$/);
  if (initMemberMatch && method === 'POST') {
    return await handleInitMember(req, res, initMemberMatch[1], initMemberMatch[2]);
  }
  
  // POST /api/team/:teamId/chat - 发送消息（统一 runtime 链路也经过 Router，#T051-2）
  const chatMatch = url.match(/^\/api\/team\/([^\/]+)\/chat$/);
  if (chatMatch && method === 'POST') {
    return await handleChatMessage(req, res, chatMatch[1]);
  }

  // GET /api/team/:teamId - 获取团队详情
  const detailMatch = url.match(/^\/api\/team\/([^\/]+)$/);
  if (detailMatch && method === 'GET') {
    return await handleGetTeamDetail(req, res, detailMatch[1]);
  }

  return false;
}

/**
 * 获取所有团队
 */
async function handleGetAllTeams(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  try {
    const teams = getAllTeams().map(registry => ({
      id: registry.id,
      name: registry.name,
      coordinator: registry.getCoordinator(),
      memberCount: registry.getMembers().length,
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      teams,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  
  return true;
}

/**
 * 获取团队详情
 */
async function handleGetTeamDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<boolean> {
  try {
    const registry = getTeamRegistry(teamId);
    
    if (!registry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: `Team not found: ${teamId}`,
      }));
      return true;
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      team: {
        id: registry.id,
        name: registry.name,
        coordinator: registry.getCoordinator(),
        members: registry.getMembers().map(m => ({
          id: m.id,
          role: m.roleName,
          name: m.name,
          model: m.model,
          modelProvider: m.modelProvider,
          modelName: m.modelName,
          skills: m.skills,
          required: m.required,
        })),
      },
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  
  return true;
}

/**
 * 获取团队初始化状态
 */
async function handleGetTeamStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<boolean> {
  try {
    const initializer = getTeamInitializer();
    const status = await initializer.checkInitStatus(teamId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      status,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  
  return true;
}

/**
 * 获取团队详细会话状态（#T051-1）
 * 
 * 区分不同层级的状态：
 * - configured: 运行时目录是否存在
 * - sessionReady: 是否有活跃 session
 * - online: 是否有最近响应
 * 
 * 用于 Dashboard 和 PM 准确判断成员在线状态
 */
async function handleGetTeamSessionStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<boolean> {
  try {
    const initializer = getTeamInitializer();
    const status = await initializer.checkInitStatus(teamId);
    const registry = getTeamRegistry(teamId);
    const runtime = resolveRuntimeBackend(registry?.raw.runtime);
    const canUseSupervisor = supportsRuntimeSupervisor(runtime);
    const supervisorSessions = canUseSupervisor
      ? await listSupervisorSessions(runtime, teamId)
      : [];
    const mergedMembers = status.members.map((member) => {
      if (!canUseSupervisor) {
        return member;
      }
      const session = supervisorSessions.find((candidate) => candidate.agentId === member.id) || null;
      if (!session) {
        return member;
      }
      return {
        ...member,
        sessionReady: member.sessionReady || session.sessionReady,
        online: member.online || session.online,
        runtimeStatus: session.status === 'busy'
          ? 'working'
          : session.status === 'error'
            ? 'error'
            : (member.runtimeStatus || (session.online ? 'idle' : 'offline')),
        statusDetail: session.status === 'busy'
          ? 'persistent_busy'
          : session.status === 'ready'
            ? 'persistent_ready'
            : session.status === 'error'
              ? 'error'
              : (member.statusDetail || 'configured_offline'),
        lastHeartbeat: (member as any).lastHeartbeat ?? (session.lastEventAt ? Date.parse(session.lastEventAt) : undefined),
        lastResponse: (member as any).lastResponse ?? (session.lastUsedAt ? Date.parse(session.lastUsedAt) : undefined),
        error: member.error || session.lastError || undefined,
      };
    });
    
    // 统计在线成员
    const onlineMembers = mergedMembers.filter(m => m.online);
    const sessionReadyMembers = mergedMembers.filter(m => m.sessionReady);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      teamId: status.teamId,
      teamName: status.teamName,
      totalMembers: status.totalMembers,
      // 配置状态
      configuredCount: status.initializedMembers.length,
      uninitializedCount: status.uninitializedMembers.length,
      // 会话状态
      sessionReadyCount: sessionReadyMembers.length,
      // 在线状态
      onlineCount: onlineMembers.length,
      // 详细成员状态
      members: mergedMembers.map(m => ({
        id: m.id,
        role: m.role,
        name: m.name,
        // 状态层级
        configured: m.configured ?? m.initialized,
        sessionReady: m.sessionReady ?? false,
        online: m.online ?? false,
        runtimeStatus: m.runtimeStatus ?? (m.initialized ? 'idle' : 'offline'),
        statusDetail: m.statusDetail ?? (m.initialized ? 'configured_offline' : 'not_configured'),
        // 时间戳
        lastHeartbeat: (m as any).lastHeartbeat,
        lastResponse: (m as any).lastResponse,
        // 错误信息
        error: m.error,
      })),
      // 汇总
      summary: {
        allConfigured: status.isFullyInitialized,
        allOnline: onlineMembers.length === status.totalMembers,
        anyOnline: onlineMembers.length > 0,
      },
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  
  return true;
}

async function handleStartTeamRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<boolean> {
  try {
    const registry = getTeamRegistry(teamId);
    if (!registry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: `Team not found: ${teamId}`,
      }));
      return true;
    }

    const runtime = resolveRuntimeBackend(registry.raw.runtime);
    if (!supportsRuntimeSupervisor(runtime)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: `backend ${runtime} 暂未接入后台常驻 supervisor`,
        runtime,
        sessions: [],
      }));
      return true;
    }

    const parsed = await readJsonBody<{ members?: string[] }>(req);
    const requestedMembers = Array.isArray(parsed.members)
      ? parsed.members.filter((value) => typeof value === 'string' && value.trim())
      : undefined;

    const targetMembers = registry.getMembers()
      .filter((member) => !requestedMembers || requestedMembers.includes(member.id));
    const sessions = [];
    for (const member of targetMembers) {
      const session = await ensureSupervisorSession(runtime, {
        teamId,
        agentId: member.id,
        cwd: registry.getTeamDir() || undefined,
        model: normalizeSupervisorModel(runtime, member),
        modelProvider: member.modelProvider ?? null,
        modelName: member.modelName ?? null,
        sessionMode: 'persistent',
        persistentKey: `team:${teamId}:agent:${member.id}`,
      });
      sessions.push(session);
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      message: `已预热 ${sessions.length} 个 ${runtime} 常驻会话`,
      runtime,
      sessions,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }

  return true;
}

async function handleStopTeamRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<boolean> {
  try {
    const registry = getTeamRegistry(teamId);
    if (!registry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: `Team not found: ${teamId}`,
      }));
      return true;
    }

    const runtime = resolveRuntimeBackend(registry.raw.runtime);
    if (!supportsRuntimeSupervisor(runtime)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: `backend ${runtime} 暂未接入后台常驻 supervisor`,
        runtime,
        stopped: [],
      }));
      return true;
    }

    const parsed = await readJsonBody<{ members?: string[]; reason?: string }>(req);
    const requestedMembers = Array.isArray(parsed.members)
      ? parsed.members.filter((value) => typeof value === 'string' && value.trim())
      : undefined;
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'Runtime session stopped by API';

    const activeSessions = await listSupervisorSessions(runtime, teamId);
    const stopped = requestedMembers && requestedMembers.length > 0
      ? (await Promise.all(
          requestedMembers.map((agentId) => disposeSupervisorSession(runtime, {
            teamId,
            agentId,
            persistentKey: `team:${teamId}:agent:${agentId}`,
            reason,
          })),
        )).filter((session): session is NonNullable<typeof session> => Boolean(session))
      : await shutdownSupervisorSessions(runtime, teamId, reason);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      message: requestedMembers && requestedMembers.length > 0
        ? `已关闭 ${stopped.length} 个 ${runtime} 常驻会话`
        : `已关闭 ${runtime} 的全部常驻会话`,
      runtime,
      stopped,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }

  return true;
}

async function handleListTeamRuntimeSessions(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
): Promise<boolean> {
  try {
    const registry = getTeamRegistry(teamId);
    if (!registry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: `Team not found: ${teamId}`,
      }));
      return true;
    }

    const runtime = resolveRuntimeBackend(registry.raw.runtime);
    const sessions = supportsRuntimeSupervisor(runtime)
      ? await listSupervisorSessions(runtime, teamId)
      : [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      teamId,
      runtime,
      supported: supportsRuntimeSupervisor(runtime),
      sessions,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }

  return true;
}

/**
 * 初始化团队
 */
async function handleInitTeam(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // 解析请求体
        let options: { members?: string[]; sendInitialMessage?: boolean } = {};
        if (body) {
          try {
            options = JSON.parse(body);
          } catch {
            // 忽略解析错误，使用默认选项
          }
        }
        
        const initializer = getTeamInitializer();
        
        // 检查当前状态
        const statusBefore = await initializer.checkInitStatus(teamId);
        
        // 如果已完全初始化，返回提示
        if (statusBefore.isFullyInitialized) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            message: '团队成员已全部初始化',
            result: {
              success: statusBefore.initializedMembers,
              failed: [],
              allSuccess: true,
            },
            status: statusBefore,
          }));
          resolve(true);
          return;
        }
        
        // 执行初始化
        const result: InitResult = await initializer.initializeAll(teamId, options);
        
        // 获取最新状态
        const statusAfter = await initializer.checkInitStatus(teamId);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: result.allSuccess
            ? `团队初始化完成：${result.success.length} 个成员`
            : `团队初始化部分完成：${result.success.length} 成功，${result.failed.length} 失败`,
          result,
          status: statusAfter,
        }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
      resolve(true);
    });
  });
}

/**
 * 初始化单个成员
 */
async function handleInitMember(
  _req: IncomingMessage,
  res: ServerResponse,
  teamId: string,
  memberId: string
): Promise<boolean> {
  try {
    const initializer = getTeamInitializer();
    
    await initializer.initializeMember(teamId, memberId);
    
    // 获取最新状态
    const status = await initializer.checkInitStatus(teamId);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      message: `成员 ${memberId} 初始化成功`,
      status,
    }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }));
  }
  
  return true;
}

/**
 * 发送消息（统一 runtime 链路经过 Router，#T051-2）
 * 
 * 统一消息链路：前端 -> 服务端 Router -> backend runner
 * 
 * 请求体：
 * {
 *   "to": "pm-01" | "@pm-01",
 *   "body": "消息内容",
 *   "from": "user" (可选，默认 user)
 * }
 */
async function handleChatMessage(
  req: IncomingMessage,
  res: ServerResponse,
  teamId: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { to, body: messageBody, from = 'user', requestId, sourceClientId, isPrivate, projectId, coordinatorAgentId } = data;
        
        if (!to || !messageBody) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Missing to or body' }));
          resolve(true);
          return;
        }
        
        // 解析目标 Agent（本地 ID）
        const localAgentId = to.startsWith('@') ? to.slice(1) : to;
        
        // 动态导入避免循环依赖
        const { handleMessageViaRouter } = await import('../../server/ws-handler.js');
        
        // 通过 MessageRouter 投递消息
        await handleMessageViaRouter(teamId, {
          from,
          to: localAgentId,
          body: messageBody,
          requestId,
          sourceClientId,
          isPrivate,
          coordinatorAgentId,
          projectId,
        });
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          message: 'Message sent via Router',
          to: localAgentId,
          requestId,
        }));
      } catch (error) {
        console.error('[API] Failed to send message:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        }));
      }
      resolve(true);
    });
  });
}
