import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

test('multi-step generation saves format, material, and style-match metadata', async () => {
  const file = `./data/test-pipeline-unit-${process.pid}.json`;
  process.env.CONFIG_FILE = '/nonexistent.yml';
  process.env.DATA_FILE = file;
  process.env.LLM_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.GENERATION_PIPELINE = 'multi';
  process.env.GENERATION_LOG_STAGES = 'true';
  process.env.GENERATION_LOG_DIR = './data/generation-logs';
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';

  const { createApp } = await import('../src/server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, uid?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(uid ? { 'x-test-user-id': uid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    const u = (await call('POST', '/api/users', {})).json;
    const H = u.id as string;
    const samples = Array.from({ length: 12 }, (_, i) => `Post ${i}: keep it concrete.`).join('\n\n');
    await call(
      'PUT',
      '/api/onboarding/draft',
      {
        step: 'persona',
        answers: {
          frontend_answers: {
            'p-1': 'I build tools for founders',
            'p-2': 'indie hackers',
            'p-3': ['ship faster'],
            'p-4': { beliefs: ['clarity'] },
            'p-5': 'Most advice is noise',
            'p-6': { experiences: ['Lost a client'] },
            'p-7': { authority: ['email'], learning: ['ads'] },
            'p-10': ['Hot takes'],
            'ts-1': 4, 'ts-2': 4, 'ts-3': 3, 'ts-4': 4, 'ts-5': 3, 'ts-6': 4, 'ts-7': 3, 'ts-8': 4, 'ts-9': 3, 'ts-10': 4,
            'ab-directness': 'A', 'ab-structure': 'B', 'ab-humor': 'A', 'ab-vulnerability': 'B', 'ab-hook': 'A', 'ab-register': 'neither',
            'yv-samples': samples,
            'st-stories': { stories: ['a', 'b', 'c', 'd', 'e'] },
            'st-opinions': { opinions: ['a', 'b', 'c', 'd', 'e'] },
            'st-numbers': { numbers: ['$8k MRR'] },
            'st-hates': { hates: ['hustle', 'synergy', 'grind'] },
          },
        },
      },
      H,
    );
    assert.equal((await call('POST', '/api/onboarding/synthesize', { questionnaire: [] }, H)).status, 200);

    const gen = await call('POST', '/api/tweets/generate', { count: 3, refresh_digest: false, pipeline: 'multi' }, H);
    assert.equal(gen.status, 201);
    assert.equal(gen.json.pipeline, 'multi');
    assert.ok(gen.json.saved >= 1);
    assert.ok(gen.json.stage_log?.stages?.length >= 2);
    for (const t of gen.json.tweets) {
      assert.ok(t.format_id);
      assert.ok(t.material_source);
      assert.equal(typeof t.style_match_score, 'number');
    }

    const single = await call('POST', '/api/tweets/generate', { count: 2, refresh_digest: false, pipeline: 'single' }, H);
    assert.equal(single.status, 201);
    assert.equal(single.json.pipeline, 'single');
  } finally {
    server.close();
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
});

test('banned pattern matcher catches configured phrases', async () => {
  const { findBannedHits } = await import('../src/lib/generation/banned');
  const hits = findBannedHits('This taught me one thing about shipping. It is a game-changer.', [
    'taught me one thing',
    'game-changer',
    're:the real .+ is never',
  ]);
  assert.ok(hits.includes('taught me one thing'));
  assert.ok(hits.includes('game-changer'));
});
