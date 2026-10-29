// Pure code validator. No LLM.
import { bannedAiPhrases } from './brain';

export interface ValidateCtx {
  bannedWords: string[];
  offLimitsTopics: string[];
  usesHashtags: boolean;
  referenceSamples: string[];
}

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

function sharesRun(a: string, b: string, n = 6): boolean {
  const wa = words(a), wb = words(b);
  if (wa.length < n || wb.length < n) return false;
  const grams = new Set<string>();
  for (let i = 0; i <= wb.length - n; i++) grams.add(wb.slice(i, i + n).join(' '));
  for (let i = 0; i <= wa.length - n; i++) if (grams.has(wa.slice(i, i + n).join(' '))) return true;
  return false;
}

export function validateTweet(text: string, ctx: ValidateCtx): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const lower = text.toLowerCase();
  if (text.length > 280) reasons.push(`too long (${text.length}/280)`);
  for (const w of ctx.bannedWords) if (w && lower.includes(w.toLowerCase())) reasons.push(`banned word: ${w}`);
  for (const t of ctx.offLimitsTopics) if (t && lower.includes(t.toLowerCase())) reasons.push(`off-limits topic: ${t}`);
  for (const p of bannedAiPhrases()) if (lower.includes(p)) reasons.push(`banned AI phrase: ${p}`);
  if (!ctx.usesHashtags && /#\w+/.test(text)) reasons.push('hashtag not allowed');
  if ((text.match(/—/g) ?? []).length > 1) reasons.push('more than one em dash');
  for (const s of ctx.referenceSamples) if (sharesRun(text, s)) { reasons.push('copies 6+ words from a reference sample'); break; }
  return { ok: reasons.length === 0, reasons };
}
