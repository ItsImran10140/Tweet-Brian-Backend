import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  normalizeVoiceStyleConfidence,
  validateProfileWrite,
  validateSynthesisOutput,
} from '../src/lib/synthesisValidate';

test('normalizeVoiceStyleConfidence keeps categorical labels', () => {
  assert.equal(normalizeVoiceStyleConfidence('high'), 'high');
  assert.equal(normalizeVoiceStyleConfidence('low'), 'low');
  assert.equal(normalizeVoiceStyleConfidence('medium'), 'medium');
  assert.equal(normalizeVoiceStyleConfidence('nope', 12), 'high');
  assert.equal(normalizeVoiceStyleConfidence(undefined, 3), 'low');
  assert.equal(normalizeVoiceStyleConfidence(0.9), 'high');
  assert.equal(normalizeVoiceStyleConfidence(0.6), 'medium');
});

test('validateSynthesisOutput rejects empty summary and accepts mock-shaped payload', () => {
  assert.throws(() => validateSynthesisOutput({ summary: '' }), (err: any) => err?.code === 'synthesis_invalid');
  const ok = validateSynthesisOutput({
    summary: 'Direct founder voice.',
    dimensions: {},
    thinkingStyle: {},
    lenses: ['founder'],
    personaCard: { bio: 'Builder', expertise: ['AI'], values: [], stories: [], bannedWords: [], offLimitsTopics: [] },
    styleFingerprint: { formalityLevel: 3, usesHashtags: false, usesEmoji: false },
    voiceGuidance: 'Short sentences.',
    doList: ['Be concrete'],
    dontList: ['Hedge'],
    openQuestions: [],
  });
  assert.equal(ok.summary, 'Direct founder voice.');
  assert.equal(ok.styleFingerprint.formalityLevel, 3);
});

test('validateProfileWrite accepts high/low confidence strings (the production bug)', () => {
  const write = validateProfileWrite({
    brain_version: '1.0.0',
    summary: 'Portrait',
    computed_scores: { source: 'frontend_questionnaire', computed: false },
    dimensions: {},
    thinking_style: {},
    lenses: [],
    persona_card: { bio: 'x' },
    style_fingerprint: { formalityLevel: 4 },
    voice_style_confidence: 'high',
    voice_style_sample_count: 12,
    voice_guidance: 'Punchy.',
    do_list: [],
    dont_list: [],
    open_questions: [],
  });
  assert.equal(write.voice_style_confidence, 'high');
  assert.equal(write.voice_style_sample_count, 12);

  assert.throws(
    () =>
      validateProfileWrite({
        summary: 'x',
        style_fingerprint: {},
        voice_style_confidence: 'extreme',
      }),
    (err: any) => err?.code === 'profile_persist_invalid',
  );
});

test('synthesis with sample onboarding answers saves profile including voice_style_confidence', async () => {
  process.env.LLM_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';

  const { getSupabase } = await import('../src/data/client');
  const sb = getSupabase();
  const email = `synth-persist-${process.pid}-${Date.now()}@test.local`;
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { full_name: 'Synth Persist Test' },
  });
  if (createErr || !created.user) {
    throw new Error(`Failed to create test auth user: ${createErr?.message ?? 'unknown'}`);
  }
  const userId = created.user.id;

  const { createApp } = await import('../src/server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user-id': userId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    const createdUser = await call('POST', '/api/users', {});
    assert.equal(createdUser.status, 201, JSON.stringify(createdUser.json));

    const samples = Array.from({ length: 12 }, (_, i) => `Sample ${i}: ship the ugly version.`).join('\n\n');
    const draft = await call('PUT', '/api/onboarding/draft', {
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
          'p-8': { offLimits: [] },
          'p-9': { neverUse: ['synergy'], overused: [] },
          'p-10': ['Hot takes'],
          'ts-1': 4,
          'ts-2': 4,
          'ts-3': 3,
          'ts-4': 4,
          'ts-5': 3,
          'ts-6': 4,
          'ts-7': 3,
          'ts-8': 4,
          'ts-9': 3,
          'ts-10': 4,
          'ab-directness': 'A',
          'ab-structure': 'B',
          'ab-humor': 'A',
          'ab-vulnerability': 'B',
          'ab-hook': 'A',
          'ab-register': 'neither',
          'yv-samples': samples,
        },
        voice_style_meta: {
          sample_count: 12,
          confidence: 'high',
          low_confidence: false,
        },
      },
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.json));
    assert.equal(draft.json.ready_to_synthesize, true);

    const syn = await call('POST', '/api/onboarding/synthesize', { questionnaire: [] });
    assert.equal(syn.status, 200, JSON.stringify(syn.json));
    assert.ok(syn.json.profile?.summary);
    assert.equal(syn.json.profile.voice_style_confidence, 'high');
    assert.equal(syn.json.profile.voice_style_sample_count, 12);

    const profile = await call('GET', '/api/profile');
    assert.equal(profile.status, 200);
    assert.ok(profile.json.summary?.length > 0);
    assert.equal(profile.json.voice_style_confidence, 'high');

    // Onboarding answers must still be present after a successful save
    const savedDraft = await call('GET', '/api/onboarding/draft');
    assert.equal(savedDraft.json.answers.frontend_answers['p-1'], 'I build tools for founders');
    assert.equal(savedDraft.json.answers.voice_style_meta.confidence, 'high');
  } finally {
    server.close();
    await sb.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});
