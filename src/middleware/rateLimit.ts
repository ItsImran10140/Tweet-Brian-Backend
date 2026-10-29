import type { RequestHandler } from 'express';
import { AppError } from '../errors';
import type { AuthedRequest } from '../routes/util';

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

function prune(arr: number[], now: number, windowMs: number): number[] {
  return arr.filter((t) => now - t < windowMs);
}

/** Periodic cleanup so the map does not grow without bound. */
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    b.timestamps = prune(b.timestamps, now, 60 * 60 * 1000);
    if (!b.timestamps.length) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref?.();

/**
 * Sliding-window rate limiter.
 * @param keyFn identity for the bucket (IP, user id, etc.)
 * @param max max requests in window
 * @param windowMs window length
 */
export function createRateLimit(
  keyFn: (req: Parameters<RequestHandler>[0]) => string,
  max: number,
  windowMs: number,
  code = 'rate_limited',
): RequestHandler {
  return (req, _res, next) => {
    try {
      const key = keyFn(req);
      const now = Date.now();
      const bucket = buckets.get(key) ?? { timestamps: [] };
      bucket.timestamps = prune(bucket.timestamps, now, windowMs);
      if (bucket.timestamps.length >= max) {
        throw new AppError(
          429,
          code,
          `Rate limit: max ${max} requests per ${Math.round(windowMs / 1000)}s.`,
          'Slow down and retry shortly. Generation has a separate per-user hourly cap.',
        );
      }
      bucket.timestamps.push(now);
      buckets.set(key, bucket);
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function clientIp(req: Parameters<RequestHandler>[0]): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]!.trim();
  return req.ip || req.socket.remoteAddress || 'unknown';
}

/** Paths that must never 429 (uptime pingers / free-tier keep-awake). */
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/health', '/keepalive']);

function isRateLimitExempt(req: Parameters<RequestHandler>[0]): boolean {
  const path = req.path || req.url?.split('?')[0] || '';
  return RATE_LIMIT_EXEMPT_PATHS.has(path);
}

/** Global per-IP limit for all traffic (exempts /health and /keepalive). */
export function globalIpRateLimit(maxPerMinute: number): RequestHandler {
  const limiter = createRateLimit((req) => `ip:${clientIp(req)}`, maxPerMinute, 60_000, 'ip_rate_limited');
  return (req, res, next) => {
    if (isRateLimitExempt(req)) return next();
    return limiter(req, res, next);
  };
}

/** Stricter per-user limit on authenticated API routes. */
export function apiUserRateLimit(maxPerMinute: number): RequestHandler {
  return createRateLimit(
    (req) => {
      const uid = (req as AuthedRequest).userId;
      return uid ? `user:${uid}` : `ip:${clientIp(req)}`;
    },
    maxPerMinute,
    60_000,
    'user_rate_limited',
  );
}
