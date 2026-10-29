import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { polarConfigSchema, readPolarConfigInput } from './config/polar';

/** Project root (the folder that holds package.json), independent of where you start the server from. */
export const ROOT = path.resolve(__dirname, '..');

// ---------- read config.yml (optional) ----------

const configPath = process.env.CONFIG_FILE
  ? path.resolve(process.env.CONFIG_FILE)
  : [path.join(ROOT, 'config.yml'), path.join(ROOT, 'config.yaml')].find((p) => fs.existsSync(p));

let raw: any = {};
if (configPath && fs.existsSync(configPath)) {
  try {
    raw = parseYaml(fs.readFileSync(configPath, 'utf8')) ?? {};
  } catch (err) {
    console.error(`Could not read ${configPath}:\n  ${err instanceof Error ? err.message : String(err)}`);
    console.error('Check the indentation (YAML uses spaces, not tabs) and that every key has a value after the colon.');
    process.exit(1);
  }
}
export const CONFIG_PATH = configPath && fs.existsSync(configPath) ? configPath : null;

// ---------- helpers ----------

const blank = (v: unknown) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v);
const fromYaml = (p: string): unknown => p.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), raw);
/** env var wins over config.yml; empty strings count as "not set" */
const val = (env: string | undefined, yml: string): unknown => blank(env ? process.env[env] : undefined) ?? blank(fromYaml(yml));

const str = z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().optional());
const num = (def: number, min: number, max: number) => z.coerce.number().min(min).max(max).default(def);
const bool = (def: boolean) =>
  z.preprocess((v) => (typeof v === 'string' ? !['false', '0', 'no', 'off'].includes(v.trim().toLowerCase()) : v), z.boolean().default(def));

// ---------- niche digest (what is happening in the user's market) ----------

const feedEntry = z.union([
  z.string().url().transform((url) => ({ url, name: undefined as string | undefined, tier: 1 })),
  z.object({ url: z.string().url(), name: z.string().optional(), tier: z.coerce.number().int().min(1).max(3).default(1) }),
]);

const nicheSchema = z
  .object({
    label: z.string().optional(),
    feeds: z.array(feedEntry).default([]),
    hacker_news: z
      .object({
        enabled: bool(true),
        min_score: num(100, 1, 10000),
        max_items: num(30, 1, 100),
        keywords: z.array(z.string()).default([]),
      })
      .default({}),
    github_releases: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'use owner/repo, e.g. vercel/next.js')).default([]),
    search: z
      .array(z.object({ objective: z.string().max(500).optional(), queries: z.array(z.string().min(2).max(200)).min(1).max(5) }))
      .default([]),
  })
  .transform((n) => ({
    label: n.label,
    feeds: n.feeds,
    hackerNews: { enabled: n.hacker_news.enabled, minScore: n.hacker_news.min_score, maxItems: n.hacker_news.max_items, keywords: n.hacker_news.keywords },
    githubReleases: n.github_releases,
    search: n.search,
  }));
export type NicheConfig = z.infer<typeof nicheSchema>;

