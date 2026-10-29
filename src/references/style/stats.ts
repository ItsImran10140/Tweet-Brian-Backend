import { cleanForAnalysis, extractEmoji, extractHashtags, median, pct, stripTrailingEmoji, words } from '../../lib/text';
import type { StoredTweet, StyleStats } from '../types';
import { eligibleTweets } from './eligibility';

const STOP = new Set(
  ('that this with have from they your what when will just like about there their would could should been were them then than into more some only over also very much even most make made ' +
    "dont didnt cant wont isnt youre thats here still every because after before being those these where which while other another").split(' '),
);

function topN<T extends string>(items: T[], n: number, minCount = 1): { key: T; count: number }[] {
  const m = new Map<T, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return [...m.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, count]) => ({ key, count }));
}

export function computeStyleStats(all: StoredTweet[]): StyleStats {
  const tweets = eligibleTweets(all);
  const n = tweets.length;
  const cleaned = tweets.map((t) => cleanForAnalysis(t.text));

  const count = (pred: (raw: string, clean: string) => boolean) =>
    tweets.reduce((acc, t, i) => acc + (pred(t.text, cleaned[i] as string) ? 1 : 0), 0);

  const lens = cleaned.map((c) => c.length);
  const wordCounts = cleaned.map((c) => words(c).length);
  const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : 0);

  const listLine = /^\s*(?:[-•*→▪▶✅✔☑]|\d+[.)])\s+\S/;
  const openers: string[] = [];
  const allEmoji: string[] = [];
  const allTags: string[] = [];
  const allWords: string[] = [];

  tweets.forEach((t, i) => {
    const c = cleaned[i] as string;
    const ws = c.split(/\s+/).filter(Boolean);
    if (ws.length >= 2) openers.push(ws.slice(0, 2).join(' ').toLowerCase().replace(/[^\w' ]/g, '').trim());
    allEmoji.push(...extractEmoji(t.text));
    allTags.push(...extractHashtags(t.text));
    for (const w of words(c)) if (w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)) allWords.push(w);
  });

  return {
    tweetCount: n,
    avgChars: avg(lens),
    medianChars: median(lens),
    avgWords: avg(wordCounts),
    pctWithLineBreaks: pct(count((_r, c) => c.includes('\n')), n),
    pctWithEmoji: pct(count((r) => extractEmoji(r).length > 0), n),
    pctWithHashtag: pct(count((r) => /#\w+/.test(r)), n),
    pctWithQuestion: pct(count((_r, c) => c.includes('?')), n),
    pctEndingWithQuestion: pct(count((_r, c) => stripTrailingEmoji(c).endsWith('?')), n),
    pctWithExclamation: pct(count((_r, c) => c.includes('!')), n),
    pctStartingLowercase: pct(count((_r, c) => /^[a-z]/.test(c)), n),
    pctWithNumbers: pct(count((_r, c) => /\d/.test(c)), n),
    pctListLike: pct(count((_r, c) => c.split('\n').filter((l) => listLine.test(l)).length >= 2), n),
    pctWithEmDash: pct(count((_r, c) => /—|\s–\s/.test(c)), n),
    pctWithEllipsis: pct(count((_r, c) => /\.\.\.|…/.test(c)), n),
    pctThreadStarters: pct(count((r) => /🧵|\bthread\b|\b1\/\d*\b|\(1\/\)/i.test(r)), n),
    topOpeners: topN(openers.filter(Boolean), 8, 2).map((x) => ({ phrase: x.key, count: x.count })),
    topHashtags: topN(allTags, 8).map((x) => ({ tag: x.key, count: x.count })),
    topEmoji: topN(allEmoji, 8).map((x) => ({ emoji: x.key, count: x.count })),
    topWords: topN(allWords, 20, 2).map((x) => ({ word: x.key, count: x.count })),
  };
}

/** Human-readable bullet list used inside the LLM context. */
export function statsToBullets(s: StyleStats): string[] {
  if (s.tweetCount === 0) return ['No usable tweets analyzed yet.'];
  const lines = [
    `Analyzed ${s.tweetCount} original tweets.`,
    `Length: avg ${s.avgChars} chars (median ${s.medianChars}), about ${s.avgWords} words.`,
    `Line breaks used in ${s.pctWithLineBreaks}% of tweets; list-style formatting in ${s.pctListLike}%.`,
    `Emoji in ${s.pctWithEmoji}%; hashtags in ${s.pctWithHashtag}%; numbers in ${s.pctWithNumbers}%.`,
    `Questions in ${s.pctWithQuestion}% (ends with a question: ${s.pctEndingWithQuestion}%); exclamation marks in ${s.pctWithExclamation}%.`,
    `Starts with a lowercase letter: ${s.pctStartingLowercase}%; em/en dashes: ${s.pctWithEmDash}%; ellipses: ${s.pctWithEllipsis}%; thread starters: ${s.pctThreadStarters}%.`,
  ];
  if (s.topOpeners.length) lines.push(`Common openers: ${s.topOpeners.map((o) => `"${o.phrase}" (${o.count})`).join(', ')}.`);
  if (s.topEmoji.length) lines.push(`Favorite emoji: ${s.topEmoji.map((e) => e.emoji).join(' ')}`);
  if (s.topHashtags.length) lines.push(`Frequent hashtags: ${s.topHashtags.map((h) => h.tag).join(', ')}`);
  if (s.topWords.length) lines.push(`Frequent words: ${s.topWords.slice(0, 12).map((w) => w.word).join(', ')}.`);
  return lines;
}
