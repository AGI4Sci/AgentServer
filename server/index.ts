/**
 * OpenTeam Studio - WebSocket Server
 * WebSocket 服务主入口
 * 
 * 目录结构：
 * - Backend 运行时：项目目录/server/backend/
 * - Team 定义：项目目录/teams/
 * 
 * 路由：
 * - /teams/{teamId}/* → Dashboard 入口或项目运行数据
 * 
 * Runtime 管理：
 * - 所有 Team 通过统一 runtime 入口选择 backend 类型
 */

import { WebSocketServer, WebSocket, RawData } from 'ws';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { readFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { extname, join } from 'path';

import { PROJECT_ROOT, TEAMS_DIR } from './utils/paths.js';
import { getTeamSkillDisplayPath, getTeamSkillFilePath } from './api/teams/shared.js';
import { applyOpenTeamConfigEnv, loadOpenTeamConfig, resolveConfiguredServerPort } from './utils/openteam-config.js';

import type { WebSocketClient, InboundMessage, OutboundMessage } from '../core/types/index.js';
import { getTeamStateManager } from '../core/store/team-state.js';
import { getTeamChatStore } from '../core/store/team-chat-store.js';
import { loadTeamsFromDirectory, getTeamRegistry, getAllTeams } from '../core/team/registry.js';
import type { TeamRegistry } from '../core/team/registry.js';
import { handleInboundMessage, setBroadcastCallback } from './ws-handler.js';
import { handleApiRequest, loadLLMConfig, primeLlmRuntimeFromHealth, setBroadcastCallback as setApiBroadcastCallback } from './api/index.js';
import { getOpenTeamInstance } from '../core/runtime/instance.js';
import { getBackendStateDir, getSharedTeamRuntimeDir } from '../core/runtime/backend-paths.js';
import { refreshCurrentInstanceWorkspaceLeases } from '../core/runtime/runtime-workspace-lease.js';
import { getTeamInitializer } from '../core/team/initializer.js';
import { getHarnessRunRecorder } from '../core/harness/run-recorder.js';
import { prewarmConfiguredTeamRuntimes } from './runtime/runtime-autostart.js';
import { sweepExpiredBlackboardLeases } from './runtime/blackboard-lease-sweep.js';
import { initializeRetrievalProviders } from './retrieval/blackboard-retrieval.js';
import {
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
} from './backend/openclaw/src/infra/net/undici-global-dispatcher.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export interface ServerOptions {
  port: number;
}

