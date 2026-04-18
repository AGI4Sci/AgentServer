import type {
  ActionResult,
  ActionSpec,
  ScopeMismatchErrorShape,
  SessionContext,
  TaskSpec,
} from './types.js';

function normalizePort(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.trim().replace(/\/+$/, '');
}

function getExpectedEnv(sessionContext: SessionContext): {
  cwd: string | null;
  port: string | null;
  url: string | null;
} {
  return {
    cwd: sessionContext.env['exec.cwd'] || null,
    port: normalizePort(sessionContext.env['exec.port']) || null,
    url: normalizeUrl(sessionContext.env['exec.url']) || null,
  };
}

export function createScopeMismatchError(
  field: ScopeMismatchErrorShape['field'],
  expected: string,
  actual: string,
  taskId: string,
): ScopeMismatchErrorShape {
  return {
    code: 'SCOPE_MISMATCH',
    field,
    expected,
    actual,
    taskId,
  };
}

export function validateActionScope(
  sessionContext: SessionContext,
  taskSpec: Pick<TaskSpec, 'taskId' | 'revision'>,
  action: ActionSpec,
): ScopeMismatchErrorShape | null {
  if (action.revision !== sessionContext.revision) {
    return createScopeMismatchError(
      'revision',
      String(sessionContext.revision),
      String(action.revision),
      taskSpec.taskId,
    );
  }

  const expected = getExpectedEnv(sessionContext);

  if (action.cwd && expected.cwd && action.cwd !== expected.cwd) {
    return createScopeMismatchError('cwd', expected.cwd, action.cwd, taskSpec.taskId);
  }

  const actualPort = normalizePort(action.port);
  if (actualPort && expected.port && actualPort !== expected.port) {
    return createScopeMismatchError('port', expected.port, actualPort, taskSpec.taskId);
  }

  const actualUrl = normalizeUrl(action.url);
  if (actualUrl && expected.url && actualUrl !== expected.url) {
    return createScopeMismatchError('url', expected.url, actualUrl, taskSpec.taskId);
  }

  return null;
}

export async function runScopedAction<T>(
  sessionContext: SessionContext,
  taskSpec: Pick<TaskSpec, 'taskId' | 'revision'>,
  action: ActionSpec,
  execute: () => Promise<ActionResult<T>> | ActionResult<T>,
): Promise<ActionResult<T>> {
  const mismatch = validateActionScope(sessionContext, taskSpec, action);
  if (mismatch) {
    throw new Error(
      JSON.stringify(mismatch),
    );
  }

  return await execute();
}

export function formatSessionContextSummary(sessionContext: SessionContext): string {
  const lines = [
    '# Session Context',
    '',
    `sessionId: ${sessionContext.sessionId}`,
    `requestId: ${sessionContext.requestId}`,
    `revision: ${sessionContext.revision}`,
    '',
    '## exec',
    '',
    `exec.cwd: ${sessionContext.env['exec.cwd'] || ''}`,
    `exec.port: ${sessionContext.env['exec.port'] || ''}`,
    `exec.url: ${sessionContext.env['exec.url'] || ''}`,
    '',
    '## env',
    '',
  ];

  const keys = Object.keys(sessionContext.env).sort();
  for (const key of keys) {
    lines.push(`${key}: ${sessionContext.env[key]}`);
  }

  lines.push('', `updatedAt: ${sessionContext.updatedAt}`);
  return lines.join('\n');
}
