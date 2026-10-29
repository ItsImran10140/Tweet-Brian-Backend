import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { billing } from '../data';
import { AppError } from '../errors';
import { resolvePlan } from '../lib/auth';
import { getPolar, productIdForPlan, type PolarPlan } from '../lib/polar';
import { grantEntitlementFromSucceededCheckout } from '../lib/polarWebhooks';
import { parse, requireUser, uid, wrap, type AuthedRequest } from './util';

export const billingRoutes = Router();
billingRoutes.use(requireUser);

const CheckoutBody = z.object({
  plan: z.enum(['lifetime', 'monthly', 'yearly']),
});

const ConfirmBody = z.object({
  checkout_id: z.string().min(1),
});

/**
 * POST /api/billing/checkout
 * Creates a Polar checkout for the signed-in user (external_customer_id = user id).
 */
billingRoutes.post(
  '/checkout',
  wrap(async (req, res) => {
    const { plan } = parse(CheckoutBody, req.body) as { plan: PolarPlan };
    const userId = uid(req);
    const email = (req as AuthedRequest).userEmail;

    let productId: string;
    if (plan === 'lifetime') {
      const seats = await billing.lifetimeSeatsRemaining();
      if (seats.sold_out) {
        throw new AppError(
          409,
          'lifetime_sold_out',
          'Founding lifetime seats are sold out. Choose monthly instead.',
          'Start a monthly plan from the paywall.',
        );
      }
      productId = productIdForPlan('lifetime', seats.seats_sold);
    } else {
      productId = productIdForPlan(plan, 0);
    }

    const polar = getPolar();
    const successUrl = config.polar.successUrl.includes('{CHECKOUT_ID}')
      ? config.polar.successUrl
      : `${config.polar.successUrl}${config.polar.successUrl.includes('?') ? '&' : '?'}checkout_id={CHECKOUT_ID}`;

    const checkout = await polar.checkouts.create({
      products: [productId],
      external_customer_id: userId,
      customer_email: email,
      success_url: successUrl,
      metadata: { plan, user_id: userId },
    });

    const url = checkout.url;
    if (!url) {
      throw new AppError(502, 'polar_checkout_failed', 'Polar did not return a checkout URL.');
    }

    res.json({
      url,
      checkout_id: checkout.id,
      plan,
      product_id: productId,
    });
  }),
);

/**
 * GET /api/billing/status
 * Plan + billing status for the signed-in user (used by /welcome polling).
 */
billingRoutes.get(
  '/status',
  wrap(async (req, res) => {
    const plan = await resolvePlan(uid(req));
    res.json({
      plan: plan.key,
      status: plan.billing_status,
      access: plan.status === 'active',
      current_period_end: plan.current_period_end,
      entitlements: plan.entitlements,
    });
  }),
);

/**
 * POST /api/billing/confirm
 * Verify a Polar checkout by id and grant access when status is succeeded.
 * Needed for local sandbox (Polar cannot POST webhooks to localhost) and webhook lag.
 */
billingRoutes.post(
  '/confirm',
  wrap(async (req, res) => {
    const { checkout_id } = parse(ConfirmBody, req.body) as { checkout_id: string };
    const userId = uid(req);
    const polar = getPolar();

    let checkout: Awaited<ReturnType<typeof polar.checkouts.get>>;
    try {
      checkout = await polar.checkouts.get(checkout_id);
    } catch {
      throw new AppError(404, 'checkout_not_found', 'Checkout not found in Polar.', 'Retry from the success page or contact support.');
    }

    const externalId =
      (typeof checkout.external_customer_id === 'string' && checkout.external_customer_id) ||
      (typeof checkout.metadata?.user_id === 'string' && checkout.metadata.user_id) ||
      null;
    if (!externalId || externalId !== userId) {
      throw new AppError(403, 'checkout_user_mismatch', 'This checkout does not belong to your account.');
    }

    if (checkout.status === 'succeeded') {
      await grantEntitlementFromSucceededCheckout(userId, checkout);
    }

    const plan = await resolvePlan(userId);
    res.json({
      checkout_id: checkout.id,
      checkout_status: checkout.status,
      plan: plan.key,
      status: plan.billing_status,
      access: plan.status === 'active',
      current_period_end: plan.current_period_end,
      entitlements: plan.entitlements,
    });
  }),
);

/**
 * GET /api/billing/portal
 * Pre-authenticated Polar customer portal link (short-lived).
 */
billingRoutes.get(
  '/portal',
  wrap(async (req, res) => {
    const userId = uid(req);
    const polar = getPolar();
    const session = await polar.customerSessions.create({
      external_customer_id: userId,
    });
    const url = session.customer_portal_url;
    if (!url) {
      throw new AppError(502, 'polar_portal_failed', 'Polar did not return a customer portal URL.');
    }
    res.json({ url });
  }),
);

/** Public handler (mounted before requireAuth). Cached lifetime seat inventory. */
export async function lifetimeSeatsHandler(_req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  try {
    const seats = await billing.lifetimeSeatsRemaining();
    res.setHeader('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    res.json(seats);
  } catch (e) {
    next(e);
  }
}
