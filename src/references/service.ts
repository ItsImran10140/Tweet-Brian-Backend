import { config } from '../config';
import { AppError } from '../errors';
import { cleanForAnalysis, tweetKey } from '../lib/text';
import { parseManualInput, type ManualTweetObject, type SplitMode } from './fetchers/manual';
import { fetchFromThirdParty } from './fetchers/thirdParty';
import { fetchFromXApi } from './fetchers/xApi';
import * as store from './store';
import { buildStyleContext, emptyStyleContext, type BuiltContext, type ContextOptions } from './style/context';
import { eligibleTweets } from './style/eligibility';
import { selectTopPerforming } from './style/exemplars';
import { buildProfileWithLlm } from './style/profile';
import { computeStyleStats } from './style/stats';
import type { RawTweet, RefAccountRow, SourceName, StoredStyle, StoredTweet, SyncSource } from './types';

// ---------- normalize raw tweets -> stored tweets ----------

export function toStored(raw: RawTweet[], source: SourceName, includeReplies: boolean): StoredTweet[] {
  const now = Date.now();
  const out: StoredTweet[] = [];
  raw.forEach((t, idx) => {
    if (t.isRetweet) return;
    if (t.isReply && !includeReplies) return;
    const text = t.text.replace(/\r\n?/g, '\n').trim();
    if (!text || cleanForAnalysis(text).length < 1) return;
    out.push({
      key: tweetKey(text),
      tweetId: t.id,
      text,
      createdAt: t.createdAt,
      likeCount: t.likeCount ?? 0,
      retweetCount: t.retweetCount ?? 0,
      replyCount: t.replyCount ?? 0,
      quoteCount: t.quoteCount ?? 0,
      isReply: Boolean(t.isReply),
      source,
      // Manual tweets have no date: space `addedAt` by index so the first pasted tweet counts as the newest.
      addedAt: new Date(now - idx).toISOString(),
    });
  });
  return out;
}

// ---------- SOURCE 3: manual import ----------

export async function importTweets(
  userId: string,
  accountId: string,
  input: { text?: string; tweets?: (string | ManualTweetObject)[]; replace?: boolean },
): Promise<{ parsed: number; skipped: number; splitMode: SplitMode; added: number; updated: number; total: number }> {
  await requireAccount(userId, accountId);
  const parsed = parseManualInput(input);
  if (input.replace) await store.clearTweets(userId, accountId);
  const stored = toStored(parsed.tweets, 'manual', true);
  const res = await store.upsertTweets(userId, accountId, stored, config.style.maxTweetsStored);
  return { parsed: parsed.tweets.length, skipped: parsed.skipped, splitMode: parsed.mode, ...res };
}

// ---------- SOURCES 1 + 2: fetch from the APIs ----------

export interface SyncAttempt {
  source: SourceName;
  status: 'ok' | 'failed' | 'skipped';
  fetched?: number;
  code?: string;
  message?: string;
  hint?: string;
}

type ApiSource = 'x_api' | 'third_party';
const FETCHERS: Record<ApiSource, (o: { handle: string; limit: number; includeReplies: boolean }) => Promise<{ tweets: RawTweet[]; displayName?: string }>> = {
  x_api: fetchFromXApi,
  third_party: fetchFromThirdParty,
};

export function sourceConfigured(source: ApiSource): boolean {
  return source === 'x_api' ? Boolean(config.twitter.xBearerToken) : Boolean(config.twitter.twitterapiIoKey);
}

export interface FetchResult {
  attempts: SyncAttempt[];
  tweets: StoredTweet[];
  lastSource?: SourceName;
  displayName?: string;
}

