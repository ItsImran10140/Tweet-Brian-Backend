import { config } from '../../config';
import { cleanForAnalysis, jaccard, wordSet } from '../../lib/text';
import type { StoredTweet } from '../types';
import { engagementScore, eligibleTweets, hasAnyMetrics, isStyleEligible } from './eligibility';

export type TweetFormat = 'opinion' | 'lesson' | 'story' | 'question' | 'humor';

/**
 * Rank tweets by engagement when metrics exist; otherwise keep store order (newest first).
 */
export function rankByEngagement(tweets: StoredTweet[]): StoredTweet[] {
  const pool = eligibleTweets(tweets);
  if (!hasAnyMetrics(pool)) return pool;
  return [...pool].sort((a, b) => engagementScore(b) - engagementScore(a));
}

/** Top-performing eligible tweets for style-card analysis (default 30–50 from config). */
export function selectTopPerforming(all: StoredTweet[], count = config.style.topPerformingCount): StoredTweet[] {
  return rankByEngagement(all).slice(0, Math.max(0, count));
}

/**
 * LAYER 2 - few-shot examples.
 * Picks tweets that are representative and different from each other:
 *  - with metrics: highest engagement first
 *  - without metrics (manual paste): newest first
 * A greedy diversity filter (word-overlap) stops near-duplicates from crowding out variety.
 */
export function selectFewShot(all: StoredTweet[], count: number): StoredTweet[] {
  if (count <= 0) return [];
  const pool = all.filter((t) => {
    if (!isStyleEligible(t)) return false;
    const len = cleanForAnalysis(t.text).length;
    return len >= 30 && len <= 500;
  });
  if (pool.length === 0) return [];

  const metrics = hasAnyMetrics(pool);
  const ranked = [...pool].sort((a, b) => {
    if (metrics) return engagementScore(b) - engagementScore(a);
    return 0; // keep the stored order (newest first)
  });

  return diversify(ranked, count);
}

/**
 * Pick 3–5 tweets whose structure best matches the requested formats
 * (story / opinion / lesson / question / humor), preferring the cached top-performing pool.
 */
export function selectStructuralFewShot(
  all: StoredTweet[],
  formats: TweetFormat[] = [],
  opts: { min?: number; max?: number; preferKeys?: string[] } = {},
): StoredTweet[] {
  const min = opts.min ?? config.style.structuralFewShotMin;
  const max = Math.max(min, opts.max ?? config.style.structuralFewShotMax);
  if (max <= 0) return [];

  const prefer = new Set(opts.preferKeys ?? []);
  const pool = all.filter((t) => {
    if (!isStyleEligible(t)) return false;
    const len = cleanForAnalysis(t.text).length;
    return len >= 30 && len <= 500;
  });
  if (pool.length === 0) return [];

  const wanted = formats.length ? formats : (['opinion', 'lesson', 'story', 'question', 'humor'] as TweetFormat[]);
  const scored = pool
    .map((t) => {
      const formatScore = Math.max(...wanted.map((f) => formatRelevance(t, f)));
      const eng = engagementScore(t);
      const preferredBonus = prefer.has(t.key) ? 40 : 0;
      return { t, score: formatScore * 100 + preferredBonus + Math.min(eng, 50) };
    })
    .sort((a, b) => b.score - a.score);

  const diversified = diversify(
    scored.map((s) => s.t),
    max,
  );
  if (diversified.length >= min) return diversified.slice(0, max);
  return diversified;
}

function diversify(ranked: StoredTweet[], count: number): StoredTweet[] {
  const picked: StoredTweet[] = [];
  const sets = new Map<string, Set<string>>();
  for (const t of ranked) sets.set(t.key, wordSet(t.text));

  for (const threshold of [0.4, 0.7]) {
    for (const t of ranked) {
      if (picked.length >= count) break;
      if (picked.some((p) => p.key === t.key)) continue;
      const s = sets.get(t.key) as Set<string>;
      if (picked.every((p) => jaccard(s, sets.get(p.key) as Set<string>) < threshold)) picked.push(t);
    }
  }
  return picked;
}

/** Heuristic: how well a tweet's shape matches a generation format. */
export function formatRelevance(t: StoredTweet, format: TweetFormat): number {
  const text = t.text;
  const lower = text.toLowerCase();
  const lines = text.split(/\n/).filter((l) => l.trim()).length;
  const words = cleanForAnalysis(text).split(/\s+/).filter(Boolean).length;
  const hasQ = /\?\s*$/.test(text.trim()) || (text.match(/\?/g) ?? []).length >= 1;
  const listLike = /^[\s]*([-•*]|\d+[.)])/m.test(text) || lines >= 3;
  const firstPerson = /\b(i|i'm|i've|my|we|our)\b/i.test(text);
  const lessonCue = /\b(learn|lesson|tip|rule|mistake|never|always|instead)\b/i.test(lower);
  const humorCue = /\b(lol|lmao|joke|ironically|apparently)\b/i.test(lower) || (words < 28 && /[!…]/.test(text));
  const opinionCue = /\b(most|nobody|stop|wrong|hot take|unpopular|actually)\b/i.test(lower);

  switch (format) {
    case 'story':
      return (firstPerson ? 0.45 : 0) + (words > 35 ? 0.25 : 0.1) + (lines >= 2 ? 0.15 : 0) + (lessonCue ? 0.1 : 0);
    case 'lesson':
      return (lessonCue ? 0.4 : 0.1) + (listLike ? 0.3 : 0) + (words > 25 ? 0.15 : 0.05);
    case 'opinion':
      return (opinionCue ? 0.4 : 0.15) + (!hasQ ? 0.15 : 0) + (words < 60 ? 0.2 : 0.05);
    case 'question':
      return (hasQ ? 0.7 : 0) + (words < 40 ? 0.2 : 0.05);
    case 'humor':
      return (humorCue ? 0.5 : 0.1) + (words < 35 ? 0.25 : 0) + (lines <= 3 ? 0.1 : 0);
    default:
      return 0.1;
  }
}

/** LAYER 3 - raw recent tweets (newest first), skipping ones already used as few-shot examples. */
export function selectRecent(all: StoredTweet[], count: number, excludeKeys: Set<string>): StoredTweet[] {
  if (count <= 0) return [];
  return all.filter((t) => isStyleEligible(t) && !excludeKeys.has(t.key)).slice(0, count);
}
