import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { loadBig5, loadQuestions } from '../lib/brain';
import { db } from '../data';
import { computeAllScores } from '../lib/scoring';
import { PLACEHOLDER, runSynthesis } from '../lib/synthesize';
import { isValidHandle, normalizeHandle } from '../lib/text';
import { normalizeVoiceStyleConfidence } from '../lib/synthesisValidate';
import { extractVoiceStyleCard, splitWritingSamples } from '../lib/voiceStyleCard';
import { fetchTweetsForHandle } from '../references/service';
import { selectFewShot } from '../references/style/exemplars';
import { listAccounts } from '../references/store';
import { parse, requireUser, uid, wrap } from './util';

export const onboarding = Router();
onboarding.use(requireUser);

const STEPS = ['persona', 'thinking', 'voice', 'lenses', 'samples', 'references', 'big5'];
const OPTIONAL = ['big5', 'references'];
const KNOWN_KEYS = new Set(STEPS);
const FRONTEND_KEYS = new Set(['frontend_answers', 'frontend_progress']);
// persona q11 (paste your posts) and q12 (admire reason per account) are answered through `samples` and `references`
const PERSONA_SKIP = new Set(['q11', 'q12']);

const isAnswered = (v: unknown) =>
  (typeof v === 'string' && v.trim() !== '' && !v.includes(PLACEHOLDER)) || (Array.isArray(v) && v.length > 0) || typeof v === 'number';

function hasFrontendAnswer(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasFrontendAnswer);
  if (value && typeof value === 'object') return Object.values(value).some(hasFrontendAnswer);
  return false;
}

function frontendProgress(answers: Record<string, any>) {
  const frontend = answers.frontend_answers ?? {};
  const personaIds = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-10'];
  const thinkingIds = Array.from({ length: 15 }, (_, index) => `ts-${index + 1}`);
  const voiceIds = ['ab-directness', 'ab-structure', 'ab-humor', 'ab-vulnerability', 'ab-hook', 'ab-register'];
  const counts = {
    persona: personaIds.filter((id) => hasFrontendAnswer(frontend[id])).length,
    thinking: thinkingIds.filter((id) => hasFrontendAnswer(frontend[id])).length,
    voice: voiceIds.filter((id) => ['A', 'B', 'neither'].includes(frontend[id])).length,
  };
  const missing: string[] = [];
  if (counts.persona < personaIds.length) missing.push(`persona: complete the ${personaIds.length} required answers`);
  if (counts.thinking < 10) missing.push(`thinking style: answer at least 10 questions (you have ${counts.thinking})`);
  if (counts.voice < 5) missing.push(`voice: answer at least 5 pairs (you have ${counts.voice})`);
  return {
    sections: {
      persona: { answered: counts.persona, total: personaIds.length },
      thinking: { answered: counts.thinking, total: thinkingIds.length },
      voice: { answered: counts.voice, total: voiceIds.length },
      yourVoice: { answered: hasFrontendAnswer(frontend['yv-samples']) || hasFrontendAnswer(frontend['p-11']) || hasFrontendAnswer(frontend['ws-samples']) ? 1 : 0, total: 1 },
      storiesAndTakes: {
        answered: ['st-stories', 'st-opinions', 'st-numbers', 'st-hates'].filter((id) => hasFrontendAnswer(frontend[id])).length,
        total: 4,
      },
      writingSamples: { answered: hasFrontendAnswer(frontend['p-11']) || hasFrontendAnswer(frontend['ws-samples']) ? 1 : 0, total: 'optional' },
      references: { answered: Array.isArray(frontend['p-12']) ? frontend['p-12'].length : Array.isArray(frontend['ref-accounts']) ? frontend['ref-accounts'].length : 0, total: 'optional' },
      deepProfile: { answered: Object.keys(frontend).filter((id) => /^dp-\d+$/.test(id) && hasFrontendAnswer(frontend[id])).length, total: 10, note: 'optional' },
    },
    ready_to_synthesize: missing.length === 0,
    missing,
  };
}

// ---------- questions + template ----------

