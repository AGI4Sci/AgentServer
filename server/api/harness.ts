import { IncomingMessage, ServerResponse } from 'http';
import { getHarnessRunStore } from '../../core/harness/run-store.js';

function getQueryParam(url: string, key: string): string | null {
  const parsed = new URL(url, 'http://127.0.0.1');
  return parsed.searchParams.get(key);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function handleHarnessRoutes(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const method = req.method || 'GET';
  const url = req.url || '/';
  const store = getHarnessRunStore();

  if (url.startsWith('/api/harness/runs') && method === 'GET') {
    const detailMatch = url.match(/^\/api\/harness\/runs\/([^/?#]+)$/);
    if (detailMatch) {
      try {
        const run = store.getRun(detailMatch[1]);
        if (!run) {
          writeJson(res, 404, { ok: false, error: `Run not found: ${detailMatch[1]}` });
          return true;
        }

        writeJson(res, 200, { ok: true, run });
        return true;
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: `Failed to rebuild run: ${detailMatch[1]}`,
          code: 'HARNESS_REBUILD_FAILED',
          detail: toErrorMessage(error),
        });
        return true;
      }
    }

    const teamId = getQueryParam(url, 'teamId') || undefined;
    const limit = Number.parseInt(getQueryParam(url, 'limit') || '20', 10);
    try {
      const runs = store.listRuns({ teamId, limit: Number.isNaN(limit) ? 20 : limit });
      writeJson(res, 200, { ok: true, runs });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: 'Failed to list harness runs',
        code: 'HARNESS_REBUILD_FAILED',
        detail: toErrorMessage(error),
      });
    }
    return true;
  }

  if (url.startsWith('/api/harness/reviews') && method === 'GET') {
    const detailMatch = url.match(/^\/api\/harness\/reviews\/([^/?#]+)$/);
    if (detailMatch) {
      try {
        const review = store.getReview(detailMatch[1]);
        if (!review) {
          writeJson(res, 404, { ok: false, error: `Review not found: ${detailMatch[1]}` });
          return true;
        }

        writeJson(res, 200, { ok: true, review });
        return true;
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          error: `Failed to rebuild review: ${detailMatch[1]}`,
          code: 'HARNESS_REBUILD_FAILED',
          detail: toErrorMessage(error),
        });
        return true;
      }
    }

    const teamId = getQueryParam(url, 'teamId') || undefined;
    const limit = Number.parseInt(getQueryParam(url, 'limit') || '20', 10);
    try {
      const reviews = store.listReviews({ teamId, limit: Number.isNaN(limit) ? 20 : limit });
      writeJson(res, 200, { ok: true, reviews });
    } catch (error) {
      writeJson(res, 500, {
        ok: false,
        error: 'Failed to list harness reviews',
        code: 'HARNESS_REBUILD_FAILED',
        detail: toErrorMessage(error),
      });
    }
    return true;
  }

  return false;
}
