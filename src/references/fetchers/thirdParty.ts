import { config } from '../../config';
import { AppError } from '../../errors';
import { requestJson, sleep } from '../../lib/http';
import type { RawTweet } from '../types';

/**
 * SOURCE 2 - Third-party tweet API: twitterapi.io
 *   GET https://api.twitterapi.io/twitter/user/last_tweets?userName=...&includeReplies=...&cursor=...
 *   Header: X-API-Key
 * No X developer approval needed. This file is the only place that knows about the provider, so
 * you can swap it for another one (Apify, etc.) by returning the same RawTweet[] shape.
 */

const base = (): string => config.twitter.twitterapiIoBase.replace(/\/$/, '');

function key(): string {
  if (!config.twitter.twitterapiIoKey) {
    throw new AppError(
      400,
      'third_party_not_configured',
      'TWITTERAPI_IO_KEY is not set.',
      'Add TWITTERAPI_IO_KEY to your .env file (get one at https://twitterapi.io), or use the X API / manual source.',
    );
  }
  return config.twitter.twitterapiIoKey;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function toIso(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const ms = Date.parse(v); // handles "Tue Dec 10 07:00:30 +0000 2024" and ISO
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Tolerant parser: the provider has changed its envelope before, so accept a few shapes. */
export function parseThirdPartyPage(json: any): { tweets: RawTweet[]; nextCursor?: string; hasNext: boolean } {
  const list: any[] = json?.data?.tweets ?? json?.tweets ?? (Array.isArray(json?.data) ? json.data : []);
  const tweets: RawTweet[] = [];
  for (const t of list) {
    if (!t || typeof t.text !== 'string') continue;
    tweets.push({
      id: t.id != null ? String(t.id) : undefined,
      text: t.text,
      createdAt: toIso(t.createdAt ?? t.created_at),
      likeCount: num(t.likeCount ?? t.like_count),
      retweetCount: num(t.retweetCount ?? t.retweet_count),
      replyCount: num(t.replyCount ?? t.reply_count),
      quoteCount: num(t.quoteCount ?? t.quote_count),
      isReply: Boolean(t.isReply ?? t.is_reply),
      isRetweet: Boolean(t.retweeted_tweet ?? t.isRetweet),
      url: typeof t.url === 'string' ? t.url : undefined,
    });
  }
  const nextCursor: string | undefined = json?.next_cursor ?? json?.data?.next_cursor ?? undefined;
  const hasNext = Boolean(json?.has_next_page ?? json?.data?.has_next_page) && Boolean(nextCursor);
  return { tweets, nextCursor, hasNext };
}

export async function fetchFromThirdParty(opts: {
  handle: string;
  limit: number;
  includeReplies: boolean;
}): Promise<{ tweets: RawTweet[] }> {
  const apiKey = key();
  const tweets: RawTweet[] = [];
  let cursor = '';
  const maxPages = Math.min(60, Math.ceil(opts.limit / 15) + 3);

  for (let page = 0; page < maxPages && tweets.length < opts.limit; page++) {
    const params = new URLSearchParams({
      userName: opts.handle,
      includeReplies: String(opts.includeReplies),
    });
    if (cursor) params.set('cursor', cursor);
    const url = `${base()}/twitter/user/last_tweets?${params}`;

    let res = await requestJson(url, { headers: { 'X-API-Key': apiKey } });
    if (res.status === 429) {
      await sleep(5500); // free tiers are rate limited to roughly one request per few seconds
      res = await requestJson(url, { headers: { 'X-API-Key': apiKey } });
    }

    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, 'third_party_unauthorized', `twitterapi.io rejected the API key (${res.status}).`, 'Check TWITTERAPI_IO_KEY.');
    }
    if (res.status === 429) {
      throw new AppError(429, 'third_party_rate_limited', 'twitterapi.io rate limit hit (429).', 'Wait a few seconds and retry, or lower the limit.');
    }
    if (res.status !== 200) {
      throw new AppError(502, 'third_party_error', `twitterapi.io error ${res.status}: ${res.json?.msg ?? res.json?.message ?? res.text.slice(0, 200)}`);
    }
    if (res.json?.status === 'error') {
      throw new AppError(502, 'third_party_error', `twitterapi.io: ${res.json?.msg ?? res.json?.message ?? 'unknown error'}`, 'Check the handle spelling and your account credits.');
    }

    const parsed = parseThirdPartyPage(res.json);
    tweets.push(...parsed.tweets);
    if (!parsed.hasNext || parsed.tweets.length === 0) break;
    cursor = parsed.nextCursor as string;
    await sleep(1100); // be polite between pages
  }

  return { tweets: tweets.slice(0, opts.limit) };
}
