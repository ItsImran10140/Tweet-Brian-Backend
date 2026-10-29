import { config } from '../../config';
import { AppError } from '../../errors';
import { requestJson } from '../../lib/http';
import { htmlToText } from '../text';

export const parallelConfigured = (): boolean => config.digest.parallel.enabled && Boolean(config.digest.parallel.apiKey);

export interface SearchHit {
  url: string;
  title: string;
  text: string;
  published: string | null;
}

/**
 * ONE call to Parallel's Search API (https://docs.parallel.ai/search/search-quickstart).
 * Billing is per request, so one entry in niches.<name>.search = one request, however many queries it holds.
 */
export async function parallelSearch(entry: { objective?: string; queries: string[] }): Promise<SearchHit[]> {
  const p = config.digest.parallel;
  const url = `${p.baseUrl.replace(/\/$/, '')}${p.searchPath}`;
  const base = { search_queries: entry.queries, ...(entry.objective ? { objective: entry.objective } : {}) };
  const call = (body: unknown) => requestJson(url, { method: 'POST', headers: { 'x-api-key': p.apiKey as string }, body, timeoutMs: config.digest.fetchTimeoutSeconds * 1000 * 2 });

  let res = await call(p.mode ? { ...base, mode: p.mode } : base);
  // A schema mismatch on the optional "mode" field must not break the whole pipeline: retry once without it.
  if ((res.status === 400 || res.status === 422) && p.mode) res = await call(base);

  if (res.status === 401 || res.status === 403) throw new AppError(502, 'parallel_unauthorized', `Parallel rejected the API key (HTTP ${res.status}).`, 'Create a key at https://platform.parallel.ai and set PARALLEL_API_KEY in .env.');
  if (res.status === 402) throw new AppError(502, 'parallel_payment_required', 'Parallel says the free allowance or credits are used up.', 'Check usage at https://platform.parallel.ai. The pipeline continues with feeds only.');
  if (res.status === 429) throw new AppError(502, 'parallel_rate_limited', 'Parallel rate limit hit.', 'The pipeline continues with feeds only; try again later.');
  if (res.status < 200 || res.status >= 300) throw new AppError(502, 'parallel_error', `Parallel answered HTTP ${res.status}: ${res.text.slice(0, 200)}`, 'Check PARALLEL_BASE_URL / PARALLEL_SEARCH_PATH in .env if you changed them.');

  const results: any[] = Array.isArray(res.json?.results) ? res.json.results : [];
  return results
    .filter((r) => r?.url && r?.title)
    .map((r) => {
      const excerpts: string[] = Array.isArray(r.excerpts) ? r.excerpts : r.excerpt ? [String(r.excerpt)] : [];
      const date = r.publish_date ?? r.published_date ?? r.date ?? null;
      const d = date ? new Date(date) : null;
      return { url: String(r.url), title: htmlToText(String(r.title)), text: htmlToText(excerpts.join(' ')), published: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null };
    });
}
