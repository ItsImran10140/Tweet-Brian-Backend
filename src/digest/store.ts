import { config } from '../config';
import { db, type Row } from '../data';
import { hostOf, localDate } from './text';

export const monthKey = (d = new Date()) => localDate(d, config.digest.timezone).slice(0, 7);
export const todayKey = (d = new Date()) => localDate(d, config.digest.timezone);

export function nicheNames(): string[] {
  return Object.keys(config.digest.niches);
}
export const defaultNiche = (): string => nicheNames()[0] ?? 'tech';

// ---------- blocklist (config + database) ----------

export async function blockedDomains(): Promise<string[]> {
  const fromDb = (await db.all('digest_blocklist')).map((r) => String(r.domain));
  return [...new Set([...config.digest.blocklistDomains.map((d) => d.toLowerCase().replace(/^www\./, '')), ...fromDb])];
}
export async function isBlocked(url: string): Promise<boolean> {
  const host = hostOf(url);
  const blocked = await blockedDomains();
  return Boolean(host) && blocked.some((d) => host === d || host.endsWith(`.${d}`));
}

// ---------- Parallel budget ----------

export async function recordParallelCall(niche: string, ok: boolean, status: string) {
  await db.insert('digest_usage', { provider: 'parallel', niche, date: todayKey(), month: monthKey(), requests: ok ? 1 : 0, ok, status });
}
export async function parallelUsage() {
  const month = monthKey();
  const used = (await db.all('digest_usage', (r) => r.provider === 'parallel' && r.month === month)).reduce((s, r) => s + (r.requests ?? 0), 0);
  const cap = config.digest.parallel.monthlyCap;
  return {
    month,
    used,
    cap,
    remaining: Math.max(0, cap - used),
    today: (await db.all('digest_usage', (r) => r.provider === 'parallel' && r.date === todayKey())).reduce((s, r) => s + (r.requests ?? 0), 0),
  };
}
export const searchedToday = async (niche: string) =>
  Boolean(await db.get('digest_usage', (r) => r.provider === 'parallel' && r.niche === niche && r.date === todayKey() && r.ok));

// ---------- digest reads ----------

/** Items of the most recent digest for a niche, best first. */
export async function latestDigest(niche: string): Promise<{ digest_date: string | null; generated_at: string | null; items: Row[] }> {
  const all = await db.all('digest_items', (r) => r.niche === niche);
  if (!all.length) return { digest_date: null, generated_at: null, items: [] };
  const date = all.map((r) => String(r.digest_date)).sort().pop() as string;
  const items = all.filter((r) => r.digest_date === date).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return { digest_date: date, generated_at: items.map((i) => String(i.created_at)).sort().pop() ?? null, items };
}

/** Hide internal fields (hashed windows) from API responses. */
export const publicItem = (r: Row) => ({
  id: r.id,
  niche: r.niche,
  digest_date: r.digest_date,
  rank: r.rank,
  headline: r.headline,
  fact_summary: r.fact_summary,
  category: r.category,
  source_name: r.source_name,
  source_url: r.source_url,
  also_reported_by: r.supporting,
  trust_tier: r.trust_tier,
  published_at: r.published_at,
});

// ---------- housekeeping ----------

export async function purgeOld(now = new Date()) {
  const rawCut = new Date(now.getTime() - config.digest.rawRetentionHours * 3600_000).toISOString();
  const digestCut = new Date(now.getTime() - config.digest.digestRetentionDays * 86400_000).toISOString();
  const runCut = new Date(now.getTime() - 60 * 86400_000).toISOString();
  return {
    raw_items_removed: await db.remove('digest_raw_items', (r) => String(r.fetched_at) < rawCut),
    digest_items_removed: await db.remove('digest_items', (r) => String(r.created_at) < digestCut),
    runs_removed: await db.remove('digest_runs', (r) => String(r.created_at) < runCut),
  };
}

/** Takedown: drop everything from a domain right now (raw items and the current digest). */
export async function removeDomainEverywhere(domain: string) {
  const match = (url: unknown) => {
    const h = hostOf(String(url ?? ''));
    return h === domain || h.endsWith(`.${domain}`);
  };
  return {
    raw_items_removed: await db.remove('digest_raw_items', (r) => match(r.url)),
    digest_items_removed: await db.remove('digest_items', (r) => match(r.source_url) || (r.supporting ?? []).some((s: any) => match(s.url))),
  };
}
