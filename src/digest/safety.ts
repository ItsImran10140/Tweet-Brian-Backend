import { config } from '../config';
import { overlapsShingles, plainWords } from './text';

/**
 * Safety gate for DRAFT TWEETS. Pure code, no LLM. Runs on every draft before it is saved.
 * Catches the things that cause legal or credibility trouble:
 *   - wording copied from a source (hashed 6-word windows)
 *   - invented first-person experiences ("I tested", "we shipped", "I interviewed 50 founders")
 *   - numbers and percentages that appear in neither the digest facts nor the user's own profile
 *   - accusations about named people or companies
 */

const EXPERIENCE: RegExp[] = [
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:tested|tried|benchmarked|interviewed|surveyed|analy[sz]ed|reviewed|measured|spoke (?:to|with)|talked (?:to|with)|asked|read through)\b/i,
  /\bwe(?:'ve| have)?\s+(?:just\s+)?(?:tested|tried|benchmarked|interviewed|surveyed|analy[sz]ed|measured|shipped|launched|raised)\b/i,
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:used|been using)\s+(?:it|this|them)\s+for\b/i,
  /\bafter\s+(?:testing|trying|using|reading)\b[^.]{0,40}\bi\b/i,
  /\bin my (?:tests?|experiments?|benchmarks?|interviews?)\b/i,
  /\bi (?:spent|wasted)\s+\d+\s+(?:hours?|days?|weeks?|months?)\b/i,
];

const ACCUSATION = /\b(?:is|are|was|were)\s+(?:a\s+)?(?:lying|scam(?:mers?)?|fraud(?:s|ulent)?|stealing|thieves|criminals?|cheating|corrupt)\b|\b(?:lied|stole|committed fraud|is (?:a )?scam)\b/i;

const numberTokens = (t: string): string[] => (t.match(/\d[\d,]*(?:\.\d+)?\s?(?:%|x|k|m|b|bn|million|billion|percent)?/gi) ?? []).map((x) => x.toLowerCase().replace(/[\s,]/g, '').replace('percent', '%')).filter((x) => x.length > 0);

export interface SafetyCtx {
  /** facts shown to the writer (headline + fact_summary of digest items) */
  digestText: string;
  /** hashed windows of the source texts behind the digest */
  digestShingles: string[];
  /** anything the user said about themselves (persona card, stories): experiences and numbers there are theirs */
  profileText: string;
}

export function safetyCheck(text: string, ctx: SafetyCtx): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const n = config.digest.safety.minOverlapWords;

  if (overlapsShingles(text, ctx.digestShingles, n)) reasons.push(`copies ${n}+ words in a row from a source`);

  if (config.digest.safety.blockInventedExperience && EXPERIENCE.some((r) => r.test(text))) {
    // A first-person claim is only fine for a "story" drawn from the user's own profile. Plain generation cannot verify it, so block it.
    reasons.push('invented first-person experience (e.g. "I tested", "we shipped"): the user did not say this');
  }

  if (config.digest.safety.checkNumbers) {
    const allowed = new Set([...numberTokens(ctx.digestText), ...numberTokens(ctx.profileText)]);
    const bare = (x: string) => x.replace(/[^0-9.]/g, '');
    const allowedBare = new Set([...allowed].map(bare));
    const stray = numberTokens(text).filter((x) => {
      const b = bare(x);
      if (!b) return false;
      if (allowed.has(x) || allowedBare.has(b)) return false;
      return Number(b) > 12 || /[%xkmb]/.test(x.replace(/[0-9.]/g, '')); // tiny counts like "3 things" are fine
    });
    if (stray.length) reasons.push(`number(s) not found in the digest or the user's profile: ${[...new Set(stray)].slice(0, 3).join(', ')}`);
  }

  if (ACCUSATION.test(text)) reasons.push('accuses a person or company of wrongdoing');
  if (plainWords(text).length === 0) reasons.push('empty');
  return { ok: reasons.length === 0, reasons };
}
