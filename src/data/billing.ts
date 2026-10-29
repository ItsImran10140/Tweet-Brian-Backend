import { getSupabase } from './client';
import type { Row } from './db';
import { isLifetimeProductId } from '../lib/polar';
import { config } from '../config';

function throwSb(error: { message: string } | null, action: string): never {
  throw new Error(`Supabase ${action} failed: ${error?.message ?? 'unknown'}`);
}

export type EntitlementStatus = 'none' | 'active' | 'canceled' | 'past_due' | 'refunded' | 'revoked';

export type EntitlementRow = {
  id?: string;
  user_id: string;
  entitlement_key: string;
  active: boolean;
  status: EntitlementStatus;
  source_purchase_id?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordPurchase(row: Row): Promise<Row> {
  const { data, error } = await getSupabase().from('purchases').insert(row).select('*').single();
  if (error) throwSb(error, 'insert purchases');
  return data as Row;
}

export async function upsertEntitlement(row: EntitlementRow | Row): Promise<Row> {
  const payload = {
    ...row,
    active: row.active ?? false,
    status: (row as EntitlementRow).status ?? (row.active ? 'active' : 'none'),
    metadata: row.metadata ?? {},
  };
  const { data, error } = await getSupabase()
    .from('entitlements')
    .upsert(payload, { onConflict: 'user_id,entitlement_key' })
    .select('*')
    .single();
  if (error) throwSb(error, 'upsert entitlements');
  return data as Row;
}

/** All entitlements for a user (including inactive / refunded). */
export async function listEntitlements(userId: string): Promise<Row[]> {
  const { data, error } = await getSupabase().from('entitlements').select('*').eq('user_id', userId);
  if (error) throwSb(error, 'list entitlements');
  return data ?? [];
}

/** Returns true if this webhook event id was newly recorded (not a duplicate). */
export async function claimWebhookEvent(eventId: string, provider?: string, payload?: unknown): Promise<boolean> {
  const { error } = await getSupabase()
    .from('processed_webhook_events')
    .insert({ event_id: eventId, provider: provider ?? null, payload: payload ?? null });
  if (error) {
    if (error.code === '23505') return false; // unique violation
    throwSb(error, 'insert processed_webhook_events');
  }
  return true;
}

const LIFETIME_CAP = 20;

/**
 * Count completed lifetime purchases. DB is source of truth for seat inventory.
 * Counts any purchase whose product_id matches configured lifetime products,
 * or metadata.plan === 'lifetime'.
 */
export async function countLifetimePurchases(): Promise<number> {
  const lifetimeIds = [config.polar.products.lifetime19, config.polar.products.lifetime29].filter(Boolean) as string[];

  const { data, error } = await getSupabase()
    .from('purchases')
    .select('id, product_id, status, metadata')
    .in('status', ['completed', 'paid']);
  if (error) throwSb(error, 'count lifetime purchases');

  let count = 0;
  for (const row of data ?? []) {
    const productId = row.product_id ? String(row.product_id) : null;
    const metaPlan = (row.metadata as { plan?: string } | null)?.plan;
    if (metaPlan === 'lifetime' || (productId && (lifetimeIds.includes(productId) || isLifetimeProductId(productId)))) {
      count += 1;
    }
  }
  return count;
}

export async function lifetimeSeatsRemaining(): Promise<{
  seats_remaining: number;
  seats_total: number;
  seats_sold: number;
  sold_out: boolean;
  next_price_cents: number | null;
}> {
  const sold = await countLifetimePurchases();
  const remaining = Math.max(0, LIFETIME_CAP - sold);
  let next_price_cents: number | null = null;
  if (sold < 10) next_price_cents = 1900;
  else if (sold < 20) next_price_cents = 2900;
  return {
    seats_remaining: remaining,
    seats_total: LIFETIME_CAP,
    seats_sold: sold,
    sold_out: remaining === 0,
    next_price_cents,
  };
}

export { LIFETIME_CAP };

export async function findUserIdByEmail(email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  const { data, error } = await getSupabase().from('profiles').select('id').ilike('email', normalized).limit(1).maybeSingle();
  if (error) throwSb(error, 'find user by email');
  return data?.id ? String(data.id) : null;
}

/**
 * Whether this entitlement currently grants paid access.
 * Lifetime / active pass; canceled only until period end; refunded / past_due / revoked lock.
 */
export function entitlementGrantsAccess(row: {
  active?: boolean;
  status?: string | null;
  ends_at?: string | null;
  entitlement_key?: string;
}): boolean {
  const status = String(row.status ?? (row.active ? 'active' : 'none'));
  if (status === 'refunded' || status === 'past_due' || status === 'revoked' || status === 'none') {
    return false;
  }
  if (status === 'canceled') {
    if (!row.ends_at) return false;
    return new Date(row.ends_at).getTime() > Date.now();
  }
  if (status === 'active' || row.active) {
    if (!row.ends_at) return true; // lifetime
    return new Date(row.ends_at).getTime() > Date.now();
  }
  return false;
}
