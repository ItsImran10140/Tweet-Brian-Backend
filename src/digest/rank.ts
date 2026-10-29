import { canonicalUrl, jaccardSets, titleWords } from './text';
import type { Cluster, RawItem } from '../digest/types';

/**
 * Merge duplicates (same page, or near-identical headlines) into clusters, then score and verify them.
 *
 * Verification rule (the "trust tiers"):
 *   confirmed = the cluster has a Tier 1 (official) or Tier 2 (Hacker News) source, OR two independent domains.
 *   A lone web-search result is NOT enough to become a fact.
 */
export function buildClusters(items: RawItem[], opts: { maxAgeHours: number; now?: Date }): Cluster[] {
  const now = opts.now ?? new Date();
  const sorted = [...items].sort((a, b) => a.tier - b.tier || (b.published_at ?? '').localeCompare(a.published_at ?? ''));
  const clusters: (Cluster & { _words: Set<string>; _canon: Set<string> })[] = [];

  for (const it of sorted) {
    const canon = canonicalUrl(it.url);
    const words = titleWords(it.title);
    let home = clusters.find((c) => c._canon.has(canon));
    if (!home) {
      home = clusters.find((c) => {
        const { score, shared } = jaccardSets(words, c._words);
        return shared >= 3 && score >= 0.6;
      });
    }
    if (!home) {
      clusters.push({
        key: it.id,
        items: [it],
        title: it.title,
        url: it.url,
        sources: [],
        best_tier: it.tier,
        domains: 0,
        confirmed: false,
        score: 0,
        published_at: it.published_at,
        excerpt: it.excerpt,
        shingles: [...it.shingles],
        _words: words,
        _canon: new Set([canon]),
      });
      continue;
    }
    home.items.push(it);
    home._canon.add(canon);
    if (!home.excerpt && it.excerpt) home.excerpt = it.excerpt;
    for (const sh of it.shingles) if (!home.shingles.includes(sh) && home.shingles.length < 600) home.shingles.push(sh);
    if (it.published_at && (!home.published_at || it.published_at > home.published_at)) home.published_at = it.published_at;
  }

  return clusters
    .map(({ _words, _canon, ...c }) => {
      const seen = new Set<string>();
      const sources = c.items
        .filter((i) => {
          const k = `${i.domain}|${i.source_name}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .map((i) => ({ name: i.source_name, url: i.url, tier: i.tier, kind: i.kind, domain: i.domain }));
      const domains = new Set(c.items.map((i) => i.domain).filter(Boolean)).size;
      const best = Math.min(...c.items.map((i) => i.tier));
      const hn = Math.max(0, ...c.items.map((i) => i.score ?? 0));
      const ageH = c.published_at ? Math.max(0, (now.getTime() - new Date(c.published_at).getTime()) / 3600_000) : opts.maxAgeHours / 2;
      const recency = Math.max(0, 6 * (1 - ageH / opts.maxAgeHours));
      const score = (4 - best) * 10 + Math.min(domains, 4) * 3 + recency + Math.log10(hn + 1) * 2;
      return { ...c, sources, domains, best_tier: best, confirmed: best <= 2 || domains >= 2, score: Math.round(score * 100) / 100 } as Cluster;
    })
    .sort((a, b) => b.score - a.score);
}
