import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { isValidHandle, normalizeHandle } from '../lib/text';
import { analyzeAccount, contextForAccount, importTweets, requireAccount, sourceConfigured, syncAccount } from '../references/service';
import { eligibleTweets } from '../references/style/eligibility';
import * as store from '../references/store';
import { idParam, parse, requireOnboarded, requireUser, uid, wrap } from './util';

/** Reference Twitter/X accounts whose WRITING STYLE inspires your tweets. */
export const references = Router();
references.use(requireUser);
references.use(requireOnboarded);

const syncSource = z.enum(['auto', 'all', 'x_api', 'third_party', 'manual']);

const summary = (a: store.RefRow) => ({
  id: a.id,
  handle: a.handle,
  display_name: a.display_name,
  admire_reason: a.admire_reason,
  tweets: a.tweets.length,
  eligible_tweets: eligibleTweets(a.tweets).length,
  has_style_profile: Boolean(a.style?.profile),
  style_low_coverage: Boolean(a.style?.lowCoverage),
  style_examples: a.style?.exampleTweetKeys?.length ?? 0,
  last_sync_at: a.last_sync_at,
  last_sync_source: a.last_sync_source,
});

references.get('/status', (_req, res) => {
  res.json({
    x_api: { configured: sourceConfigured('x_api') },
    third_party: { configured: sourceConfigured('third_party'), provider: 'twitterapi.io' },
    manual: { configured: true, note: 'Always works: paste tweets with /tweets/import' },
  });
});

// Connect a reference account. Tweets can come from an API (syncNow) or be pasted afterwards.
references.post(
  '/',
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        handle: z.string().min(1),
        admire_reason: z.string().max(500).optional(),
        preferredSource: syncSource.default('auto'),
        syncNow: z.boolean().default(false),
        analyze: z.boolean().default(false),
        limit: z.number().int().min(5).max(3200).optional(),
        text: z.string().max(2_000_000).optional(),
        tweets: z.array(z.string()).optional(),
      }),
      req.body,
    );
    const handle = normalizeHandle(body.handle);
    if (!isValidHandle(handle)) throw new AppError(400, 'invalid_handle', `"${body.handle}" is not a valid X handle.`, 'Use 1-15 letters, numbers or underscores, e.g. IndieHackers');
    if (await store.findByHandle(uid(req), handle)) throw new AppError(409, 'account_exists', `@${handle} is already connected.`, 'List yours with GET /api/references');

    const account = await store.createAccount(uid(req), { handle, preferredSource: body.preferredSource, admireReason: body.admire_reason });
    const out: Record<string, unknown> = { account: summary(account) };

    if (body.text || body.tweets?.length) out.import = await importTweets(uid(req), account.id, { text: body.text, tweets: body.tweets });
    if (body.syncNow) {
      try {
        out.sync = await syncAccount(uid(req), account.id, { limit: body.limit });
      } catch (err) {
        const e = err instanceof AppError ? err : new AppError(500, 'internal_error', String(err));
        out.syncError = { code: e.code, message: e.message, hint: e.hint, details: e.details };
      }
    }
    if (body.analyze) {
      try {
        const s = await analyzeAccount(uid(req), account.id);
        out.style = {
          tweetsAnalyzed: s.tweetsAnalyzed,
          hasProfile: Boolean(s.profile),
          profileError: s.profileError,
          lowCoverage: s.lowCoverage,
          fromCache: s.fromCache,
          exampleCount: s.exampleTweetKeys?.length ?? 0,
        };
        if (s.profileError === 'no_usable_tweets') {
          out.styleError = {
            code: 'no_tweets',
            message: `@${account.handle} has no usable tweets yet.`,
            hint: 'Run /sync or paste 30–50 tweets with /tweets/import, then /analyze.',
          };
        }
      } catch (err) {
        const e = err instanceof AppError ? err : new AppError(500, 'internal_error', String(err));
        out.styleError = { code: e.code, message: e.message, hint: e.hint };
      }
    }
    out.account = summary(await requireAccount(uid(req), account.id));
    out.next = `No tweets yet? POST /api/references/${account.id}/sync (API) or /tweets/import (paste 30–50 top tweets). Then POST /api/references/${account.id}/analyze.`;
    res.status(201).json(out);
  }),
);

references.get(
  '/',
  wrap(async (req, res) => {
    const accounts = await store.listAccounts(uid(req));
    res.json({ accounts: accounts.map(summary) });
  }),
);

