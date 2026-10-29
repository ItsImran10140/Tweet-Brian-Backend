import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

// Whole flow in MOCK mode against an isolated data file: onboarding -> references -> digest -> generate -> feedback.
test('full flow in mock mode', async () => {
  const file = `./data/test-flow-${process.pid}.json`;
  process.env.CONFIG_FILE = '/nonexistent.yml';
  process.env.DATA_FILE = file;
  process.env.LLM_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';
  process.env.ADMIN_KEY = 'test-admin-key';
  const { createApp } = await import('../src/server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, uid?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(uid ? { 'x-test-user-id': uid } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    const health = (await call('GET', '/health')).json;
    assert.equal(health.ok, true);
    assert.equal(health.service, 'tweet-brain');
    assert.equal(health.llm, undefined);
    const onboardingPage = await fetch(base + '/onboarding');
    assert.equal(onboardingPage.status, 200);
    assert.match(onboardingPage.headers.get('content-type') ?? '', /text\/html/);
    const onboardingHtml = await onboardingPage.text();
    assert.match(onboardingHtml, /Save answers &amp; build profile/);
    assert.match(onboardingHtml, /Generate tweets/);
    assert.equal((await call('GET', '/api/profile')).status, 401);

    const u = (await call('POST', '/api/users', {})).json;
    const H = u.id;

    // validation rejects bad answers and saves nothing
    const bad = await call('PUT', '/api/onboarding/draft', { answers: { thinking: { t1: 9 } } }, H);
    assert.equal(bad.status, 400);

    // synthesize refuses to run while answers are template placeholders
    const tpl = (await call('GET', '/api/onboarding/template', undefined, H)).json;
    assert.ok(tpl.body.answers.persona.q1.includes('TYPE YOUR ANSWER'));
    await call('PUT', '/api/onboarding/draft', tpl.body, H);
    const early = await call('POST', '/api/onboarding/synthesize', undefined, H);
    assert.equal(early.status, 400);
    assert.equal(early.json.error.code, 'placeholder_answers');

    const thinking = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`t${i + 1}`, (i % 5) + 1]));
    const voice = Object.fromEntries(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'].map((k, i) => [k, i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'neither']));
    const persona = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i + 1}`, `answer ${i + 1}`]));
    persona.q10 = ['AI'] as any;
    persona.q7 = 'synergy, leverage';
    const saved = await call('PUT', '/api/onboarding/draft', { answers: { persona, thinking, voice, lenses: ['founder'], samples: ['one', 'two', 'three'] } }, H);
    assert.equal(saved.json.ready_to_synthesize, true);

    const syn = await call('POST', '/api/onboarding/synthesize', undefined, H);
    assert.equal(syn.status, 200);
    assert.ok((await call('GET', '/api/profile', undefined, H)).json.summary);

    // reference account by paste
    const ref = await call('POST', '/api/references', { handle: '@IndieHackers', text: 'Ship the ugly version this week\n---\nSimple pricing beats clever pricing everywhere', analyze: true }, H);
    assert.equal(ref.status, 201);
    assert.equal(ref.json.account.tweets, 2);
    assert.equal((await call('POST', '/api/references', { handle: 'indiehackers' }, H)).status, 409);
    const ctx = await call('GET', `/api/references/${ref.json.account.id}/context`, undefined, H);
    assert.match(ctx.json.context, /<reference_style account="@IndieHackers">/);

    // newsletter endpoints are gone
    assert.equal((await call('POST', '/api/newsletters/paste', { text: 'x' }, H)).status, 404);

    // no niches are configured in this test: the digest is empty and generation falls back to evergreen tweets
    assert.equal((await call('GET', '/api/digest/niches', undefined, H)).json.niches.length, 0);
    assert.equal((await call('POST', '/api/users', { niche: 'nope' })).status, 400);

    const gen = await call('POST', '/api/tweets/generate', { count: 5 }, H);
    assert.equal(gen.status, 201);
    assert.equal(gen.json.saved, 5);
    assert.deepEqual(gen.json.used.reference_accounts, ['IndieHackers']);
    assert.equal(gen.json.evergreen_tweets, 5);

    // feedback
    const id = gen.json.tweets[0].id;
    assert.equal((await call('POST', `/api/tweets/${id}/like`, undefined, H)).status, 200);
    assert.equal((await call('POST', `/api/tweets/${id}/discard`, { reason: 'nope' }, H)).status, 400);

    // The app's calendar and schedule are backed by user-owned API data.
    const slots = await call('GET', '/api/publishing/slots', undefined, H);
    assert.equal(slots.status, 200);
    assert.ok(slots.json.slots.length > 0);
    const savedSlots = await call('PUT', '/api/publishing/slots', {
      slots: [{ dayOfWeek: 1, time: '09:30', enabled: true }],
    }, H);
    assert.deepEqual(savedSlots.json.slots.map(({ dayOfWeek, time, enabled }: any) => ({ dayOfWeek, time, enabled })), [
      { dayOfWeek: 1, time: '09:30', enabled: true },
    ]);
    assert.equal((await call('GET', '/api/publishing/slots', undefined, H)).json.slots[0].time, '09:30');

    const scheduledAtUtc = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const scheduled = await call('PATCH', `/api/tweets/${id}/schedule`, {
      scheduledAtUtc,
      text: 'Edited and scheduled',
    }, H);
    assert.equal(scheduled.status, 200);
    assert.equal(scheduled.json.status, 'scheduled');
    assert.equal(scheduled.json.text, 'Edited and scheduled');
    assert.equal(scheduled.json.scheduled_at, scheduledAtUtc);

    const duplicate = await call('POST', `/api/tweets/${id}/duplicate`, { scheduledAtUtc: null }, H);
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.json.status, 'pending');
    assert.equal(duplicate.json.text, 'Edited and scheduled');
    const locallyPublished = await call('POST', `/api/tweets/${duplicate.json.id}/publish`, {}, H);
    assert.equal(locallyPublished.status, 200);
    assert.equal(locallyPublished.json.status, 'published');
    assert.equal(locallyPublished.json.external_publish, false);
    assert.equal((await call('DELETE', `/api/tweets/${duplicate.json.id}`, undefined, H)).json.id, duplicate.json.id);

    // other users cannot see my data
    const other = (await call('POST', '/api/users', {})).json;
    assert.equal((await call('GET', '/api/references', undefined, other.id)).json.accounts.length, 0);
    assert.equal((await call('POST', `/api/tweets/${id}/like`, undefined, other.id)).status, 404);
    assert.equal((await call('GET', '/api/publishing/slots', undefined, other.id)).json.slots.length > 0, true);

    const frontendUser = (await call('POST', '/api/users', {})).json;
    const frontendAnswers = {
      'p-1': 'I build tools for independent founders.',
      'p-2': 'A founder trying to find their first customers.',
      'p-3': ['Learn something', 'Feel less alone'],
      'p-4': { beliefs: ['Talk to users', 'Ship early', 'Write clearly'] },
      'p-5': 'Most founders should talk to users before adding features.',
      'p-6': { experiences: ['A failed launch', 'A customer interview', 'A useful lesson'] },
      'p-7': { authority: ['Customer discovery'], learning: ['Audience growth'] },
      'p-8': { offLimits: ['Personal health'] },
      'p-9': { neverUse: ['synergy'], overused: ['amazing'] },
      'p-10': ['Lessons learned'],
      'p-11': 'A real writing sample.',
      'p-12': [{ handle: 'IndieHackers', samples: '', admires: ['Clarity'] }],
      'ws-samples': 'Another writing sample.',
      ...Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`ts-${index + 1}`, (index % 5) + 1])),
      'ab-directness': 'A',
      'ab-structure': 'B',
      'ab-humor': 'neither',
      'ab-vulnerability': 'A',
      'ab-hook': 'B',
      'ab-register': 'A',
      'dp-1': 4,
    };
    const frontendSaved = await call('PUT', '/api/onboarding/draft', {
      step: 'persona',
      answers: {
        frontend_answers: frontendAnswers,
        frontend_progress: { sectionIndex: 0, questionIndex: 1, completed: false, deepProfileSkipped: false },
      },
    }, frontendUser.id);
    assert.equal(frontendSaved.status, 200);
    assert.equal(frontendSaved.json.ready_to_synthesize, true);
    assert.deepEqual(frontendSaved.json.warnings, []);
    const frontendDraft = await call('GET', '/api/onboarding/draft', undefined, frontendUser.id);
    assert.deepEqual(frontendDraft.json.answers.frontend_answers, frontendAnswers);
    assert.deepEqual(frontendDraft.json.answers.frontend_progress, { sectionIndex: 0, questionIndex: 1, completed: false, deepProfileSkipped: false });

    const frontendSynthesis = await call('POST', '/api/onboarding/synthesize', {
      questionnaire: [{ id: 'persona', questions: [{ id: 'p-1', label: 'What do you build?' }] }],
    }, frontendUser.id);
    assert.equal(frontendSynthesis.status, 200);
    assert.equal(frontendSynthesis.json.profile.computed_scores.source, 'frontend_questionnaire');
    assert.equal((await call('GET', '/api/profile', undefined, frontendUser.id)).json.summary.length > 0, true);
    assert.equal((await call('DELETE', '/api/users/me', undefined, frontendUser.id)).status, 200);

    assert.equal((await call('DELETE', '/api/users/me', undefined, H)).status, 200);
  } finally {
    server.close();
    for (const f of [file, `${file}.tmp`]) if (fs.existsSync(f)) fs.rmSync(f);
  }
});