function questionGuide() {
  const q = loadQuestions();
  const guide: Record<string, unknown> = {};
  for (const p of q.persona) {
    if (PERSONA_SKIP.has(p.id)) continue;
    guide[p.id] = { step: 'persona', question: p.text, answer_with: p.type === 'multi_select' ? `a list, any of: ${JSON.stringify(p.options)}` : 'free text (use "" to skip)' };
  }
  for (const t of q.thinking) guide[t.id] = { step: 'thinking', statement: t.text, answer_with: '1 (strongly disagree) to 5 (strongly agree), or null to skip' };
  for (const v of q.voice) guide[v.id] = { step: 'voice', A: v.a, B: v.b, answer_with: '"A", "B" or "neither"' };
  return guide;
}

function buildTemplate() {
  const q = loadQuestions();
  const persona: Record<string, unknown> = {};
  for (const p of q.persona) {
    if (PERSONA_SKIP.has(p.id)) continue;
    persona[p.id] = p.type === 'multi_select' ? [] : PLACEHOLDER;
  }
  const thinking = Object.fromEntries(q.thinking.map((t) => [t.id, null]));
  const voice = Object.fromEntries(q.voice.map((v) => [v.id, null]));
  const big5 = Object.fromEntries(loadBig5().map((i) => [i.id, null]));
  return {
    persona,
    thinking,
    voice,
    lenses: [],
    samples: [],
    references: [],
    big5,
  };
}

onboarding.get('/questions', (_req, res) => {
  res.json({ steps: STEPS, optional_steps: OPTIONAL, ...loadQuestions(), big5: loadBig5() });
});

onboarding.get('/template', (_req, res) => {
  res.json({
    how_to_use: [
      '1. Copy the "body" object below into a PUT /api/onboarding/draft request (Postman: Body > raw > JSON).',
      '2. Replace every "' + PLACEHOLDER + '" with your real answer (use "" to skip a question). Put numbers 1-5 in "thinking", "A"/"B"/"neither" in "voice".',
      '3. "lenses": pick up to 2 from the list in "lens_options". "samples": 3-10 of your own past posts. "references" is optional (you can connect accounts later via /api/references).',
      '4. Send it. The response shows your progress and anything still missing. You can send it in pieces, each PUT merges into what is saved.',
      '5. When "ready_to_synthesize" is true, call POST /api/onboarding/synthesize.',
    ],
    lens_options: loadQuestions().lenses,
    questions_by_id: questionGuide(),
    body: { step: 'all', answers: buildTemplate() },
  });
});

// ---------- validation ----------

