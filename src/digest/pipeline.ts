import { config } from '../config';
import { AppError } from '../errors';
import { db } from '../data';
import { buildClusters } from './rank';
import { notify } from './notify';
import { collectFeed, makeItem } from './sources/feed';
import { collectGithubReleases } from './sources/github';
import { collectHackerNews } from './sources/hackerNews';
import { parallelConfigured, parallelSearch } from './sources/parallel';
import { isBlocked, latestDigest, parallelUsage, purgeOld, recordParallelCall, searchedToday, todayKey } from './store';
import { summarizeClusters } from './summarize';
import { hostOf } from './text';
import type { Cluster, RawItem, SourceReport } from './types';

/**
 * THE AUTOPILOT PIPELINE (one niche, shared by every user of that niche)
 *
 *   COLLECT  official feeds + GitHub releases + Hacker News + (budget-capped) Parallel search
 *   CLUSTER  merge duplicates, score, assign trust tiers
 *   VERIFY   keep only items with an official/community source or two independent domains
 *   SUMMARIZE  LLM call #1: facts in its own words (code rejects copied wording)
 *   STORE    digest_items (short fact + link), raw excerpts are purged after raw_retention_hours
 *
 * Every failure is caught: the previous digest keeps being served and an alert is sent.
 */

export interface RunOptions {
  /** collect + cluster + verify only: no LLM, nothing saved, Parallel skipped unless includeSearch */
  dryRun?: boolean;
  /** spend Parallel requests even if the niche was already searched today */
  forceSearch?: boolean;
  /** with dryRun: also call Parallel (uses your free allowance) */
  includeSearch?: boolean;
  trigger?: 'manual' | 'cron' | 'auto';
  now?: Date;
}

const running = new Set<string>();