const schema = z.object({
  port: num(3001, 1, 65535),
  dataFile: z.string().default('./data/db.json'),
  cronEnabled: bool(true),
  frontendUrl: z.string().url().default('http://localhost:5173'),
  supabase: z.object({
    url: str,
    serviceRoleKey: str,
  }),
  xOAuth: z.object({
    clientId: str,
    clientSecret: str,
    redirectUri: str,
    tokenEncryptionKey: str,
  }),
  llm: z.object({
    provider: z.enum(['gemini', 'openrouter', 'mock', 'auto']).default('gemini'),
    fallback: z.enum(['gemini', 'openrouter', 'mock', 'none']).default('openrouter'),
    timeoutSeconds: num(120, 5, 600),
    gemini: z.object({
      apiKey: str,
      model: z.string().default('gemini-3.5-flash-lite'),
      baseUrl: z.string().default('https://generativelanguage.googleapis.com'),
    }),
    openrouter: z.object({
      apiKey: str,
      model: z.string().default('openrouter/free'),
      baseUrl: z.string().default('https://openrouter.ai/api/v1'),
    }),
  }),
  twitter: z.object({
    xBearerToken: str,
    twitterapiIoKey: str,
    xApiBase: z.string().default('https://api.x.com/2'),
    twitterapiIoBase: z.string().default('https://api.twitterapi.io'),
  }),
  style: z.object({
    maxTweetsStored: num(400, 20, 3200),
    /** How many top-performing tweets to feed the LLM when building a reference style card (target 30–50). */
    topPerformingCount: num(50, 10, 100),
    /** Soft floor: warn / mark low-coverage if fewer eligible tweets than this. */
    topPerformingMin: num(30, 5, 100),
    fewShotCount: num(8, 0, 30),
    /** At generation time, retrieve this many format-relevant structure examples (clamped with max). */
    structuralFewShotMin: num(3, 1, 10),
    structuralFewShotMax: num(5, 1, 15),
    rawRecentCount: num(25, 0, 100),
    contextCharBudget: num(12000, 2000, 100000),
    /** Reuse a cached style card until this age (hours). Set 0 to always rebuild. */
    styleCardTtlHours: num(168, 0, 8760),
    /** Rebuild the card early if eligible tweet count drifted by this many since last analysis. */
    styleCardInvalidateDelta: num(15, 0, 500),
  }),
  digest: z.object({
    enabled: bool(true),
    scheduleCron: z.string().default('0 4 * * *'),
    timezone: z.string().default('Asia/Kolkata'),
    itemsPerDigest: num(10, 1, 30),
    maxCandidatesForLlm: num(40, 5, 200),
    maxAgeHours: num(48, 6, 720),
    staleAfterHours: num(26, 1, 720),
    excerptMaxChars: num(300, 100, 1000),
    maxItemsPerFeed: num(15, 1, 100),
    rawRetentionHours: num(48, 1, 720),
    digestRetentionDays: num(30, 1, 365),
    newsShare: num(0.6, 0, 1),
    fetchTimeoutSeconds: num(15, 3, 60),
    userAgent: z.string().default('TweetBrain/1.0 (daily niche digest bot)'),
    blocklistDomains: z.array(z.string()).default([]),
    hackerNewsApiBase: z.string().default('https://hacker-news.firebaseio.com/v0'),
    githubBase: z.string().default('https://github.com'),
    parallel: z.object({
      enabled: bool(true),
      apiKey: str,
      baseUrl: z.string().default('https://api.parallel.ai'),
      searchPath: z.string().default('/v1/search'),
      mode: z.string().default('fast'),
      monthlyCap: num(4000, 0, 1000000),
    }),
    safety: z.object({
      blockInventedExperience: bool(true),
      checkNumbers: bool(true),
      minOverlapWords: num(6, 4, 12),
    }),
    niches: z.record(z.string().regex(/^[a-z0-9_-]{1,32}$/, 'niche names use lowercase letters, numbers, - or _'), nicheSchema).default({}),
  }),
  alerts: z.object({ webhookUrl: str, telegramBotToken: str, telegramChatId: str }),
  adminKey: str,
  /** Polar: see `src/config/polar.ts` — sandbox vs production via POLAR_ENVIRONMENT only. */
  polar: polarConfigSchema,
  generation: z.object({
    /** multi = pick material → format → draft → critique/rewrite; single = legacy one-shot */
    pipeline: z.enum(['multi', 'single']).default('multi'),
    logStages: bool(true),
    logDir: z.string().default('./data/generation-logs'),
    /** Rewrite when any of voice/specificity/originality is below this (1–10). */
    critiqueMinScore: num(6, 1, 10),
    /** Editable banned phrasing / patterns (substring match, case-insensitive). Prefix with "re:" for regex. */
    bannedPatterns: z.array(z.string()).default([
      'taught me one thing',
      're:the real .+ is never',
      're:is easy\\. .+ requires discipline',
      'game-changer',
      "here's the thing",
      'heres the thing',
      "in today's fast-paced world",
      'delve into',
      'unlock the power',
      "let's dive in",
      'buckle up',
      'the future is here',
      'you got this',
      'keep grinding',
      'trust the process',
      'never give up',
      'believe in yourself',
    ]),
  }),
  limits: z.object({
    /** Max POST /api/tweets/generate (and other gen) calls per user per hour. */
    generatePerHour: num(30, 1, 10000),
    /** One free batch per new user (0 disables free batches). */
    freeBatchesPerUser: num(1, 0, 10),
    /** Global circuit breaker: free batches across all users per UTC day. */
    freeGenerationsGlobalPerDay: num(200, 0, 1000000),
    /** Paid plan: max draft tweets generated per user per UTC day. */
    paidDraftsPerDay: num(50, 1, 10000),
    /** Paid plan: max posts/schedules marked per user per UTC day. */
    paidPostsPerDay: num(20, 1, 10000),
    /** Global per-IP requests per minute (all routes). */
    ipPerMinute: num(120, 10, 100000),
    /** Per-authenticated-user API requests per minute (after auth). */
    apiPerMinute: num(60, 5, 100000),
  }),
});

