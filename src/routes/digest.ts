import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { AppError } from '../errors';
import { db } from '../data';
import { runDigest, runDigestAll } from '../digest/pipeline';
import { alertsConfigured, notify } from '../digest/notify';
import { parallelConfigured } from '../digest/sources/parallel';
import { blockedDomains, defaultNiche, latestDigest, nicheNames, parallelUsage, publicItem, purgeOld, removeDomainEverywhere } from '../digest/store';
import { hostOf } from '../digest/text';
import { requireAdmin } from '../middleware/admin';
import { parse, requireOnboarded, requireUser, uid, wrap } from './util';

/** What is happening in your niche today: short verified facts with source links. Same digest for every user of the niche. */
export const digest = Router();
digest.use(requireUser);
digest.use(requireOnboarded);

const nicheFrom = async (req: Request): Promise<string> => {
  // Users only see their own niche (shared digest content, not other users' data).
  const mine = (await db.get('users', (u) => u.id === uid(req)))?.niche;
  const niche = mine || defaultNiche();
  if (!config.digest.niches[niche]) throw new AppError(404, 'unknown_niche', `No niche called "${niche}".`, `Configured niches: ${nicheNames().join(', ') || '(none, add digest.niches to config.yml)'}`);
  return niche;
};

digest.get('/niches', (_req, res) => {
  res.json({ niches: nicheNames().map((n) => ({ name: n, label: config.digest.niches[n].label ?? n })) });
});

digest.get(
  '/',
  wrap(async (req, res) => {
    const niche = await nicheFrom(req);
    const d = await latestDigest(niche);
    const ageHours = d.generated_at ? Math.round((Date.now() - new Date(d.generated_at).getTime()) / 360000) / 10 : null;
    res.json({
      niche,
      digest_date: d.digest_date,
      generated_at: d.generated_at,
      age_hours: ageHours,
      stale: ageHours === null ? true : ageHours > config.digest.staleAfterHours,
      count: d.items.length,
      items: d.items.map(publicItem),
      hint: d.items.length ? undefined : 'No digest yet. Build one with POST /api/admin/digest/run (or just generate tweets: it builds one automatically).',
    });
  }),
);

export const adminDigest = Router();
adminDigest.use(requireAdmin);

const flag = (v: unknown) => v === '1' || v === 'true';
const nicheParam = (req: Request): string | undefined => (req.query.niche ? String(req.query.niche) : undefined);

adminDigest.post(
  '/run',
  wrap(async (req, res) => {
    const opts = { trigger: 'manual' as const, forceSearch: flag(req.query.force_search) };
    const n = nicheParam(req);
    res.json(n ? await runDigest(n, opts) : await runDigestAll(opts));
  }),
);

adminDigest.post(
  '/dry-run',
  wrap(async (req, res) => {
    const n = nicheParam(req) ?? defaultNiche();
    res.json(await runDigest(n, { dryRun: true, includeSearch: flag(req.query.include_search), trigger: 'manual' }));
  }),
);

adminDigest.get(
  '/status',
  wrap(async (_req, res) => {
    const lastRuns = (await db.all('digest_runs'))
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 5)
      .map(({ id, niche, status, trigger, created_at, duration_ms, collected, confirmed, items_saved, error }) => ({
        id, niche, status, trigger, created_at, duration_ms, collected, confirmed, items_saved, error,
      }));
    const niches = [];
    for (const n of nicheNames()) {
      const c = config.digest.niches[n];
      const d = await latestDigest(n);
      niches.push({
        name: n,
        feeds: c.feeds.length,
        github_repos: c.githubReleases.length,
        hacker_news: c.hackerNews.enabled,
        search_entries: c.search.length,
        latest_digest: d.digest_date,
        items: d.items.length,
        generated_at: d.generated_at,
      });
    }
    res.json({
      enabled: config.digest.enabled,
      schedule: { cron: config.digest.scheduleCron, timezone: config.digest.timezone },
      niches,
      parallel: { configured: parallelConfigured(), ...(await parallelUsage()), mode: config.digest.parallel.mode },
      alerts_configured: alertsConfigured(),
      blocklist: await blockedDomains(),
      last_runs: lastRuns,
    });
  }),
);

adminDigest.get(
  '/runs',
  wrap(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 10) || 10, 1), 100);
    const runs = (await db.all('digest_runs')).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
    res.json({ count: runs.length, runs });
  }),
);

adminDigest.get(
  '/usage',
  wrap(async (_req, res) => {
    res.json({ parallel: { configured: parallelConfigured(), ...(await parallelUsage()) }, note: 'One Parallel request = one entry under niches.<name>.search, once per niche per day.' });
  }),
);

adminDigest.get(
  '/raw',
  wrap(async (req, res) => {
    const niche = nicheParam(req);
    const rows = (await db.all('digest_raw_items', (r) => !niche || r.niche === niche))
      .sort((a, b) => String(b.fetched_at).localeCompare(String(a.fetched_at)))
      .slice(0, 100);
    res.json({ count: rows.length, items: rows.map(({ shingles, ...r }) => r) });
  }),
);

adminDigest.post(
  '/purge',
  wrap(async (_req, res) => {
    res.json(await purgeOld());
  }),
);

adminDigest.get(
  '/blocklist',
  wrap(async (_req, res) => {
    res.json({ domains: await blockedDomains() });
  }),
);

adminDigest.post(
  '/blocklist',
  wrap(async (req, res) => {
    const b = parse(z.object({ domain: z.string().min(3), reason: z.string().max(300).optional() }), req.body);
    const domain = (b.domain.includes('/') ? hostOf(b.domain) : b.domain.toLowerCase().replace(/^www\./, '')).trim();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new AppError(400, 'invalid_domain', `"${b.domain}" is not a domain.`, 'Use something like example.com');
    if (!(await db.get('digest_blocklist', (r) => r.domain === domain))) await db.insert('digest_blocklist', { domain, reason: b.reason ?? null });
    res.status(201).json({ blocked: domain, removed_now: await removeDomainEverywhere(domain), all_blocked: await blockedDomains() });
  }),
);

adminDigest.delete(
  '/blocklist/:domain',
  wrap(async (req, res) => {
    const n = await db.remove('digest_blocklist', (r) => r.domain === String(req.params.domain).toLowerCase());
    if (!n) throw new AppError(404, 'not_in_blocklist', 'That domain is not in the database blocklist (domains from config.yml must be removed there).');
    res.json({ unblocked: req.params.domain });
  }),
);

adminDigest.post(
  '/test-alert',
  wrap(async (_req, res) => {
    if (!alertsConfigured()) throw new AppError(400, 'alerts_not_configured', 'No alert target is configured.', 'Set ALERT_WEBHOOK_URL (Slack/Discord) or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env.');
    await notify('Test alert: if you can read this, failure alerts work.');
    res.json({ sent: true });
  }),
);
