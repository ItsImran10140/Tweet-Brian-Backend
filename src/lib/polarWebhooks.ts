import { billing, db } from '../data';
import type { EntitlementStatus } from '../data/billing';
import { isLifetimeProductId, planFromProductId, type PolarPlan } from './polar';

type AnyRecord = Record<string, unknown>;

/** Swappable for tests (avoid mutating ESM namespace exports). */
export const polarWebhookDeps = {
  listEntitlements: (userId: string) => billing.listEntitlements(userId),
  upsertEntitlement: (row: Parameters<typeof billing.upsertEntitlement>[0]) => billing.upsertEntitlement(row),
  recordPurchase: (row: Parameters<typeof billing.recordPurchase>[0]) => billing.recordPurchase(row),
  findUserIdByEmail: (email: string) => billing.findUserIdByEmail(email),
  getUser: async (pred: (u: AnyRecord) => boolean) => {
    const row = await db.get('users', (u) => pred(u as AnyRecord));
    return row as AnyRecord | undefined;
  },
};

function asRecord(v: unknown): AnyRecord | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as AnyRecord) : null;
}

function nestedCustomer(data: AnyRecord): AnyRecord | null {
  return asRecord(data.customer) ?? asRecord(asRecord(data.order)?.customer) ?? null;
}

/** Prefer Polar external_customer_id / customer.external_id, then email. */
export async function resolveUserIdFromPolarPayload(data: AnyRecord): Promise<string | null> {
  const customer = nestedCustomer(data);
  const externalId =
    (typeof data.external_customer_id === 'string' && data.external_customer_id) ||
    (typeof customer?.external_id === 'string' && customer.external_id) ||
    null;
  if (externalId) {
    const user = await polarWebhookDeps.getUser((u) => u.id === externalId);
    if (user) return String(user.id);
  }

  const email =
    (typeof data.customer_email === 'string' && data.customer_email) ||
    (typeof customer?.email === 'string' && customer.email) ||
    null;
  if (email) {
    return polarWebhookDeps.findUserIdByEmail(email);
  }
  return null;
}

function productIdFromPayload(data: AnyRecord): string | null {
  if (typeof data.product_id === 'string') return data.product_id;
  const product = asRecord(data.product);
  if (typeof product?.id === 'string') return product.id;
  const items = data.items;
  if (Array.isArray(items) && items[0]) {
    const item = asRecord(items[0]);
    const p = asRecord(item?.product);
    if (typeof p?.id === 'string') return p.id;
    if (typeof item?.product_id === 'string') return item.product_id;
  }
  return null;
}

function periodEndFromPayload(data: AnyRecord): string | null {
  const end = data.current_period_end;
  if (typeof end === 'string') return end;
  if (typeof end === 'number') return new Date(end * (end < 1e12 ? 1000 : 1)).toISOString();
  return null;
}

function subscriptionStatusToEntitlement(status: string | undefined): EntitlementStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    case 'revoked':
    case 'incomplete_expired':
      return 'revoked';
    default:
      return (status as EntitlementStatus) || 'active';
  }
}

async function upsertPlanEntitlement(opts: {
  userId: string;
  plan: PolarPlan;
  status: EntitlementStatus;
  endsAt: string | null;
  metadata?: Record<string, unknown>;
  purchaseId?: string | null;
}) {
  const grants =
    opts.status === 'active' ||
    (opts.status === 'canceled' && opts.endsAt && new Date(opts.endsAt).getTime() > Date.now());
  await polarWebhookDeps.upsertEntitlement({
    user_id: opts.userId,
    entitlement_key: opts.plan,
    active: Boolean(grants),
    status: opts.status,
    ends_at: opts.endsAt,
    source_purchase_id: opts.purchaseId ?? null,
    metadata: opts.metadata ?? {},
  });
}

async function handleOrderPaid(data: AnyRecord): Promise<void> {
  const userId = await resolveUserIdFromPolarPayload(data);
  if (!userId) return;

  const productId = productIdFromPayload(data);
  const plan = planFromProductId(productId) ?? (isLifetimeProductId(productId) ? 'lifetime' : null);
  if (!plan) return;

  const orderId = typeof data.id === 'string' ? data.id : undefined;
  const amount = typeof data.total_amount === 'number' ? data.total_amount : undefined;
  const currency = typeof data.currency === 'string' ? data.currency : 'usd';

  let purchaseId: string | null = null;
  try {
    const purchase = await polarWebhookDeps.recordPurchase({
      user_id: userId,
      provider: 'polar',
      provider_payment_id: orderId ?? null,
      product_id: productId,
      amount_cents: amount ?? null,
      currency,
      status: 'paid',
      metadata: { plan, raw_type: 'order.paid' },
    });
    purchaseId = String(purchase.id);
  } catch (err) {
    // Unique provider_payment_id collisions → treat as already recorded
    console.warn('[polar] recordPurchase order.paid:', err instanceof Error ? err.message : err);
  }

  await upsertPlanEntitlement({
    userId,
    plan,
    status: 'active',
    endsAt: plan === 'lifetime' ? null : periodEndFromPayload(data),
    purchaseId,
    metadata: { polar_order_id: orderId, product_id: productId },
  });
}

