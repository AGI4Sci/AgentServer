/**
 * 统一 API 响应格式
 */

export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export function success<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function error(message: string): ApiResponse<never> {
  return { ok: false, error: message };
}

export function sendJson<T>(
  res: import('http').ServerResponse,
  status: number,
  body: ApiResponse<T>
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
