import { z } from 'zod';
import { AppError } from '../errors';
import { db } from '../data';
import { llmJson } from './llm';
import { ideaSource } from './research';
import { normalizeStyleCard } from './voiceStyleCard';
import { voiceSlidersPrompt } from './voiceSliders';

const Variants = z.object({
  variants: z.array(z.string()).min(1).max(5),
});

/** Rewrite a rough idea into 3 voice-matched variants (not saved unless the client asks). */
export async function rewriteFromIdea(userId: string, idea: string) {
  const trimmed = idea.trim();
  if (trimmed.length < 3) throw new AppError(400, 'idea_too_short', 'Type a rough thought first.');

  const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
  if (!profile) throw new AppError(400, 'no_profile', 'Finish onboarding before rewriting ideas.');

  const style = normalizeStyleCard(profile.style_fingerprint);
  const sliders = voiceSlidersPrompt(profile.voice_sliders);

  const result = await llmJson(
    {
      kind: 'draft',
      brain: 'You rewrite a rough idea into short social posts in the user\'s voice. Return JSON only.',
      system: JSON.stringify({
        styleFingerprint: style,
        voiceGuidance: profile.voice_guidance,
        voiceSliders: sliders,
        doList: profile.do_list,
        dontList: profile.dont_list,
        persona: profile.persona_card,
      }),
      user: `ROUGH IDEA:
"""
${trimmed.slice(0, 1000)}
"""

Write exactly 3 different variants in the user's voice (max 280 chars each).
Vary structure (one punchy, one with a concrete detail, one with a question or twist).
Do not invent facts the user did not imply. Match style card rhythm and contractions.

Return JSON: { "variants": ["...", "...", "..."] }`,
      temperature: 0.85,
      meta: { format: 'from_idea' },
    },
    Variants,
  );

  const variants = result.variants.map((v) => v.trim().slice(0, 280)).filter(Boolean).slice(0, 3);
  if (variants.length < 1) throw new AppError(502, 'empty_variants', 'No variants were produced.');

  return { idea: trimmed, variants };
}

/** Persist one chosen variant as a new draft. */
export async function saveIdeaVariant(userId: string, text: string, idea: string) {
  const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
  const user = await db.get('users', (u) => u.id === userId);
  return db.insert('generated_tweets', {
    user_id: userId,
    text: text.trim().slice(0, 280),
    original_text: text.trim().slice(0, 280),
    edited_text: null,
    tweet_type: 'opinion',
    format_id: 'from_idea',
    format_label: 'From my idea',
    material_source: 'topic',
    material_label: 'from_idea',
    material_id: null,
    sources: [ideaSource(idea)],
    style_match_score: null,
    niche: user?.niche ?? null,
    kind: 'evergreen',
    brain_version: profile?.brain_version ?? null,
    batch_id: null,
    pipeline: 'from_idea',
    source_idea: idea.slice(0, 1000),
    status: 'pending',
  });
}
