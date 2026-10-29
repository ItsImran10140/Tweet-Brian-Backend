import { z } from 'zod';
import { db } from '../data';
import { llmJson } from './llm';
import { normalizeStyleCard } from './voiceStyleCard';

const EDIT_BATCH = 10;

const InsightSchema = z.object({
  summary: z.string(),
  lessons: z.array(z.string()).min(1).max(8),
  styleCardPatch: z
    .object({
      typicalClosings: z.array(z.string()).optional(),
      typicalOpenings: z.array(z.string()).optional(),
      wordsNeverUsed: z.array(z.string()).optional(),
      lineBreakHabits: z.string().optional(),
      tone: z.string().optional(),
      humorType: z.string().optional(),
      avgSentenceLength: z.number().nullish(),
      formalityLevel: z.number().nullish(),
    })
    .default({}),
});

export type StyleLearning = {
  id: string;
  user_id: string;
  summary: string;
  lessons: string[];
  style_card_patch: Record<string, unknown>;
  edit_event_ids: string[];
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
};

/** Count unprocessed edit feedback events. */
export async function unprocessedEditCount(userId: string): Promise<number> {
  return (await db.all(
    'feedback_events',
    (e) => e.user_id === userId && e.kind === 'edit' && !e.learning_processed,
  )).length;
}

/**
 * Persist an original→edited pair when the user changes draft text
 * (before schedule, mark-posted, or an explicit save). Returns a pending
 * style learning once 10 edits accumulate, otherwise null.
 */
export async function saveTweetEdit(
  userId: string,
  tweet: { id?: unknown; text?: unknown; original_text?: unknown; edited_text?: unknown },
  text: string,
): Promise<StyleLearning | null> {
  const tweetId = String(tweet.id ?? '');
  if (!tweetId) return null;

  const priorText = String(tweet.text ?? '');
  const priorEdited = tweet.edited_text != null ? String(tweet.edited_text) : null;
  const priorOriginal = tweet.original_text != null ? String(tweet.original_text) : null;
  const current = String(priorEdited || priorText || '').trim();
  const next = String(text || '').trim();
  if (!next || next === current) return null;

  const original = priorEdited || priorOriginal || priorText;
  await db.update('generated_tweets', (x) => x.id === tweetId, {
    edited_text: next,
    text: next,
    original_text: priorOriginal || priorText,
  });
  await db.insert('feedback_events', {
    user_id: userId,
    tweet_id: tweetId,
    kind: 'edit',
    original_text: original,
    edited_text: next,
    learning_processed: false,
  });
  return maybeLearnFromEdits(userId).catch(() => null);
}

/**
 * After every 10 saved edits, compare originals vs edits and propose style-card updates.
 * Returns a pending learning for the user to accept/reject, or null if not ready.
 */
export async function maybeLearnFromEdits(userId: string): Promise<StyleLearning | null> {
  const pending = await db.all(
    'feedback_events',
    (e) => e.user_id === userId && e.kind === 'edit' && !e.learning_processed,
  );
  if (pending.length < EDIT_BATCH) return null;

  const existing = await db.get(
    'style_learnings',
    (r) => r.user_id === userId && r.status === 'pending',
  );
  if (existing) return existing as StyleLearning;

  const batch = pending
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, EDIT_BATCH);

  const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
  const style = normalizeStyleCard(profile?.style_fingerprint);

  const pairs = batch.map((e) => ({
    original: e.original_text,
    edited: e.edited_text,
  }));

  const result = await llmJson(
    {
      kind: 'learn',
      brain: 'You compare original AI drafts to the user\'s edits and extract durable style preferences.',
      meta: { discardGroups: [] },
      user: `The user edited ${pairs.length} drafts before posting/scheduling.
Find consistent patterns (e.g. "removes the final moral line", "shortens sentences", "adds contractions", "drops soft closers").

Current style card:
${JSON.stringify(style, null, 2)}

Edit pairs:
${JSON.stringify(pairs, null, 2)}

Return JSON:
{
  "summary": "1-2 sentence plain-English summary for the user",
  "lessons": ["short lesson bullets the user can accept"],
  "styleCardPatch": {
    "typicalClosings": [],
    "typicalOpenings": [],
    "wordsNeverUsed": [],
    "lineBreakHabits": "",
    "tone": "",
    "humorType": "",
    "avgSentenceLength": null,
    "formalityLevel": null
  }
}
Only include patch fields you are confident about. Prefer empty arrays/omit over guessing.`,
      temperature: 0.3,
    },
    InsightSchema,
  );

  const row = await db.insert('style_learnings', {
    user_id: userId,
    summary: result.summary,
    lessons: result.lessons,
    style_card_patch: result.styleCardPatch,
    edit_event_ids: batch.map((e) => e.id),
    status: 'pending',
  });

  for (const e of batch) {
    await db.update('feedback_events', (r) => r.id === e.id, { learning_processed: true });
  }

  return row as StyleLearning;
}

export async function listPendingLearnings(userId: string) {
  return db.all('style_learnings', (r) => r.user_id === userId && r.status === 'pending');
}

export async function respondToLearning(userId: string, learningId: string, accept: boolean) {
  const row = await db.get('style_learnings', (r) => r.id === learningId && r.user_id === userId);
  if (!row) return null;
  if (row.status !== 'pending') return row;

  if (accept) {
    const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
    if (profile) {
      const current = normalizeStyleCard(profile.style_fingerprint);
      const patch = (row.style_card_patch ?? {}) as Record<string, unknown>;
      const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null && v !== '')) };
      for (const key of ['typicalClosings', 'typicalOpenings', 'wordsNeverUsed', 'punctuationQuirks', 'wordsAndPhrasesOftenUsed', 'openers'] as const) {
        if (Array.isArray(patch[key]) || Array.isArray(current[key])) {
          merged[key] = [...new Set([...(current[key] as string[] ?? []), ...((patch[key] as string[]) ?? [])])];
        }
      }
      await db.update('personality_profiles', (p) => p.id === profile.id, {
        style_fingerprint: merged,
      });
      for (const lesson of row.lessons ?? []) {
        await db.insert('learned_rules', {
          user_id: userId,
          source: 'edit_learning',
          rule_text: lesson,
          supporting_event_ids: row.edit_event_ids ?? [],
          last_applied_at: null,
          retired_at: null,
        });
      }
    }
  }

  await db.update('style_learnings', (r) => r.id === learningId, {
    status: accept ? 'accepted' : 'rejected',
    resolved_at: new Date().toISOString(),
  });
  return db.get('style_learnings', (r) => r.id === learningId);
}
