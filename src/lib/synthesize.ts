import { AppError } from '../errors';
import { ensureAccount } from '../references/service';
import { chipsToItems, replaceOnboardingBank } from './experienceBank';
import { loadBig5, loadBrain, loadQuestions } from './brain';
import { db } from '../data';
import { llmJson } from './llm';
import { computeAllScores, flat } from './scoring';
import { isValidHandle, normalizeHandle } from './text';
import { normalizeStyleCard, splitWritingSamples } from './voiceStyleCard';
import {
  SynthesisSchema,
  normalizeVoiceStyleConfidence,
  profileWritePayload,
  validateProfileWrite,
  validateSynthesisOutput,
  type SynthesisResult,
} from './synthesisValidate';

export { SynthesisSchema } from './synthesisValidate';

const splitList = (s?: string) => (s ?? '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

export const PLACEHOLDER = 'TYPE YOUR ANSWER';

/**
 * Call the synthesizer LLM, validate shape, retry once on validation failure.
 * Does not write to the DB. Onboarding answers are never touched here.
 */
async function synthesizeFromLlm(input: {
  brain: string;
  user: string;
  meta: unknown;
}): Promise<SynthesisResult> {
  let lastErr: AppError | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? input.user
        : `${input.user}\n\nYour previous JSON failed validation (${lastErr?.message ?? 'invalid shape'}). Return ONLY valid JSON for the synthesis schema; no commentary.`;
    try {
      const raw = await llmJson({ kind: 'synthesize', brain: input.brain, user, meta: input.meta }, SynthesisSchema);
      return validateSynthesisOutput(raw);
    } catch (err) {
      if (err instanceof AppError && (err.code === 'synthesis_invalid' || err.code === 'llm_bad_output')) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw (
    lastErr ??
    new AppError(
      422,
      'synthesis_invalid',
      'Could not build a valid personality profile from the model output.',
      'Your onboarding answers are still saved. Try synthesize again.',
    )
  );
}

async function savePersonalityProfile(userId: string, patch: Record<string, unknown>) {
  const write = validateProfileWrite(patch);
  const payload = profileWritePayload(write);
  try {
    return await db.upsertByUser('personality_profiles', userId, payload);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(
      422,
      'profile_save_failed',
      `Could not save personality profile: ${msg.slice(0, 300)}`,
      'Your onboarding answers are still saved. Try synthesize again after fixing the issue.',
    );
  }
}

export async function runSynthesis(userId: string, options: { questionnaire?: unknown } = {}) {
  const draft = (await db.get('onboarding_drafts', (r) => r.user_id === userId))?.answers;
  if (!draft) throw new AppError(400, 'no_draft', 'No onboarding answers saved yet.', 'Save answers with PUT /api/onboarding/draft first (GET /api/onboarding/template shows the shape).');

  const frontendAnswers = draft.frontend_answers as Record<string, any> | undefined;
  if (frontendAnswers) {
    const voiceIds = ['ab-directness', 'ab-structure', 'ab-humor', 'ab-vulnerability', 'ab-hook', 'ab-register'];
    const voiceCount = voiceIds.filter((id) => ['A', 'B', 'neither'].includes(frontendAnswers[id])).length;
    const missing = [
      ...['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7', 'p-10'].filter((id) => !hasAnswer(frontendAnswers[id])),
      ...Array.from({ length: 10 }, (_, index) => `ts-${index + 1}`).filter((id) => !hasAnswer(frontendAnswers[id])),
    ];
    if (voiceCount < 5) missing.push(`voice: answer at least 5 pairs (you have ${voiceCount})`);
    if (missing.length) {
      throw new AppError(400, 'incomplete_frontend_answers', `Required onboarding answers are missing: ${missing.join(', ')}.`, 'Return to onboarding, complete the required questions, and try again.');
    }

    const brain = loadBrain();
    const samples = [
      ...frontendSamples(frontendAnswers['p-11']),
      ...frontendSamples(frontendAnswers['ws-samples']),
      ...frontendSamples(frontendAnswers['yv-samples']),
      ...splitWritingSamples(typeof frontendAnswers['yv-transcript'] === 'string' ? frontendAnswers['yv-transcript'] : ''),
    ];
    const references = Array.isArray(frontendAnswers['p-12'])
      ? frontendAnswers['p-12']
      : Array.isArray(frontendAnswers['ref-accounts'])
        ? frontendAnswers['ref-accounts']
        : [];
    const experience = frontendAnswers['p-6']?.experiences;
    const bankStories = frontendAnswers['st-stories']?.stories;
    const bankOpinions = frontendAnswers['st-opinions']?.opinions;
    const bankNumbers = frontendAnswers['st-numbers']?.numbers;
    const bankHates = frontendAnswers['st-hates']?.hates;
    const allStories = [
      ...(Array.isArray(experience) ? experience : []),
      ...(Array.isArray(bankStories) ? bankStories : []),
    ];
    const personaCardInput = {
      bio: frontendAnswers['p-1'] ?? '',
      audience: frontendAnswers['p-2'] ?? '',
      outcomes: frontendAnswers['p-3'] ?? [],
      beliefs: frontendAnswers['p-4']?.beliefs ?? [],
      hotTake: frontendAnswers['p-5'] ?? '',
      experiences: allStories,
      opinions: Array.isArray(bankOpinions) ? bankOpinions : [],
      keyNumbers: Array.isArray(bankNumbers) ? bankNumbers : [],
      nicheHates: Array.isArray(bankHates) ? bankHates : [],
      expertise: frontendAnswers['p-7']?.authority ?? [],
      learning: frontendAnswers['p-7']?.learning ?? [],
      offLimits: frontendAnswers['p-8']?.offLimits ?? [],
      neverUse: frontendAnswers['p-9']?.neverUse ?? [],
      overused: frontendAnswers['p-9']?.overused ?? [],
      formats: frontendAnswers['p-10'] ?? [],
    };
    const draftVoiceCard = draft.voice_style_card ? normalizeStyleCard(draft.voice_style_card) : null;
    const draftVoiceMeta = draft.voice_style_meta ?? {};
    const user = JSON.stringify({
      questionnaire: options.questionnaire ?? null,
      answers: frontendAnswers,
      personaCardInput,
      writingSamples: samples,
      existingVoiceStyleCard: draftVoiceCard,
      referenceAccounts: references.map((r: any) => ({
        handle: r?.handle,
        admireReason: Array.isArray(r?.admires) ? r.admires.join(', ') : '',
        samples: frontendSamples(r?.samples),
      })),
      deepProfileAnswers: Object.fromEntries(Object.entries(frontendAnswers).filter(([id]) => id.startsWith('dp-'))),
    }, null, 2);
    const refs = references.map((r: any) => ({
      handle: r?.handle,
      admire_reason: Array.isArray(r?.admires) ? r.admires.join(', ') : '',
      sample_tweets: frontendSamples(r?.samples),
    }));
    const meta = {
      lenses: [],
      stories: allStories,
      bannedWords: [
        ...(Array.isArray(frontendAnswers['p-9']?.neverUse) ? frontendAnswers['p-9'].neverUse : []),
        ...(Array.isArray(frontendAnswers['p-9']?.overused) ? frontendAnswers['p-9'].overused : []),
      ],
      offLimits: Array.isArray(frontendAnswers['p-8']?.offLimits) ? frontendAnswers['p-8'].offLimits : [],
    };
    const frontendBrain = `${brain.text}\n\nThe following user record uses the questionnaire supplied in the JSON. Interpret answer IDs only through their supplied question labels and options. Do not force these answers into another questionnaire or invent numeric scores from unrelated items. If existingVoiceStyleCard is present, prefer it for styleFingerprint and refine only if samples clearly contradict it.`;

    // Validate LLM output (with one retry) BEFORE any database writes so failed synthesis never looks like a 500 mid-save.
    const result = await synthesizeFromLlm({ brain: frontendBrain, user, meta });
    const warnings: string[] = [];

    if (draftVoiceCard) {
      result.styleFingerprint = normalizeStyleCard({ ...result.styleFingerprint, ...draftVoiceCard });
    } else {
      result.styleFingerprint = normalizeStyleCard(result.styleFingerprint);
    }

    result.personaCard = {
      ...result.personaCard,
      stories: [...new Set([...(result.personaCard.stories ?? []), ...allStories])],
    };

    const sampleCount = typeof draftVoiceMeta.sample_count === 'number' ? draftVoiceMeta.sample_count : samples.length;
    const confidence = normalizeVoiceStyleConfidence(draftVoiceMeta.confidence, sampleCount);

    const profilePatch = validateProfileWrite({
      brain_version: brain.version,
      summary: result.summary,
      computed_scores: { source: 'frontend_questionnaire', computed: false },
      dimensions: result.dimensions,
      thinking_style: result.thinkingStyle,
      lenses: result.lenses,
      persona_card: result.personaCard,
      style_fingerprint: result.styleFingerprint,
      voice_style_confidence: confidence,
      voice_style_sample_count: sampleCount > 0 ? sampleCount : undefined,
      voice_guidance: result.voiceGuidance,
      do_list: result.doList,
      dont_list: result.dontList,
      open_questions: result.openQuestions,
    });

    await db.remove('user_writing_samples', (r) => r.user_id === userId);
    for (const sample of samples) await db.insert('user_writing_samples', { user_id: userId, sample_text: sample });
    for (const reference of refs) {
      const handle = normalizeHandle(String(reference.handle ?? ''));
      if (!isValidHandle(handle)) {
        warnings.push(`Skipped reference "${reference.handle}": not a valid X handle.`);
        continue;
      }
      await ensureAccount(userId, handle, {
        admireReason: reference.admire_reason,
        sampleTweets: reference.sample_tweets,
      });
    }

    await replaceOnboardingBank(userId, [
      ...chipsToItems(bankStories, 'story'),
      ...chipsToItems(experience, 'story'),
      ...chipsToItems(bankOpinions, 'opinion'),
      ...chipsToItems(
        typeof frontendAnswers['p-5'] === 'string' && frontendAnswers['p-5'].trim()
          ? [frontendAnswers['p-5']]
          : [],
        'opinion',
      ),
      ...chipsToItems(bankNumbers, 'number'),
      ...chipsToItems(bankHates, 'hate'),
    ]);

    const profile = await savePersonalityProfile(userId, profilePatch);
    return { profile, warnings };
  }

  const persona = draft.persona ?? {};
  const stillPlaceholder = Object.entries(persona)
    .filter(([, v]) => typeof v === 'string' && v.includes(PLACEHOLDER))
    .map(([k]) => k);
  if (stillPlaceholder.length) {
    throw new AppError(400, 'placeholder_answers', `These persona answers still say "${PLACEHOLDER}": ${stillPlaceholder.join(', ')}.`, 'Replace them with your real answers (or empty strings) and PUT /api/onboarding/draft again.');
  }

  const q = loadQuestions();
  const brain = loadBrain();
  const scores = computeAllScores(q, loadBig5(), draft); // 1. scores in CODE
  const samples: string[] = (draft.samples ?? []).filter((s: unknown) => typeof s === 'string' && s.trim());
  const refs: any[] = Array.isArray(draft.references) ? draft.references : [];
  const lenses: string[] = (draft.lenses ?? []).slice(0, 2);
  const warnings: string[] = [];

  const user = JSON.stringify(
    {
      computedScores: scores,
      personaAnswers: persona,
      writingSamples: samples,
      referenceAccounts: refs.map((r) => ({ handle: r.handle, samples: r.sample_tweets, admireReason: r.admire_reason })),
      pickedLenses: lenses,
    },
    null,
    2,
  );

  const meta = {
    lenses,
    stories: persona.q5 ? [persona.q5] : [],
    bannedWords: splitList(persona.q7),
    offLimits: splitList(persona.q6),
  };

  const result = await synthesizeFromLlm({ brain: brain.text, user, meta });

  // 2. overwrite dimensions/thinkingStyle with code-computed values (the LLM only interprets them)
  result.dimensions = { ...flat(scores.big5), ...flat(scores.voice) };
  result.thinkingStyle = flat(scores.thinkingStyle);

  result.styleFingerprint = normalizeStyleCard(
    draft.voice_style_card
      ? { ...result.styleFingerprint, ...normalizeStyleCard(draft.voice_style_card) }
      : result.styleFingerprint,
  );

  const sampleCount = typeof draft.voice_style_meta?.sample_count === 'number'
    ? draft.voice_style_meta.sample_count
    : samples.length;
  const confidence = normalizeVoiceStyleConfidence(draft.voice_style_meta?.confidence, sampleCount);

  const profilePatch = validateProfileWrite({
    brain_version: brain.version,
    summary: result.summary,
    computed_scores: scores,
    dimensions: result.dimensions,
    thinking_style: result.thinkingStyle,
    lenses: result.lenses,
    persona_card: result.personaCard,
    style_fingerprint: result.styleFingerprint,
    voice_style_confidence: confidence,
    voice_style_sample_count: sampleCount > 0 ? sampleCount : undefined,
    voice_guidance: result.voiceGuidance,
    do_list: result.doList,
    dont_list: result.dontList,
    open_questions: result.openQuestions,
  });

  // 3. save writing samples (after validated profile payload)
  await db.remove('user_writing_samples', (r) => r.user_id === userId);
  for (const s of samples) await db.insert('user_writing_samples', { user_id: userId, sample_text: s });

  // 4. accounts listed in the onboarding answers become connected reference accounts (existing ones are kept)
  for (const r of refs) {
    const handle = normalizeHandle(String(r?.handle ?? ''));
    if (!isValidHandle(handle)) {
      warnings.push(`Skipped reference "${r?.handle}": not a valid X handle.`);
      continue;
    }
    await ensureAccount(userId, handle, {
      admireReason: r.admire_reason,
      sampleTweets: Array.isArray(r.sample_tweets) ? r.sample_tweets.filter((t: unknown) => typeof t === 'string') : [],
    });
  }

  const profile = await savePersonalityProfile(userId, profilePatch);
  return { profile, warnings };
}

function hasAnswer(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasAnswer);
  if (value && typeof value === 'object') return Object.values(value).some(hasAnswer);
  return false;
}

function frontendSamples(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((sample): sample is string => typeof sample === 'string' && sample.trim().length > 0).map((sample) => sample.trim());
  if (typeof value !== 'string') return [];
  return value.split(/\r?\n\s*\r?\n/).map((sample) => sample.trim()).filter(Boolean);
}