async function handleSubscriptionEvent(type: string, data: AnyRecord): Promise<void> {
  const userId = await resolveUserIdFromPolarPayload(data);
  if (!userId) return;

  const productId = productIdFromPayload(data);
  const plan = planFromProductId(productId) ?? 'monthly';
  const polarStatus = typeof data.status === 'string' ? data.status : undefined;
  const endsAt = periodEndFromPayload(data);

  let status: EntitlementStatus;
  if (type === 'subscription.past_due') status = 'past_due';
  else if (type === 'subscription.revoked') status = 'revoked';
  else if (type === 'subscription.canceled') status = 'canceled';
  else if (type === 'subscription.active' || type === 'subscription.created') status = 'active';
  else status = subscriptionStatusToEntitlement(polarStatus);

  // End-of-period cancel: Polar still reports active + cancel_at_period_end
  if (data.cancel_at_period_end === true && status === 'active') {
    status = 'canceled';
  }

  await upsertPlanEntitlement({
    userId,
    plan,
    status,
    endsAt: plan === 'lifetime' ? null : endsAt,
    metadata: {
      polar_subscription_id: typeof data.id === 'string' ? data.id : null,
      polar_status: polarStatus,
      cancel_at_period_end: data.cancel_at_period_end === true,
      event: type,
      product_id: productId,
    },
  });
}

async function handleRefund(data: AnyRecord): Promise<void> {
  const userId = await resolveUserIdFromPolarPayload(data);
  if (!userId) {
    // Try order nested under refund
    const order = asRecord(data.order);
    if (order) {
      const fromOrder = await resolveUserIdFromPolarPayload(order);
      if (fromOrder) return revokeForRefund(fromOrder, data, order);
    }
    return;
  }
  await revokeForRefund(userId, data, data);
}

async function revokeForRefund(userId: string, refund: AnyRecord, orderLike: AnyRecord): Promise<void> {
  const productId = productIdFromPayload(orderLike) ?? productIdFromPayload(refund);
  const plan = planFromProductId(productId);
  const rows = await polarWebhookDeps.listEntitlements(userId);
  const targets = plan ? rows.filter((r) => r.entitlement_key === plan) : rows;

  for (const row of targets) {
    await polarWebhookDeps.upsertEntitlement({
      user_id: userId,
      entitlement_key: String(row.entitlement_key),
      active: false,
      status: 'refunded',
      ends_at: row.ends_at ? String(row.ends_at) : null,
      metadata: {
        ...((row.metadata as Record<string, unknown>) ?? {}),
        refunded: true,
        polar_refund_id: typeof refund.id === 'string' ? refund.id : null,
      },
    });
  }
}

/**
 * Apply a validated Polar webhook event to entitlements / purchases.
 * Event type names match docs.polar.sh (order.paid, subscription.*, order.refunded, refund.created).
 */
export async function applyPolarEvent(type: string, data: unknown): Promise<void> {
  const payload = asRecord(data) ?? {};
  switch (type) {
    case 'order.paid':
      await handleOrderPaid(payload);
      return;
    case 'subscription.created':
    case 'subscription.active':
    case 'subscription.updated':
    case 'subscription.canceled':
    case 'subscription.revoked':
    case 'subscription.past_due':
      await handleSubscriptionEvent(type, payload);
      return;
    case 'order.refunded':
    case 'refund.created':
      await handleRefund(payload);
      return;
    default:
      // Unknown / unhandled — caller already acknowledged
      return;
  }
}

export type SucceededCheckout = {
  id: string;
  status: string;
  external_customer_id?: string | null;
  customer_email?: string | null;
  product_id?: string | null;
  product?: { id?: string | null } | null;
  metadata?: Record<string, unknown> | null;
  total_amount?: number | null;
  currency?: string | null;
  subscription_id?: string | null;
};

/**
 * Grant access from a Polar checkout that already reports `status === "succeeded"`.
 * Used when webhooks cannot reach the server (local sandbox) or lag behind redirect.
 * Entitlement only — purchases stay webhook-driven so lifetime seat counts stay accurate.
 */
export async function grantEntitlementFromSucceededCheckout(
  userId: string,
  checkout: SucceededCheckout,
): Promise<{ plan: PolarPlan; granted: boolean }> {
  if (checkout.status !== 'succeeded') {
    return { plan: 'lifetime', granted: false };
  }

  const meta = asRecord(checkout.metadata) ?? {};
  const productId =
    (typeof checkout.product_id === 'string' && checkout.product_id) ||
    (typeof checkout.product?.id === 'string' && checkout.product.id) ||
    null;
  const metaPlan = typeof meta.plan === 'string' ? meta.plan : null;
  const plan: PolarPlan | null =
    planFromProductId(productId) ??
    (metaPlan === 'lifetime' || metaPlan === 'monthly' || metaPlan === 'yearly' ? metaPlan : null) ??
    (isLifetimeProductId(productId) ? 'lifetime' : null);

  if (!plan) {
    return { plan: 'lifetime', granted: false };
  }

  await upsertPlanEntitlement({
    userId,
    plan,
    status: 'active',
    endsAt: null,
    metadata: {
      polar_checkout_id: checkout.id,
      product_id: productId,
      polar_subscription_id: checkout.subscription_id ?? null,
      source: 'checkout_confirm',
    },
  });

  return { plan, granted: true };
}
