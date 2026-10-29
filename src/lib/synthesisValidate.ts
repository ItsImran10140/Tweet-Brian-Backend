import { z } from 'zod';
import { AppError } from '../errors';
import { VoiceStyleCardSchema, normalizeStyleCard } from './voiceStyleCard';

const strArr = z.array(z.string()).default([]);

/** LLM synthesis shape (lenient defaults for optional sections). */
export const SynthesisSchema = z.object({
  summary: z.string().min(1),
  dimensions: z.record(z.any()).default({}),
  thinkingStyle: z.record(z.any()).default({}),
  lenses: strArr,
  personaCard: z
    .object({
      bio: z.string().default(''),
      expertise: strArr,
      values: strArr,
      stories: strArr,
      bannedWords: strArr,
      offLimitsTopics: strArr,
    })
    .default({}),
  styleFingerprint: VoiceStyleCardSchema.default({}),
  voiceGuidance: z.string().default(''),
  doList: strArr,
  dontList: strArr,
  openQuestions: strArr,
});

export type SynthesisResult = z.infer<typeof SynthesisSchema>;

export const VoiceStyleConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type VoiceStyleConfidence = z.infer<typeof VoiceStyleConfidenceSchema>;

/** Row fields written to personality_profiles (excluding id / user_id / timestamps). */
export const PersonalityProfileWriteSchema = z.object({
  brain_version: z.string().optional(),
  summary: z.string().min(1),
  computed_scores: z.any().optional(),
  dimensions: z.record(z.any()).default({}),
  thinking_style: z.record(z.any()).default({}),
  lenses: z.array(z.string()).default([]),
  persona_card: z.any().default({}),
  style_fingerprint: VoiceStyleCardSchema,
  voice_style_confidence: VoiceStyleConfidenceSchema.optional(),
  voice_style_sample_count: z.number().int().nonnegative().optional(),
  voice_guidance: z.string().default(''),
  do_list: z.array(z.string()).default([]),
  dont_list: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
});

export type PersonalityProfileWrite = z.infer<typeof PersonalityProfileWriteSchema>;

function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Normalize sample-count / fingerprint meta into a categorical confidence label. */
export function normalizeVoiceStyleConfidence(
  raw: unknown,
  sampleCount?: number,
): VoiceStyleConfidence | undefined {
  const asEnum = VoiceStyleConfidenceSchema.safeParse(raw);
  if (asEnum.success) return asEnum.data;

  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw >= 0.8) return 'high';
    if (raw >= 0.5) return 'medium';
    return 'low';
  }

  if (typeof sampleCount === 'number' && Number.isFinite(sampleCount)) {
    if (sampleCount >= 10) return 'high';
    if (sampleCount > 0) return 'low';
  }

  return undefined;
}

/**
 * Validate + normalize LLM synthesis JSON before any DB writes.
 * Throws AppError 422 (answers untouched) on failure.
 */
export function validateSynthesisOutput(raw: unknown): SynthesisResult {
  const parsed = SynthesisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      422,
      'synthesis_invalid',
      `Synthesis output failed validation: ${formatZodIssues(parsed.error)}`,
      'Your onboarding answers are still saved. Try synthesize again.',
      parsed.error.issues,
    );
  }
  return {
    ...parsed.data,
    styleFingerprint: normalizeStyleCard(parsed.data.styleFingerprint),
  };
}

/** Validate the personality_profiles write payload before insert/update. */
export function validateProfileWrite(raw: unknown): PersonalityProfileWrite {
  const parsed = PersonalityProfileWriteSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      422,
      'profile_persist_invalid',
      `Personality profile failed validation before save: ${formatZodIssues(parsed.error)}`,
      'Your onboarding answers are still saved. Try synthesize again.',
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** Strip undefined so Supabase does not receive unexpected nulls for omitted optionals. */
export function profileWritePayload(write: PersonalityProfileWrite): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(write)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
