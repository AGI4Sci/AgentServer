import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

export class GeminiCliAgent {
  constructor(options = {}) {
    this.cwd = typeof options.cwd === 'string' ? options.cwd : process.cwd();
  }

  session(options = {}) {
    return new GeminiFunctionalSmokeSession(this.cwd, options.sessionId);
  }
}

class GeminiFunctionalSmokeSession {
  constructor(cwd, sessionId) {
    this.cwd = cwd;
    this.id = sessionId || `gemini-functional-smoke-${Date.now().toString(36)}`;
  }

  async *sendStream(prompt, signal) {
    if (signal?.aborted) {
      throw new Error('Gemini functional smoke aborted before start');
    }
    const handoff = parseHandoff(prompt);
    const backend = handoff?.metadata?.backend || 'gemini';
    await appendFile(
      join(this.cwd, 'AGENT_BACKEND_SMOKE.md'),
      `functional smoke completed by ${backend}\n`,
      'utf8',
    );
    yield {
      type: 'tool_call_request',
      value: {
        name: 'write_file',
        args: {
          path: 'AGENT_BACKEND_SMOKE.md',
          mode: 'append',
        },
      },
    };
    yield {
      type: 'tool_call_response',
      value: {
        name: 'write_file',
        status: 'ok',
      },
    };
    yield {
      type: 'content',
      value: `Gemini functional smoke completed for ${backend}.`,
    };
    yield {
      type: 'finished',
      value: {
        status: 'completed',
      },
    };
  }
}

function parseHandoff(prompt) {
  const marker = 'AgentServer handoff packet:';
  const index = prompt.indexOf(marker);
  if (index < 0) {
    return null;
  }
  try {
    return JSON.parse(prompt.slice(index + marker.length).trim());
  } catch {
    return null;
  }
}
