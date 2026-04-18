import type { SessionStreamEvent, SessionOutput } from '../session-types.js';
import { normalizeSessionStreamEvent } from '../runtime-event-contract.js';
import type { BackendType } from '../../../core/runtime/backend-catalog.js';

export type FixtureBackend = BackendType;

function normalizeToolName(name: string): string {
  const normalized = name.trim();
  if (normalized === 'list_directory' || normalized === 'list_directories' || normalized === 'list_directory_tool') {
    return 'list_dir';
  }
  return normalized;
}

function compactDetail(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string'
    ? record.path
    : typeof record.directory_path === 'string'
      ? record.directory_path
      : undefined;
  return path ? `path=${path}` : JSON.stringify(record);
}

function resultOutput(text: string): SessionOutput {
  return { success: true, result: text };
}

function errorOutput(message: string): SessionOutput {
  return { success: false, error: message };
}

function messageFrom(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message;
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error;
    }
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string' && nested.message.trim()) {
        return nested.message;
      }
    }
  }
  return fallback;
}

export function normalizeCodexNativeEvent(raw: unknown): SessionStreamEvent[] {
  const event = raw as Record<string, unknown>;
  const type = typeof event.type === 'string' ? event.type : '';
  if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
    return [normalizeSessionStreamEvent({ type: 'text-delta', text: event.delta, raw })];
  }
  if (type === 'response.tool_call' && typeof event.name === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-call',
      toolName: normalizeToolName(event.name),
      detail: compactDetail(event.arguments),
      raw,
    })];
  }
  if (type === 'response.tool_result' && typeof event.name === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-result',
      toolName: normalizeToolName(event.name),
      output: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? ''),
      raw,
    })];
  }
  if (type === 'response.completed' && typeof event.output === 'string') {
    return [normalizeSessionStreamEvent({ type: 'result', output: resultOutput(event.output), raw })];
  }
  if (type === 'response.error' || type === 'error') {
    const message = typeof event.message === 'string' ? event.message : 'Codex backend error';
    return [
      normalizeSessionStreamEvent({ type: 'error', error: message, raw }),
      normalizeSessionStreamEvent({ type: 'result', output: errorOutput(message), raw }),
    ];
  }
  return [];
}

export function normalizeClaudeCodeNativeEvent(raw: unknown): SessionStreamEvent[] {
  const payload = raw as Record<string, unknown>;
  if (payload.type === 'text-delta' && typeof payload.text === 'string') {
    return [normalizeSessionStreamEvent({ type: 'text-delta', text: payload.text, raw })];
  }
  if (payload.type === 'tool-call' && typeof payload.toolName === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-call',
      toolName: normalizeToolName(payload.toolName),
      detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      raw,
    })];
  }
  if (payload.type === 'tool-result' && typeof payload.toolName === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-result',
      toolName: normalizeToolName(payload.toolName),
      detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      output: typeof payload.output === 'string' ? payload.output : undefined,
      raw,
    })];
  }
  if (payload.type === 'result' && typeof payload.output === 'string') {
    return [normalizeSessionStreamEvent({ type: 'result', output: resultOutput(payload.output), raw })];
  }
  if (payload.type === 'permission-request' && typeof payload.toolName === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'permission-request',
      requestId: typeof payload.permissionId === 'string'
        ? payload.permissionId
        : typeof payload.requestId === 'string'
          ? payload.requestId
          : 'permission-fixture',
      toolName: normalizeToolName(payload.toolName),
      detail: typeof payload.detail === 'string' ? payload.detail : undefined,
      raw,
    })];
  }
  if (payload.type === 'control_request') {
    const request = payload.request as Record<string, unknown> | undefined;
    if (request?.subtype === 'can_use_tool' && typeof request.tool_name === 'string') {
      return [normalizeSessionStreamEvent({
        type: 'permission-request',
        requestId: typeof payload.request_id === 'string' ? payload.request_id : 'permission-fixture',
        toolName: normalizeToolName(request.tool_name),
        detail: typeof request.decision_reason === 'string' ? request.decision_reason : undefined,
        raw,
      })];
    }
  }
  if (payload.type === 'error') {
    const message = typeof payload.error === 'string' ? payload.error : 'Claude Code backend error';
    return [
      normalizeSessionStreamEvent({
        type: 'error',
        error: message,
        raw,
      }),
      normalizeSessionStreamEvent({ type: 'result', output: errorOutput(message), raw }),
    ];
  }
  return [];
}

export function normalizeOpenClawNativeEvent(raw: unknown): SessionStreamEvent[] {
  const payload = raw as Record<string, unknown>;
  if ((payload.event === 'assistant.delta' || payload.type === 'text') && typeof payload.text === 'string') {
    return [normalizeSessionStreamEvent({ type: 'text-delta', text: payload.text, raw })];
  }
  if ((payload.event === 'tool.call' || payload.type === 'tool-call') && typeof payload.toolName === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-call',
      toolName: normalizeToolName(payload.toolName),
      detail: typeof payload.detail === 'string' ? payload.detail : compactDetail(payload.args),
      raw,
    })];
  }
  if ((payload.event === 'tool.result' || payload.type === 'tool-result') && typeof payload.toolName === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-result',
      toolName: normalizeToolName(payload.toolName),
      output: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? ''),
      raw,
    })];
  }
  if ((payload.event === 'run.completed' || payload.type === 'completed') && typeof payload.output === 'string') {
    return [normalizeSessionStreamEvent({ type: 'result', output: resultOutput(payload.output), raw })];
  }
  if (payload.event === 'run.error' || payload.type === 'error') {
    const message = messageFrom(payload, 'OpenClaw backend error');
    return [
      normalizeSessionStreamEvent({ type: 'error', error: message, raw }),
      normalizeSessionStreamEvent({ type: 'result', output: errorOutput(message), raw }),
    ];
  }
  return [];
}

export function normalizeZeroClawNativeEvent(raw: unknown): SessionStreamEvent[] {
  const payload = raw as Record<string, unknown>;
  if (payload.type === 'text' && typeof payload.content === 'string') {
    return [normalizeSessionStreamEvent({ type: 'text-delta', text: payload.content, raw })];
  }
  if (payload.type === 'tool_call' && typeof payload.name === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-call',
      toolName: normalizeToolName(payload.name),
      detail: compactDetail(payload.args),
      raw,
    })];
  }
  if (payload.type === 'tool_result' && typeof payload.name === 'string') {
    return [normalizeSessionStreamEvent({
      type: 'tool-result',
      toolName: normalizeToolName(payload.name),
      output: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? ''),
      raw,
    })];
  }
  if (payload.type === 'final' && typeof payload.full_response === 'string') {
    return [normalizeSessionStreamEvent({ type: 'result', output: resultOutput(payload.full_response), raw })];
  }
  if (payload.type === 'error') {
    const message = messageFrom(payload, 'ZeroClaw backend error');
    return [normalizeSessionStreamEvent({
      type: 'error',
      error: message,
      raw,
    }), normalizeSessionStreamEvent({ type: 'result', output: errorOutput(message), raw })];
  }
  return [];
}

export function normalizeNativeEvents(backend: FixtureBackend, raws: unknown[]): SessionStreamEvent[] {
  return raws.flatMap((raw) => {
    if (backend === 'codex') {
      return normalizeCodexNativeEvent(raw);
    }
    if (backend === 'openclaw') {
      return normalizeOpenClawNativeEvent(raw);
    }
    if (backend === 'zeroclaw') {
      return normalizeZeroClawNativeEvent(raw);
    }
    return normalizeClaudeCodeNativeEvent(raw);
  });
}
