import type { Request, RequestHandler, Response } from 'express';
import type { User } from '@supabase/supabase-js';
import { z } from 'zod';
import { AppError } from '../errors';
import { db } from '../data';
import { verifyAccessToken } from '../lib/auth';
import { assertOnboarded } from '../lib/gates';

export type AuthedRequest = Request & {
  userId: string;
  userEmail: string;
  authUser: User;
};

function testAuthEnabled(): boolean {
  return process.env.ALLOW_TEST_AUTH === '1' || process.env.NODE_ENV === 'test';
}

function syntheticUser(id: string, email?: string): User {
  return {
    id,
    email: email ?? `${id}@test.local`,
    app_metadata: {},
    user_metadata: {},
    aud: 'authenticated',
    created_at: new Date().toISOString(),
  } as User;
}

/**
 * Verify Supabase access token. Attaches userId + verified email.
 * Rejects missing/invalid tokens with 401.
 * When ALLOW_TEST_AUTH=1 (or NODE_ENV=test), accepts x-test-user-id for localhost tests.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  Promise.resolve()
    .then(async () => {
      const testId = req.header('x-test-user-id')?.trim();
      if (testAuthEnabled() && testId) {
        const authed = req as AuthedRequest;
        authed.userId = testId;
        authed.userEmail = `${testId}@test.local`;
        authed.authUser = syntheticUser(testId);
        next();
        return;
      }

      const header = req.header('authorization');
      if (!header || !header.toLowerCase().startsWith('bearer ')) {
        throw new AppError(
          401,
          'unauthorized',
          'Missing Authorization bearer token.',
          'Sign in with Google, then send Authorization: Bearer <access_token>.',
        );
      }
      const token = header.slice(7).trim();
      if (!token) {
        throw new AppError(401, 'unauthorized', 'Empty access token.', 'Sign in with Google again.');
      }
      const user = await verifyAccessToken(token);
      const authed = req as AuthedRequest;
      authed.userId = user.id;
      authed.userEmail = user.email!;
      authed.authUser = user;
      next();
    })
    .catch(next);
};

/** Require auth (if not already applied) and an existing profiles row. */
export const requireUser: RequestHandler = (req, _res, next) => {
  Promise.resolve()
    .then(async () => {
      if (!(req as AuthedRequest).userId) {
        await new Promise<void>((resolve, reject) => {
          requireAuth(req, _res, (err?: unknown) => (err ? reject(err) : resolve()));
        });
      }
      const id = (req as AuthedRequest).userId;
      const user = await db.get('users', (u) => u.id === id);
      if (!user) {
        throw new AppError(
          401,
          'unknown_user',
          'No profile for this account yet.',
          'Call GET /api/me after sign-in to create your profile, then retry.',
        );
      }
      next();
    })
    .catch(next);
};

export const uid = (req: Request): string => (req as AuthedRequest).userId;

/** Block API use until onboarding_completed is true (except onboarding + /me). */
export const requireOnboarded: RequestHandler = (req, _res, next) => {
  Promise.resolve()
    .then(async () => {
      if (!(req as AuthedRequest).userId) {
        await new Promise<void>((resolve, reject) => {
          requireAuth(req, _res, (err?: unknown) => (err ? reject(err) : resolve()));
        });
      }
      await assertOnboarded(uid(req));
      next();
    })
    .catch(next);
};

/** Paid (or lifetime) entitlement required. Refunded / past_due / canceled-and-expired → 402. */
export const requirePaid: RequestHandler = (req, _res, next) => {
  Promise.resolve()
    .then(async () => {
      const { assertPaid } = await import('../lib/gates');
      await assertPaid(uid(req));
      next();
    })
    .catch(next);
};

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new AppError(400, 'invalid_request', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

export const idParam = (req: Request): string => String(req.params.id);

// simple in-memory rate limiter
const hits = new Map<string, number[]>();
export function rateLimit(max: () => number, windowMs: number): RequestHandler {
  return (req, _res, next) => {
    const k = (req as AuthedRequest).userId ?? req.ip ?? 'anon';
    const now = Date.now();
    const arr = (hits.get(k) ?? []).filter((t) => now - t < windowMs);
    const limit = max();
    if (arr.length >= limit) throw new AppError(429, 'rate_limited', `Rate limit: max ${limit} per ${Math.round(windowMs / 60000)} min.`, 'Raise limits.generate_per_hour in config.yml while testing.');
    arr.push(now);
    hits.set(k, arr);
    next();
  };
}