const parsed = schema.safeParse({
  port: val('PORT', 'server.port'),
  dataFile: val('DATA_FILE', 'server.data_file'),
  cronEnabled: val('CRON_ENABLED', 'server.cron_enabled'),
  frontendUrl: val('FRONTEND_URL', 'server.frontend_url'),
  supabase: {
    url: val('SUPABASE_URL', 'supabase.url'),
    serviceRoleKey: val('SUPABASE_SERVICE_ROLE_KEY', 'supabase.service_role_key'),
  },
  xOAuth: {
    clientId: val('X_CLIENT_ID', 'x_oauth.client_id'),
    clientSecret: val('X_CLIENT_SECRET', 'x_oauth.client_secret'),
    redirectUri: val('X_REDIRECT_URI', 'x_oauth.redirect_uri'),
    tokenEncryptionKey: val('X_TOKEN_ENCRYPTION_KEY', 'x_oauth.token_encryption_key'),
  },
  llm: {
    provider: val('LLM_PROVIDER', 'llm.provider'),
    fallback: val('LLM_FALLBACK_PROVIDER', 'llm.fallback_provider'),
    timeoutSeconds: val('LLM_TIMEOUT_SECONDS', 'llm.timeout_seconds'),
    gemini: {
      apiKey: val('GEMINI_API_KEY', 'llm.gemini.api_key'),
      model: val('GEMINI_MODEL', 'llm.gemini.model'),
      baseUrl: val('GEMINI_BASE_URL', 'llm.gemini.base_url'),
    },
    openrouter: {
      apiKey: val('OPENROUTER_API_KEY', 'llm.openrouter.api_key'),
      model: val('OPENROUTER_MODEL', 'llm.openrouter.model'),
      baseUrl: val('OPENROUTER_BASE_URL', 'llm.openrouter.base_url'),
    },
  },
  twitter: {
    xBearerToken: val('X_BEARER_TOKEN', 'twitter.x_bearer_token'),
    twitterapiIoKey: val('TWITTERAPI_IO_KEY', 'twitter.twitterapi_io_key'),
    xApiBase: val('X_API_BASE', 'twitter.x_api_base'),
    twitterapiIoBase: val('TWITTERAPI_IO_BASE', 'twitter.twitterapi_io_base'),
  },
  style: {
    maxTweetsStored: val('MAX_TWEETS_STORED', 'style.max_tweets_stored'),
    topPerformingCount: val('TOP_PERFORMING_COUNT', 'style.top_performing_count'),
    topPerformingMin: val('TOP_PERFORMING_MIN', 'style.top_performing_min'),
    fewShotCount: val('FEW_SHOT_COUNT', 'style.few_shot_count'),
    structuralFewShotMin: val('STRUCTURAL_FEW_SHOT_MIN', 'style.structural_few_shot_min'),
    structuralFewShotMax: val('STRUCTURAL_FEW_SHOT_MAX', 'style.structural_few_shot_max'),
    rawRecentCount: val('RAW_RECENT_COUNT', 'style.raw_recent_count'),
    contextCharBudget: val('CONTEXT_CHAR_BUDGET', 'style.context_char_budget'),
    styleCardTtlHours: val('STYLE_CARD_TTL_HOURS', 'style.style_card_ttl_hours'),
    styleCardInvalidateDelta: val('STYLE_CARD_INVALIDATE_DELTA', 'style.style_card_invalidate_delta'),
  },
  digest: {
    enabled: val('DIGEST_ENABLED', 'digest.enabled'),
    scheduleCron: val('DIGEST_CRON', 'digest.schedule_cron'),
    timezone: val('DIGEST_TIMEZONE', 'digest.timezone'),
    itemsPerDigest: val(undefined, 'digest.items_per_digest'),
    maxCandidatesForLlm: val(undefined, 'digest.max_candidates_for_llm'),
    maxAgeHours: val(undefined, 'digest.max_age_hours'),
    staleAfterHours: val(undefined, 'digest.stale_after_hours'),
    excerptMaxChars: val(undefined, 'digest.excerpt_max_chars'),
    maxItemsPerFeed: val(undefined, 'digest.max_items_per_feed'),
    rawRetentionHours: val(undefined, 'digest.raw_retention_hours'),
    digestRetentionDays: val(undefined, 'digest.digest_retention_days'),
    newsShare: val(undefined, 'digest.news_share'),
    fetchTimeoutSeconds: val(undefined, 'digest.fetch_timeout_seconds'),
    userAgent: val('DIGEST_USER_AGENT', 'digest.user_agent'),
    blocklistDomains: fromYaml('digest.blocklist_domains') ?? undefined,
    hackerNewsApiBase: val('HN_API_BASE', 'digest.hacker_news_api_base'),
    githubBase: val('GITHUB_BASE', 'digest.github_base'),
    parallel: {
      enabled: val('PARALLEL_ENABLED', 'digest.parallel.enabled'),
      apiKey: val('PARALLEL_API_KEY', 'digest.parallel.api_key'),
      baseUrl: val('PARALLEL_BASE_URL', 'digest.parallel.base_url'),
      searchPath: val('PARALLEL_SEARCH_PATH', 'digest.parallel.search_path'),
      mode: val('PARALLEL_MODE', 'digest.parallel.mode'),
      monthlyCap: val('PARALLEL_MONTHLY_CAP', 'digest.parallel.monthly_cap'),
    },
    safety: {
      blockInventedExperience: val(undefined, 'digest.safety.block_invented_experience'),
      checkNumbers: val(undefined, 'digest.safety.check_numbers'),
      minOverlapWords: val(undefined, 'digest.safety.min_overlap_words'),
    },
    niches: fromYaml('digest.niches') ?? undefined,
  },
  alerts: {
    webhookUrl: val('ALERT_WEBHOOK_URL', 'alerts.webhook_url'),
    telegramBotToken: val('TELEGRAM_BOT_TOKEN', 'alerts.telegram_bot_token'),
    telegramChatId: val('TELEGRAM_CHAT_ID', 'alerts.telegram_chat_id'),
  },
  adminKey: val('ADMIN_KEY', 'server.admin_key'),
  polar: readPolarConfigInput(val),
  generation: {
    pipeline: val('GENERATION_PIPELINE', 'generation.pipeline'),
    logStages: val('GENERATION_LOG_STAGES', 'generation.log_stages'),
    logDir: val('GENERATION_LOG_DIR', 'generation.log_dir'),
    critiqueMinScore: val('GENERATION_CRITIQUE_MIN_SCORE', 'generation.critique_min_score'),
    bannedPatterns: fromYaml('generation.banned_patterns') ?? undefined,
  },
  limits: {
    generatePerHour: val('LIMITS_GENERATE_PER_HOUR', 'limits.generate_per_hour'),
    freeBatchesPerUser: val('LIMITS_FREE_BATCHES_PER_USER', 'limits.free_batches_per_user'),
    freeGenerationsGlobalPerDay: val('LIMITS_FREE_GENERATIONS_GLOBAL_PER_DAY', 'limits.free_generations_global_per_day'),
    paidDraftsPerDay: val('LIMITS_PAID_DRAFTS_PER_DAY', 'limits.paid_drafts_per_day'),
    paidPostsPerDay: val('LIMITS_PAID_POSTS_PER_DAY', 'limits.paid_posts_per_day'),
    ipPerMinute: val('LIMITS_IP_PER_MINUTE', 'limits.ip_per_minute'),
    apiPerMinute: val('LIMITS_API_PER_MINUTE', 'limits.api_per_minute'),
  },
});

if (!parsed.success) {
  console.error(`Invalid configuration${configPath ? ` in ${configPath}` : ''}:`);
  for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  dataFile: path.resolve(ROOT, parsed.data.dataFile),
};
export type ProviderName = 'gemini' | 'openrouter' | 'mock';
