import express from 'express';
import { CONFIG_PATH, ROOT, config } from './config';
import { getSupabase } from './data';
import { runGenerationCron, startCrons } from './cron';
import { AppError } from './errors';
import { brainStatus } from './lib/brain';
import { db } from './lib/db';
import { llmInfo, llmPing } from './lib/llm';
import { learnForAllUsers } from './lib/learnRules';
import { log } from './lib/safeLog';
import { parallelConfigured } from './digest/sources/parallel';
import { latestDigest, nicheNames, parallelUsage } from './digest/store';
import { alertsConfigured } from './digest/notify';
import { sourceConfigured } from './references/service';
import { requireAdmin } from './middleware/admin';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiUserRateLimit, globalIpRateLimit } from './middleware/rateLimit';
import { authX } from './routes/authX';
import { billingRoutes, lifetimeSeatsHandler } from './routes/billing';
import { adminDigest, digest } from './routes/digest';
import { experience } from './routes/experience';
import { me } from './routes/me';
import { onboarding } from './routes/onboarding';
import { profile } from './routes/profile';
import { publishing } from './routes/publishing';
import { references } from './routes/references';
import { tweets } from './routes/tweets';
import { users } from './routes/users';
import { polarWebhookHandler } from './routes/webhooksPolar';
import { requireAuth, requireUser, uid } from './routes/util';

