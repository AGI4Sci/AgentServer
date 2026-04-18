import { promises as fs } from 'fs';
import { dirname, resolve } from 'path';
import { spawn } from 'child_process';

export type LocalDevPrimitiveCall = {
  toolName:
    | 'append_file'
    | 'read_file'
    | 'write_file'
    | 'list_dir'
    | 'grep_search'
    | 'run_command'
    | 'apply_patch'
    | 'web_search'
    | 'web_fetch'
    | 'browser_open'
    | 'browser_activate';
  args: Record<string, string>;
};

export type LocalDevPrimitiveResult = {
  ok: boolean;
  output: string;
};

const TOOL_NAMES = [
  'append_file',
  'read_file',
  'write_file',
  'list_dir',
  'grep_search',
  'run_command',
  'apply_patch',
  'web_search',
  'web_fetch',
  'browser_open',
  'browser_activate',
] as const;

const MAX_OUTPUT_CHARS = 12_000;
const WEB_SEARCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; OpenTeamStudioRuntime/1.0; +https://localhost/openteam)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
};

function truncate(value: string, limit = MAX_OUTPUT_CHARS): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n...[truncated ${value.length - limit} chars]`;
}

function resolveTargetPath(rawPath: string, cwd: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error('Missing required path.');
  }
  return resolve(cwd, trimmed);
}

function isShadowBlackboardPath(targetPath: string): boolean {
  return /(?:^|\/)\.blackboard(?:\/|$)/.test(targetPath);
}

function assertPathAllowed(targetPath: string): void {
  if (isShadowBlackboardPath(targetPath)) {
    throw new Error('Access to .blackboard/* shadow files is forbidden. Use the server-provided blackboard facts in the prompt instead.');
  }
}

function assertCommandAllowed(command: string): void {
  if (/(?:^|[\s"'`])\.blackboard(?:\/|[\s"'`]|$)/.test(command)) {
    throw new Error('Commands that inspect or mutate .blackboard/* shadow files are forbidden. Use the server-provided blackboard facts in the prompt instead.');
  }
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeXmlContentBlock(text: string): string {
  if (text.startsWith('\n')) {
    text = text.slice(1);
  }
  if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  return text;
}

function extractTagValue(body: string, tag: string): string | null {
  const match = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeXml(match[1]).trim() : null;
}

function extractInvokeParameter(body: string, name: string): string | null {
  const match = body.match(new RegExp(`<(?:parameter|param)\\s+name=["']${name}["']>([\\s\\S]*?)</(?:parameter|param)>`, 'i'));
  return match ? decodeXml(match[1]).trim() : null;
}

function extractNamedToolArg(body: string, keys: string[], fallback: string | null = null): string | null {
  for (const key of keys) {
    const parameterValue = extractInvokeParameter(body, key);
    if (parameterValue) {
      return parameterValue;
    }
    const tagValue = extractTagValue(body, key);
    if (tagValue) {
      return tagValue;
    }
  }
  return fallback;
}

function extractNamedToolTagCall(text: string): LocalDevPrimitiveCall | null {
  const match = text.match(/<tool\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool>/i);
  if (!match) {
    return null;
  }
  const toolTagName = normalizeToolCallName(String(match[1] || ''));
  if (!toolTagName) {
    return null;
  }
  const body = match[2] || '';

  if (toolTagName === 'run_command') {
    const command = extractNamedToolArg(body, ['command', 'cmd']);
    const cwd = extractNamedToolArg(body, ['cwd', 'workdir', 'working_directory']);
    if (!command) {
      return null;
    }
    return {
      toolName: 'run_command',
      args: {
        command,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  if (toolTagName === 'append_file') {
    const path = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    const content = extractNamedToolArg(body, ['content', 'text'], '') || '';
    if (!path) {
      return null;
    }
    return {
      toolName: 'append_file',
      args: { path, content },
    };
  }

  if (toolTagName === 'read_file') {
    const path = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    if (!path) {
      return null;
    }
    return {
      toolName: 'read_file',
      args: { path },
    };
  }

  if (toolTagName === 'write_file') {
    const path = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    const content = extractNamedToolArg(body, ['content', 'text'], '') || '';
    if (!path) {
      return null;
    }
    return {
      toolName: 'write_file',
      args: { path, content },
    };
  }

  if (toolTagName === 'list_dir') {
    const path = extractNamedToolArg(body, ['path', 'directory', 'dir'], '.') || '.';
    return {
      toolName: 'list_dir',
      args: { path },
    };
  }

  if (toolTagName === 'grep_search') {
    const path = extractNamedToolArg(body, ['path', 'directory', 'dir'], '.') || '.';
    const pattern = extractNamedToolArg(body, ['pattern', 'query', 'regex']);
    if (!pattern) {
      return null;
    }
    return {
      toolName: 'grep_search',
      args: { path, pattern },
    };
  }

  if (toolTagName === 'apply_patch') {
    const patch = extractNamedToolArg(body, ['patch', 'diff']);
    if (!patch) {
      return null;
    }
    return {
      toolName: 'apply_patch',
      args: { patch },
    };
  }

  if (toolTagName === 'web_search') {
    const query = extractNamedToolArg(body, ['query', 'q', 'text']);
    if (!query) {
      return null;
    }
    return {
      toolName: 'web_search',
      args: { query },
    };
  }

  if (toolTagName === 'web_fetch' || toolTagName === 'browser_open') {
    const url = extractNamedToolArg(body, ['url', 'href']);
    if (!url) {
      return null;
    }
    return {
      toolName: toolTagName,
      args: { url },
    };
  }

  if (toolTagName === 'browser_activate') {
    const app = extractNamedToolArg(body, ['app', 'application'], 'Microsoft Edge') || 'Microsoft Edge';
    return {
      toolName: 'browser_activate',
      args: { app },
    };
  }

  return null;
}

function extractBracketToolCallValue(block: string, key: string): string | null {
  const match = block.match(new RegExp(`--${key}\\s+"([\\s\\S]*?)"`, 'i'));
  return match ? decodeXml(match[1]).trim() : null;
}

function extractBracketToolCall(text: string): LocalDevPrimitiveCall | null {
  const match = text.match(/\[TOOL_CALL\]([\s\S]*?)\[\/TOOL_CALL\]/i);
  if (!match) {
    return null;
  }
  const block = match[1] || '';
  const toolNameMatch = block.match(/tool\s*=>\s*"([^"]+)"/i);
  const toolName = normalizeToolCallName(toolNameMatch?.[1] || '');
  if (!toolName) {
    return null;
  }

  if (toolName === 'run_command') {
    const command = extractBracketToolCallValue(block, 'command') || extractBracketToolCallValue(block, 'cmd');
    if (!command) {
      return null;
    }
    return {
      toolName,
      args: { command },
    };
  }

  if (toolName === 'read_file') {
    const path = extractBracketToolCallValue(block, 'path') || extractBracketToolCallValue(block, 'file_path');
    if (!path) {
      return null;
    }
    return {
      toolName,
      args: { path },
    };
  }

  if (toolName === 'write_file') {
    const path = extractBracketToolCallValue(block, 'path') || extractBracketToolCallValue(block, 'file_path');
    const content = extractBracketToolCallValue(block, 'content') || '';
    if (!path) {
      return null;
    }
    return {
      toolName,
      args: { path, content },
    };
  }

  return null;
}

function normalizeInvokeBodyToCanonical(body: string): string {
  return String(body || '').replace(
    /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi,
    (_match, name: string, value: string) => `<${String(name || '').trim()}>${value}</${String(name || '').trim()}>`,
  );
}

function normalizeProviderToolMarkup(text: string): string {
  let normalized = decodeXml(String(text || '')).replace(/\r\n/g, '\n');
  normalized = normalized.replace(/<\/?steps?\b[^>]*>/gi, '\n');
  normalized = normalized.replace(/<\/?function_calls\b[^>]*>/gi, '\n');
  normalized = normalized.replace(/<\/?tool_code\b[^>]*>/gi, '\n');

  normalized = normalized.replace(
    /<tool\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/tool>/gi,
    (match, rawName: string, body: string) => {
      const toolName = normalizeToolCallName(rawName);
      if (!toolName) {
        return match;
      }
      return `<${toolName}>${body}</${toolName}>`;
    },
  );

  normalized = normalized.replace(
    /<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/gi,
    (match, rawName: string, body: string) => {
      const toolName = normalizeToolCallName(rawName);
      if (!toolName && String(rawName || '').trim().toLowerCase() !== 'glob') {
        return match;
      }
      const canonicalBody = normalizeInvokeBodyToCanonical(body);
      if (String(rawName || '').trim().toLowerCase() === 'glob') {
        return match;
      }
      return `<${toolName}>${canonicalBody}</${toolName}>`;
    },
  );

  normalized = normalized.replace(/<\/([a-z_]+)_call>/gi, (_match, rawName: string) => {
    const toolName = normalizeToolCallName(rawName);
    return toolName ? `</${toolName}>` : `</${rawName}_call>`;
  });

  normalized = normalized.replace(/<\/?tool_call\b[^>]*>/gi, '\n');
  return normalized.trim();
}

function extractMalformedWrappedToolBody(text: string, toolName: typeof TOOL_NAMES[number]): string | null {
  const match = text.match(
    new RegExp(`<${toolName}>([\\s\\S]*?)(?:</${toolName}>|</tool>|</tool_call>|</[a-z_]+_call>|$)`, 'i'),
  );
  return match ? match[1] : null;
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function normalizeToolCallName(name: string): LocalDevPrimitiveCall['toolName'] | null {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === 'bash' || normalized === 'shell' || normalized === 'run_command') {
    return 'run_command';
  }
  if (normalized === 'read' || normalized === 'read_file') {
    return 'read_file';
  }
  if (normalized === 'append' || normalized === 'append_file' || normalized === 'file.append') {
    return 'append_file';
  }
  if (normalized === 'write' || normalized === 'write_file') {
    return 'write_file';
  }
  if (normalized === 'list_dir' || normalized === 'ls' || normalized === 'list') {
    return 'list_dir';
  }
  if (normalized === 'grep' || normalized === 'grep_search' || normalized === 'search') {
    return 'grep_search';
  }
  if (normalized === 'apply_patch' || normalized === 'patch') {
    return 'apply_patch';
  }
  if (
    normalized === 'web_search'
    || normalized === 'web.search'
    || normalized === 'search_web'
    || normalized === 'browser.search'
  ) {
    return 'web_search';
  }
  if (normalized === 'web_fetch' || normalized === 'fetch') {
    return 'web_fetch';
  }
  if (normalized === 'browser_open' || normalized === 'open_url') {
    return 'browser_open';
  }
  if (normalized === 'browser_activate' || normalized === 'activate_app') {
    return 'browser_activate';
  }
  return null;
}

function readStringField(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function extractFirstJsonObject(text: string): string | null {
  const source = String(text || '');
  const start = source.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }
  return null;
}

function parseEmbeddedToolCallJson(text: string): LocalDevPrimitiveCall | null {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (!match) {
    return null;
  }
  const rawPayload = stripCodeFence(decodeXml(match[1] || ''));
  if (!rawPayload) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    const firstObject = extractFirstJsonObject(rawPayload);
    if (!firstObject) {
      return null;
    }
    try {
      parsed = JSON.parse(firstObject);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const toolName = normalizeToolCallName(String(record.name || record.tool || ''));
  if (!toolName) {
    return null;
  }

  const parameters =
    record.parameters && typeof record.parameters === 'object' && !Array.isArray(record.parameters)
      ? (record.parameters as Record<string, unknown>)
      : {};

  if (toolName === 'run_command') {
    const command = readStringField(parameters, ['command', 'cmd']);
    const cwd = readStringField(parameters, ['cwd', 'workdir', 'working_directory']);
    if (!command) {
      return null;
    }
    return {
      toolName,
      args: {
        command,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  if (toolName === 'read_file') {
    const path = readStringField(parameters, ['path', 'file_path', 'file']);
    if (!path) {
      return null;
    }
    return {
      toolName,
      args: { path },
    };
  }

  if (toolName === 'append_file') {
    const path = readStringField(parameters, ['path', 'file_path', 'file']);
    if (!path) {
      return null;
    }
    const content = readStringField(parameters, ['content', 'text']) || '';
    return {
      toolName,
      args: { path, content },
    };
  }

  if (toolName === 'write_file') {
    const path = readStringField(parameters, ['path', 'file_path', 'file']);
    if (!path) {
      return null;
    }
    const content = readStringField(parameters, ['content', 'text']) || '';
    return {
      toolName,
      args: { path, content },
    };
  }

  if (toolName === 'list_dir') {
    const path = readStringField(parameters, ['path', 'dir', 'directory']) || '.';
    return {
      toolName,
      args: { path },
    };
  }

  if (toolName === 'grep_search') {
    const path = readStringField(parameters, ['path', 'dir', 'directory']) || '.';
    const pattern = readStringField(parameters, ['pattern', 'query', 'regex']);
    if (!pattern) {
      return null;
    }
    return {
      toolName,
      args: { path, pattern },
    };
  }

  if (toolName === 'apply_patch') {
    const patch = readStringField(parameters, ['patch', 'diff']);
    if (!patch) {
      return null;
    }
    return {
      toolName,
      args: { patch },
    };
  }

  if (toolName === 'web_search') {
    const query = readStringField(parameters, ['query', 'q', 'text']);
    if (!query) {
      return null;
    }
    return {
      toolName,
      args: { query },
    };
  }

  if (toolName === 'web_fetch' || toolName === 'browser_open') {
    const url = readStringField(parameters, ['url', 'href']);
    if (!url) {
      return null;
    }
    return {
      toolName,
      args: { url },
    };
  }

  if (toolName === 'browser_activate') {
    const app = readStringField(parameters, ['app', 'application']) || 'Microsoft Edge';
    return {
      toolName,
      args: { app },
    };
  }

  return null;
}

function extractMinimaxInvokeCall(text: string): LocalDevPrimitiveCall | null {
  const invokeMatch = text.match(/<invoke\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/invoke>/i);
  if (!invokeMatch) {
    return null;
  }
  const invokeName = String(invokeMatch[1] || '').trim().toLowerCase();
  const toolName = normalizeToolCallName(invokeName);
  const body = invokeMatch[2] || '';

  if (toolName === 'run_command' || invokeName === 'bash' || invokeName === 'shell') {
    const command = extractNamedToolArg(body, ['command', 'cmd']);
    const cwd = extractNamedToolArg(body, ['cwd', 'workdir', 'working_directory']);
    if (!command) {
      return null;
    }
    return {
      toolName: 'run_command',
      args: {
        command,
        ...(cwd ? { cwd } : {}),
      },
    };
  }

  if (toolName === 'read_file' || invokeName === 'read') {
    const filePath = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    if (!filePath) {
      return null;
    }
    return {
      toolName: 'read_file',
      args: {
        path: filePath,
      },
    };
  }

  if (toolName === 'append_file') {
    const filePath = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    const content = extractNamedToolArg(body, ['content', 'text'], '') || '';
    if (!filePath) {
      return null;
    }
    return {
      toolName: 'append_file',
      args: {
        path: filePath,
        content,
      },
    };
  }

  if (invokeName === 'glob') {
    const pattern = extractInvokeParameter(body, 'pattern');
    const cwd = extractInvokeParameter(body, 'cwd') || '.';
    if (!pattern) {
      return null;
    }
    return {
      toolName: 'run_command',
      args: {
        command: `rg --files ${JSON.stringify(cwd)} -g ${JSON.stringify(pattern)} | head -200`,
      },
    };
  }

  if (toolName === 'write_file' || invokeName === 'write') {
    const filePath = extractNamedToolArg(body, ['file_path', 'path', 'file']);
    const content = extractNamedToolArg(body, ['content', 'text'], '') || '';
    if (!filePath) {
      return null;
    }
    return {
      toolName: 'write_file',
      args: {
        path: filePath,
        content: content || '',
      },
    };
  }

  if (toolName === 'list_dir') {
    const path = extractNamedToolArg(body, ['path', 'directory', 'dir'], '.') || '.';
    return {
      toolName: 'list_dir',
      args: { path },
    };
  }

  if (toolName === 'grep_search') {
    const path = extractNamedToolArg(body, ['path', 'directory', 'dir'], '.') || '.';
    const pattern = extractNamedToolArg(body, ['pattern', 'query', 'regex']);
    if (!pattern) {
      return null;
    }
    return {
      toolName: 'grep_search',
      args: { path, pattern },
    };
  }

  if (toolName === 'apply_patch') {
    const patch = extractNamedToolArg(body, ['patch', 'diff']);
    if (!patch) {
      return null;
    }
    return {
      toolName: 'apply_patch',
      args: { patch },
    };
  }

  if (toolName === 'web_search' || invokeName === 'web.search') {
    const query = extractNamedToolArg(body, ['query', 'q', 'text']);
    if (!query) {
      return null;
    }
    return {
      toolName: 'web_search',
      args: {
        query,
      },
    };
  }

  if (toolName === 'web_fetch' || toolName === 'browser_open') {
    const url = extractNamedToolArg(body, ['url', 'href']);
    if (!url) {
      return null;
    }
    return {
      toolName,
      args: { url },
    };
  }

  if (toolName === 'browser_activate') {
    const app = extractNamedToolArg(body, ['app', 'application'], 'Microsoft Edge') || 'Microsoft Edge';
    return {
      toolName: 'browser_activate',
      args: { app },
    };
  }

  return null;
}

/** 去掉 MiniMax 等供应商常用的 `<step>` / `<steps>` 包裹，便于 `<invoke name=...>` 被同一套正则吃到。 */
function stripStepLikeXmlNoise(text: string): string {
  return String(text || '')
    .replace(/<\/?steps?\b[^>]*>/gi, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
}

function extractLocalDevPrimitiveCallOnce(text: string): LocalDevPrimitiveCall | null {
  for (const toolName of TOOL_NAMES) {
    const match = text.match(new RegExp(`<${toolName}>([\\s\\S]*?)</${toolName}>`, 'i'));
    const body = match?.[1] ?? extractMalformedWrappedToolBody(text, toolName);
    if (!body) {
      continue;
    }
    const args: Record<string, string> = {};
    if (toolName === 'read_file' || toolName === 'list_dir') {
      const path = extractTagValue(body, 'path');
      if (path) {
        args.path = path;
      }
    } else if (toolName === 'append_file') {
      const path = extractTagValue(body, 'path');
      const contentMatch = body.match(/<content>([\s\S]*?)<\/content>/i);
      if (path) {
        args.path = path;
      }
      if (contentMatch) {
        args.content = normalizeXmlContentBlock(decodeXml(contentMatch[1]));
      }
    } else if (toolName === 'write_file') {
      const path = extractTagValue(body, 'path');
      const contentMatch = body.match(/<content>([\s\S]*?)<\/content>/i);
      if (path) {
        args.path = path;
      }
      if (contentMatch) {
        args.content = normalizeXmlContentBlock(decodeXml(contentMatch[1]));
      }
    } else if (toolName === 'grep_search') {
      const path = extractTagValue(body, 'path');
      const pattern = extractTagValue(body, 'pattern');
      if (path) {
        args.path = path;
      }
      if (pattern) {
        args.pattern = pattern;
      }
    } else if (toolName === 'run_command') {
      const command = extractTagValue(body, 'command');
      if (command) {
        args.command = command;
      }
    } else if (toolName === 'apply_patch') {
      const patchMatch = body.match(/<patch>([\s\S]*?)<\/patch>/i);
      if (patchMatch) {
        args.patch = decodeXml(patchMatch[1]);
      }
    } else if (toolName === 'web_search') {
      const query = extractTagValue(body, 'query') || extractTagValue(body, 'q');
      if (query) {
        args.query = query;
      }
    } else if (toolName === 'web_fetch' || toolName === 'browser_open') {
      const url = extractTagValue(body, 'url');
      if (url) {
        args.url = url;
      }
    } else if (toolName === 'browser_activate') {
      const app = extractTagValue(body, 'app');
      args.app = app || 'Microsoft Edge';
    }
    return { toolName, args };
  }
  const embeddedJsonCall = parseEmbeddedToolCallJson(text);
  if (embeddedJsonCall) {
    return embeddedJsonCall;
  }
  const namedToolTagCall = extractNamedToolTagCall(text);
  if (namedToolTagCall) {
    return namedToolTagCall;
  }
  const bracketToolCall = extractBracketToolCall(text);
  if (bracketToolCall) {
    return bracketToolCall;
  }
  return extractMinimaxInvokeCall(text);
}

export function extractLocalDevPrimitiveCall(text: string): LocalDevPrimitiveCall | null {
  const direct = extractLocalDevPrimitiveCallOnce(text);
  if (direct) {
    return direct;
  }
  const normalizedProviderMarkup = normalizeProviderToolMarkup(text);
  if (normalizedProviderMarkup && normalizedProviderMarkup !== String(text || '').trim()) {
    const normalizedCall = extractLocalDevPrimitiveCallOnce(normalizedProviderMarkup);
    if (normalizedCall) {
      return normalizedCall;
    }
  }
  const stripped = stripStepLikeXmlNoise(text);
  if (stripped && stripped !== String(text || '').trim()) {
    return extractLocalDevPrimitiveCallOnce(stripped);
  }
  return null;
}

function resolveCallCwd(call: LocalDevPrimitiveCall, cwd: string): string {
  const override = String(call.args.cwd || '').trim();
  return override ? resolve(cwd, override) : cwd;
}

function sanitizeCallArgs(call: LocalDevPrimitiveCall): Record<string, string> {
  const { cwd, ...restArgs } = call.args;
  return restArgs;
}

export function summarizeLocalDevPrimitiveCall(call: LocalDevPrimitiveCall): string {
  try {
    return JSON.stringify(sanitizeCallArgs(call));
  } catch {
    return '';
  }
}

export function extractAndNormalizeLocalDevPrimitiveCall(text: string, cwd: string): LocalDevPrimitiveCall | null {
  const call = extractLocalDevPrimitiveCall(text);
  if (!call) {
    return null;
  }
  return {
    toolName: call.toolName,
    args: {
      ...sanitizeCallArgs(call),
      ...(call.args.cwd ? { cwd: resolve(cwd, call.args.cwd) } : {}),
    },
  };
}

async function runCommand(command: string, cwd: string): Promise<LocalDevPrimitiveResult> {
  return await new Promise((resolvePromise) => {
    const child = spawn('/bin/zsh', ['-lc', command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill('SIGTERM');
      resolvePromise({
        ok: false,
        output: `Command timed out after 120000ms.\n\nstdout:\n${truncate(stdout)}\n\nstderr:\n${truncate(stderr)}`,
      });
    }, 120_000).unref();

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        ok: false,
        output: `Failed to start command: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const summary = `exit_code=${code ?? 'null'} signal=${signal ?? 'null'}\nstdout:\n${truncate(stdout)}\n\nstderr:\n${truncate(stderr)}`;
      resolvePromise({
        ok: code === 0,
        output: summary.trim(),
      });
    });
  });
}

async function fetchWebSearchPage(query: string): Promise<{ provider: string; url: string; response: Response; text: string }> {
  const providers = [
    {
      provider: 'duckduckgo-html',
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    },
    {
      provider: 'bing',
      url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    },
  ];
  const failures: string[] = [];
  for (const candidate of providers) {
    try {
      const response = await fetch(candidate.url, {
        headers: WEB_SEARCH_HEADERS,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (response.ok) {
        return {
          provider: candidate.provider,
          url: response.url || candidate.url,
          response,
          text,
        };
      }
      failures.push(`${candidate.provider}: status=${response.status}`);
    } catch (error) {
      failures.push(`${candidate.provider}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`web_search failed for all providers: ${failures.join(' | ')}`);
}

export async function executeLocalDevPrimitiveCall(
  call: LocalDevPrimitiveCall,
  options: { cwd: string },
): Promise<LocalDevPrimitiveResult> {
  const cwd = resolveCallCwd(call, options.cwd);
  if (call.toolName === 'read_file') {
    const targetPath = resolveTargetPath(call.args.path || '', cwd);
    assertPathAllowed(targetPath);
    const content = await fs.readFile(targetPath, 'utf-8');
    return {
      ok: true,
      output: `path=${targetPath}\n${truncate(content)}`,
    };
  }

  if (call.toolName === 'append_file') {
    const targetPath = resolveTargetPath(call.args.path || '', cwd);
    assertPathAllowed(targetPath);
    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.appendFile(targetPath, call.args.content || '', 'utf-8');
    return {
      ok: true,
      output: `appended ${Buffer.byteLength(call.args.content || '', 'utf-8')} bytes to ${targetPath}`,
    };
  }

  if (call.toolName === 'write_file') {
    const targetPath = resolveTargetPath(call.args.path || '', cwd);
    assertPathAllowed(targetPath);
    await fs.mkdir(dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, call.args.content || '', 'utf-8');
    return {
      ok: true,
      output: `wrote ${Buffer.byteLength(call.args.content || '', 'utf-8')} bytes to ${targetPath}`,
    };
  }

  if (call.toolName === 'list_dir') {
    const targetPath = resolveTargetPath(call.args.path || '.', cwd);
    assertPathAllowed(targetPath);
    const entries = await fs.readdir(targetPath, { withFileTypes: true });
    const rendered = entries
      .slice(0, 400)
      .map((entry) => `${entry.isDirectory() ? 'dir' : 'file'} ${entry.name}`)
      .join('\n');
    return {
      ok: true,
      output: `path=${targetPath}\n${rendered}`,
    };
  }

  if (call.toolName === 'grep_search') {
    const targetPath = resolveTargetPath(call.args.path || '.', cwd);
    assertPathAllowed(targetPath);
    const pattern = call.args.pattern?.trim();
    if (!pattern) {
      throw new Error('grep_search requires <pattern>.');
    }
    const result = await runCommand(
      `rg -n --hidden --no-ignore-vcs --glob '!node_modules' --glob '!.git' ${JSON.stringify(pattern)} ${JSON.stringify(targetPath)}`,
      cwd,
    );
    return result;
  }

  if (call.toolName === 'run_command') {
    const command = call.args.command?.trim();
    if (!command) {
      throw new Error('run_command requires <command>.');
    }
    assertCommandAllowed(command);
    return await runCommand(command, cwd);
  }

  if (call.toolName === 'apply_patch') {
    const patch = call.args.patch;
    if (!patch?.trim()) {
      throw new Error('apply_patch requires <patch>.');
    }
    const escapedPatch = patch.replace(/'/g, `'\"'\"'`);
    return await runCommand(`printf '%s' '${escapedPatch}' | patch -p0`, cwd);
  }

  if (call.toolName === 'web_search') {
    const query = call.args.query?.trim();
    if (!query) {
      throw new Error('web_search requires <query>.');
    }
    const { provider, url, response, text } = await fetchWebSearchPage(query);
    return {
      ok: response.ok,
      output: `status=${response.status}\nprovider=${provider}\nurl=${url}\nquery=${query}\n${truncate(text)}`,
    };
  }

  if (call.toolName === 'web_fetch') {
    const url = call.args.url?.trim();
    if (!url) {
      throw new Error('web_fetch requires <url>.');
    }
    const response = await fetch(url);
    const text = await response.text();
    return {
      ok: response.ok,
      output: `status=${response.status}\nurl=${url}\n${truncate(text)}`,
    };
  }

  if (call.toolName === 'browser_open') {
    const url = call.args.url?.trim();
    if (!url) {
      throw new Error('browser_open requires <url>.');
    }
    return await runCommand(`open -a "Microsoft Edge" ${JSON.stringify(url)}`, cwd);
  }

  if (call.toolName === 'browser_activate') {
    const app = call.args.app?.trim() || 'Microsoft Edge';
    return await runCommand(`osascript -e ${JSON.stringify(`tell application "${app}" to activate`)}`, cwd);
  }

  throw new Error(`Unsupported primitive: ${call.toolName}`);
}
