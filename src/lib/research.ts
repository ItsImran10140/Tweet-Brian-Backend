import { z } from 'zod';
import { AppError } from '../errors';
import { requestJson } from './http';
import { isMock, llmGroundedSearch, llmOpenRouterWebSearch } from './llm';

export type ResearchSourceType = 'web' | 'newsletter' | 'idea';
export type ResearchStatus = 'ok' | 'failed' | 'empty';

/** Public shape stored on each draft and returned by the API. */
export interface DraftSource {
  type: ResearchSourceType;
  title: string;
  url: string | null;
  fetched_at: string;
}

export interface ResearchFinding extends DraftSource {
  /** 1-based index in the research pack shown to the LLM */
  n: number;
  snippet?: string;
}

export interface ResearchPack {
  fetched_at: string;
  query: string;
  findings: ResearchFinding[];
  web: ResearchFinding[];
  /** @deprecated Newsletters are no longer a live source; always []. */
  newsletters: ResearchFinding[];
  research_status: ResearchStatus;
  research_error?: string;
}

function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function asDraftSource(f: ResearchFinding): DraftSource {
  return {
    type: f.type,
    title: f.title,
    url: f.url,
    fetched_at: f.fetched_at,
  };
}

function mockWebFindings(query: string, fetchedAt: string): ResearchFinding[] {
  return [
    {
      n: 0,
      type: 'web',
      title: `Recent discussion: ${query.slice(0, 80) || 'your niche'}`,
      url: 'https://news.ycombinator.com',
      fetched_at: fetchedAt,
      snippet: `[MOCK] Builders are debating shipping speed vs polish in ${query || 'this niche'}.`,
    },
    {
      n: 0,
      type: 'web',
      title: 'Industry roundup (mock)',
      url: 'https://www.theverge.com',
      fetched_at: fetchedAt,
      snippet: '[MOCK] A concrete product update landed this week — use it as a reaction hook, not a summary.',
    },
  ];
}

const FindingListSchema = z.object({
  findings: z
    .array(
      z.object({
        title: z.string(),
        url: z.string().optional().nullable(),
        snippet: z.string().optional().nullable(),
      }),
    )
    .default([]),
});

function buildSearchQuery(opts: { topic?: string; niche?: string; idea?: string }): string {
  const topic = opts.topic?.trim();
  const idea = opts.idea?.trim();
  const niche = opts.niche?.trim();
  if (topic) return topic.slice(0, 200);
  if (idea) return idea.slice(0, 200);
  if (niche) return `${niche} industry news product launches debates`.slice(0, 200);
  return 'technology startups';
}

function mapGroundedSources(
  sources: { title: string; url: string | null; snippet?: string }[],
  fetched_at: string,
): ResearchFinding[] {
  return sources.map((s) => ({
    n: 0,
    type: 'web' as const,
    title: s.title.slice(0, 200) || hostOf(s.url) || 'Web result',
    url: s.url,
    fetched_at,
    snippet: s.snippet?.slice(0, 280),
  }));
}

async function parseFindingsFromText(text: string, fetched_at: string): Promise<ResearchFinding[]> {
  if (!text.trim()) return [];
  try {
    const { extractJson } = await import('./json');
    const parsed = FindingListSchema.parse(extractJson(text));
    return parsed.findings.slice(0, 8).map((f) => ({
      n: 0,
      type: 'web' as const,
      title: f.title.slice(0, 200),
      url: f.url ?? null,
      fetched_at,
      snippet: f.snippet?.slice(0, 280) ?? undefined,
    }));
  } catch {
    return [];
  }
}