function corsAllowedOrigins(): Set<string> {
  const origins = new Set<string>([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  try {
    origins.add(new URL(config.frontendUrl).origin);
  } catch {
    /* ignore invalid FRONTEND_URL */
  }
  return origins;
}

export function createApp() {
  const app = express();
  // So req.ip / rate limits work behind a single reverse proxy (Railway, Render, nginx).
  app.set('trust proxy', 1);

  const allowedOrigins = corsAllowedOrigins();
  app.use((req, res, next) => {
    const origin = req.header('origin');
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key, x-request-id');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  // Polar webhooks need the raw body for signature verification (docs.polar.sh).
  app.post('/webhooks/polar', express.raw({ type: 'application/json' }), polarWebhookHandler);

  app.use(express.json({ limit: '5mb' }));
  app.use(globalIpRateLimit(config.limits.ipPerMinute));

  // Public seat inventory (DB is source of truth). Cached briefly.
  app.get('/billing/lifetime-seats', lifetimeSeatsHandler);
  app.get('/api/billing/lifetime-seats', lifetimeSeatsHandler);

  app.get('/', (_req, res) => {
    res.json({
      name: 'tweet-brain',
      start_here: ['GET /health', 'GET /keepalive', 'GET /api/me', 'GET /api/onboarding/template'],
      docs: 'See README.md and postman/tweet-brain.postman_collection.json',
    });
  });

  app.get('/onboarding', (_req, res) => {
    res.sendFile('public/onboarding.html', { root: ROOT });
  });

  /** Lean probe for load balancers / uptime monitors. No secrets, no heavy work. */
  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'tweet-brain',
      ts: new Date().toISOString(),
    });
  });

  /**
   * Tiny DB read so an external cron can ping daily and keep a free Supabase project awake.
   * See supabase/README.md → "Keepalive (stop free-plan pause)".
   */
  app.get('/keepalive', async (_req, res, next) => {
    try {
      const started = Date.now();
      const { error } = await getSupabase().from('profiles').select('id').limit(1);
      if (error) throw new AppError(503, 'db_unavailable', 'Database keepalive read failed.', error.message);
      res.json({
        ok: true,
        db: 'ok',
        ms: Date.now() - started,
        ts: new Date().toISOString(),
      });
    } catch (e) {
      next(e);
    }
  });

  // Admin / ops routes: ADMIN_KEY only (no user JWT). Mounted before requireAuth.
  app.get('/api/admin/status', requireAdmin, async (_req, res, next) => {
    try {
      const llm = llmInfo();
      const latest: Record<string, string | null> = {};
      for (const n of nicheNames()) latest[n] = (await latestDigest(n)).digest_date;
      res.json({
        ok: true,
        config_file: CONFIG_PATH ?? 'none found (using defaults + env vars). Copy config.example.yml to config.yml',
        llm,
        brain: brainStatus(),
        twitter_sources: { x_api: sourceConfigured('x_api'), third_party: sourceConfigured('third_party'), manual: true },
        cron_enabled: config.cronEnabled,
        digest: {
          enabled: config.digest.enabled,
          niches: nicheNames(),
          latest,
          parallel: { configured: parallelConfigured(), ...(await parallelUsage()) },
          alerts_configured: alertsConfigured(),
          admin_key_required: true,
        },
      });
    } catch (e) {
      next(e);
    }
  });
  app.use('/api/admin/digest', adminDigest);
  app.get('/api/llm/test', requireAdmin, async (_req, res, next) => {
    try {
      res.json(await llmPing());
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/dev/run-generation-cron', requireAdmin, async (req, res, next) => {
    try {
      res.json(await runGenerationCron(new Date(), req.query.force === '1'));
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/dev/run-learning', requireAdmin, async (_req, res, next) => {
    try {
      res.json(await learnForAllUsers());
    } catch (e) {
      next(e);
    }
  });

  // Every user-facing /api request requires a valid Supabase access token.
  app.use('/api', requireAuth);
  app.use('/api', apiUserRateLimit(config.limits.apiPerMinute));

  app.use('/api/me', me);
  app.use('/api/billing', billingRoutes);
  app.use('/api/users', users);
  app.use('/api/onboarding', onboarding);
  app.use('/api/references', references);
  app.use('/api/digest', digest);
  app.use('/api/tweets', tweets);
  app.use('/api/publishing', publishing);
  app.use('/api/profile', profile);
  app.use('/api/experience', experience);
  app.use('/auth/x', authX);

  // Overview of everything for the calling user
  app.get('/api/overview', requireUser, async (req, res, next) => {
    try {
      const id = uid(req);
      const user = await db.get('users', (u) => u.id === id);
      if (!user) throw new AppError(401, 'unknown_user', 'No profile for this account yet.', 'Call GET /api/me after sign-in.');
      const mine = (t: Parameters<typeof db.all>[0]) => db.all(t, (r) => r.user_id === id);
      const onboarding = await mine('onboarding_drafts');
      const profiles = await mine('personality_profiles');
      const experience = await mine('experience_items');
      const refs = await mine('reference_accounts');
      const tweets = await mine('generated_tweets');
      const rules = await mine('learned_rules');
      const d = await latestDigest(user.niche ?? nicheNames()[0] ?? 'tech');
      res.json({
        user,
        onboarding_draft_exists: onboarding.length > 0,
        has_profile: profiles.length > 0,
        experience_items: experience.length,
        reference_accounts: refs.map((a) => ({ id: a.id, handle: a.handle, tweets: (a.tweets ?? []).length, has_style_profile: Boolean(a.style?.profile) })),
        niche: user.niche,
        digest: { date: d.digest_date, items: d.items.length },
        tweets: {
          pending: tweets.filter((t) => t.status === 'pending').length,
          liked: tweets.filter((t) => t.status === 'liked').length,
          discarded: tweets.filter((t) => t.status === 'discarded').length,
        },
        learned_rules: rules.filter((r) => !r.retired_at).length,
      });
    } catch (e) {
      next(e);
    }
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

if (require.main === module) {
  const hasGemini = Boolean(config.llm.gemini.apiKey);
  const hasOpenRouter = Boolean(config.llm.openrouter.apiKey);
  if (!hasGemini && !hasOpenRouter) {
    console.error('\nFATAL: Live web research needs an API key.');
    console.error('  Set llm.gemini.api_key (Google Search grounding) and/or llm.openrouter.api_key (web-search fallback) in config.yml.');
    console.error('  Refusing to start without a research-capable key.\n');
    process.exit(1);
  }
  if (!hasGemini) {
    console.warn('\nWARNING: llm.gemini.api_key is missing. Live research will use OpenRouter web search only.\n');
  }
  if (!config.adminKey) {
    log('warn', 'ADMIN_KEY unset — /api/admin/* and /api/dev/* are closed until you set it');
  }

  createApp().listen(config.port, () => {
    const llm = llmInfo();
    console.log(`\nTweet Brain running on http://localhost:${config.port}`);
    console.log(`  Config file : ${CONFIG_PATH ?? 'NOT FOUND (copy config.example.yml to config.yml)'}`);
    console.log(`  LLM         : ${llm.mode === 'mock' ? 'MOCK mode (fake answers)' : llm.order.map((o) => `${o.provider}:${o.model}`).join('  ->  ')}`);
    for (const n of llm.notes) console.log(`                ${n}`);
    console.log(`  Live search : gemini_grounding=${hasGemini ? 'on' : 'off'}  openrouter_web=${hasOpenRouter ? 'on' : 'off'}`);
    console.log(`  Digest      : niches=[${nicheNames().join(', ') || 'none'}]  parallel_search=${parallelConfigured() ? 'on' : 'off (no key: feeds only)'}  alerts=${alertsConfigured() ? 'on' : 'off'}`);
    console.log(`  Tweet APIs  : x_api=${sourceConfigured('x_api')}  twitterapi.io=${sourceConfigured('third_party')}  manual=always`);
    console.log(`  Supabase    : ${config.supabase.url ? 'configured' : 'MISSING SUPABASE_URL'}\n`);
    if (config.cronEnabled) startCrons();
  });
}