/** Pull tweets for any handle (a reference account OR your own account) from the configured API sources. */
export async function fetchTweetsForHandle(
  handle: string,
  opts: { requested: SyncSource; limit?: number; includeReplies?: boolean; manualHint: string },
): Promise<FetchResult> {
  const requested = opts.requested;
  const limit = Math.min(Math.max(opts.limit ?? 200, 5), 3200);
  const includeReplies = opts.includeReplies ?? false;

  if (requested === 'manual') {
    throw new AppError(400, 'manual_source', 'The "manual" source has nothing to fetch.', opts.manualHint);
  }
  const order: ApiSource[] = requested === 'x_api' ? ['x_api'] : requested === 'third_party' ? ['third_party'] : ['x_api', 'third_party'];

  const attempts: SyncAttempt[] = [];
  const collected: StoredTweet[] = [];
  let lastSource: SourceName | undefined;
  let displayName: string | undefined;

  for (const source of order) {
    const explicit = requested === source;
    if (!explicit && !sourceConfigured(source)) {
      attempts.push({ source, status: 'skipped', code: `${source}_not_configured`, message: 'Not configured (no key in config.yml).' });
      continue;
    }
    try {
      const res = await FETCHERS[source]({ handle, limit, includeReplies });
      collected.push(...toStored(res.tweets, source, includeReplies));
      lastSource = source;
      displayName = displayName ?? res.displayName;
      attempts.push({ source, status: 'ok', fetched: res.tweets.length });
      if (requested === 'auto') break; // auto = first source that works; "all" keeps going
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (explicit) throw err; // user asked for this exact source: surface the real error
      attempts.push({ source, status: 'failed', code: err.code, message: err.message, hint: err.hint });
    }
  }

  if (collected.length === 0) {
    const anyFailed = attempts.some((a) => a.status === 'failed');
    throw new AppError(
      anyFailed ? 502 : 400,
      anyFailed ? 'all_sources_failed' : 'no_sources_configured',
      anyFailed
        ? 'Every configured tweet source failed (see details).'
        : 'No tweet source is configured. Set twitter.x_bearer_token and/or twitter.twitterapi_io_key in config.yml, or paste tweets manually.',
      opts.manualHint,
      attempts,
    );
  }
  return { attempts, tweets: collected, lastSource, displayName };
}

export interface SyncReport {
  requested: SyncSource;
  attempts: SyncAttempt[];
  added: number;
  updated: number;
  total: number;
}

export async function syncAccount(
  userId: string,
  accountId: string,
  opts: { source?: SyncSource; limit?: number; includeReplies?: boolean } = {},
): Promise<SyncReport> {
  const account = await requireAccount(userId, accountId);
  const requested = opts.source ?? account.preferred_source;
  const fetched = await fetchTweetsForHandle(account.handle, {
    requested,
    // Default to enough tweets to cover a top-performing sample for the style card.
    limit: opts.limit ?? Math.max(config.style.topPerformingCount, 50),
    includeReplies: opts.includeReplies,
    manualHint: `Paste 30–50 top tweets with POST /api/references/${accountId}/tweets/import`,
  });
  const merge = await store.upsertTweets(userId, accountId, fetched.tweets, config.style.maxTweetsStored);
  await store.updateAccount(userId, accountId, {
    last_sync_at: new Date().toISOString(),
    last_sync_source: fetched.lastSource,
    ...(fetched.displayName && !account.display_name ? { display_name: fetched.displayName } : {}),
  });
  return { requested, attempts: fetched.attempts, ...merge };
}

// ---------- style analysis ----------