export class OpenTeamServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WebSocketClient> = new Map();
  private port: number;
  private agentGcTimer: NodeJS.Timeout | null = null;
  private harnessSweepTimer: NodeJS.Timeout | null = null;
  private workspaceLeaseTimer: NodeJS.Timeout | null = null;
  private blackboardLeaseTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions) {
    this.port = options.port;
  }

  /**
   * 处理 HTTP 请求
   */
  private async handleHttpRequest(
    req: IncomingMessage, 
    res: ServerResponse, 
    teams: any[]
  ): Promise<void> {
    // API 路由
    const handled = await handleApiRequest(req, res, '');
    if (handled) return;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = req.url || '/';

    // Health check
    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        ok: true, 
        clients: this.clients.size,
        teams: teams.length,
        teamsDir: TEAMS_DIR,
      }));
      return;
    }

    // Teams API (legacy)
    if (url === '/api/teams') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(teams));
      return;
    }

    // Team Agents API (legacy)
    const agentsMatch = url.match(/^\/api\/teams\/([^\/]+)\/agents$/);
    if (agentsMatch) {
      const teamId = agentsMatch[1];
      const teamManager = getTeamStateManager();
      const agents = teamManager.getTeamAgents(teamId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agents));
      return;
    }

    // 静态文件服务
    this.serveStatic(url, res);
  }

  /**
   * 静态文件服务
   * 
   * 路由规则：
   * - /ui/* → 项目目录/ui/
   * - /teams/{teamId}/* → 项目目录/teams/{teamId}/
   */
  private serveStatic(url: string, res: ServerResponse): void {
    // 去除查询参数
    const urlPath = url.split('?')[0];
    
    // 根路径重定向到 studio
    if (urlPath === '/' || urlPath === '') {
      res.writeHead(302, { 'Location': '/ui/studio.html' });
      res.end();
      return;
    }

    if (urlPath === '/studio-react') {
      res.writeHead(302, { 'Location': '/studio-react/' });
      res.end();
      return;
    }

    if (urlPath === '/teams-react') {
      res.writeHead(302, { 'Location': '/teams-react/' });
      res.end();
      return;
    }

    let filePath: string;

    // UI 文件 → 项目目录/ui/
    if (urlPath.startsWith('/ui/')) {
      filePath = join(PROJECT_ROOT, urlPath);
    }
    // studio-react 构建产物
    else if (urlPath.startsWith('/studio-react/')) {
      filePath = this.resolveStudioReactPath(urlPath);
    }
    else if (urlPath.startsWith('/teams-react/')) {
      filePath = this.resolveTeamsReactPath(urlPath);
    }
    else if (urlPath.startsWith('/template-packs/')) {
      filePath = join(PROJECT_ROOT, urlPath);
    }
    // Team Dashboard / Team 运行时文件
    else if (urlPath.startsWith('/teams/')) {
      filePath = this.resolveTeamPath(urlPath);
    }
    // 其他文件（兼容旧路径）
    else {
      filePath = join(PROJECT_ROOT, 'ui', urlPath);
    }

    // 安全检查：防止路径遍历攻击
    if (!filePath.startsWith(PROJECT_ROOT)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    // 检查文件是否存在
    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    // 读取并返回文件
    try {
      const content = readFileSync(filePath);
      const ext = extname(filePath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      
      // 禁用缓存（开发模式）
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Content-Type', contentType);
      res.writeHead(200);
      res.end(content);
    } catch (error) {
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  }

  /**
   * 解析 Team 文件路径
   * 
   * 路径结构：
   * - /teams/{teamId}/dashboard.html → React Dashboard 入口
   * - /teams/{teamId}/package/dashboard.html → React Dashboard 入口（兼容固定链接）
   * - /teams/{teamId}/projects/* → 项目运行数据
   * - /teams/{teamId}/* → teams 中的 team 定义 / 项目文件
   */
  private resolveTeamPath(urlPath: string): string {
    const match = urlPath.match(/^\/teams\/([^\/]+)(?:\/(.+))?$/);
    if (!match) {
      return join(TEAMS_DIR, urlPath.replace('/teams/', ''));
    }

    const teamId = match[1];
    const file = match[2] || '';

    if (file === '' || file === 'dashboard.html' || file === 'package/dashboard.html') {
      return join(PROJECT_ROOT, 'teams-react', 'dist', 'vibe-coding.html');
    }

    if (file.startsWith('projects/')) {
      return join(TEAMS_DIR, teamId, file);
    }

    return join(TEAMS_DIR, teamId, file);
  }

  private resolveStudioReactPath(urlPath: string): string {
    const relativePath = urlPath.replace(/^\/studio-react\/?/, '');
    const distRoot = join(PROJECT_ROOT, 'studio-react', 'dist');
    if (!relativePath) {
      return join(distRoot, 'index.html');
    }
    return join(distRoot, relativePath);
  }

  private resolveTeamsReactPath(urlPath: string): string {
    const relativePath = urlPath.replace(/^\/teams-react\/?/, '');
    const distRoot = join(PROJECT_ROOT, 'teams-react', 'dist');
    if (!relativePath) {
      return join(distRoot, 'vibe-coding.html');
    }
    return join(distRoot, relativePath);
  }

  // 团队初始化状态缓存
  private teamInitStatus: Map<string, { initialized: boolean; members: string[] }> = new Map();

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    applyOpenTeamConfigEnv({ overwrite: true });
    ensureGlobalUndiciEnvProxyDispatcher();
    ensureGlobalUndiciStreamTimeouts();

    // 加载 Team 配置到 TeamRegistry（新的权威配置源）
    const loadedRegistries = loadTeamsFromDirectory(TEAMS_DIR);
    console.log(`[Server] Loaded ${loadedRegistries.length} team registries`);

    // 初始化 Team 状态管理（保留用于兼容）
    const teamManager = getTeamStateManager();
    const teams = await teamManager.discoverTeams();
    console.log(`[Server] Discovered ${teams.length} teams`);
    console.log(`[Server] Teams directory: ${TEAMS_DIR}`);

    // 初始化 LLM 配置，并将运行时绑定到第一个健康的 endpoint（含 fallbacks）
    loadLLMConfig();
    void primeLlmRuntimeFromHealth().catch((error) => {
      console.warn('[LLM] primeLlmRuntimeFromHealth failed:', error);
    });
    initializeRetrievalProviders();
    this.startHarnessSweep();

    // 设置广播回调 - 将 OpenClaw 响应广播给所有客户端
    setBroadcastCallback((teamId: string, message: OutboundMessage) => {
      this.broadcast(teamId, message);
    });
    
    // 设置测试 API 的广播回调
    setApiBroadcastCallback((teamId: string, message: OutboundMessage) => {
      this.broadcast(teamId, message);
    });

    // 创建 HTTP server
    const server = createServer((req, res) => {
      void this.handleHttpRequest(req, res, teams).catch((error) => {
        console.error('[Server] HTTP request failed:', error);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
    });

    // 创建 WebSocket server
    this.wss = new WebSocketServer({ server });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    // 注册进程关闭钩子
    const handleShutdown = async (signal: NodeJS.Signals) => {
      console.log(`[Server] Shutting down due to ${signal}...`);
      
      // 某些旧运行时如果仍引用当前 cwd，删除 workspace 可能导致进程进入坏状态。
      // 默认跳过清理；仅在显式开启时执行。
      if (loadOpenTeamConfig().server.cleanupAgentInstancesOnShutdown) {
        this.cleanupAgentInstances();
      } else {
        console.log('[Server] Skip agent workspace cleanup on shutdown (set server.cleanupAgentInstancesOnShutdown=true in openteam.json to enable)');
      }

      if (this.agentGcTimer) {
        clearInterval(this.agentGcTimer);
        this.agentGcTimer = null;
      }
      if (this.workspaceLeaseTimer) {
        clearInterval(this.workspaceLeaseTimer);
        this.workspaceLeaseTimer = null;
      }
      if (this.blackboardLeaseTimer) {
        clearInterval(this.blackboardLeaseTimer);
        this.blackboardLeaseTimer = null;
      }
      
      process.exit(0);
    };

    process.on('SIGINT', () => void handleShutdown('SIGINT'));
    process.on('SIGTERM', () => void handleShutdown('SIGTERM'));

    return new Promise((resolve, reject) => {
      server.listen(this.port, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════════╗');
        console.log('║       OpenTeam Studio - Ready!            ║');
        console.log('╚═══════════════════════════════════════════╝');
        console.log('');
        console.log(`🚀 Studio UI:    http://localhost:${this.port}/ui/studio.html`);
        console.log(`📁 Teams:        http://localhost:${this.port}/teams/vibe-coding/dashboard.html`);
        console.log(`📡 WebSocket:    ws://localhost:${this.port}/ws`);
        console.log(`❤️  Health:       http://localhost:${this.port}/health`);
        console.log('');
        
        // 🆕 后台自动初始化所有团队（不阻塞服务器启动）
        this.backgroundInitializeTeams(loadedRegistries);
        setTimeout(() => {
          this.runAgentGc('startup');
        }, 0).unref();
        this.startWorkspaceLeaseHeartbeat();
        this.startBlackboardLeaseSweep();
        this.scheduleAgentGc();
        
        resolve();
      });
      server.on('error', reject);
    });
  }

  private startHarnessSweep(): void {
    if (this.harnessSweepTimer) {
      clearInterval(this.harnessSweepTimer);
    }

    const recorder = getHarnessRunRecorder();
    const sweepIntervalMs = Math.max(5_000, Math.trunc(loadOpenTeamConfig().runtime.harness.sweepIntervalMs));
    this.harnessSweepTimer = setInterval(() => {
      const abandonedRuns = recorder.sweepAbandonedRuns();
      if (abandonedRuns.length > 0) {
        console.log(`[Harness] Marked ${abandonedRuns.length} run(s) as abandoned`);
      }
    }, sweepIntervalMs);
  }

  private runAgentGc(trigger: 'startup' | 'interval'): void {
    const compiledScriptPath = join(PROJECT_ROOT, 'dist', 'server', 'scripts', 'agent-gc-runner.js');
    const sourceScriptPath = join(PROJECT_ROOT, 'server', 'scripts', 'agent-gc-runner.ts');
    const scriptPath = existsSync(compiledScriptPath) ? compiledScriptPath : sourceScriptPath;

    const execArgs = [...process.execArgv, scriptPath, trigger];
    const child = spawn(process.execPath, execArgs, {
      cwd: PROJECT_ROOT,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }

  private scheduleAgentGc(): void {
    const intervalMs = 60 * 60 * 1000;
    this.agentGcTimer = setInterval(() => {
      this.runAgentGc('interval');
    }, intervalMs);
  }

  private startWorkspaceLeaseHeartbeat(): void {
    if (this.workspaceLeaseTimer) {
      clearInterval(this.workspaceLeaseTimer);
    }
    const heartbeatIntervalMs = Math.max(5_000, Math.trunc(loadOpenTeamConfig().runtime.workspace.leaseHeartbeatIntervalMs));

    const refresh = () => {
      try {
        refreshCurrentInstanceWorkspaceLeases();
      } catch (error) {
        console.warn('[WorkspaceLease] Failed to refresh leases:', error);
      }
    };

    refresh();
    this.workspaceLeaseTimer = setInterval(refresh, heartbeatIntervalMs);
    this.workspaceLeaseTimer.unref();
  }

  private startBlackboardLeaseSweep(): void {
    if (this.blackboardLeaseTimer) {
      clearInterval(this.blackboardLeaseTimer);
    }
    const sweepIntervalMs = Math.max(5_000, Math.trunc(loadOpenTeamConfig().runtime.blackboard.leaseSweepIntervalMs));
    const sweep = () => {
      try {
        const batches = sweepExpiredBlackboardLeases();
        const total = batches.reduce((n, b) => n + b.resets, 0);
        if (total > 0) {
          console.log(`[BlackboardLease] Expired lease sweep: ${total} task(s) reset across ${batches.length} session(s)`);
        }
      } catch (error) {
        console.warn('[BlackboardLease] sweep failed:', error);
      }
    };
    sweep();
    this.blackboardLeaseTimer = setInterval(sweep, sweepIntervalMs);
    this.blackboardLeaseTimer.unref();
  }

  /**
   * 后台自动初始化所有团队
   * 不阻塞服务器启动，初始化完成后通知客户端
   */
  private async backgroundInitializeTeams(registries: TeamRegistry[]): Promise<void> {
    const initializer = getTeamInitializer();
    
    for (const registry of registries) {
      const teamId = registry.id;
      console.log(`[Init] Starting background initialization for team: ${teamId}`);
      
      // 标记初始化中
      this.teamInitStatus.set(teamId, { initialized: false, members: [] });
      
      try {
        const result = await initializer.initializeAll(teamId);
        
        if (result.allSuccess) {
          console.log(`[Init] ✅ Team ${teamId} initialized: ${result.success.join(', ')}`);
          this.teamInitStatus.set(teamId, { 
            initialized: true, 
            members: result.success 
          });
          
          // 通知所有该 team 的客户端
          this.broadcast(teamId, {
            type: 'team-ready',
            teamId,
            members: result.success,
            timestamp: new Date().toISOString(),
          });
        } else {
          console.warn(`[Init] ⚠️ Team ${teamId} partial init: ${result.success.length}/${result.success.length + result.failed.length}`);
          this.teamInitStatus.set(teamId, { 
            initialized: false, 
            members: result.success 
          });
        }
      } catch (error) {
        console.error(`[Init] ❌ Failed to initialize team ${teamId}:`, error);
        continue;
      }

      try {
        await prewarmConfiguredTeamRuntimes([registry]);
        console.log(`[Prewarm] Team ${teamId} runtime prewarm check complete`);
      } catch (error) {
        console.error(`[Prewarm] ❌ Failed to prewarm runtime for team ${teamId}:`, error);
      }
    }
  }

  /**
   * 处理新连接
   */
  private handleConnection(ws: WebSocket, req: import('http').IncomingMessage): void {
    const clientId = randomUUID();
    const url = new URL(req.url || '/', `http://localhost:${this.port}`);
    const teamId = url.searchParams.get('teamId') || 'default';
    const projectId = url.searchParams.get('projectId') || undefined;
    const sessionMode = String(url.searchParams.get('sessionMode') || '').trim();
    const requestedSessionId = String(url.searchParams.get('sessionId') || '').trim();
    const teamChatStore = getTeamChatStore();
    const sessionId = requestedSessionId
      || (sessionMode === 'new' ? teamChatStore.startNewSession(teamId).sessionId : teamChatStore.getActiveSessionId(teamId));

    const client: WebSocketClient = {
      id: clientId,
      teamId,
      projectId,
      sessionId,
      ws,
      connectedAt: new Date().toISOString(),
    };

    this.clients.set(clientId, client);
    console.log(`[WS] Client connected: ${clientId} (team=${teamId})`);

    // 发送会话初始化消息
    const skillPath = getTeamSkillFilePath(teamId);
    const initStatus = this.teamInitStatus.get(teamId);
    
    this.sendToClient(client, {
      type: 'session-init',
      teamId,
      sessionId,
      teamSkillPath: skillPath,
      clientId,
      sharedChatMode: true,
      // 🆕 包含团队初始化状态
      teamReady: initStatus?.initialized ?? false,
      initializedMembers: initStatus?.members ?? [],
      message: `Team skill location: ${getTeamSkillDisplayPath(teamId)}`,
      timestamp: new Date().toISOString(),
    });

    ws.on('message', (data: RawData) => {
      this.handleMessage(client, data);
    });

    ws.on('close', () => {
      this.clients.delete(clientId);
      console.log(`[WS] Client disconnected: ${clientId}`);
    });

    ws.on('error', (error) => {
      console.error(`[WS] Client error ${clientId}:`, error.message);
      this.clients.delete(clientId);
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(client: WebSocketClient, data: RawData): Promise<void> {
    try {
      const message = JSON.parse(data.toString()) as InboundMessage;
      console.log(`[WS] Message from ${client.id}:`, message.type);

      // 处理消息
      const response = await handleInboundMessage(message, client);
      
      if (response) {
        this.sendToClient(client, response);
      }
    } catch (error) {
      console.error(`[WS] Failed to handle message:`, error);
      this.sendToClient(client, {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 清理当前实例创建的 team runtime workspace
   * 
   * Workspace 实例命名规则: workspace-{instanceId}--{localAgentId}
   * 只删除以当前实例 ID 开头的 runtime workspace。
   */
  private cleanupAgentInstances(): void {
    try {
      const instance = getOpenTeamInstance();
      const instanceId = instance.getInstanceId();
      
      let cleaned = 0;
      const stateDirs = [getSharedTeamRuntimeDir(), getBackendStateDir('openclaw')];

      for (const stateDir of stateDirs) {
        if (!existsSync(stateDir)) {
          continue;
        }

        const entries = readdirSync(stateDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          
          if (entry.name.startsWith(`workspace-${instanceId}--`)) {
            const agentPath = join(stateDir, entry.name);
            try {
              rmSync(agentPath, { recursive: true, force: true });
              console.log(`[Cleanup] Removed runtime workspace: ${entry.name}`);
              cleaned++;
            } catch (err) {
              console.error(`[Cleanup] Failed to remove ${entry.name}:`, err);
            }
          }
        }
      }
      
      if (cleaned > 0) {
        console.log(`[Cleanup] Cleaned ${cleaned} agent instances for ${instanceId}`);
      }
    } catch (error) {
      console.error('[Cleanup] Failed to clean agent instances:', error);
    }
  }

  /**
   * 发送消息给客户端
   */
  sendToClient(client: WebSocketClient, message: OutboundMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  /**
   * 广播消息给 Team 所有客户端
   * 如果 teamId 为 "all"，则广播给所有客户端
   */
  broadcast(teamId: string, message: OutboundMessage, excludeClientId?: string): void {
    for (const [id, client] of this.clients) {
      if (id === excludeClientId) continue;
      if (message.isPrivate && message.sourceClientId && id !== message.sourceClientId) {
        continue;
      }
      // 如果 teamId 是 "all"，或者客户端属于该 team，则发送消息
      if (teamId === 'all' || client.teamId === teamId) {
        this.sendToClient(client, message);
      }
    }
  }

  /**
   * 获取连接的客户端数量
   */
  getClientCount(): number {
    return this.clients.size;
  }
}

// 启动服务
const PORT = resolveConfiguredServerPort();

const server = new OpenTeamServer({
  port: PORT,
});

server.start().then(() => {
  console.log(`[Server] Ready at http://localhost:${PORT}`);
}).catch((error) => {
  console.error('[Server] Failed to start:', error);
  process.exit(1);
});
