import type { IncomingMessage, ServerResponse } from 'http';
import { error, sendJson, success } from '../../utils/response.js';
import {
  buildRemoteServicePayload,
  fetchRemoteServices,
  getScpHubApiKey,
  getTool,
  getTools,
  loadToolsFromFile,
  loadToolsFromScpHub,
  refreshTools,
} from './catalog.js';
import { invokeMcpTool, mockInvokeTool } from './invoke.js';
import type { InvokeRequest, InvokeResponse } from './types.js';

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleGetTools(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const data = await getTools();
    if (!data) {
      sendJson(res, 500, error('Failed to load tools data'));
      return true;
    }

    sendJson(res, 200, success({
      categories: data.categories,
      tools: data.tools,
      total: data.tools.length,
      lastUpdated: data.lastUpdated,
    }));
  } catch (err) {
    console.error('[API] Get tools error:', err);
    sendJson(res, 500, error(String(err)));
  }

  return true;
}

async function handleGetTool(_req: IncomingMessage, res: ServerResponse, toolId: string): Promise<boolean> {
  try {
    const tool = await getTool(toolId);
    if (!tool) {
      sendJson(res, 404, error(`Tool not found: ${toolId}`));
      return true;
    }

    const data = await getTools();
    const category = data?.categories.find((item) => item.id === tool.category);
    sendJson(res, 200, success({ tool, category }));
  } catch (err) {
    console.error('[API] Get tool error:', err);
    sendJson(res, 500, error(String(err)));
  }

  return true;
}

async function handleSyncTools(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    console.log('[API] Syncing tools from SCP Hub...');
    const result = await refreshTools();
    if (result.success && result.data) {
      sendJson(res, 200, success({
        message: 'Tools synced successfully',
        total: result.data.tools.length,
        categories: result.data.categories.length,
        lastUpdated: result.data.lastUpdated,
      }));
    } else {
      sendJson(res, 500, error(result.error || 'Failed to sync tools'));
    }
  } catch (err) {
    console.error('[API] Sync tools error:', err);
    sendJson(res, 500, error(String(err)));
  }

  return true;
}

async function handleGetRemoteTools(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    if (!getScpHubApiKey()) {
      sendJson(res, 400, error('SCP_HUB_API_KEY not configured. Cannot fetch remote tools.'));
      return true;
    }

    const data = await loadToolsFromScpHub();
    if (data) {
      sendJson(res, 200, success({
        categories: data.categories,
        tools: data.tools,
        total: data.tools.length,
        lastUpdated: data.lastUpdated,
        source: 'remote',
      }));
    } else {
      sendJson(res, 500, error('Failed to fetch tools from SCP Hub'));
    }
  } catch (err) {
    console.error('[API] Get remote tools error:', err);
    sendJson(res, 500, error(String(err)));
  }

  return true;
}

async function handleGetServices(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    console.log('[API] Fetching services from SCP Hub...');

    if (!getScpHubApiKey()) {
      console.log('[API] No API key, returning local tools');
      const localData = await loadToolsFromFile();
      if (localData) {
        sendJson(res, 200, success({
          services: localData.tools,
          categories: localData.categories,
          total: localData.tools.length,
          lastUpdated: localData.lastUpdated,
          source: 'local',
        }));
      } else {
        sendJson(res, 500, error('No API key configured and failed to load local tools'));
      }
      return true;
    }

    const services = await fetchRemoteServices();
    if (!services) {
      const localData = await loadToolsFromFile();
      if (localData) {
        sendJson(res, 200, success({
          services: localData.tools,
          categories: localData.categories,
          total: localData.tools.length,
          lastUpdated: localData.lastUpdated,
          source: 'local',
        }));
      } else {
        sendJson(res, 502, error('SCP Hub API error'));
      }
      return true;
    }

    const payload = buildRemoteServicePayload(services);
    console.log(`[API] Fetched ${payload.services.length} services from SCP Hub`);
    sendJson(res, 200, success(payload));
  } catch (err) {
    console.error('[API] Get services error:', err);
    const localData = await loadToolsFromFile();
    if (localData) {
      sendJson(res, 200, success({
        services: localData.tools,
        categories: localData.categories,
        total: localData.tools.length,
        lastUpdated: localData.lastUpdated,
        source: 'local',
      }));
    } else {
      sendJson(res, 500, error(String(err)));
    }
  }

  return true;
}

async function handleInvokeTool(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const data = JSON.parse(await readBody(req)) as InvokeRequest;
    const { toolId, action, params = {}, timeout } = data;

    if (!toolId || !action) {
      sendJson(res, 400, error('Missing required fields: toolId, action'));
      return true;
    }

    const tool = await getTool(toolId);
    if (!tool) {
      sendJson(res, 404, error(`Tool not found: ${toolId}`));
      return true;
    }

    if (!tool.tools.includes(action)) {
      sendJson(res, 400, error(`Invalid action: ${action}. Valid actions: ${tool.tools.join(', ')}`));
      return true;
    }

    console.log(`[SCP-Tools] Invoking: ${toolId}.${action}`, params);
    let result: InvokeResponse;
    if (getScpHubApiKey()) {
      result = await invokeMcpTool(toolId, action, params, timeout);
      if (!result.success && result.error?.includes('HTTP 401')) {
        console.log('[SCP-Tools] API authentication failed, falling back to mock mode');
        result = await mockInvokeTool(toolId, action, params);
      }
    } else {
      console.log('[SCP-Tools] Using mock mode (no API key configured)');
      result = await mockInvokeTool(toolId, action, params);
    }

    if (result.success) {
      sendJson(res, 200, success({
        toolId,
        action,
        result: result.result,
        executionTime: result.executionTime,
      }));
    } else {
      sendJson(res, 500, error(result.error || 'Tool invocation failed'));
    }
  } catch (err) {
    console.error('[API] Invoke tool error:', err);
    sendJson(res, 500, error(String(err)));
  }

  return true;
}

export async function handleScpToolsRoutes(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  if (url === '/api/scp-tools' && method === 'GET') {
    return handleGetTools(req, res);
  }
  if (url === '/api/scp-tools/invoke' && method === 'POST') {
    return handleInvokeTool(req, res);
  }
  if (url === '/api/scp-tools/sync' && method === 'POST') {
    return handleSyncTools(req, res);
  }
  if (url === '/api/scp-tools/remote' && method === 'GET') {
    return handleGetRemoteTools(req, res);
  }
  if (url === '/api/scp-tools/services' && method === 'GET') {
    return handleGetServices(req, res);
  }

  const toolMatch = url.match(/^\/api\/scp-tools\/([^\/]+)$/);
  if (toolMatch && method === 'GET') {
    return handleGetTool(req, res, toolMatch[1]);
  }

  return false;
}
