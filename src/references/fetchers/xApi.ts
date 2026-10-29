import { config } from '../../config';
import { AppError } from '../../errors';
import { requestJson } from '../../lib/http';
import type { RawTweet } from '../types';

/**
 * SOURCE 1 - Official X API v2 (https://docs.x.com)
 *   GET /2/users/by/username/:username        -> user id
 *   GET /2/users/:id/tweets                   -> posts timeline (max_results 5..100, pagination_token)
 * Needs X_BEARER_TOKEN. Whether your X developer plan can read other users' posts depends on the
 * plan/credits on your developer account.
 */

const base = (): string => config.twitter.xApiBase.replace(/\/$/, '');

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  note_tweet?: { text?: string };
  public_metrics?: { like_count?: number; retweet_count?: number; reply_count?: number; quote_count?: number };
  referenced_tweets?: { type: string; id: string }[];
}

function authHeaders(): Record<string, string> {
  if (!config.twitter.xBearerToken) {
    throw new AppError(
      400,
      'x_api_not_configured',
      'X_BEARER_TOKEN is not set.',
      'Add X_BEARER_TOKEN to your .env file (get one at https://developer.x.com), or use the third-party / manual source.',
    );
  }
  return { Authorization: `Bearer ${config.twitter.xBearerToken}` };
}

function explain(status: number, body: any, ctx: string): AppError {
  const detail: string = body?.detail ?? body?.title ?? body?.error ?? '';
  if (status === 401) {
    return new AppError(502, 'x_api_unauthorized', `X API rejected the bearer token (401) while ${ctx}. ${detail}`.trim(), 'Check X_BEARER_TOKEN - copy the Bearer Token (not the API key) from your X developer app.');
  }
  if (status === 402) {
    return new AppError(502, 'x_api_payment_required', `X API says this request needs credits or a paid plan (402) while ${ctx}. ${detail}`.trim(), 'Add credits / upgrade your X developer plan, or use the third-party or manual source.');
  }
  if (status === 403) {
    return new AppError(502, 'x_api_forbidden', `X API denied access (403) while ${ctx}. ${detail}`.trim(), 'Your X developer plan may not include reading other accounts\' posts. Use the third-party or manual source instead.');
  }
  if (status === 404) {
    return new AppError(404, 'x_api_user_not_found', `X API could not find that user while ${ctx}.`, 'Check the handle spelling.');
  }
  if (status === 429) {
    return new AppError(429, 'x_api_rate_limited', `X API rate limit hit (429) while ${ctx}.`, 'Wait a few minutes and retry, or lower the limit.');
  }
  return new AppError(502, 'x_api_error', `X API error ${status} while ${ctx}. ${detail}`.trim());
}

async function lookupUserId(handle: string): Promise<{ id: string; name?: string }> {
  const res = await requestJson(`${base()}/users/by/username/${encodeURIComponent(handle)}`, { headers: authHeaders() });
  if (res.status !== 200) throw explain(res.status, res.json, 'looking up the user');
  if (res.json?.errors?.length && !res.json?.data) {
    const e = res.json.errors[0];
    throw new AppError(404, 'x_api_user_not_found', e?.detail ?? `User @${handle} not found or unavailable.`);
  }
  const data = res.json?.data;
  if (!data?.id) throw new AppError(404, 'x_api_user_not_found', `User @${handle} not found.`);
  return { id: data.id as string, name: data.name as string | undefined };
}

export async function fetchFromXApi(opts: {
  handle: string;
  limit: number;
  includeReplies: boolean;
}): Promise<{ tweets: RawTweet[]; displayName?: string }> {
  const headers = authHeaders();
  const user = await lookupUserId(opts.handle);

  const tweets: RawTweet[] = [];
  let token: string | undefined;
  const maxPages = 40;

  for (let page = 0; page < maxPages && tweets.length < opts.limit; page++) {
    const remaining = opts.limit - tweets.length;
    const params = new URLSearchParams({
      max_results: String(Math.min(100, Math.max(5, remaining))),
      exclude: opts.includeReplies ? 'retweets' : 'retweets,replies',
      'tweet.fields': 'created_at,public_metrics,note_tweet,referenced_tweets',
    });
    if (token) params.set('pagination_token', token);

    const res = await requestJson(`${base()}/users/${user.id}/tweets?${params}`, { headers });
    if (res.status !== 200) throw explain(res.status, res.json, 'fetching tweets');

    const items: XTweet[] = res.json?.data ?? [];
    for (const t of items) {
      const isReply = t.referenced_tweets?.some((r) => r.type === 'replied_to') ?? false;
      const isRetweet = t.referenced_tweets?.some((r) => r.type === 'retweeted') ?? false;
      tweets.push({
        id: t.id,
        // note_tweet.text holds the full text of long (>280 char) posts
        text: t.note_tweet?.text ?? t.text,
        createdAt: t.created_at,
        likeCount: t.public_metrics?.like_count,
        retweetCount: t.public_metrics?.retweet_count,
        replyCount: t.public_metrics?.reply_count,
        quoteCount: t.public_metrics?.quote_count,
        isReply,
        isRetweet,
        url: `https://x.com/${opts.handle}/status/${t.id}`,
      });
    }

    token = res.json?.meta?.next_token;
    if (!token || items.length === 0) break;
  }

  return { tweets: tweets.slice(0, opts.limit), displayName: user.name };
}
