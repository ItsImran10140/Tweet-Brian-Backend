import { Router } from 'express';
import { z } from 'zod';
import { db, USER_TABLES } from '../data';
import { isValidHandle, normalizeHandle } from '../lib/text';
import { AppError } from '../errors';
import { config } from '../config';
import { ensureProfile } from '../lib/auth';
import { defaultNiche } from '../digest/store';
import { normalizeAccountTier, normalizeTierSource } from '../lib/accountTier';
import { refreshAccountTier } from '../lib/xOAuth';
import { parse, requireUser, uid, wrap, type AuthedRequest } from './util';

export const users = Router();

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const Fields = {
  timezone: z.string().refine(validTz, 'unknown time zone (use e.g. Asia/Kolkata)'),
  daily_tweet_limit: z.number().int().min(1).max(30),
  preferred_generation_time: z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM, e.g. 09:00'),
  twitter_handle: z.string().optional(),
  niche: z.string().regex(/^[a-z0-9_-]{1,32}$/, 'use lowercase letters, numbers, - or _ (e.g. tech)'),
  account_tier: z.enum(['free', 'premium']),
  name: z.string().max(200).optional(),
};
const CreateBody = z.object({
  timezone: Fields.timezone.default('Asia/Kolkata'),
  daily_tweet_limit: Fields.daily_tweet_limit.default(10),
  preferred_generation_time: Fields.preferred_generation_time.default('09:00'),
  twitter_handle: Fields.twitter_handle,
  niche: Fields.niche.optional(),
});
const PatchBody = z.object({
  // email is owned by Supabase Auth — never accept client overrides
  timezone: Fields.timezone.optional(),
  daily_tweet_limit: Fields.daily_tweet_limit.optional(),
  preferred_generation_time: Fields.preferred_generation_time.optional(),
  twitter_handle: Fields.twitter_handle,
  niche: Fields.niche.optional(),
  account_tier: Fields.account_tier.optional(),
  name: Fields.name,
});

function withTierDefaults(user: Record<string, unknown> | undefined) {
  if (!user) return user;
  return {
    ...user,
    account_tier: normalizeAccountTier(user.account_tier),
    tier_source: normalizeTierSource(user.tier_source),
  };
}

function cleanHandle(h?: string): string | undefined {
  if (h === undefined) return undefined;
  if (h.trim() === '') return '';
  const handle = normalizeHandle(h);
  if (!isValidHandle(handle)) throw new AppError(400, 'invalid_handle', `"${h}" is not a valid X handle.`, 'Use 1-15 letters, numbers or underscores, e.g. imran_builds');
  return handle;
}

function checkNiche(niche?: string): string | undefined {
  if (niche === undefined) return undefined;
  if (!config.digest.niches[niche]) {
    const names = Object.keys(config.digest.niches);
    throw new AppError(400, 'unknown_niche', `"${niche}" is not a niche in config.yml.`, names.length ? `Use one of: ${names.join(', ')}` : 'Add a niche under digest.niches in config.yml first.');
  }
  return niche;
}

users.post(
  '/',
  wrap(async (req, res) => {
    const authUser = (req as AuthedRequest).authUser;
    const b = parse(CreateBody, req.body);
    const niche = checkNiche(b.niche) ?? defaultNiche();
    await ensureProfile(authUser);
    await db.update(
      'users',
      (u) => u.id === authUser.id,
      {
        timezone: b.timezone,
        daily_tweet_limit: b.daily_tweet_limit,
        preferred_generation_time: b.preferred_generation_time,
        niche,
        twitter_handle: cleanHandle(b.twitter_handle),
      },
    );
    const u = await db.get('users', (row) => row.id === authUser.id);
    res.status(201).json(withTierDefaults(u));
  }),
);

users.get(
  '/me',
  requireUser,
  wrap(async (req, res) => {
    const connected = await db.get('social_accounts', (a) => a.user_id === uid(req) && a.platform === 'x' && a.status === 'connected');
    if (connected) {
      await refreshAccountTier(uid(req));
    }
    res.json(withTierDefaults(await db.get('users', (u) => u.id === uid(req))));
  }),
);

users.patch(
  '/me',
  requireUser,
  wrap(async (req, res) => {
    const b = parse(PatchBody, req.body);
    const patch: Record<string, unknown> = { ...b };
    if (b.twitter_handle !== undefined) patch.twitter_handle = cleanHandle(b.twitter_handle);
    if (b.niche !== undefined) patch.niche = checkNiche(b.niche);
    if (b.account_tier !== undefined) {
      const current = await db.get('users', (u) => u.id === uid(req));
      const source = normalizeTierSource(current?.tier_source);
      if (source !== 'fallback' && source !== 'manual') {
        throw new AppError(
          400,
          'tier_locked',
          'Account tier was detected from X and cannot be changed manually.',
          'Reconnect X if the detected tier looks wrong.',
        );
      }
      patch.account_tier = b.account_tier;
      patch.tier_source = 'manual';
    }
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    await db.update('users', (u) => u.id === uid(req), patch);
    res.json(withTierDefaults(await db.get('users', (u) => u.id === uid(req))));
  }),
);

users.delete(
  '/me',
  requireUser,
  wrap(async (req, res) => {
    const id = uid(req);
    for (const t of USER_TABLES) await db.remove(t, (r) => r.user_id === id);
    await db.remove('users', (u) => u.id === id);
    res.json({ deleted: true });
  }),
);