references.get(
  '/:id',
  wrap(async (req, res) => {
    const a = await requireAccount(uid(req), idParam(req));
    const bySource = a.tweets.reduce<Record<string, number>>((m, t) => ((m[t.source] = (m[t.source] ?? 0) + 1), m), {});
    res.json({ account: summary(a), tweetsBySource: bySource, style: a.style ? { generatedAt: a.style.generatedAt, tweetsAnalyzed: a.style.tweetsAnalyzed, hasProfile: Boolean(a.style.profile), profileError: a.style.profileError } : null });
  }),
);

references.delete(
  '/:id',
  wrap(async (req, res) => {
    await requireAccount(uid(req), idParam(req));
    await store.deleteAccount(uid(req), idParam(req));
    res.json({ deleted: true });
  }),
);

references.post(
  '/:id/sync',
  wrap(async (req, res) => {
    const body = parse(z.object({ source: syncSource.optional(), limit: z.number().int().min(5).max(3200).optional(), includeReplies: z.boolean().optional(), analyze: z.boolean().default(false) }), req.body);
    const sync = await syncAccount(uid(req), idParam(req), body);
    const style = body.analyze ? await analyzeAccount(uid(req), idParam(req)) : undefined;
    res.json({ sync, ...(style ? { style: { tweetsAnalyzed: style.tweetsAnalyzed, hasProfile: Boolean(style.profile), profileError: style.profileError } } : {}) });
  }),
);

references.post(
  '/:id/tweets/import',
  wrap(async (req, res) => {
    const body = parse(
      z.object({
        text: z.string().max(2_000_000).optional(),
        tweets: z
          .array(z.union([z.string(), z.object({ text: z.string(), createdAt: z.string().optional(), likeCount: z.number().optional(), retweetCount: z.number().optional(), replyCount: z.number().optional(), quoteCount: z.number().optional(), url: z.string().optional() })]))
          .optional(),
        replace: z.boolean().default(false),
        analyze: z.boolean().default(false),
      }),
      req.body,
    );
    const result = await importTweets(uid(req), idParam(req), body);
    const style = body.analyze ? await analyzeAccount(uid(req), idParam(req)) : undefined;
    res.json({ import: result, ...(style ? { style: { tweetsAnalyzed: style.tweetsAnalyzed, hasProfile: Boolean(style.profile), profileError: style.profileError } } : {}) });
  }),
);

references.get(
  '/:id/tweets',
  wrap(async (req, res) => {
    const a = await requireAccount(uid(req), idParam(req));
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
    res.json({ total: a.tweets.length, offset, limit, tweets: a.tweets.slice(offset, offset + limit) });
  }),
);

references.delete(
  '/:id/tweets',
  wrap(async (req, res) => {
    await requireAccount(uid(req), idParam(req));
    await store.clearTweets(uid(req), idParam(req));
    res.json({ cleared: true });
  }),
);

references.post(
  '/:id/analyze',
  wrap(async (req, res) => {
    const body = parse(z.object({ useLlm: z.boolean().default(true), force: z.boolean().default(false) }), req.body);
    const style = await analyzeAccount(uid(req), idParam(req), body);
    if (style.profileError === 'no_usable_tweets') {
      throw new AppError(
        400,
        'no_tweets',
        'This account has no usable tweets yet.',
        'Run /sync or paste 30–50 top-performing tweets with /tweets/import, then analyze again.',
      );
    }
    res.json({ style });
  }),
);

references.get(
  '/:id/style',
  wrap(async (req, res) => {
    const a = await requireAccount(uid(req), idParam(req));
    if (!a.style) throw new AppError(404, 'no_style', 'No style analysis yet.', `POST /api/references/${a.id}/analyze`);
    res.json({ style: a.style });
  }),
);

/** Shows exactly the text block that gets handed to the LLM for this account. */
references.get('/:id/context', wrap(async (req, res) => {
  const num = (v: unknown) => (v === undefined || v === '' ? undefined : Math.max(0, Number(v) || 0));
  const formatsRaw = typeof req.query.formats === 'string' ? req.query.formats : '';
  const formats = formatsRaw
    .split(',')
    .map((f) => f.trim())
    .filter((f): f is 'opinion' | 'lesson' | 'story' | 'question' | 'humor' =>
      ['opinion', 'lesson', 'story', 'question', 'humor'].includes(f),
    );
  const built = await contextForAccount(uid(req), idParam(req), {
    fewShotCount: num(req.query.fewShot),
    rawRecentCount: num(req.query.recent),
    charBudget: num(req.query.budget),
    formats,
  });
  if (req.query.format === 'text') {
    res.type('text/plain').send(built.text || `(skipped: ${built.layers.skipReason ?? 'no context'})`);
    return;
  }
  res.json({
    layers: built.layers,
    chars: built.chars,
    fewShotCount: built.fewShotTweets.length,
    context: built.text,
  });
}));

