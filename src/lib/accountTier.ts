export type AccountTier = 'free' | 'premium';
export type TierSource = 'api' | 'fallback' | 'manual';

export const FREE_CHAR_LIMIT = 280;
export const PREMIUM_CHAR_LIMIT = 25_000;

/** Map X API subscription_type to a single Free/Premium tier. */
export function tierFromSubscriptionType(subscriptionType: unknown): AccountTier {
  if (typeof subscriptionType !== 'string') return 'free';
  const value = subscriptionType.trim().toLowerCase();
  if (!value || value === 'none') return 'free';
  return 'premium';
}

export function charLimitForTier(tier: AccountTier | string | undefined | null): number {
  return tier === 'premium' ? PREMIUM_CHAR_LIMIT : FREE_CHAR_LIMIT;
}

export function normalizeAccountTier(tier: unknown): AccountTier {
  return tier === 'premium' ? 'premium' : 'free';
}

export function normalizeTierSource(source: unknown): TierSource {
  if (source === 'api' || source === 'manual' || source === 'fallback') return source;
  return 'fallback';
}