function isStyleCacheFresh(existing: StoredStyle | null | undefined, eligibleCount: number): boolean {
  if (!existing?.profile || !existing.generatedAt) return false;
  const ttl = config.style.styleCardTtlHours;
  if (ttl <= 0) return false;
  const ageMs = Date.now() - new Date(existing.generatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return false;
  if (ageMs > ttl * 3600_000) return false;
  const delta = Math.abs(eligibleCount - (existing.tweetsAnalyzed ?? 0));
  if (delta >= config.style.styleCardInvalidateDelta) return false;
  return true;
}

export async function analyzeAccount(
  userId: string,
  accountId: string,
  opts: { useLlm?: boolean; force?: boolean } = {},
): Promise<StoredStyle> {
  const account = await requireAccount(userId, accountId);
  const tweets = await store.getTweets(account);
  const stats = computeStyleStats(tweets);
  const eligibleCount = eligibleTweets(tweets).length;

  if (stats.tweetCount === 0 || eligibleCount === 0) {
    const empty: StoredStyle = {
      accountId,
      generatedAt: new Date().toISOString(),
      tweetsAnalyzed: 0,
      exampleTweetKeys: [],
      lowCoverage: true,
      stats,
      profile: null,
      profileError: 'no_usable_tweets',
    };
    await store.saveStyle(userId, accountId, empty);
    // Soft failure for callers that expect a style object; the HTTP route can still surface this.
    return empty;
  }

  if (!opts.force && isStyleCacheFresh(account.style, eligibleCount)) {
    const cached: StoredStyle = {
      ...account.style!,
      fromCache: true,
      // Keep example keys aligned with current top performers when possible
      exampleTweetKeys: account.style!.exampleTweetKeys?.length
        ? account.style!.exampleTweetKeys
        : selectTopPerforming(tweets).map((t) => t.key),
    };
    return cached;
  }

  const top = selectTopPerforming(tweets);
  const lowCoverage = top.length < config.style.topPerformingMin;

  let profile: StoredStyle['profile'] = null;
  let profileError: string | undefined;
  let exampleTweetKeys = top.map((t) => t.key);

  if (opts.useLlm ?? true) {
    try {
      const built = await buildProfileWithLlm(account.handle, stats, tweets);
      profile = built.profile;
      exampleTweetKeys = built.sample.map((t) => t.key);
    } catch (err) {
      profileError = err instanceof Error ? err.message : String(err);
    }
  }

  const style: StoredStyle = {
    accountId,
    generatedAt: new Date().toISOString(),
    tweetsAnalyzed: eligibleCount,
    exampleTweetKeys,
    lowCoverage,
    fromCache: false,
    stats,
    profile,
    profileError,
  };
  await store.saveStyle(userId, accountId, style);
  return style;
}

/** Ensure a cached style card exists when possible; never throws for empty accounts. */
export async function ensureStyleCard(
  userId: string,
  accountId: string,
): Promise<StoredStyle | null> {
  try {
    return await analyzeAccount(userId, accountId, { useLlm: true, force: false });
  } catch {
    return null;
  }
}

// ---------- context (what the LLM sees) ----------

export async function contextForAccount(userId: string, accountId: string, opts: ContextOptions = {}): Promise<BuiltContext & { account: RefAccountRow }> {
  const account = await requireAccount(userId, accountId);
  const tweets = await store.getTweets(account);
  if (tweets.length === 0) {
    return { account, ...emptyStyleContext(account, `No tweets stored for @${account.handle}`) };
  }
  const style = account.style ?? {
    stats: computeStyleStats(tweets),
    profile: null,
    exampleTweetKeys: selectTopPerforming(tweets).map((t) => t.key),
  };
  return {
    account,
    ...buildStyleContext(account, tweets, style, {
      note: account.admire_reason || undefined,
      preferExampleKeys: style.exampleTweetKeys,
      ...opts,
    }),
  };
}

// ---------- helpers ----------

export async function requireAccount(userId: string, id: string): Promise<RefAccountRow> {
  const acc = await store.getAccount(userId, id);
  if (!acc) throw new AppError(404, 'account_not_found', `No reference account with id "${id}".`, 'List yours with GET /api/references');
  return acc;
}

/** Used by onboarding: make sure an account exists for a handle listed in the onboarding answers. */
export async function ensureAccount(userId: string, handle: string, extra: { admireReason?: string; sampleTweets?: string[] } = {}): Promise<RefAccountRow> {
  let acc = await store.findByHandle(userId, handle);
  if (!acc) acc = await store.createAccount(userId, { handle, preferredSource: 'auto', admireReason: extra.admireReason });
  else if (extra.admireReason && !acc.admire_reason) await store.updateAccount(userId, acc.id, { admire_reason: extra.admireReason });
  if (extra.sampleTweets?.length) {
    const stored = toStored(extra.sampleTweets.map((text) => ({ text })), 'manual', true);
    await store.upsertTweets(userId, acc.id, stored, config.style.maxTweetsStored);
  }
  return await requireAccount(userId, acc.id);
}
