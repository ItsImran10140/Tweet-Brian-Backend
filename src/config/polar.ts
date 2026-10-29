import { z } from 'zod';

/**
 * Polar payments settings — driven only by environment variables.
 *
 * SDK server selection: pass `environment` to `createPolar` from
 * `@polar-sh/sdk/2026-10`. Docs: https://polar.sh/docs/integrate/sandbox
 * (`sandbox` → sandbox-api.polar.sh, otherwise production api.polar.sh).
 *
 * OAT scopes (dashboard → Settings → Developers): at minimum
 * `products:read`, `checkouts:write`, `customer_sessions:write`.
 * List Products also accepts `products:write`. See https://polar.sh/docs/integrate/oat
 *
 * Webhooks: verify with raw body + `webhooks.validateEvent` and
 * `POLAR_WEBHOOK_SECRET`. Docs: https://polar.sh/docs/integrate/webhooks/delivery
 */
export const POLAR_ENV_VARS = [
  'POLAR_ENVIRONMENT',
  'POLAR_ACCESS_TOKEN',
  'POLAR_WEBHOOK_SECRET',
  'POLAR_PRODUCT_LIFETIME_19',
  'POLAR_PRODUCT_LIFETIME_29',
  'POLAR_PRODUCT_MONTHLY',
  'POLAR_PRODUCT_YEARLY',
  'POLAR_SUCCESS_URL',
] as const;

export type PolarEnvironment = 'sandbox' | 'production';

const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v;

const optionalTrimmed = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim() : v),
  z.string().optional(),
);

export const polarConfigSchema = z.object({
  accessToken: optionalTrimmed,
  webhookSecret: optionalTrimmed,
  /** sandbox | production — only this field selects the Polar API host. */
  environment: z.enum(['sandbox', 'production']).default('sandbox'),
  /** Public app URL for checkout success redirects (must include `{CHECKOUT_ID}`). */
  successUrl: z.string().default('https://app.tweet-brain.com/welcome?checkout_id={CHECKOUT_ID}'),
  products: z.object({
    /** Founding lifetime ($19) product id */
    lifetime19: optionalTrimmed,
    /** Early lifetime ($29) product id */
    lifetime29: optionalTrimmed,
    monthly: optionalTrimmed,
    yearly: optionalTrimmed,
  }),
});

export type PolarConfig = z.infer<typeof polarConfigSchema>;

/** Build the polar config object from env / yaml helper (`val`) used by `src/config.ts`. */
export function readPolarConfigInput(val: (env: string | undefined, yml: string) => unknown) {
  return {
    accessToken: val('POLAR_ACCESS_TOKEN', 'polar.access_token'),
    webhookSecret: val('POLAR_WEBHOOK_SECRET', 'polar.webhook_secret'),
    environment: val('POLAR_ENVIRONMENT', 'polar.environment') ?? 'sandbox',
    successUrl:
      val('POLAR_SUCCESS_URL', 'polar.success_url') ??
      'https://app.tweet-brain.com/welcome?checkout_id={CHECKOUT_ID}',
    products: {
      lifetime19: val('POLAR_PRODUCT_LIFETIME_19', 'polar.products.lifetime_19'),
      lifetime29: val('POLAR_PRODUCT_LIFETIME_29', 'polar.products.lifetime_29'),
      monthly: val('POLAR_PRODUCT_MONTHLY', 'polar.products.monthly'),
      yearly: val('POLAR_PRODUCT_YEARLY', 'polar.products.yearly'),
    },
  };
}

/** Whether a webhook signing secret is present (never returns the secret). */
export function polarWebhookSecretConfigured(polar: PolarConfig): boolean {
  return Boolean(blank(polar.webhookSecret));
}

/** Labels for the four product env vars (for diagnostics). */
export const POLAR_PRODUCT_SLOTS = [
  { key: 'lifetime19' as const, env: 'POLAR_PRODUCT_LIFETIME_19', label: 'founding lifetime ($19)' },
  { key: 'lifetime29' as const, env: 'POLAR_PRODUCT_LIFETIME_29', label: 'early lifetime ($29)' },
  { key: 'monthly' as const, env: 'POLAR_PRODUCT_MONTHLY', label: 'monthly' },
  { key: 'yearly' as const, env: 'POLAR_PRODUCT_YEARLY', label: 'yearly' },
];
