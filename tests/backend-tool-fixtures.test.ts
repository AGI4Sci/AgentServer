import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { BACKEND_IDS, type BackendType } from '../core/runtime/backend-catalog.ts';
import { normalizeNativeEvents } from '../server/runtime/workers/backend-event-normalizers.ts';

const FIXTURE_ROOT = join(process.cwd(), 'server', 'runtime', 'workers', '__fixtures__');

function stripRaw(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripRaw);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'raw' || item === undefined) {
      continue;
    }
    out[key] = stripRaw(item);
  }
  return out;
}

async function readJsonl(path: string): Promise<unknown[]> {
  const raw = await readFile(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

for (const backend of BACKEND_IDS) {
  test(`${backend} normalizes list_dir tool events`, async () => {
    const nativeEvents = await readJsonl(join(FIXTURE_ROOT, backend, 'list-dir.native.jsonl'));
    const expected = await readJson(join(FIXTURE_ROOT, backend, 'list-dir.expected.json'));
    const normalized = normalizeNativeEvents(backend as BackendType, nativeEvents);

    assert.deepEqual(stripRaw(normalized), expected);
    assert.deepEqual(
      normalized
        .filter((event) => event.type === 'tool-call' || event.type === 'tool-result')
        .map((event) => event.type === 'tool-call' || event.type === 'tool-result' ? `${event.type}:${event.toolName}` : event.type),
      ['tool-call:list_dir', 'tool-result:list_dir'],
    );
  });
}