function nicheOrThrow(niche: string) {
  const cfg = config.digest.niches[niche];
  if (!cfg) {
    const names = Object.keys(config.digest.niches);
    throw new AppError(404, 'unknown_niche', `No niche called "${niche}" in config.yml.`, names.length ? `Configured niches: ${names.join(', ')}` : 'Add a niche under digest.niches in config.yml (see config.example.yml).');
  }
  return cfg;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function collectSearch(niche: string, cfg: ReturnType<typeof nicheOrThrow>, opts: RunOptions, now: Date, reports: SourceReport[], officialHosts: string[]): Promise<RawItem[]> {
  const label = 'Parallel Search';
  if (!cfg.search.length) return [];
  if (!parallelConfigured()) {
    reports.push({ source: label, kind: 'search', ok: true, items: 0, note: 'skipped: no PARALLEL_API_KEY set, running on feeds only' });
    return [];
  }
  if (opts.dryRun && !opts.includeSearch) {
    reports.push({ source: label, kind: 'search', ok: true, items: 0, note: 'skipped in dry run (add include_search=1 to spend Parallel requests)' });
    return [];
  }
  if (!opts.dryRun && (await searchedToday(niche)) && !opts.forceSearch) {
    const cached = (await db.all('digest_raw_items', (r) => r.niche === niche && r.kind === 'search' && r.fetch_date === todayKey(now))) as RawItem[];
    reports.push({ source: label, kind: 'search', ok: true, items: cached.length, note: 'reused results already fetched today (0 Parallel requests used). Add force_search=1 to search again.' });
    return cached;
  }

  const out: RawItem[] = [];
  for (const entry of cfg.search) {
    const usage = await parallelUsage();
    if (usage.used >= usage.cap) {
      reports.push({ source: 'Parallel budget', kind: 'parallel-budget', ok: true, items: 0, note: `monthly cap reached (${usage.used}/${usage.cap}); search stopped, feeds carry the digest` });
      break;
    }
    const name = `Parallel: ${entry.queries[0]}`;
    try {
      const hits = await parallelSearch(entry);
      await recordParallelCall(niche, true, 'ok');
      const items = [];
      for (const h of hits) {
        if (await isBlocked(h.url)) continue;
        const host = hostOf(h.url);
        const official = officialHosts.some((d) => host === d || host.endsWith(`.${d}`));
        items.push(makeItem({ niche, kind: 'search', source_name: host || 'web', tier: official ? 1 : 3, title: h.title, url: h.url, text: h.text, published: h.published }, now));
      }
      out.push(...items);
      reports.push({ source: name, kind: 'search', ok: true, items: items.length });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'error';
      await recordParallelCall(niche, false, code);
      reports.push({ source: name, kind: 'search', ok: false, items: 0, error: errMsg(e) });
      if (['parallel_unauthorized', 'parallel_payment_required', 'parallel_rate_limited'].includes(code)) break; // no point hammering
    }
  }
  return out;
}

async function collectAll(niche: string, opts: RunOptions, now: Date) {
  const cfg = nicheOrThrow(niche);
  const reports: SourceReport[] = [];
  const items: RawItem[] = [];
  const keep = async (list: RawItem[]) => {
    const out: RawItem[] = [];
    for (const i of list) {
      if (!(await isBlocked(i.url))) out.push(i);
    }
    return out;
  };

  for (const feed of cfg.feeds) {
    const name = feed.name ?? hostOf(feed.url);
    try {
      const got = await keep(await collectFeed(niche, feed, now));
      items.push(...got);
      reports.push({ source: name, kind: 'feed', ok: true, items: got.length });
    } catch (e) {
      reports.push({ source: name, kind: 'feed', ok: false, items: 0, error: errMsg(e) });
    }
  }
  for (const repo of cfg.githubReleases) {
    try {
      const got = await keep(await collectGithubReleases(niche, repo, now));
      items.push(...got);
      reports.push({ source: `github:${repo}`, kind: 'github', ok: true, items: got.length });
    } catch (e) {
      reports.push({ source: `github:${repo}`, kind: 'github', ok: false, items: 0, error: errMsg(e) });
    }
  }
  if (cfg.hackerNews.enabled) {
    try {
      const got = await keep(await collectHackerNews(niche, cfg.hackerNews, now));
      items.push(...got);
      reports.push({ source: 'Hacker News', kind: 'hn', ok: true, items: got.length });
    } catch (e) {
      reports.push({ source: 'Hacker News', kind: 'hn', ok: false, items: 0, error: errMsg(e) });
    }
  }
  const officialHosts = cfg.feeds.filter((f) => f.tier === 1).map((f) => hostOf(f.url)).filter(Boolean);
  items.push(...(await collectSearch(niche, cfg, opts, now, reports, officialHosts)));
  return { cfg, items, reports };
}

const preview = (c: Cluster) => ({
  title: c.title,
  url: c.url,
  best_tier: c.best_tier,
  independent_domains: c.domains,
  confirmed: c.confirmed,
  score: c.score,
  published_at: c.published_at,
  excerpt: c.excerpt,
  sources: c.sources.map((s) => ({ name: s.name, tier: s.tier, url: s.url })),
});

export async function runDigest(niche: string, opts: RunOptions = {}) {
  const cfg = nicheOrThrow(niche);
  if (running.has(niche)) return { niche, status: 'already_running' as const };
  running.add(niche);
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  const run = opts.dryRun ? null : await db.insert('digest_runs', { niche, trigger: opts.trigger ?? 'manual', status: 'running', started_at: now.toISOString() });
  const finish = async (r: Record<string, unknown>) => {
    const full = { niche, run_id: run?.id ?? null, duration_ms: Date.now() - t0, ...r };
    if (run) await db.update('digest_runs', (x) => x.id === run.id, { ...full, finished_at: new Date().toISOString() });
    return full;
  };

  try {
    const housekeeping = opts.dryRun ? null : await purgeOld(now);
    const { items, reports } = await collectAll(niche, opts, now);

    if (!opts.dryRun) {
      for (const it of items) {
        if (it.kind === 'search' && (await db.get('digest_raw_items', (r) => r.id === it.id && r.niche === niche))) continue;
        await db.remove('digest_raw_items', (r) => r.id === it.id && r.niche === niche);
        await db.insert('digest_raw_items', { ...it });
      }
    }

    const clusters = buildClusters(items, { maxAgeHours: config.digest.maxAgeHours, now });
    const confirmed = clusters.filter((c) => c.confirmed);
    const candidates = confirmed.slice(0, config.digest.maxCandidatesForLlm);
    const counts = { collected: items.length, clusters: clusters.length, confirmed: confirmed.length, dropped_unconfirmed: clusters.length - confirmed.length, candidates_for_llm: candidates.length };
    const failedSources = reports.filter((r) => !r.ok);
    const allFailed = reports.filter((r) => r.kind !== 'parallel-budget').length > 0 && reports.every((r) => !r.ok || r.items === 0) && failedSources.length > 0;
    const parallel = await parallelUsage();

    if (opts.dryRun) {
      return finish({ status: 'dry_run' as const, ...counts, sources: reports, parallel, preview: clusters.slice(0, 40).map(preview), note: 'Dry run: nothing was saved and the LLM was not called.' });
    }

    const previous = await latestDigest(niche);
    if (!candidates.length) {
      const msg = allFailed ? `Digest for "${niche}": every source failed. Serving the previous digest (${previous.digest_date ?? 'none'}).` : `Digest for "${niche}": nothing new and confirmed was found. Serving the previous digest (${previous.digest_date ?? 'none'}).`;
      await notify(msg);
      return finish({ status: 'empty' as const, ...counts, sources: reports, parallel, kept_previous_digest: previous.items.length > 0, housekeeping });
    }

    let summary;
    try {
      summary = await summarizeClusters(niche, cfg.label, candidates);
    } catch (e) {
      await notify(`Digest for "${niche}" failed at the summarize step: ${errMsg(e)}. Serving the previous digest (${previous.digest_date ?? 'none'}).`);
      return finish({ status: 'failed' as const, ...counts, sources: reports, parallel, error: errMsg(e), kept_previous_digest: previous.items.length > 0, housekeeping });
    }

    if (!summary.items.length) {
      await notify(`Digest for "${niche}": the model produced no usable items. Serving the previous digest.`);
      return finish({ status: 'empty' as const, ...counts, sources: reports, parallel, llm_calls: summary.llm_calls, rejected_by_copy_check: summary.rejected, kept_previous_digest: previous.items.length > 0, housekeeping });
    }

    const date = todayKey(now);
    await db.remove('digest_items', (r) => r.niche === niche && r.digest_date === date);
    for (let i = 0; i < summary.items.length; i++) {
      const s = summary.items[i];
      await db.insert('digest_items', {
        niche,
        digest_date: date,
        run_id: run?.id,
        rank: i + 1,
        headline: s.headline,
        fact_summary: s.fact_summary,
        category: s.category,
        source_name: s.cluster.sources[0]?.name ?? hostOf(s.cluster.url),
        source_url: s.cluster.url,
        supporting: s.cluster.sources.filter((x) => x.url !== s.cluster.url).slice(0, 3).map((x) => ({ name: x.name, url: x.url })),
        trust_tier: s.cluster.best_tier,
        confirmed_by_domains: s.cluster.domains,
        published_at: s.cluster.published_at,
        shingles: s.cluster.shingles.slice(0, 400),
      });
    }

    return finish({
      status: (failedSources.length ? 'partial' : 'ok') as 'partial' | 'ok',
      ...counts,
      sources: reports,
      parallel,
      llm_calls: summary.llm_calls,
      items_saved: summary.items.length,
      rejected_by_copy_check: summary.rejected,
      digest_date: date,
      housekeeping,
    });
  } catch (e) {
    await notify(`Digest for "${niche}" crashed: ${errMsg(e)}`);
    return finish({ status: 'failed' as const, error: errMsg(e) });
  } finally {
    running.delete(niche);
  }
}

export async function runDigestAll(opts: RunOptions = {}) {
  const out: Record<string, unknown> = {};
  for (const niche of Object.keys(config.digest.niches)) out[niche] = await runDigest(niche, opts);
  return out;
}

/** Used by tweet generation: build a digest only when there is none, or it is older than digest.stale_after_hours. */
export async function ensureFreshDigest(niche: string): Promise<{ ran: boolean; reason: string }> {
  if (!config.digest.enabled) return { ran: false, reason: 'digest disabled in config' };
  if (!config.digest.niches[niche]) return { ran: false, reason: `unknown niche "${niche}"` };
  const { generated_at } = await latestDigest(niche);
  const stale = !generated_at || Date.now() - new Date(generated_at).getTime() > config.digest.staleAfterHours * 3600_000;
  if (!stale) return { ran: false, reason: 'digest is fresh' };
  const r: any = await runDigest(niche, { trigger: 'auto' });
  return { ran: true, reason: `built automatically (${r.status})` };
}
