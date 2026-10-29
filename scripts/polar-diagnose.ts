/**
 * One-command Polar config check (never prints secrets).
 *
 *   npm run polar:diagnose
 *
 * Confirms: active environment, access token can list products (products:read),
 * all four configured product IDs exist in that environment, webhook secret is set.
 */
import { config } from '../src/config';
import { POLAR_PRODUCT_SLOTS, polarWebhookSecretConfigured } from '../src/config/polar';
import { getPolar, resetPolarClient } from '../src/lib/polar';

type ProductRow = { id: string; name?: string | null };

function fail(message: string): never {
  console.error(`\nFAIL  ${message}`);
  process.exit(1);
}

function ok(message: string): void {
  console.log(`  OK    ${message}`);
}

async function listAllProducts(): Promise<ProductRow[]> {
  const polar = getPolar();
  const items: ProductRow[] = [];
  let page = 1;
  for (;;) {
    const res = await polar.products.list({ page, limit: 100 });
    const batch = (res.items ?? []) as ProductRow[];
    items.push(...batch);
    const maxPage = res.pagination?.max_page ?? page;
    if (page >= maxPage) break;
    page += 1;
  }
  return items;
}

async function main(): Promise<void> {
  resetPolarClient();
  const polarCfg = config.polar;
  const env = polarCfg.environment;

  console.log('Polar diagnose');
  console.log('--------------');
  console.log(`  Environment : ${env}`);
  console.log(
    `  API host    : ${env === 'sandbox' ? 'sandbox-api.polar.sh (via SDK environment=sandbox)' : 'api.polar.sh (production)'}`,
  );
  console.log(`  Access token: ${polarCfg.accessToken ? 'set (value hidden)' : 'MISSING'}`);
  console.log(`  Webhook secret: ${polarWebhookSecretConfigured(polarCfg) ? 'set (value hidden)' : 'MISSING'}`);
  console.log(`  Success URL : ${polarCfg.successUrl ? 'set' : 'MISSING'}`);
  console.log('');

  if (env !== 'sandbox' && env !== 'production') {
    fail(`POLAR_ENVIRONMENT must be "sandbox" or "production" (got ${JSON.stringify(env)}).`);
  }
  ok(`POLAR_ENVIRONMENT=${env}`);

  if (!polarCfg.accessToken) {
    fail('POLAR_ACCESS_TOKEN is missing. Create an Organization Access Token in the same environment (sandbox.polar.sh or polar.sh → Settings → Developers).');
  }
  ok('POLAR_ACCESS_TOKEN is set');

  if (!polarWebhookSecretConfigured(polarCfg)) {
    fail('POLAR_WEBHOOK_SECRET is missing. Add a webhook endpoint in Polar and copy the signing secret (whsec_…).');
  }
  ok('POLAR_WEBHOOK_SECRET is set');

  if (!polarCfg.successUrl || !polarCfg.successUrl.includes('{CHECKOUT_ID}')) {
    fail('POLAR_SUCCESS_URL must be set and include {CHECKOUT_ID} (Polar substitutes the checkout session id).');
  }
  ok('POLAR_SUCCESS_URL includes {CHECKOUT_ID}');

  let products: ProductRow[];
  try {
    products = await listAllProducts();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(
      `Token could not list products against ${env}. Check POLAR_ENVIRONMENT matches the token (sandbox tokens cannot hit production), and the OAT has products:read (or products:write). Detail: ${msg}`,
    );
  }

  console.log(`  Listed ${products.length} product(s) from Polar (${env}).`);
  ok('Access token works (products.list)');

  const byId = new Map(products.map((p) => [p.id, p]));
  const missingConfigured: string[] = [];
  const unsetSlots: string[] = [];

  for (const slot of POLAR_PRODUCT_SLOTS) {
    const id = polarCfg.products[slot.key];
    if (!id) {
      unsetSlots.push(`${slot.env} (${slot.label})`);
      continue;
    }
    const found = byId.get(id);
    if (!found) {
      missingConfigured.push(`${slot.env}=${id} (${slot.label}) — not in ${env} product list`);
      continue;
    }
    ok(`${slot.env} → ${id}${found.name ? ` (${found.name})` : ''}`);
  }

  if (unsetSlots.length) {
    fail(`Missing product id env vars:\n  - ${unsetSlots.join('\n  - ')}`);
  }
  if (missingConfigured.length) {
    fail(
      `Configured product IDs were not found in the ${env} catalog (wrong id or wrong environment):\n  - ${missingConfigured.join('\n  - ')}`,
    );
  }

  console.log('\nPASS  Polar config looks good for this environment.');
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
