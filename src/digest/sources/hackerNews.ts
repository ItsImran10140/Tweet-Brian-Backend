import { config } from '../../config';
import { requestJson } from '../../lib/http';
import { hostOf } from '../text';
import { isFresh, makeItem } from './feed';
import type { NicheConfig } from '../../config';
import type { RawItem } from '../types';

/** What people are talking about today. Official Hacker News API, no key needed. Tier 2. */
export async function collectHackerNews(niche: string, cfg: NicheConfig['hackerNews'], now = new Date()): Promise<RawItem[]> {
  const base = config.digest.hackerNewsApiBase.replace(/\/$/, '');
  const timeoutMs = config.digest.fetchTimeoutSeconds * 1000;
  const top = await requestJson(`${base}/topstories.json`, { timeoutMs });
  if (top.status !== 200 || !Array.isArray(top.json)) throw new Error(`Hacker News topstories answered HTTP ${top.status}`);
  const ids: number[] = top.json.slice(0, 80);

  const stories: any[] = [];
  for (let i = 0; i < ids.length; i += 10) {
    const batch = await Promise.all(ids.slice(i, i + 10).map((id) => requestJson(`${base}/item/${id}.json`, { timeoutMs }).then((r) => r.json).catch(() => null)));
    stories.push(...batch);
  }

  const kw = cfg.keywords.map((k) => k.toLowerCase());
  const out: RawItem[] = [];
  for (const s of stories) {
    if (!s || s.type !== 'story' || s.dead || s.deleted || !s.title || !s.url) continue;
    if ((s.score ?? 0) < cfg.minScore) continue;
    const published = s.time ? new Date(s.time * 1000).toISOString() : null;
    if (!isFresh(published, config.digest.maxAgeHours, now)) continue;
    const title = String(s.title);
    if (kw.length && !kw.some((k) => title.toLowerCase().includes(k))) continue;
    out.push(makeItem({ niche, kind: 'hn', source_name: `Hacker News (${hostOf(s.url)})`, tier: 2, title, url: String(s.url), text: '', published, score: Number(s.score) }, now));
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, cfg.maxItems);
}
