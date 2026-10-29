import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { db } from '../data';
import { listPendingLearnings, respondToLearning } from '../lib/editLearning';
import { DEFAULT_VOICE_SLIDERS, normalizeVoiceSliders } from '../lib/voiceSliders';
import { parse, requireOnboarded, requireUser, uid, wrap } from './util';

export const profile = Router();
profile.use(requireUser);
// GET / remains available during onboarding (returns 404 until synthesize). Mutations require completion.

profile.get(
  '/',
  wrap(async (req, res) => {
    const p = await db.get('personality_profiles', (r) => r.user_id === uid(req));
    if (!p) throw new AppError(404, 'no_profile', 'No profile yet.', 'Run POST /api/onboarding/synthesize after saving your answers.');
    const rules = await db.all('learned_rules', (r) => r.user_id === uid(req) && !r.retired_at);
    res.json({
      summary: p.summary,
      persona_card: p.persona_card,
      voice_guidance: p.voice_guidance,
      style_fingerprint: p.style_fingerprint,
      voice_style_confidence: p.voice_style_confidence ?? null,
      voice_style_sample_count: p.voice_style_sample_count ?? null,
      voice_sliders: normalizeVoiceSliders(p.voice_sliders ?? DEFAULT_VOICE_SLIDERS),
      scores: p.computed_scores,
      lenses: p.lenses,
      do_list: p.do_list,
      dont_list: p.dont_list,
      open_questions: p.open_questions,
      brain_version: p.brain_version,
      pending_learnings: await listPendingLearnings(uid(req)),
      rules,
    });
  }),
);

const Patch = z.object({
  bannedWords: z.array(z.string()).optional(),
  offLimitsTopics: z.array(z.string()).optional(),
  stories: z.array(z.string()).optional(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).optional(),
  voiceSliders: z
    .object({
      casualPolished: z.number().min(1).max(10).optional(),
      seriousFunny: z.number().min(1).max(10).optional(),
      shortLong: z.number().min(1).max(10).optional(),
      humbleBold: z.number().min(1).max(10).optional(),
    })
    .optional(),
});

profile.patch(
  '/',
  requireOnboarded,
  wrap(async (req, res) => {
    const b = parse(Patch, req.body);
    const p = await db.get('personality_profiles', (r) => r.user_id === uid(req));
    if (!p) throw new AppError(404, 'no_profile', 'No profile yet.', 'Run POST /api/onboarding/synthesize first.');
    const card = { bannedWords: [], offLimitsTopics: [], stories: [], ...p.persona_card } as { bannedWords: string[]; offLimitsTopics: string[]; stories: string[] };
    const addRule = async (text: string) =>
      db.insert('learned_rules', { user_id: uid(req), source: 'user_stated', rule_text: text, supporting_event_ids: [], last_applied_at: null, retired_at: null });

    for (const w of b.bannedWords ?? []) if (!card.bannedWords.includes(w)) { card.bannedWords.push(w); await addRule(`Never use the word/phrase "${w}".`); }
    for (const t of b.offLimitsTopics ?? []) if (!card.offLimitsTopics.includes(t)) { card.offLimitsTopics.push(t); await addRule(`Never write about: ${t}.`); }
    for (const s of b.stories ?? []) if (!card.stories.includes(s)) { card.stories.push(s); await addRule(`The user's real story you may draw on: ${s}`); }
    let open: string[] = p.open_questions ?? [];
    for (const a of b.answers ?? []) {
      await addRule(`Q: ${a.question} A: ${a.answer}`);
      open = open.filter((q) => q !== a.question);
    }

    const patch: Record<string, unknown> = { persona_card: card, open_questions: open };
    let voiceSliders = normalizeVoiceSliders(p.voice_sliders);
    if (b.voiceSliders) {
      voiceSliders = normalizeVoiceSliders({ ...voiceSliders, ...b.voiceSliders });
      patch.voice_sliders = voiceSliders;
    }

    await db.update('personality_profiles', (r) => r.id === p.id, patch);
    res.json({ persona_card: card, open_questions: open, voice_sliders: voiceSliders });
  }),
);

profile.get(
  '/learnings',
  requireOnboarded,
  wrap(async (req, res) => {
    res.json({ learnings: await listPendingLearnings(uid(req)) });
  }),
);

profile.post(
  '/learnings/:id/respond',
  requireOnboarded,
  wrap(async (req, res) => {
    const { accept } = parse(z.object({ accept: z.boolean() }), req.body);
    const row = await respondToLearning(uid(req), String(req.params.id), accept);
    if (!row) throw new AppError(404, 'learning_not_found', 'No pending learning with that id.');
    res.json({ learning: row });
  }),
);
