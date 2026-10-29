import { AppError } from '../errors';

export interface HttpResult {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

/**
 * Small wrapper around fetch: timeout, JSON parsing, and network errors mapped to AppError.
 * It does NOT throw on HTTP 4xx/5xx - callers decide what those mean.
 */
export async function requestJson(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(502, 'network_error', `Network request failed: ${msg}`, 'Check your internet connection and try again.');
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
