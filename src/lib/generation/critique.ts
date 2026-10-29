import { z } from 'zod';
import { config } from '../../config';
import { llmJson } from '../llm';
import { findBannedHits } from './banned';

export const CritiqueSchema = z.object({
  voiceMatch: z.number().min(1).max(10),
  specificity: z.number().min(1).max(10),
  originality: z.number().min(1).max(10),
  bannedHits: z.array(z.string()).default([]),
  pass: z.boolean(),
  rewrite: z.string().nullable().default(null),
  notes: z.string().default(''),
});

export type CritiqueResult = z.infer<typeof CritiqueSchema>;

export function styleMatchScore(c: Pick<CritiqueResult, 'voiceMatch' | 'specificity' | 'originality'>): number {
  return Math.round(((c.voiceMatch + c.specificity + c.originality) / 3) * 10) / 10;
}

export async function critiqueAndMaybeRewrite(input: {
  draft: string;
  formatLabel: string;
  materialLabel: string;
  styleCardJson: string;
  bannedPatterns: string[];
}): Promise<CritiqueResult> {
  const localHits = findBannedHits(input.draft, input.bannedPatterns);
  const min = config.generation.critiqueMinScore;

  const result = await llmJson(
    {
      kind: 'critique',
      brain: `You are a ruthless editor for short-form posts.
Score the draft, catch banned patterns, and rewrite ONCE if it fails.
Return ONE JSON object only.`,
      user: `FORMAT: ${input.formatLabel}
MATERIAL SOURCE: ${input.materialLabel}

USER STYLE CARD:
${input.styleCardJson}

BANNED PATTERNS (reject / rewrite if present):
${input.bannedPatterns.map((p) => `- ${p}`).join('\n')}
- stiff_no_contraction_phrasing (formal "do not/cannot" with zero contractions in a casual voice)
- generic motivational closers ("you got this", "trust the process", etc.)

DRAFT:
"""
${input.draft}
"""

Local scanner already found: ${localHits.length ? localHits.join(', ') : '(none)'}

Score 1–10 for:
- voiceMatch (matches style card rhythm, contractions, line breaks)
- specificity (has a concrete name, number, tool, or moment)
- originality (not a recycled template)

Set pass=true only if all scores >= ${min} AND no banned hits.
If pass=false, rewrite once into "rewrite" (max 280 chars) fixing voice, specificity, banned lines.
If pass=true, set rewrite to null.

Return JSON:
{
  "voiceMatch": number,
  "specificity": number,
  "originality": number,
  "bannedHits": ["..."],
  "pass": boolean,
  "rewrite": string|null,
  "notes": "short"
}`,
      temperature: 0.3,
      maxTokens: 2048,
      meta: { minScore: min, localHits },
    },
    CritiqueSchema,
  );

  // Merge local hits the model might have missed
  result.bannedHits = [...new Set([...(result.bannedHits ?? []), ...localHits])];
  if (result.bannedHits.length || result.voiceMatch < min || result.specificity < min || result.originality < min) {
    result.pass = false;
  }
  if (result.pass) result.rewrite = null;
  else if (!result.rewrite?.trim()) {
    // Model failed to rewrite — keep original but mark fail; caller may still save with low score
    result.rewrite = null;
  } else {
    result.rewrite = result.rewrite.trim().slice(0, 280);
  }
  return result;
}
