/**
 * Auth hardening, rate-limit surface, safe logs, lean health.
 * Run: npm test -- test/hardening.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { redact, redactString } from '../src/lib/safeLog';
import { createApp } from '../src/server';

test('safeLog redacts bearer tokens and service-role shaped secrets', () => {
  const s = redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaa.bbb and sb_secret_abc123XYZ');
  assert.ok(!s.includes('eyJ'), s);
  assert.ok(!s.includes('sb_secret_'), s);
  assert.match(s, /\[REDACTED\]/);

  const obj = redact({
    authorization: 'Bearer secret-token',
    nested: { api_key: 'sk-live-abcdef', ok: true },
  }) as Record<string, unknown>;
  assert.equal(obj.authorization, '[REDACTED]');
  assert.equal((obj.nested as Record<string, unknown>).api_key, '[REDACTED]');
  assert.equal((obj.nested as Record<string, unknown>).ok, true);
});

test('GET /health is public and lean; admin status requires ADMIN_KEY', async () => {
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';
  // Ensure admin key is set for this process (config already parsed — patch via header mismatch test).
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const body = (await health.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.service, 'tweet-brain');
    assert.equal(body.llm, undefined);
    assert.equal(body.digest, undefined);

    const statusNoKey = await fetch(`${base}/api/admin/status`);
    assert.ok(statusNoKey.status === 401 || statusNoKey.status === 503, `got ${statusNoKey.status}`);

    const llmNoKey = await fetch(`${base}/api/llm/test`);
    assert.ok(llmNoKey.status === 401 || llmNoKey.status === 503, `got ${llmNoKey.status}`);

    const devNoKey = await fetch(`${base}/api/dev/run-learning`, { method: 'POST' });
    assert.ok(devNoKey.status === 401 || devNoKey.status === 503, `got ${devNoKey.status}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});

test('user API still requires auth; 500s do not echo raw Error.message', async () => {
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';
  const app = createApp();
  const server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    const noAuth = await fetch(`${base}/api/me`);
    assert.equal(noAuth.status, 401);

    const withTest = await fetch(`${base}/api/me`, { headers: { 'x-test-user-id': 'hardening-user' } });
    // May 200 (profile created) or 5xx if Supabase missing in CI — but never leak stack in body shape.
    const json = (await withTest.json()) as { error?: { message?: string; code?: string } };
    if (withTest.status >= 500) {
      assert.equal(json.error?.code, 'internal_error');
      assert.equal(json.error?.message, 'Unexpected error');
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
