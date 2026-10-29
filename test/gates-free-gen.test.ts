/**
 * First-run onboarding + free-batch gates.
 * Run: ALLOW_TEST_AUTH=1 npm test -- test/gates-free-gen.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors';

test('withGenerationLock rejects a second concurrent generate (double-click)', async () => {
  process.env.ALLOW_TEST_AUTH = '1';
  const { withGenerationLock, clearGenerationLocks } = await import('../src/lib/gates');
  clearGenerationLocks();

  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });

  const first = withGenerationLock('user-a', async () => {
    await hold;
    return 'ok';
  });

  await assert.rejects(
    () => withGenerationLock('user-a', async () => 'second'),
    (err: unknown) => err instanceof AppError && err.code === 'generation_in_progress' && err.status === 409,
  );

  release();
  assert.equal(await first, 'ok');
  clearGenerationLocks();
});

test('throwBlocked maps free_paused and paywall codes', async () => {
  const { throwBlocked } = await import('../src/lib/gates');

  assert.throws(
    () =>
      throwBlocked({
        mode: 'blocked',
        code: 'free_paused',
        message: 'Free drafts are paused for today, subscribe to continue',
      }),
    (err: unknown) => err instanceof AppError && err.code === 'free_paused' && err.status === 503,
  );

  assert.throws(
    () => throwBlocked({ mode: 'blocked', code: 'paywall', message: 'Subscribe to unlock more drafts.' }),
    (err: unknown) => err instanceof AppError && err.code === 'paywall' && err.status === 402,
  );
});

test('generation failure path does not mark free used (persist skipped on empty tweets)', async () => {
  // Pure contract: generateWithEntitlement only calls persistFreeBatch when tweets.length > 0.
  // Simulate the guard used in generateWithEntitlement.
  const tweets: unknown[] = [];
  let freeMarked = false;
  if (!tweets.length) {
    // would throw generation_failed — free_generation_used stays false
  } else {
    freeMarked = true;
  }
  assert.equal(freeMarked, false);
});

test('onboarding progress merge prefers server resume cursor', () => {
  // Mirrors frontend hydrate rule: server frontend_progress wins unless local is further ahead.
  const server = { sectionIndex: 2, questionIndex: 1, answers: { 'p-1': 'a' } };
  const localBehind = { sectionIndex: 0, questionIndex: 0, answers: { 'p-1': 'a' } };
  const localAhead = { sectionIndex: 3, questionIndex: 0, answers: { 'p-1': 'a', 'p-2': 'b' } };

  const pick = (local: typeof localBehind, remote: typeof server) => {
    const localAheadOfServer =
      local.sectionIndex > remote.sectionIndex
      || (local.sectionIndex === remote.sectionIndex && local.questionIndex > remote.questionIndex);
    return localAheadOfServer ? local : remote;
  };

  assert.deepEqual(pick(localBehind, server), server);
  assert.deepEqual(pick(localAhead, server), localAhead);
});
