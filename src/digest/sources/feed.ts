import * as cheerio from 'cheerio';
import { config } from '../../config';
import { AppError } from '../../errors';
import { requestJson } from '../../lib/http';
import { canonicalUrl, hostOf, htmlToText, localDate, sha1, shingleHashes, trimAtBoundary } from '../text';
import type { RawItem, SourceKind } from '../types';

export interface ParsedEntry {
  title: string;
  url: string;
  published: string | null;
  text: string; // plain text of the entry body (may be long; only a short excerpt is kept)
}

const BROWSER_ACCEPT = 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5';

/** Download a URL as text with a timeout and a size cap. Never throws on HTTP errors, callers decide. */
export async function fetchText(url: string): Promise<string> {
  const res = await requestJson(url, {
    headers: { Accept: BROWSER_ACCEPT, 'User-Agent': config.digest.userAgent },
    timeoutMs: config.digest.fetchTimeoutSeconds * 1000,
  });
  if (res.status < 200 || res.status >= 300) throw new AppError(502, 'feed_http_error', `${url} answered HTTP ${res.status}.`, 'Check the URL in a browser. Dead feeds are skipped automatically.');
  if (res.text.length > 4_000_000) throw new AppError(502, 'feed_too_large', `${url} is larger than 4 MB.`);
  return res.text;
}

const dateOf = (v: string | undefined): string | null => {
  if (!v) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Parses RSS 2.0, RSS 1.0 (RDF) and Atom. */
export function parseFeed(xml: string): ParsedEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ParsedEntry[] = [];

  // RSS / RDF
  $('item').each((_, el) => {
    const n = $(el);
    const title = htmlToText(n.children('title').first().text());
    let url = n.children('link').first().text().trim();
    if (!url) {
      const guid = n.children('guid').first();
      if (guid.attr('isPermaLink') !== 'false') url = guid.text().trim();
    }
    const body = n.children('content\\:encoded').first().text() || n.children('description').first().text() || '';
    const published = dateOf(n.children('pubDate').first().text() || n.children('dc\\:date').first().text());
    if (title && /^https?:\/\//i.test(url)) out.push({ title, url, published, text: htmlToText(body) });
  });

  // Atom
  $('entry').each((_, el) => {
    const n = $(el);
    const title = htmlToText(n.children('title').first().text());
    const links = n.children('link').toArray().map((l) => ({ href: $(l).attr('href') ?? '', rel: $(l).attr('rel') ?? 'alternate' }));
    const url = (links.find((l) => l.rel === 'alternate') ?? links[0])?.href?.trim() ?? '';
    const body = n.children('content').first().text() || n.children('summary').first().text() || '';
    const published = dateOf(n.children('published').first().text() || n.children('updated').first().text());
    if (title && /^https?:\/\//i.test(url)) out.push({ title, url, published, text: htmlToText(body) });
  });

  if (!out.length && !/<(rss|feed|rdf:RDF)\b/i.test(xml)) throw new AppError(422, 'not_a_feed', 'The response is not an RSS or Atom feed.', 'Use the feed URL (often ending in /rss, /feed, /atom or .xml), not the website home page.');
  return out;
}

export interface MakeItemInput {
  niche: string;
  kind: SourceKind;
  source_name: string;
  tier: 1 | 2 | 3;
  title: string;
  url: string;
  text: string;
  published: string | null;
  score?: number;
}

/** Turns raw text into the stored shape: short excerpt + hashed shingles, never the full text. */
export function makeItem(i: MakeItemInput, now = new Date()): RawItem {
  const url = i.url.trim();
  const full = `${i.title}. ${i.text}`.slice(0, 4000);
  return {
    id: sha1(canonicalUrl(url), 20),
    niche: i.niche,
    kind: i.kind,
    source_name: i.source_name,
    tier: i.tier,
    title: i.title.trim().slice(0, 240),
    url,
    domain: hostOf(url),
    excerpt: i.text ? trimAtBoundary(i.text, config.digest.excerptMaxChars) : '',
    published_at: i.published,
    fetched_at: now.toISOString(),
    fetch_date: localDate(now, config.digest.timezone),
    ...(i.score !== undefined ? { score: i.score } : {}),
    shingles: shingleHashes(full, config.digest.safety.minOverlapWords),
  };
}

export const isFresh = (published: string | null, maxAgeHours: number, now = new Date()): boolean =>
  !published || now.getTime() - new Date(published).getTime() <= maxAgeHours * 3600_000;

export async function collectFeed(niche: string, feed: { url: string; name?: string; tier: number }, now = new Date()): Promise<RawItem[]> {
  const xml = await fetchText(feed.url);
  const name = feed.name ?? hostOf(feed.url);
  return parseFeed(xml)
    .filter((e) => isFresh(e.published, config.digest.maxAgeHours, now))
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''))
    .slice(0, config.digest.maxItemsPerFeed)
    .map((e) => makeItem({ niche, kind: 'feed', source_name: name, tier: feed.tier as 1 | 2 | 3, title: e.title, url: e.url, text: e.text, published: e.published }, now));
}
