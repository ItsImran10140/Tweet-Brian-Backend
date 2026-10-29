import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../errors';
import { db, usage } from '../data';
import { charLimitForTier } from '../lib/accountTier';
import { saveTweetEdit } from '../lib/editLearning';
import { rewriteFromIdea, saveIdeaVariant } from '../lib/fromIdea';
import { generateWithEntitlement, generationRateLimitMax } from '../lib/generateWithEntitlement';
import { assertPaid, assertPaidAndXConnected, assertPaidPostQuota, utcToday } from '../lib/gates';
import { REFINE_ACTIONS, refineTweet } from '../lib/refineTweet';
import { parse, idParam, rateLimit, requireOnboarded, requireUser, uid, wrap } from './util';

export const tweets = Router();
tweets.use(requireUser);
tweets.use(requireOnboarded);

async function userCharLimit(req: import('express').Request): Promise<number> {
  const user = await db.get('users', (u) => u.id === uid(req));
  return charLimitForTier(user?.account_tier);
}

const GenerateBody = z.object({
  topic: z.string().max(4000).optional(),
  count: z.number().int().min(1).max(30).optional(),
  niche: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
  refresh_digest: z.boolean().default(true),
  pipeline: z.enum(['multi', 'single']).optional(),
});

tweets.post(
  '/generate',
  rateLimit(generationRateLimitMax, 60 * 60 * 1000),
  wrap(async (req, res) => {
    const b = parse(GenerateBody, req.body);
    res.status(201).json(
      await generateWithEntitlement(uid(req), {
        topic: b.topic,
        count: b.count,
        niche: b.niche,
        refreshDigest: b.refresh_digest,
        pipeline: b.pipeline,
      }),
    );
  }),
);

tweets.get(
  '/',
  wrap(async (req, res) => {
    const { status, batch_id } = req.query;
    const list = (await db.all(
      'generated_tweets',
      (t) => t.user_id === uid(req) && (!status || t.status === status) && (!batch_id || t.batch_id === batch_id),
    )).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ count: list.length, tweets: list });
  }),
);

tweets.post(
  '/from-idea',
  rateLimit(generationRateLimitMax, 60 * 60 * 1000),
  wrap(async (req, res) => {
    await assertPaid(uid(req), 'idea rewrites');
    const { idea } = parse(z.object({ idea: z.string().min(3).max(1000) }), req.body);
    res.json(await rewriteFromIdea(uid(req), idea));
  }),
);

tweets.post(
  '/from-idea/save',
  wrap(async (req, res) => {
    await assertPaid(uid(req), 'saving idea variants');
    const max = await userCharLimit(req);
    const { text, idea } = parse(z.object({ text: z.string().min(1).max(max), idea: z.string().max(1000).default('') }), req.body);
    const tweet = await saveIdeaVariant(uid(req), text, idea);
    res.status(201).json({ tweet });
  }),
);

async function mine(req: import('express').Request) {
  const t = await db.get('generated_tweets', (x) => x.id === idParam(req) && x.user_id === uid(req));
  if (!t) throw new AppError(404, 'tweet_not_found', 'No tweet with that id.', 'List yours with GET /api/tweets');
  return t;
}

tweets.post(
  '/:id/like',
  wrap(async (req, res) => {
    const t = await mine(req);
    await db.update('generated_tweets', (x) => x.id === t.id, { status: 'liked', feedback: 'up' });
    await db.insert('feedback_events', { user_id: uid(req), tweet_id: t.id, kind: 'like' });
    res.json({ ok: true, feedback: 'up' });
  }),
);

tweets.post(
  '/:id/feedback',
  wrap(async (req, res) => {
    const t = await mine(req);
    const { vote } = parse(z.object({ vote: z.enum(['up', 'down']) }), req.body);
    await db.update('generated_tweets', (x) => x.id === t.id, {
      feedback: vote,
      status: vote === 'up' ? 'liked' : t.status === 'liked' ? 'pending' : t.status,
    });
    await db.insert('feedback_events', {
      user_id: uid(req),
      tweet_id: t.id,
      kind: vote === 'up' ? 'like' : 'dislike',
      original_text: t.text,
    });
    res.json({ ok: true, feedback: vote });
  }),
);

const DiscardBody = z.object({ reason: z.enum(['too_generic', 'not_my_opinion', 'wrong_tone', 'too_long', 'off_topic']) });
tweets.post(
  '/:id/discard',
  wrap(async (req, res) => {
    const t = await mine(req);
    const { reason } = parse(DiscardBody, req.body);
    await db.update('generated_tweets', (x) => x.id === t.id, { status: 'discarded', discard_reason: reason, feedback: 'down' });
    await db.insert('feedback_events', { user_id: uid(req), tweet_id: t.id, kind: 'discard', discard_reason: reason, original_text: t.original_text });
    res.json({ ok: true });
  }),
);

