import type { User } from '@supabase/supabase-js';
import { billing, db, getSupabase } from '../data';
import { AppError } from '../errors';
import { defaultNiche } from '../digest/store';

export type AppState = 'new' | 'onboarded' | 'paid';

export type PlanStatus = {
  /** Access gate: 'active' means paid features are unlocked. */
  status: 'none' | 'active';
  key: string | null;
  /** Raw billing status from entitlements (for /billing/status). */
  billing_status: 'none' | 'active' | 'canceled' | 'past_due' | 'refunded' | 'revoked';
  current_period_end: string | null;
  entitlements: Array<{ key: string; ends_at: string | null; status: string }>;
};

export type WhoAmI = {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  onboarding_completed: boolean;
  free_generation_used: boolean;
  plan: PlanStatus;
  /** True when an X social_accounts row exists with status=connected. */
  x_connected: boolean;
  state: AppState;
};

function metaString(user: User, ...keys: string[]): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Verify a Supabase access token and return the auth user (email required). */
export async function verifyAccessToken(token: string): Promise<User> {
  const { data, error } = await getSupabase().auth.getUser(token);
  if (error || !data.user) {
    throw new AppError(401, 'invalid_token', 'Missing or invalid access token.', 'Sign in with Google and send Authorization: Bearer <access_token>.');
  }
  const user = data.user;
  if (!user.email) {
    throw new AppError(401, 'email_required', 'Signed-in user has no email.', 'Use a Google account that shares an email address.');
  }
  return user;
}

/**
 * Create the profiles row on first sign-in. Idempotent upsert — safe to call on every whoami.
 * Never trusts browser-supplied id; always uses the verified auth user.
 */
export async function ensureProfile(user: User) {
  const name = metaString(user, 'full_name', 'name');
  const avatar_url = metaString(user, 'avatar_url', 'picture');
  const existing = await db.get('users', (u) => u.id === user.id);

  if (!existing) {
    return db.insert('users', {
      id: user.id,
      email: user.email,
      name,
      avatar_url,
      timezone: 'Asia/Kolkata',
      daily_tweet_limit: 10,
      preferred_generation_time: '09:00',
      niche: defaultNiche(),
      account_tier: 'free',
      tier_source: 'fallback',
      onboarding_completed: false,
      free_generation_used: false,
    });
  }

  const patch: Record<string, unknown> = {};
  if (user.email && existing.email !== user.email) patch.email = user.email;
  if (name && !existing.name) patch.name = name;
  if (avatar_url && !existing.avatar_url) patch.avatar_url = avatar_url;
  if (Object.keys(patch).length) {
    await db.update('users', (u) => u.id === user.id, patch);
    return (await db.get('users', (u) => u.id === user.id))!;
  }
  return existing;
}

export async function resolvePlan(userId: string): Promise<PlanStatus> {
  const rows = await billing.listEntitlements(userId);
  const mapped = rows.map((r) => ({
    key: String(r.entitlement_key),
    ends_at: r.ends_at ? String(r.ends_at) : null,
    status: String(r.status ?? (r.active ? 'active' : 'none')),
    grants: billing.entitlementGrantsAccess(r),
  }));
  const withAccess = mapped.filter((e) => e.grants);
  if (!withAccess.length) {
    const preferredNone =
      ['lifetime', 'yearly', 'monthly'].find((k) => mapped.some((e) => e.key === k)) ?? mapped[0]?.key;
    const latest = mapped.find((e) => e.key === preferredNone) ?? mapped[0];
    return {
      status: 'none',
      key: latest?.key ?? null,
      billing_status: (latest?.status as PlanStatus['billing_status']) ?? 'none',
      current_period_end: latest?.ends_at ?? null,
      entitlements: mapped.map(({ key, ends_at, status }) => ({ key, ends_at, status })),
    };
  }

  const preferred =
    ['lifetime', 'yearly', 'monthly'].find((k) => withAccess.some((e) => e.key === k)) ?? withAccess[0]!.key;
  const primary = withAccess.find((e) => e.key === preferred) ?? withAccess[0]!;
  return {
    status: 'active',
    key: preferred,
    billing_status: (primary.status as PlanStatus['billing_status']) || 'active',
    current_period_end: primary.ends_at,
    entitlements: mapped.map(({ key, ends_at, status }) => ({ key, ends_at, status })),
  };
}

/** Compute funnel state from the database only. */
export async function buildWhoAmI(user: User): Promise<WhoAmI> {
  const profile = await ensureProfile(user);
  const hasPersonality = Boolean(await db.get('personality_profiles', (p) => p.user_id === user.id));
  const onboarding_completed = Boolean(profile.onboarding_completed) || hasPersonality;
  if (onboarding_completed && !profile.onboarding_completed) {
    await db.update('users', (u) => u.id === user.id, { onboarding_completed: true });
  }
  const plan = await resolvePlan(user.id);
  const free_generation_used = Boolean(profile.free_generation_used);
  const xAccount = await db.get(
    'social_accounts',
    (a) => a.user_id === user.id && a.platform === 'x' && a.status === 'connected',
  );
  const x_connected = Boolean(xAccount);

  let state: AppState = 'new';
  if (onboarding_completed && plan.status === 'active') state = 'paid';
  else if (onboarding_completed) state = 'onboarded';

  return {
    id: user.id,
    email: user.email!,
    name: (profile.name as string | null) ?? metaString(user, 'full_name', 'name'),
    avatar_url: (profile.avatar_url as string | null) ?? metaString(user, 'avatar_url', 'picture'),
    onboarding_completed,
    free_generation_used,
    plan,
    x_connected,
    state,
  };
}