function validateAnswers(answers: Record<string, any>) {
  const q = loadQuestions();
  const errors: string[] = [];
  const warnings: string[] = [];
  const out: Record<string, any> = {};

  for (const [k, v] of Object.entries(answers)) {
    if (!KNOWN_KEYS.has(k)) {
      if (FRONTEND_KEYS.has(k)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          errors.push(`${k} must be an object`);
          continue;
        }
        out[k] = v;
      } else {
        warnings.push(`Unknown section "${k}" was saved but is not used. Sections: ${STEPS.join(', ')}.`);
        out[k] = v;
      }
      continue;
    }
    if (k === 'persona') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('persona must be an object like {"q1":"..."}'); continue; }
      const ids = new Set(q.persona.map((p) => p.id));
      const cleaned: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(v as Record<string, unknown>)) {
        if (!ids.has(id) || PERSONA_SKIP.has(id)) { warnings.push(`persona.${id}: not a persona question id (ignored)`); continue; }
        const def = q.persona.find((p) => p.id === id);
        if (def?.type === 'multi_select') {
          if (!Array.isArray(a) || a.some((x) => typeof x !== 'string')) { errors.push(`persona.${id} must be a list of strings`); continue; }
          const bad = (a as string[]).filter((x) => !(def.options ?? []).includes(x));
          if (bad.length) warnings.push(`persona.${id}: unrecognised options ${JSON.stringify(bad)}; allowed: ${JSON.stringify(def.options)}`);
        } else if (a !== null && typeof a !== 'string') { errors.push(`persona.${id} must be text`); continue; }
        cleaned[id] = a;
      }
      out[k] = cleaned;
    } else if (k === 'thinking' || k === 'big5') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${k} must be an object like {"${k === 'thinking' ? 't1' : 'b1'}": 4}`); continue; }
      const ids = new Set((k === 'thinking' ? q.thinking : loadBig5()).map((i) => i.id));
      const cleaned: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(v as Record<string, unknown>)) {
        if (!ids.has(id)) { warnings.push(`${k}.${id}: unknown id (ignored)`); continue; }
        if (a !== null && !(typeof a === 'number' && Number.isInteger(a) && a >= 1 && a <= 5)) { errors.push(`${k}.${id} must be a whole number 1-5 (or null to skip), got ${JSON.stringify(a)}`); continue; }
        cleaned[id] = a;
      }
      out[k] = cleaned;
    } else if (k === 'voice') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('voice must be an object like {"v1":"A"}'); continue; }
      const ids = new Set(q.voice.map((i) => i.id));
      const cleaned: Record<string, unknown> = {};
      for (const [id, a] of Object.entries(v as Record<string, unknown>)) {
        if (!ids.has(id)) { warnings.push(`voice.${id}: unknown id (ignored)`); continue; }
        if (a === null) { cleaned[id] = null; continue; }
        const s = typeof a === 'string' ? (a.toLowerCase() === 'neither' ? 'neither' : a.toUpperCase()) : '';
        if (!['A', 'B', 'neither'].includes(s)) { errors.push(`voice.${id} must be "A", "B" or "neither", got ${JSON.stringify(a)}`); continue; }
        cleaned[id] = s;
      }
      out[k] = cleaned;
    } else if (k === 'lenses') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { errors.push('lenses must be a list of strings'); continue; }
      const bad = v.filter((x: string) => !q.lenses.includes(x));
      if (bad.length) errors.push(`lenses: unknown ${JSON.stringify(bad)}; choose from ${JSON.stringify(q.lenses)}`);
      if (v.length > 2) errors.push('lenses: pick at most 2');
      out[k] = v;
    } else if (k === 'samples') {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) { errors.push('samples must be a list of strings (one past post each)'); continue; }
      out[k] = v.map((s: string) => s.trim()).filter(Boolean);
    } else if (k === 'references') {
      if (!Array.isArray(v)) { errors.push('references must be a list like [{"handle":"IndieHackers","admire_reason":"..."}]'); continue; }
      const cleaned = [];
      for (const r of v) {
        const handle = normalizeHandle(String(r?.handle ?? ''));
        if (!isValidHandle(handle)) { errors.push(`references: "${r?.handle}" is not a valid X handle`); continue; }
        cleaned.push({ handle, admire_reason: typeof r.admire_reason === 'string' ? r.admire_reason : '', sample_tweets: Array.isArray(r.sample_tweets) ? r.sample_tweets.filter((t: unknown) => typeof t === 'string') : [] });
      }
      out[k] = cleaned;
    }
  }
  return { errors, warnings, out };
}

// ---------- progress ----------

function progressOf(answers: Record<string, any>) {
  if (answers.frontend_answers) return frontendProgress(answers);
  const q = loadQuestions();
  const personaIds = q.persona.filter((p) => !PERSONA_SKIP.has(p.id)).map((p) => p.id);
  const count = (obj: any, ids: string[]) => ids.filter((id) => isAnswered(obj?.[id]) || (typeof obj?.[id] === 'string' && obj[id] === 'neither')).length;
  const persona = count(answers.persona, personaIds);
  const thinking = count(answers.thinking, q.thinking.map((t) => t.id));
  const voice = ['A', 'B', 'neither'].length && q.voice.filter((v) => ['A', 'B', 'neither'].includes(answers.voice?.[v.id])).length;
  const big5Items = loadBig5();
  const sections = {
    persona: { answered: persona, total: personaIds.length },
    thinking: { answered: thinking, total: q.thinking.length },
    voice: { answered: voice, total: q.voice.length },
    lenses: { answered: (answers.lenses ?? []).length, total: 2 },
    samples: { answered: (answers.samples ?? []).length, total: '3-10 recommended' },
    references: { answered: (answers.references ?? []).length, total: 'optional' },
    big5: { answered: big5Items.filter((i) => typeof answers.big5?.[i.id] === 'number').length, total: big5Items.length, note: 'optional' },
  };
  const missing: string[] = [];
  if (persona < 5) missing.push(`persona: answer at least 5 of ${personaIds.length} (you have ${persona})`);
  if (thinking < 10) missing.push(`thinking: rate at least 10 of ${q.thinking.length} statements (you have ${thinking})`);
  if (voice < 5) missing.push(`voice: choose A/B/neither for at least 5 of ${q.voice.length} pairs (you have ${voice})`);
  return { sections, ready_to_synthesize: missing.length === 0, missing };
}

const draftOf = async (userId: string): Promise<Record<string, any>> =>
  (await db.get('onboarding_drafts', (r) => r.user_id === userId))?.answers ?? {};

// ---------- draft ----------

onboarding.get(
  '/draft',
  wrap(async (req, res) => {
    const d = await db.get('onboarding_drafts', (r) => r.user_id === uid(req));
    const answers = d?.answers ?? {};
    res.json({ step: d?.step ?? STEPS[0], answers, ...progressOf(answers) });
  }),
);

// Autosave: body = { step: "thinking", answers: { thinking: { t1: 4, ... } } }. Each PUT merges into what is saved.
onboarding.put(
  '/draft',
  wrap(async (req, res) => {
    const { step, answers } = req.body ?? {};
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new AppError(400, 'invalid_request', 'Body must look like { "step": "persona", "answers": { "persona": { "q1": "..." } } }', 'GET /api/onboarding/template gives you the full shape.');
    }
    const { errors, warnings, out } = validateAnswers(answers);
    if (errors.length) throw new AppError(400, 'invalid_answers', errors.join('; '), 'Fix these and send again. Nothing was saved.');

    const cur = await draftOf(uid(req));
    const merged: Record<string, any> = { ...cur };
    for (const [k, v] of Object.entries(out)) {
      merged[k] = FRONTEND_KEYS.has(k)
        ? v
        : v && typeof v === 'object' && !Array.isArray(v)
          ? { ...(cur[k] ?? {}), ...(v as object) }
          : v;
    }
    const row = await db.upsertByUser('onboarding_drafts', uid(req), { answers: merged, step: step ?? 'persona' });
    const leftoverPlaceholders = Object.entries(merged.persona ?? {}).filter(([, v]) => typeof v === 'string' && (v as string).includes(PLACEHOLDER)).map(([k]) => k);
    if (leftoverPlaceholders.length) warnings.push(`Still placeholders (replace or set to ""): ${leftoverPlaceholders.join(', ')}`);
    res.json({ saved: true, step: row.step, warnings, ...progressOf(merged) });
  }),
);

// Preview the code-computed scores (no LLM)
onboarding.post(
  '/score',
  wrap(async (req, res) => {
    res.json(computeAllScores(loadQuestions(), loadBig5(), await draftOf(uid(req))));
  }),
);

onboarding.post(
  '/synthesize',
  wrap(async (req, res) => {
    const userId = uid(req);
    const { profile, warnings } = await runSynthesis(userId, { questionnaire: req.body?.questionnaire });
    const brainVersion = profile.brain_version ?? null;
    const cur = await draftOf(userId);
    await db.upsertByUser('onboarding_drafts', userId, {
      answers: cur,
      step: 'complete',
      brain_version: brainVersion,
    });
    await db.update('users', (u) => u.id === userId, { onboarding_completed: true });
    res.json({
      profile,
      warnings,
      onboarding_completed: true,
      brain_version: brainVersion,
      reference_accounts: (await listAccounts(userId)).map((a) => ({ id: a.id, handle: a.handle, tweets: a.tweets.length })),
      next: 'Open the generation screen and run your free draft batch (POST /api/tweets/generate).',
    });
  }),
);

const VoiceFingerprintBody = z.object({
  samples: z.union([z.string(), z.array(z.string())]).optional(),
  transcript: z.string().optional(),
});

/** Extract a structured voice style card from pasted tweets / a transcript. */
onboarding.post(
  '/voice-fingerprint',
  wrap(async (req, res) => {
    const body = parse(VoiceFingerprintBody, req.body);
    const fromSamples = splitWritingSamples(body.samples ?? []);
    const fromTranscript = splitWritingSamples(body.transcript ?? '');
    const samples = [...fromSamples, ...fromTranscript];
    if (samples.length === 0) {
      throw new AppError(400, 'no_samples', 'Paste 10–20 of your tweets, or upload a voice-note transcript.', 'Separate each tweet with a blank line.');
    }

    const result = await extractVoiceStyleCard(samples);
    const userId = uid(req);
    const cur = await draftOf(userId);
    await db.upsertByUser('onboarding_drafts', userId, {
      answers: {
        ...cur,
        voice_style_card: result.styleCard,
        voice_style_meta: {
          sample_count: result.sampleCount,
          confidence: result.confidence,
          low_confidence: result.lowConfidence,
          extracted_at: new Date().toISOString(),
        },
      },
      step: 'your-voice',
    });

    const existing = await db.get('personality_profiles', (r) => r.user_id === userId);
    if (existing) {
      await db.update('personality_profiles', (r) => r.id === existing.id, {
        style_fingerprint: result.styleCard,
        voice_style_confidence: normalizeVoiceStyleConfidence(result.confidence, result.sampleCount),
        voice_style_sample_count: result.sampleCount,
      });
    }

    await db.remove('user_writing_samples', (r) => r.user_id === userId);
    for (const sample of samples) await db.insert('user_writing_samples', { user_id: userId, sample_text: sample });

    res.json({
      style_card: result.styleCard,
      sample_count: result.sampleCount,
      confidence: result.confidence,
      low_confidence: result.lowConfidence,
      hint: result.lowConfidence
        ? 'Fewer than 10 samples — marked low-confidence. Add more tweets for a sharper fingerprint.'
        : undefined,
    });
  }),
);

// ---------- optional: use YOUR OWN X account as writing samples ----------

const OwnTweetsBody = z.object({
  handle: z.string().optional(),
  source: z.enum(['auto', 'all', 'x_api', 'third_party']).default('auto'),
  limit: z.number().int().min(5).max(3200).default(200),
  append: z.boolean().default(false),
});

onboarding.post(
  '/own-tweets',
  wrap(async (req, res) => {
    const body = parse(OwnTweetsBody, req.body);
    const user = (await db.get('users', (u) => u.id === uid(req)))!;
    const raw = body.handle ?? user.twitter_handle;
    if (!raw) throw new AppError(400, 'no_handle', 'No X handle given.', 'Send {"handle":"your_handle"} or set twitter_handle with PATCH /api/users/me.');
    const handle = normalizeHandle(raw);
    if (!isValidHandle(handle)) throw new AppError(400, 'invalid_handle', `"${raw}" is not a valid X handle.`);

    const fetched = await fetchTweetsForHandle(handle, {
      requested: body.source,
      limit: body.limit,
      manualHint: 'No key configured? Paste 3-10 of your own posts into "samples" with PUT /api/onboarding/draft instead.',
    });
    const picked = selectFewShot(fetched.tweets, 10).map((t) => t.text);
    if (picked.length === 0) throw new AppError(422, 'no_usable_tweets', `Fetched ${fetched.tweets.length} tweets but none were long enough to use as samples.`);

    const cur = await draftOf(uid(req));
    const samples = body.append ? [...new Set([...(cur.samples ?? []), ...picked])].slice(0, 10) : picked;
    await db.upsertByUser('onboarding_drafts', uid(req), { answers: { ...cur, samples }, step: 'samples' });
    await db.update('users', (u) => u.id === uid(req), { twitter_handle: handle });
    res.json({ handle, fetched: fetched.tweets.length, source: fetched.lastSource, samples_saved: samples.length, samples, attempts: fetched.attempts });
  }),
);
