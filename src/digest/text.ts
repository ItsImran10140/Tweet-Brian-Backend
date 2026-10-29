import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';

const STOP = new Set(
  'a an the and or of to in on for with from by at as is are was were be been it its this that these those new now how what why who will can has have had says said say via about into over after before more most up out not no than then so we you your our their his her them they i'.split(' '),
);

export const sha1 = (s: string, len = 16) => createHash('sha1').update(s).digest('hex').slice(0, len);

/** HTML (or plain text) -> plain text with collapsed whitespace. Entities are decoded. */
export function htmlToText(input: string): string {
  if (!input) return '';
  const looksHtml = /<[a-z][\s\S]*>/i.test(input);
  const raw = looksHtml ? cheerio.load(`<div>${input}</div>`)('div').first().text() : input;
  return raw.replace(/\s+/g, ' ').trim();
}

/** Cut at a sentence (or word) boundary near `max` characters. */
export function trimAtBoundary(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim() + '…';
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Same page, different tracking junk -> same string. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|ref$|ref_|fbclid|gclid|mc_|source$)/i.test(k)) u.searchParams.delete(k);
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url.trim();
  }
}

export function plainWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []).filter(Boolean);
}

/** Words that carry meaning (for clustering near-duplicate headlines). */
export function titleWords(title: string): Set<string> {
  return new Set(plainWords(title).filter((w) => w.length > 2 && !STOP.has(w)));
}

export function jaccardSets(a: Set<string>, b: Set<string>): { score: number; shared: number } {
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  const union = a.size + b.size - shared;
  return { score: union === 0 ? 0 : shared / union, shared };
}

/** Hashed n-word windows. Capped so a long article cannot bloat the database. */
export function shingleHashes(text: string, n = 6, cap = 300): string[] {
  const w = plainWords(text);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length && out.size < cap; i++) out.add(sha1(w.slice(i, i + n).join(' '), 8));
  return [...out];
}

/** True when `text` contains any n-word run that is also in the hashed source windows. */
export function overlapsShingles(text: string, shingles: string[], n = 6): boolean {
  if (!shingles.length) return false;
  const set = new Set(shingles);
  const w = plainWords(text);
  for (let i = 0; i + n <= w.length; i++) if (set.has(sha1(w.slice(i, i + n).join(' '), 8))) return true;
  return false;
}

export function localDate(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