tweets.post(
  '/:id/edit',
  wrap(async (req, res) => {
    const t = await mine(req);
    const max = await userCharLimit(req);
    const { text } = parse(z.object({ text: z.string().min(1).max(max) }), req.body);
    const learning = await saveTweetEdit(uid(req), t, text);
    res.json({ ok: true, learning });
  }),
);

tweets.post(
  '/:id/refine',
  rateLimit(generationRateLimitMax, 60 * 60 * 1000),
  wrap(async (req, res) => {
    await assertPaid(uid(req), 'AI refine');
    const { action } = parse(z.object({ action: z.enum(REFINE_ACTIONS) }), req.body);
    const tweet = await refineTweet(uid(req), idParam(req), action);
    res.json({ tweet });
  }),
);

tweets.patch(
  '/:id/schedule',
  wrap(async (req, res) => {
    await assertPaidAndXConnected(uid(req), 'scheduling');
    await assertPaidPostQuota(uid(req));
    const tweet = await mine(req);
    const max = await userCharLimit(req);
    const { scheduledAtUtc, text } = parse(
      z.object({
        scheduledAtUtc: z.string().datetime({ offset: true }).nullable(),
        text: z.string().min(1).max(max).optional(),
      }),
      req.body,
    );
    let learning = null;
    if (text !== undefined) {
      learning = await saveTweetEdit(uid(req), tweet, text);
    }
    const status = scheduledAtUtc
      ? new Date(scheduledAtUtc).getTime() < Date.now() ? 'failed' : 'scheduled'
      : 'pending';
    await db.update('generated_tweets', (x) => x.id === tweet.id && x.user_id === uid(req), {
      scheduled_at: scheduledAtUtc,
      status,
    });
    if (scheduledAtUtc) {
      await usage.incrementDailyUsage(uid(req), utcToday(), { drafts_posted: 1 });
    }
    res.json({
      ...(await db.get('generated_tweets', (x) => x.id === tweet.id && x.user_id === uid(req))),
      learning,
    });
  }),
);

tweets.post(
  '/:id/publish',
  wrap(async (req, res) => {
    await assertPaidAndXConnected(uid(req), 'posting');
    await assertPaidPostQuota(uid(req));
    const tweet = await mine(req);
    const max = await userCharLimit(req);
    const { text } = parse(z.object({ text: z.string().min(1).max(max).optional() }), req.body);
    let learning = null;
    if (text !== undefined) {
      learning = await saveTweetEdit(uid(req), tweet, text);
    }
    const now = new Date().toISOString();
    await db.update('generated_tweets', (x) => x.id === tweet.id && x.user_id === uid(req), {
      status: 'posted',
      published_at: now,
      posted_at: now,
      scheduled_at: now,
    });
    await usage.incrementDailyUsage(uid(req), utcToday(), { drafts_posted: 1 });
    res.json({
      ...(await db.get('generated_tweets', (x) => x.id === tweet.id && x.user_id === uid(req))),
      external_publish: false,
      notice: 'Marked as published in the local workspace only; no social network post was sent.',
      learning,
    });
  }),
);

tweets.post(
  '/:id/duplicate',
  wrap(async (req, res) => {
    const tweet = await mine(req);
    const { scheduledAtUtc } = parse(z.object({
      scheduledAtUtc: z.string().datetime({ offset: true }).nullable().default(null),
    }), req.body);
    const copy = await db.insert('generated_tweets', {
      user_id: uid(req),
      text: tweet.text,
      original_text: tweet.original_text,
      edited_text: null,
      tweet_type: tweet.tweet_type,
      niche: tweet.niche,
      kind: tweet.kind,
      source_name: tweet.source_name,
      source_url: tweet.source_url,
      source_headline: tweet.source_headline,
      verify_note: tweet.verify_note,
      brain_version: tweet.brain_version,
      batch_id: tweet.batch_id,
      status: scheduledAtUtc && new Date(scheduledAtUtc).getTime() >= Date.now() ? 'scheduled' : 'pending',
      scheduled_at: scheduledAtUtc,
    });
    res.status(201).json(copy);
  }),
);

tweets.delete(
  '/:id',
  wrap(async (req, res) => {
    const tweet = await mine(req);
    await db.remove('generated_tweets', (x) => x.id === tweet.id && x.user_id === uid(req));
    res.json({ id: tweet.id });
  }),
);
