import { config } from '../../config';

/** Match banned patterns from config.yml (substring, or `re:` regex). */
export function findBannedHits(text: string, patterns: string[] = config.generation.bannedPatterns): string[] {
  const hits: string[] = [];
  const hay = text;
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (!pattern) continue;
    try {
      if (pattern.toLowerCase().startsWith('re:')) {
        const body = pattern.slice(3);
        const re = new RegExp(body, 'i');
        if (re.test(hay)) hits.push(pattern);
      } else if (hay.toLowerCase().includes(pattern.toLowerCase())) {
        hits.push(pattern);
      }
    } catch {
      // bad regex in config — skip rather than crash generation
    }
  }
  // Heuristic: stiff "do not / cannot / will not" heavy prose with zero contractions looks unnatural for casual voices
  const hasContraction = /\b(i'm|i've|i'd|don't|doesn't|can't|won't|it's|that's|there's|we're|they're|you're|isn't|aren't|wasn't|weren't|haven't|hasn't)\b/i.test(
    text,
  );
  const stiff = /\b(do not|cannot|will not|it is|that is|there is)\b/i.test(text);
  if (stiff && !hasContraction && text.split(/\s+/).length > 12) {
    hits.push('stiff_no_contraction_phrasing');
  }
  return [...new Set(hits)];
}
