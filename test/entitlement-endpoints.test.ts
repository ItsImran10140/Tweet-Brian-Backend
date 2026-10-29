/**
 * Locked-endpoint + onboarding gate behaviour (no live LLM).
 * Run: npm test -- test/entitlement-endpoints.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { AppError } from '../src/errors';

test('requireOnboarded blocks incomplete users; locked routes return paywall for free users', async () => {
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';

  const data = await import('../src/data');
  const { db } = data;
  const originalGet = db.get.bind(db);

  const profiles = new Map<string, Record<string, unknown>>([
    ['fresh-user', { id: 'fresh-user', onboarding_completed: false, free_generation_used: false }],
    ['free-user', { id: 'free-user', onboarding_completed: true, free_generation_used: true, daily_tweet_limit: 10 }],
    ['paid-user', { id: 'paid-user', onboarding_completed: true, free_generation_used: true, daily_tweet_limit: 10 }],
    ['paid-no-x', { id: 'paid-no-x', onboarding_completed: true, free_generation_used: true, daily_tweet_limit: 10 }],
  ]);

  (db as any).get = async (table: string, pred: (r: any) => boolean) => {
    if (table === 'users' || table === 'profiles') {
      for (const row of profiles.values()) {
        if (pred(row)) return row;
      }
      return undefined;
    }
    return originalGet(table as any, pred);
  };

  const gates = await import('../src/lib/gates');
  const originalResolve = gates.planResolver.resolve;
  const originalXConnected = gates.xConnectionResolver.isConnected;
  gates.planResolver.resolve = async (userId: string) => {
    if (userId === 'paid-user' || userId === 'paid-no-x') {
      return {
        status: 'active' as const,
        key: 'monthly',
        billing_status: 'active' as const,
        current_period_end: null,
        entitlements: [{ key: 'monthly', ends_at: null, status: 'active' }],
      };
    }
    return {
      status: 'none' as const,
      key: null,
      billing_status: 'none' as const,
      current_period_end: null,
      entitlements: [],
    };
  };

  const connectedX = new Set(['paid-user']);
  gates.xConnectionResolver.isConnected = async (userId: string) => connectedX.has(userId);

  const { requireAuth, requireOnboarded, wrap, uid } = await import('../src/routes/util');
  const { assertPaid, assertPaidAndXConnected } = gates;

  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth);

  app.get(
    '/api/tweets',
    requireOnboarded,
    wrap(async (req, res) => {
      res.json({ ok: true, userId: uid(req) });
    }),
  );

  app.post(
    '/api/tweets/generate',
    requireOnboarded,
    wrap(async (req, res) => {
      const user = profiles.get(uid(req));
      if (user?.free_generation_used) {
        await assertPaid(uid(req), 'more drafts');
      }
      res.status(201).json({ ok: true });
    }),
  );

  app.patch(
    '/api/tweets/:id/schedule',
    requireOnboarded,
    wrap(async (req, res) => {
      await assertPaidAndXConnected(uid(req), 'scheduling');
      res.json({ ok: true });
    }),
  );

  app.post(
    '/api/tweets/:id/publish',
    requireOnboarded,
    wrap(async (req, res) => {
      await assertPaidAndXConnected(uid(req), 'posting');
      res.status(201).json({ ok: true });
    }),
  );

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ error: { code: 'internal', message: String(err) } });
  });

  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, userId: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    const blocked = await call('GET', '/api/tweets', 'fresh-user');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.error.code, 'onboarding_required');

    const okRead = await call('GET', '/api/tweets', 'free-user');
    assert.equal(okRead.status, 200);

    const gen = await call('POST', '/api/tweets/generate', 'free-user');
    assert.equal(gen.status, 402);
    assert.equal(gen.json.error.code, 'paywall');

    const schedule = await call('PATCH', '/api/tweets/t1/schedule', 'free-user');
    assert.equal(schedule.status, 402);
    assert.equal(schedule.json.error.code, 'paywall');

    const paidNoX = await call('PATCH', '/api/tweets/t1/schedule', 'paid-no-x');
    assert.equal(paidNoX.status, 403);
    assert.equal(paidNoX.json.error.code, 'x_required');

    const publishNoX = await call('POST', '/api/tweets/t1/publish', 'paid-no-x');
    assert.equal(publishNoX.status, 403);
    assert.equal(publishNoX.json.error.code, 'x_required');

    const paidSchedule = await call('PATCH', '/api/tweets/t1/schedule', 'paid-user');
    assert.equal(paidSchedule.status, 200);

    const paidGen = await call('POST', '/api/tweets/generate', 'paid-user');
    assert.equal(paidGen.status, 201);
  } finally {
    (db as any).get = originalGet;
    gates.planResolver.resolve = originalResolve;
    gates.xConnectionResolver.isConnected = originalXConnected;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('double-click on generate: second request gets generation_in_progress', async () => {
  const { withGenerationLock, clearGenerationLocks } = await import('../src/lib/gates');
  clearGenerationLocks();

  let resolveHold!: () => void;
  const hold = new Promise<void>((r) => {
    resolveHold = r;
  });

  const a = withGenerationLock('dbl', async () => {
    await hold;
    return 1;
  });
  await assert.rejects(withGenerationLock('dbl', async () => 2), (e: unknown) => e instanceof AppError && e.code === 'generation_in_progress');
  resolveHold();
  assert.equal(await a, 1);
  clearGenerationLocks();
});
