import { config } from '../config';
import { AppError } from '../errors';
import { billing, db, usage } from '../data';
import * as auth from './auth';
import type { PlanStatus } from './auth';

export type GateUser = {
  id: string;
  onboarding_completed?: boolean;
  free_generation_used?: boolean;
  daily_tweet_limit?: number;
};

/** Swappable for tests (avoid mutating ESM exports). */
export const planResolver = {
  resolve: (userId: string): Promise<PlanStatus> => auth.resolvePlan(userId),
};

export function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function loadGateUser(userId: string): Promise<GateUser> {
  const user = await db.get('users', (u) => u.id === userId);
  if (!user) {
    throw new AppError(401, 'unknown_user', 'No profile for this account yet.', 'Call GET /api/me after sign-in.');
  }
  return user as GateUser;
}

/** True when the user has an active paid entitlement. */
export async function isPaid(userId: string, plan?: PlanStatus): Promise<boolean> {
  const resolved = plan ?? (await planResolver.resolve(userId));
  return resolved.status === 'active';
}

export async function assertOnboarded(userId: string, user?: GateUser): Promise<GateUser> {
  const u = user ?? (await loadGateUser(userId));
  if (!u.onboarding_completed) {
    throw new AppError(
      403,
      'onboarding_required',
      'Finish onboarding before using this feature.',
      'Complete the onboarding screens, then try again.',
    );
  }
  return u;
}

export async function assertPaid(userId: string, action = 'this action'): Promise<PlanStatus> {
  const plan = await planResolver.resolve(userId);
  if (plan.status !== 'active') {
    throw new AppError(
      402,
      'paywall',
      `Subscribe to unlock ${action}.`,
      'Your free batch is available for viewing and editing; generating more, scheduling, and posting require a plan.',
    );
  }
  return plan;
}

/** Swappable for tests. */
export const xConnectionResolver = {
  isConnected: async (userId: string): Promise<boolean> => {
    const account = await db.get(
      'social_accounts',
      (a) => a.user_id === userId && a.platform === 'x' && a.status === 'connected',
    );
    return Boolean(account);
  },
};

export async function assertXConnected(userId: string): Promise<void> {
  if (await xConnectionResolver.isConnected(userId)) return;
  throw new AppError(
    403,
    'x_required',
    'Connect your X account to schedule or post.',
    'Open Connect X (one more step after checkout) or Settings → Your user.',
  );
}

/** Scheduling / posting: active paid entitlement AND a connected X account. */
export async function assertPaidAndXConnected(userId: string, action = 'this action'): Promise<PlanStatus> {
  const plan = await assertPaid(userId, action);
  await assertXConnected(userId);
  return plan;
}

/** Paid daily draft quota (generation). Free users are handled separately. */
export async function assertPaidDraftQuota(userId: string, draftsToAdd: number): Promise<void> {
  const day = utcToday();
  const row = await usage.getDailyUsage(userId, day);
  const used = Number(row?.drafts_generated ?? 0);
  const cap = config.limits.paidDraftsPerDay;
  if (used + draftsToAdd > cap) {
    throw new AppError(
      429,
      'daily_draft_limit',
      `Daily draft limit reached (${cap} per day).`,
      'Try again tomorrow, or lower the batch size.',
    );
  }
}

export async function assertPaidPostQuota(userId: string): Promise<void> {
  const day = utcToday();
  const row = await usage.getDailyUsage(userId, day);
  const used = Number(row?.drafts_posted ?? 0);
  const cap = config.limits.paidPostsPerDay;
  if (used >= cap) {
    throw new AppError(
      429,
      'daily_post_limit',
      `Daily post/schedule limit reached (${cap} per day).`,
      'Try again tomorrow.',
    );
  }
}

export type FreeGenDecision =
  | { mode: 'paid' }
  | { mode: 'free' }
  | { mode: 'blocked'; code: 'paywall' | 'free_paused' | 'free_disabled'; message: string };

/**
 * Decide whether this user may run a generate call.
 * Does not mutate state — call save_free_generation_batch after drafts are ready.
 */
export async function decideGenerationAccess(userId: string): Promise<FreeGenDecision> {
  const user = await assertOnboarded(userId);
  if (await isPaid(userId)) return { mode: 'paid' };

  if (config.limits.freeBatchesPerUser <= 0) {
    return {
      mode: 'blocked',
      code: 'free_disabled',
      message: 'Free drafts are not available. Subscribe to generate.',
    };
  }

  if (user.free_generation_used) {
    return {
      mode: 'blocked',
      code: 'paywall',
      message: 'Subscribe to unlock more drafts.',
    };
  }

  const { getGlobalFreeCount } = await import('../data/freeGeneration');
  const globalCount = await getGlobalFreeCount(utcToday());
  if (globalCount >= config.limits.freeGenerationsGlobalPerDay) {
    console.error(
      `[ALERT] Free draft circuit breaker hit: ${globalCount}/${config.limits.freeGenerationsGlobalPerDay} free generations on ${utcToday()} UTC. user=${userId}`,
    );
    return {
      mode: 'blocked',
      code: 'free_paused',
      message: 'Free drafts are paused for today, subscribe to continue',
    };
  }

  return { mode: 'free' };
}

export function throwBlocked(decision: Extract<FreeGenDecision, { mode: 'blocked' }>): never {
  if (decision.code === 'free_paused') {
    throw new AppError(503, 'free_paused', decision.message, 'Subscribe for unlimited generation, or try again tomorrow.');
  }
  if (decision.code === 'free_disabled') {
    throw new AppError(402, 'paywall', decision.message);
  }
  throw new AppError(402, 'paywall', decision.message, 'You can still view, edit, and copy your free drafts.');
}

/** In-memory single-flight lock so a double-click cannot run two LLM batches. */
const generationLocks = new Map<string, Promise<unknown>>();

export async function withGenerationLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (generationLocks.has(userId)) {
    throw new AppError(409, 'generation_in_progress', 'A generation is already running for this account.', 'Wait for it to finish, then retry if needed.');
  }
  const work = fn().finally(() => {
    generationLocks.delete(userId);
  });
  generationLocks.set(userId, work);
  return work;
}

/** Test helper: clear locks between cases. */
export function clearGenerationLocks(): void {
  generationLocks.clear();
}

/** Exported for tests that stub billing without hitting the network. */
export async function listActiveEntitlementKeys(userId: string): Promise<string[]> {
  const rows = await billing.listEntitlements(userId);
  return rows.filter((r) => r.active).map((r) => String(r.entitlement_key));
}
