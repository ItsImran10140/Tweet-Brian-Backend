/** Maps onto the legacy tweet_type field for UI/compatibility. */
export type LegacyTweetType = 'opinion' | 'lesson' | 'story' | 'question' | 'humor';

/** ~10 structural formats used by the multi-step generation pipeline. */
export interface DraftFormat {
  id: string;
  label: string;
  /** Short instruction for the drafter LLM. */
  brief: string;
  legacyType: LegacyTweetType;
}

export const FORMAT_LIBRARY: DraftFormat[] = [
  {
    id: 'deadpan_story',
    label: 'Deadpan story',
    brief: 'A short first-person moment told flatly, then a blunt takeaway. No hype.',
    legacyType: 'story',
  },
  {
    id: 'x_having_y_moment',
    label: '"X is having its Y moment" analogy',
    brief: 'Compare one thing to another well-known moment or era. One sharp analogy, then why it matters.',
    legacyType: 'opinion',
  },
  {
    id: 'reactive_news_personal',
    label: 'Reactive news take with personal angle',
    brief: 'React to a news/digest fact in fresh words, then add the user\'s personal angle from their material — not a summary.',
    legacyType: 'opinion',
  },
  {
    id: 'build_in_public_numbers',
    label: 'Build-in-public update with numbers',
    brief: 'A shipping/progress update that includes at least one real number from the user\'s material.',
    legacyType: 'lesson',
  },
  {
    id: 'contrarian_one_liner',
    label: 'Contrarian one-liner',
    brief: 'One punchy sentence that takes a side most people in the niche would push back on.',
    legacyType: 'opinion',
  },
  {
    id: 'before_after',
    label: 'Before / after',
    brief: 'Two beats: how it was, how it is now (or failed vs fixed). Concrete, not inspirational.',
    legacyType: 'story',
  },
  {
    id: 'list',
    label: 'List',
    brief: 'A short numbered or bulleted list (2–4 items) of tactics, mistakes, or observations.',
    legacyType: 'lesson',
  },
  {
    id: 'question',
    label: 'Question',
    brief: 'One specific question that invites a reply. Avoid vague "what do you think?" closers.',
    legacyType: 'question',
  },
  {
    id: 'short_joke',
    label: 'Short joke',
    brief: 'A dry, short joke or observation. Wit over punchline setup. Stay in the user\'s humor register.',
    legacyType: 'humor',
  },
  {
    id: 'mini_thread',
    label: 'Mini-thread',
    brief: 'A compact 2–3 beat thread in one post (line breaks as beats). Hook → detail → takeaway.',
    legacyType: 'lesson',
  },
];

/** Assign formats so a batch varies; shuffle then cycle if count > library size. */
export function assignFormats(count: number, preferNews = false): DraftFormat[] {
  const pool = [...FORMAT_LIBRARY];
  // Fisher–Yates
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out: DraftFormat[] = [];
  for (let i = 0; i < count; i++) {
    let fmt = pool[i % pool.length];
    // Bias news-heavy slots toward reactive_news_personal when digest exists
    if (preferNews && i % 3 === 0) {
      const newsFmt = FORMAT_LIBRARY.find((f) => f.id === 'reactive_news_personal');
      if (newsFmt) fmt = newsFmt;
    }
    out.push(fmt);
  }
  // If we reused reactive_news too often, re-spread uniqueness for small batches
  if (count <= FORMAT_LIBRARY.length) {
    const seen = new Set<string>();
    for (let i = 0; i < out.length; i++) {
      if (seen.has(out[i].id)) {
        const alt = pool.find((f) => !seen.has(f.id));
        if (alt) out[i] = alt;
      }
      seen.add(out[i].id);
    }
  }
  return out;
}
