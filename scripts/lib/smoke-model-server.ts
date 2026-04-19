import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface SmokeModelServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startSmokeModelServer(): Promise<SmokeModelServer> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'agent-server-smoke-model',
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'agent-server',
          },
        ],
      }));
      return;
    }

    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const raw = await readRequestBody(req);
    const body = raw ? JSON.parse(raw) as { messages?: Array<{ role?: string; content?: string }> } : {};
    const transcript = (body.messages || []).map((message) => message.content || '').join('\n\n');
    const content = transcript.includes('Tool result for list_dir:')
      ? 'The working directory contains README.md and package.json.'
      : '<list_dir><path>.</path></list_dir>';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-smoke-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'agent-server-smoke-model',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Smoke model server did not bind to a TCP port.');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