function mergeFindings(fromText: ResearchFinding[], fromChunks: ResearchFinding[]): ResearchFinding[] {
  const merged: ResearchFinding[] = [...fromText];
  const seen = new Set(merged.map((f) => `${f.title}|${f.url ?? ''}`));
  for (const chunk of fromChunks) {
    const key = `${chunk.title}|${chunk.url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(chunk);
  }
  return merged.slice(0, 8);
}

function shortErr(err: unknown): string {
  if (err instanceof AppError) return err.message.slice(0, 200);
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/**
 * Free, keyless fallback: Hacker News Algolia search.
 * Used when Gemini grounding and OpenRouter web search both fail or return nothing.
 */
async function hnAlgoliaSearch(query: string, fetched_at: string): Promise<ResearchFinding[]> {
  const url =
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}` +
    `&tags=story&hitsPerPage=8&restrictSearchableAttributes=title,url`;
  const res = await requestJson(url, { timeoutMs: 15_000 });
  if (res.status !== 200 || !Array.isArray(res.json?.hits)) {
    throw new AppError(502, 'hn_search_failed', `HN Algolia search HTTP ${res.status}`, 'Retry later.');
  }
  const hits: any[] = res.json.hits;
  const out: ResearchFinding[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const title = String(h?.title || h?.story_title || '').trim();
    const link = typeof h?.url === 'string' && h.url ? h.url : h?.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null;
    if (!title || !link) continue;
    const key = `${title}|${link}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const points = typeof h.points === 'number' ? h.points : null;
    const created = h.created_at ? String(h.created_at) : fetched_at;
    out.push({
      n: 0,
      type: 'web',
      title: title.slice(0, 200),
      url: link,
      fetched_at: created,
      snippet: points != null ? `HN discussion (${points} pts). ${title}` : title,
    });
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * Fresh research before drafting: Gemini Google Search grounding on the topic/niche,
 * with OpenRouter web-search and HN Algolia fallbacks. Newsletters are not used.
 */
export async function runResearch(
  userId: string,
  opts: { topic?: string; niche?: string; idea?: string } = {},
): Promise<ResearchPack> {
  void userId;
  const fetched_at = new Date().toISOString();
  const query = buildSearchQuery(opts);

  let web: ResearchFinding[] = [];
  let research_status: ResearchStatus = 'ok';
  let research_error: string | undefined;

  if (isMock()) {
    web = mockWebFindings(query, fetched_at);
  } else {
    const searchPrompt =
      `Find 4–6 concrete, recent news items, product launches, or debates about: ${query}. ` +
      `Prefer items from the last 14 days. Return short factual angles a founder could react to — not generic advice.`;
    const system =
      'You are a research assistant for a personal social-media writing tool. Prefer verifiable, recent facts with clear titles and URLs. Ignore paywalled fluff.';

    const failures: string[] = [];

    // 1) Gemini Google Search grounding
    try {
      const grounded = await llmGroundedSearch({ query: searchPrompt, system });
      const fromChunks = mapGroundedSources(grounded.sources, fetched_at);
      const fromText = await parseFindingsFromText(grounded.text, fetched_at);
      web = mergeFindings(fromText, fromChunks);
    } catch (err) {
      failures.push(`gemini: ${shortErr(err)}`);
    }

    // 2) OpenRouter web search if Gemini returned nothing
    if (!web.length) {
      try {
        const grounded = await llmOpenRouterWebSearch({ query: searchPrompt, system });
        const fromChunks = mapGroundedSources(grounded.sources, fetched_at);
        const fromText = await parseFindingsFromText(grounded.text, fetched_at);
        web = mergeFindings(fromText, fromChunks);
      } catch (err) {
        failures.push(`openrouter: ${shortErr(err)}`);
      }
    }

    // 3) Keyless HN Algolia fallback when LLM search quotas are exhausted
    if (!web.length) {
      try {
        web = await hnAlgoliaSearch(query, fetched_at);
      } catch (err) {
        failures.push(`hn: ${shortErr(err)}`);
      }
    }

    if (!web.length) {
      research_status = failures.length ? 'failed' : 'empty';
      research_error = failures.length
        ? failures.join(' | ').slice(0, 280)
        : 'Live search returned no usable sources.';
      console.warn(`[research] live search failed: ${research_error}`);
    } else if (failures.length) {
      console.warn(`[research] primary search failed, used fallback (${web.length} sources): ${failures.join(' | ').slice(0, 200)}`);
    }
  }

  const findings: ResearchFinding[] = web.map((f, i) => ({ ...f, n: i + 1 }));

  return {
    fetched_at,
    query,
    findings,
    web: findings,
    newsletters: [],
    research_status,
    research_error,
  };
}

/** Prompt block + id map for the generator. */
export function researchPromptBlock(pack: ResearchPack): string {
  if (!pack.findings.length) {
    const why =
      pack.research_status === 'failed'
        ? `(Live web research failed: ${pack.research_error ?? 'unknown'}. Write from the user profile/style only and set source_ids to [].)`
        : '(No live web findings this run. Write from the user profile/style only and set source_ids to [].)';
    return `<live_research>\n${why}\n</live_research>`;
  }
  const lines = pack.findings.map((f) => {
    const bits = [
      `${f.n}. [${f.type}] ${f.title}`,
      f.url ? `url=${f.url}` : null,
      f.snippet ? `fact=${f.snippet}` : null,
    ].filter(Boolean);
    return bits.join(' | ');
  });
  return (
    `<live_research fetched_at="${pack.fetched_at}" query="${pack.query}">\n` +
    `Each tweet MUST use at least one concrete, recent fact from this list when possible — paraphrase, never copy wording. Cite by number in source_ids.\n` +
    `${lines.join('\n')}\n` +
    `</live_research>`
  );
}

export function resolveDraftSources(pack: ResearchPack, sourceIds: unknown): DraftSource[] {
  if (!Array.isArray(sourceIds) || !sourceIds.length) return [];
  const out: DraftSource[] = [];
  const seen = new Set<number>();
  for (const raw of sourceIds) {
    const n = Number(raw);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    const hit = pack.findings.find((f) => f.n === n);
    if (!hit) continue;
    seen.add(n);
    out.push(asDraftSource(hit));
  }
  return out;
}

export function ideaSource(idea: string): DraftSource {
  return {
    type: 'idea',
    title: idea.trim().slice(0, 120) || 'My idea',
    url: null,
    fetched_at: new Date().toISOString(),
  };
}

export function researchSummary(pack: ResearchPack, drafts: { sources?: DraftSource[] }[]) {
  const cited = new Set<string>();
  for (const d of drafts) {
    for (const s of d.sources ?? []) {
      cited.add(`${s.type}|${s.url ?? s.title}`);
    }
  }
  return {
    fetched_at: pack.fetched_at,
    query: pack.query,
    web_count: pack.web.length,
    newsletter_count: 0,
    finding_count: pack.findings.length,
    cited_count: cited.size,
    live_source_count: pack.web.length,
    research_status: pack.research_status,
    research_error: pack.research_error ?? null,
  };
}
