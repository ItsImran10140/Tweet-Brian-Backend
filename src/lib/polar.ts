import { createPolar } from '@polar-sh/sdk/2026-10';
import { config } from '../config';
import { AppError } from '../errors';

export type PolarPlan = 'lifetime' | 'monthly' | 'yearly';

let client: ReturnType<typeof createPolar> | null = null;

/** Polar SDK client. Sandbox vs production is controlled only by POLAR_ENVIRONMENT. */
export function getPolar() {
  if (client) return client;
  const { accessToken, environment } = config.polar;
  if (!accessToken) {
    throw new AppError(
      503,
      'polar_not_configured',
      'Payments are not configured yet.',
      'Set POLAR_ACCESS_TOKEN (and product ids) in the server environment.',
    );
  }
  client = createPolar({
    accessToken,
    environment: environment === 'sandbox' ? 'sandbox' : 'production',
  });
  return client;
}

/** Reset between tests. */
export function resetPolarClient(): void {
  client = null;
}

export function productIdForPlan(plan: PolarPlan, lifetimePaidCount: number): string {
  const p = config.polar.products;
  if (plan === 'monthly') {
    if (!p.monthly) throw missingProduct('monthly');
    return p.monthly;
  }
  if (plan === 'yearly') {
    if (!p.yearly) throw missingProduct('yearly');
    return p.yearly;
  }
  // lifetime tiers: first 10 → $19, next 10 → $29
  if (lifetimePaidCount < 10) {
    if (!p.lifetime19) throw missingProduct('lifetime ($19)');
    return p.lifetime19;
  }
  if (lifetimePaidCount < 20) {
    if (!p.lifetime29) throw missingProduct('lifetime ($29)');
    return p.lifetime29;
  }
  throw new AppError(
    409,
    'lifetime_sold_out',
    'Founding lifetime seats are sold out. Choose monthly instead.',
    'Start a monthly plan from the paywall.',
  );
}

export function planFromProductId(productId: string | null | undefined): PolarPlan | null {
  if (!productId) return null;
  const p = config.polar.products;
  if (productId === p.lifetime19 || productId === p.lifetime29) return 'lifetime';
  if (productId === p.monthly) return 'monthly';
  if (productId === p.yearly) return 'yearly';
  return null;
}

export function isLifetimeProductId(productId: string | null | undefined): boolean {
  if (!productId) return false;
  const p = config.polar.products;
  return productId === p.lifetime19 || productId === p.lifetime29;
}

function missingProduct(label: string): AppError {
  return new AppError(
    503,
    'polar_product_missing',
    `Polar product id for ${label} is not configured.`,
    'Set the matching POLAR_PRODUCT_* env var.',
  );
}
