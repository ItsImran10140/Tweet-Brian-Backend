import { createHash } from 'node:crypto';

const URL_RE = /https?:\/\/\S+/gi;
const MENTION_RE = /(^|\s)@\w{1,15}/g;
// Extended pictographic covers emoji without matching digits/#/*.
const EMOJI_RE = /\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu;

export function stripUrls(text: string): string {
  return text.replace(URL_RE, '').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export function stripMentions(text: string): string {
  return text.replace(MENTION_RE, '$1').replace(/[ \t]{2,}/g, ' ').trim();
}

/** Text used for analysis: no links, no @mentions. */
export function cleanForAnalysis(text: string): string {
  return stripMentions(stripUrls(decodeEntities(text)));
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Normalization used only for de-duplication (never shown to the LLM). */
export function normalizeForDedupe(text: string): string {
  return stripUrls(decodeEntities(text)).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tweetKey(text: string): string {
  const h = createHash('sha1').update(normalizeForDedupe(text)).digest('hex').slice(0, 16);
  return `tw_${h}`;
}

export function extractEmoji(text: string): string[] {
  return text.match(EMOJI_RE) ?? [];
}

/** "What did you ship? 👇" should still count as ending with a question. */
const TRAILING_EMOJI_RE = new RegExp('(?:\\s|' + EMOJI_RE.source + ')+$', 'u');
export function stripTrailingEmoji(text: string): string {
  return text.replace(TRAILING_EMOJI_RE, '').trimEnd();
}

export function extractHashtags(text: string): string[] {
  return (text.match(/#\w+/g) ?? []).map((t) => t.toLowerCase());
}

export function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).filter(Boolean);
}

export function wordSet(text: string): Set<string> {
  return new Set(words(cleanForAnalysis(text)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export function pct(part: number, total: number): number {
  return total === 0 ? 0 : Math.round((part / total) * 1000) / 10;
}

export function normalizeHandle(input: string): string {
  let h = input.trim();
  h = h.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '');
  h = h.replace(/[/?#].*$/, '');
  h = h.replace(/^@/, '');
  return h;
}

export function isValidHandle(handle: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/.test(handle);
}
