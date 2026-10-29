import { config } from '../../config';
import { AppError } from '../../errors';
import { requestJson } from '../http';
import { extractJson } from '../json';

/**
 * ONE place that talks to language models.
 *   - Gemini      (main)         -> Google AI Studio key
 *   - OpenRouter  (free testing) -> OpenRouter key, default model "openrouter/free"
 *   - mock        (no keys)      -> canned answers so every endpoint can be tried for free
 * If the main provider fails (quota, outage, bad model name) the fallback provider is tried automatically.
 */

export type LlmKind = 'synthesize' | 'generate' | 'draft' | 'critique' | 'learn' | 'ref_profile' | 'voice_fingerprint' | 'digest' | 'ping' | 'research';

export interface GroundedSearchSource {
  title: string;
  url: string | null;
  snippet?: string;
}

export interface GroundedSearchResult {
  text: string;
  sources: GroundedSearchSource[];
  provider: string;
  model: string;
}

export interface LlmCall {
  kind: LlmKind;
  /** main system block (the brain file, or a task-specific system prompt) */
  brain: string;
  /** extra system context appended after `brain` */
  system?: string;
  user: string;
  /** only used by the mock */
  meta?: any;
  maxTokens?: number;
  temperature?: number;
  /** ask the provider for JSON output where it supports a JSON mode */
  json?: boolean;
}

interface CompleteInput {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  json: boolean;
}
interface Provider {
  name: 'gemini' | 'openrouter';
  model: string;
  complete(input: CompleteInput): Promise<string>;
}

const timeoutMs = () => config.llm.timeoutSeconds * 1000;

// ---------- providers ----------

function geminiHint(status: number): string {
  if (status === 400) return 'Check llm.gemini.model in config.yml and that the API key is a Google AI Studio key.';
  if (status === 401 || status === 403) return 'The Gemini API key was rejected. Create a new one at https://aistudio.google.com/apikey and paste it into llm.gemini.api_key.';
  if (status === 404) return `Model "${config.llm.gemini.model}" is not available for this key. Try "gemini-3.5-flash-lite" or "gemini-3.8-flash" in llm.gemini.model.`;
  if (status === 429) return 'Gemini free-tier rate limit hit. Wait a minute, pick a model with more free requests (gemini-3.5-flash-lite), or rely on the OpenRouter fallback.';
  return 'See the message above. Gemini errors are usually a bad key, a bad model name, or a rate limit.';
}

function makeGemini(): Provider {
  const { apiKey, baseUrl } = config.llm.gemini;
  const model = config.llm.gemini.model.replace(/^models\//, '');
  return {
    name: 'gemini',
    model,
    async complete({ system, user, maxTokens, temperature, json }) {
      const res = await requestJson(`${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey as string },
        timeoutMs: timeoutMs(),
        body: {
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: 'application/json' } : {}) },
        },
      });
      if (res.status !== 200) {
        const msg = res.json?.error?.message ?? res.text.slice(0, 300);
        throw new AppError(502, 'gemini_error', `Gemini API error ${res.status}: ${msg}`, geminiHint(res.status));
      }
      const cand = res.json?.candidates?.[0];
      const parts: { text?: string; thought?: boolean }[] = cand?.content?.parts ?? [];
      const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
      if (!text) {
        const why = res.json?.promptFeedback?.blockReason ?? cand?.finishReason ?? 'empty response';
        throw new AppError(502, 'gemini_empty', `Gemini returned no text (${why}).`, 'Try again, or switch llm.gemini.model.');
      }
      return text;
    },
  };
}

function makeOpenRouter(): Provider {
  const { apiKey, model, baseUrl } = config.llm.openrouter;
  return {
    name: 'openrouter',
    model,
    async complete({ system, user, maxTokens, temperature }) {
      const res = await requestJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'http://localhost', 'X-Title': 'Tweet Brain' },
        timeoutMs: timeoutMs(),
        body: {
          model,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature,
        },
      });
      if (res.status !== 200 || res.json?.error) {
        const msg = res.json?.error?.message ?? res.text.slice(0, 300);
        const status = res.json?.error?.code ?? res.status;
        const hint =
          status === 401
            ? 'The OpenRouter key was rejected. Create one at https://openrouter.ai/keys and paste it into llm.openrouter.api_key.'
            : status === 429
              ? 'OpenRouter free models are rate limited. Wait a minute and retry.'
              : status === 404
                ? `Model "${model}" was not found on OpenRouter. Use "openrouter/free" or pick an id from https://openrouter.ai/models?pricing=free`
                : 'See the message above.';
        throw new AppError(502, 'openrouter_error', `OpenRouter error ${status}: ${msg}`, hint);
      }
      const content = res.json?.choices?.[0]?.message?.content;
      const text = (Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : String(content ?? '')).trim();
      if (!text) throw new AppError(502, 'openrouter_empty', 'OpenRouter returned an empty answer.', 'Retry; free models sometimes return nothing under load.');
      return text;
    },
  };
}

// ---------- which providers will be used ----------

export interface ChainInfo {
  mock: boolean;
  providers: Provider[];
  notes: string[];
}

export function resolveChain(): ChainInfo {
  const notes: string[] = [];
  const wanted: string[] = [];
  if (config.llm.provider === 'auto') wanted.push('gemini', 'openrouter');
  else wanted.push(config.llm.provider);
  if (config.llm.fallback !== 'none') wanted.push(config.llm.fallback);

  if (wanted[0] === 'mock') return { mock: true, providers: [], notes: ['llm.provider is "mock": answers are fake.'] };

  const providers: Provider[] = [];
  for (const name of [...new Set(wanted)]) {
    if (name === 'mock') continue;
    if (name === 'gemini') {
      if (config.llm.gemini.apiKey) providers.push(makeGemini());
      else notes.push('Gemini skipped: llm.gemini.api_key is empty.');
    } else if (name === 'openrouter') {
      if (config.llm.openrouter.apiKey) providers.push(makeOpenRouter());
      else notes.push('OpenRouter skipped: llm.openrouter.api_key is empty.');
    }
  }
  if (providers.length === 0) {
    notes.push('No LLM API key found, so MOCK mode is active (fake answers). Put a key in config.yml to go live.');
    return { mock: true, providers: [], notes };
  }
  return { mock: false, providers, notes };
}

export const isMock = (): boolean => resolveChain().mock;

export function llmInfo() {
  const c = resolveChain();
  return {
    mode: c.mock ? 'mock' : 'live',
    order: c.providers.map((p) => ({ provider: p.name, model: p.model })),
    notes: c.notes,
  };
}

// ---------- calling ----------

async function completeReal(c: LlmCall, forceJson: boolean): Promise<{ text: string; provider: string; model: string }> {
  const { providers } = resolveChain();
  const input: CompleteInput = {
    system: [c.brain, c.system].filter(Boolean).join('\n\n'),
    user: c.user,
    maxTokens: c.maxTokens ?? 8192,
    temperature: c.temperature ?? (c.kind === 'generate' || c.kind === 'draft' ? 0.9 : 0.3),
    json: c.json ?? forceJson,
  };
  const failures: string[] = [];
  for (const p of providers) {
    try {
      const text = await p.complete(input);
      return { text, provider: p.name, model: p.model };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${p.name} (${p.model}): ${msg}`);
      if (providers.length > 1 && p !== providers[providers.length - 1]) console.warn(`[llm] ${p.name} failed, trying next provider. ${msg}`);
    }
  }
  throw new AppError(502, 'llm_failed', `Every LLM provider failed. ${failures.join(' | ')}`, 'Run GET /api/llm/test to see which key or model is wrong.', failures);
}

export async function llmText(c: LlmCall): Promise<string> {
  if (isMock()) return JSON.stringify(mockAnswer(c));
  return (await completeReal(c, false)).text;
}

/**
 * Gemini generateContent with Google Search grounding.
 * Returns model text plus citation chunks (title/url) from groundingMetadata.
 */
export async function llmGroundedSearch(opts: {
  query: string;
  system?: string;
}): Promise<GroundedSearchResult> {
  if (isMock()) {
    return {
      text: JSON.stringify({
        findings: [
          { title: `Mock result for ${opts.query.slice(0, 60)}`, url: 'https://news.ycombinator.com', snippet: 'Mock recent discussion.' },
        ],
      }),
      sources: [
        { title: `Mock result for ${opts.query.slice(0, 60)}`, url: 'https://news.ycombinator.com', snippet: 'Mock recent discussion.' },
      ],
      provider: 'mock',
      model: 'mock',
    };
  }

  const { apiKey, baseUrl } = config.llm.gemini;
  if (!apiKey) {
    throw new AppError(503, 'gemini_search_unavailable', 'Gemini is not configured for live web research.', 'Set llm.gemini.api_key to enable Google Search grounding.');
  }

  const model = config.llm.gemini.model.replace(/^models\//, '');
  const userPrompt =
    `Search the live web now for current information.\n\n${opts.query}\n\n` +
    `After searching, reply with JSON only:\n` +
    `{ "findings": [{ "title": "...", "url": "https://...", "snippet": "one concrete recent fact" }] }\n` +
    `Include 4–6 findings with real URLs from the search results when possible.`;

  const res = await requestJson(`${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey as string },
    timeoutMs: timeoutMs(),
    body: {
      ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      tools: [{ google_search: {} }],
      // temperature 1.0: low temps often skip search and leave groundingMetadata empty
      generationConfig: { temperature: 1.0, maxOutputTokens: 2048 },
    },
  });

  if (res.status !== 200) {
    const msg = res.json?.error?.message ?? res.text.slice(0, 300);
    throw new AppError(502, 'gemini_error', `Gemini search error ${res.status}: ${msg}`, geminiHint(res.status));
  }

  const cand = res.json?.candidates?.[0];
  const parts: { text?: string; thought?: boolean }[] = cand?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought).map((p) => p.text ?? '').join('').trim();
  const meta = cand?.groundingMetadata ?? res.json?.candidates?.[0]?.groundingMetadata ?? {};
  const chunks: any[] = meta.groundingChunks ?? [];
  const sources: GroundedSearchSource[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const web = chunk?.web ?? chunk;
    const url = typeof web?.uri === 'string' ? web.uri : typeof web?.url === 'string' ? web.url : null;
    const title = typeof web?.title === 'string' && web.title.trim() ? web.title.trim() : url ? (() => { try { return new URL(url).hostname; } catch { return 'Web result'; } })() : 'Web result';
    const key = `${title}|${url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ title, url, snippet: undefined });
  }

  return { text, sources, provider: 'gemini', model };
}

/**
 * OpenRouter chat completion with the web search plugin (fallback when Gemini grounding fails).
 */
export async function llmOpenRouterWebSearch(opts: {
  query: string;
  system?: string;
}): Promise<GroundedSearchResult> {
  if (isMock()) {
    return {
      text: JSON.stringify({
        findings: [
          { title: `Mock OR result for ${opts.query.slice(0, 60)}`, url: 'https://news.ycombinator.com', snippet: 'Mock recent discussion.' },
        ],
      }),
      sources: [
        { title: `Mock OR result for ${opts.query.slice(0, 60)}`, url: 'https://news.ycombinator.com', snippet: 'Mock recent discussion.' },
      ],
      provider: 'mock',
      model: 'mock',
    };
  }

  const { apiKey, baseUrl, model } = config.llm.openrouter;
  if (!apiKey) {
    throw new AppError(503, 'openrouter_search_unavailable', 'OpenRouter is not configured for live web research fallback.', 'Set llm.openrouter.api_key.');
  }

  const userPrompt =
    `Search the live web now for current information.\n\n${opts.query}\n\n` +
    `After searching, reply with JSON only:\n` +
    `{ "findings": [{ "title": "...", "url": "https://...", "snippet": "one concrete recent fact" }] }\n` +
    `Include 4–6 findings with real URLs from the search results.`;

  const res = await requestJson(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'http://localhost', 'X-Title': 'Tweet Brain' },
    timeoutMs: timeoutMs(),
    body: {
      model,
      messages: [
        ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.3,
      plugins: [{ id: 'web', max_results: 6 }],
    },
  });

  if (res.status !== 200 || res.json?.error) {
    const msg = res.json?.error?.message ?? res.text.slice(0, 300);
    const status = res.json?.error?.code ?? res.status;
    throw new AppError(502, 'openrouter_error', `OpenRouter search error ${status}: ${msg}`, 'Check llm.openrouter.api_key / model, or wait if rate limited.');
  }

  const message = res.json?.choices?.[0]?.message;
  const content = message?.content;
  const text = (Array.isArray(content) ? content.map((c: any) => c?.text ?? '').join('') : String(content ?? '')).trim();
  const sources: GroundedSearchSource[] = [];
  const seen = new Set<string>();

  const annotations: any[] = Array.isArray(message?.annotations) ? message.annotations : [];
  for (const ann of annotations) {
    const cite = ann?.url_citation ?? ann;
    if (ann?.type && ann.type !== 'url_citation' && !cite?.url) continue;
    const url = typeof cite?.url === 'string' ? cite.url : null;
    const title =
      typeof cite?.title === 'string' && cite.title.trim()
        ? cite.title.trim()
        : url
          ? (() => {
              try {
                return new URL(url).hostname;
              } catch {
                return 'Web result';
              }
            })()
          : 'Web result';
    const key = `${title}|${url ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      title,
      url,
      snippet: typeof cite?.content === 'string' ? cite.content.slice(0, 280) : undefined,
    });
  }

  return { text, sources, provider: 'openrouter', model };
}

/** Call, parse JSON, validate with zod, retry once on bad JSON (provider failures are NOT retried here). */
export async function llmJson<T>(c: LlmCall, schema: { parse: (x: unknown) => T }): Promise<T> {
  let lastErr: unknown;
  let lastRaw = '';
  for (let i = 0; i < 2; i++) {
    const call: LlmCall = i === 0 ? c : { ...c, user: c.user + '\n\nYour last reply was not valid JSON for the requested shape. Return ONLY the JSON, no commentary, no markdown fences.' };
    try {
      lastRaw = isMock() ? JSON.stringify(mockAnswer(call)) : (await completeReal(call, true)).text;
      return schema.parse(extractJson(lastRaw));
    } catch (err) {
      if (err instanceof AppError) throw err;
      lastErr = err;
    }
  }
  const why = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new AppError(502, 'llm_bad_output', `The model did not return usable JSON (tried twice): ${why.slice(0, 400)}`, 'Try again. If it keeps happening, use a stronger model in config.yml (e.g. gemini-3.8-flash).', lastRaw.slice(0, 500));
}

/** Tests each configured provider separately so you can see which key works. */
export async function llmPing(): Promise<unknown> {
  const chain = resolveChain();
  if (chain.mock) return { mode: 'mock', ok: true, notes: chain.notes, message: 'No real provider is configured, so nothing to test. Add a key to config.yml.' };
  const results = [];
  for (const p of chain.providers) {
    const t0 = Date.now();
    try {
      const reply = await p.complete({ system: 'You are a connectivity test.', user: 'Reply with exactly one word: pong', maxTokens: 64, temperature: 0, json: false });
      results.push({ provider: p.name, model: p.model, ok: true, ms: Date.now() - t0, reply: reply.slice(0, 80) });
    } catch (err) {
      const e = err instanceof AppError ? err : new AppError(502, 'llm_error', String(err));
      results.push({ provider: p.name, model: p.model, ok: false, ms: Date.now() - t0, error: e.message, hint: e.hint });
    }
  }
  return { mode: 'live', ok: results.some((r) => r.ok), results, notes: chain.notes };
}

// ---------- MOCK MODE: lets you see every endpoint work with no API key ----------

function mockAnswer(c: LlmCall): unknown {
  switch (c.kind) {
    case 'synthesize':
      return {
        summary: '[MOCK] Analytical, contrarian builder who writes short, direct posts and prefers data over vibes.',
        dimensions: {},
        thinkingStyle: {},
        lenses: c.meta?.lenses ?? [],
        personaCard: {
          bio: '[MOCK] Founder writing about tech and business.',
          expertise: ['startups', 'AI'],
          values: ['speed', 'honesty'],
          stories: c.meta?.stories ?? [],
          bannedWords: c.meta?.bannedWords ?? [],
          offLimitsTopics: c.meta?.offLimits ?? [],
        },
        styleFingerprint: {
          avgSentenceLength: 9,
          avgSentenceWords: 9,
          sentenceLengthRange: { min: 4, max: 18 },
          lineBreakHabits: 'Short paragraphs',
          usesContractions: true,
          punctuationQuirks: [],
          capitalizationStyle: 'Sentence case',
          humorType: 'dry',
          typicalOpenings: ['Hot take:'],
          typicalClosings: ['Try this.'],
          wordsAndPhrasesOftenUsed: ['ship'],
          wordsNeverUsed: ['synergy'],
          formalityLevel: 3,
          usesHashtags: false,
          usesEmoji: false,
          openers: ['Hot take:'],
          tone: 'direct, dry',
        },
        voiceGuidance: '[MOCK] Short sentences. Take a side. No fluff.',
        doList: ['Take a clear position', 'Use concrete numbers'],
        dontList: ['Hedge', 'Use corporate jargon'],
        openQuestions: ['What is your biggest professional failure?'],
      };
    case 'ref_profile':
      return {
        voiceSummary: '[MOCK] Punchy, practical and encouraging. Short posts with a clear takeaway.',
        toneDescriptors: ['direct', 'practical', 'upbeat'],
        sentenceStructure: 'Short sentences and fragments.',
        vocabulary: 'Plain words, light startup jargon.',
        hooksAndOpeners: ['Opens with a bold claim or a number'],
        formattingRules: ['Line breaks between ideas', 'Rarely uses hashtags'],
        recurringTopics: ['shipping', 'distribution', 'pricing'],
        signatureMoves: ['Contrast (X vs Y)', 'Ends with a blunt takeaway'],
        doList: ['Lead with the point', 'Keep it under 200 characters'],
        dontList: ['Hedge', 'Use corporate jargon'],
        hookTypes: ['bold claim', 'number lead', 'contrast'],
        tweetStructurePatterns: [
          'story with escalation',
          'analogy plus 3-beat logic',
          'reactive take plus personal angle',
        ],
        averageLength: '~140 characters / 2 short lines',
        lineBreakRhythm: 'One idea per line; blank line before the takeaway',
        tone: 'direct, practical',
        concreteness: 'Highly concrete — prefers numbers and named tactics over abstractions',
        humorFrequency: 'Occasional dry asides; never the main point',
      };
    case 'voice_fingerprint':
      return {
        avgSentenceLength: 11,
        sentenceLengthRange: { min: 4, max: 22 },
        lineBreakHabits: 'Single short paragraphs; blank line between ideas',
        usesContractions: true,
        punctuationQuirks: ['occasional em dash', 'rare ellipsis'],
        capitalizationStyle: 'Sentence case; rarely all-caps',
        humorType: 'dry, observational',
        typicalOpenings: ['Hot take:', 'Nobody talks about'],
        typicalClosings: ['Try this next.', 'What am I missing?'],
        wordsAndPhrasesOftenUsed: ['honestly', 'ship', 'concrete'],
        wordsNeverUsed: ['synergy', 'leverage', 'delve'],
        formalityLevel: 3,
        usesHashtags: false,
        usesEmoji: false,
        tone: 'direct, dry',
        openers: ['Hot take:', 'Nobody talks about'],
        avgSentenceWords: 11,
      };
    case 'generate': {
      const plan: string[] = c.meta?.plan ?? [];
      const texts: Record<string, string> = {
        opinion: 'Most roundups summarize. Almost none tell you what to actually do next.',
        lesson: 'Ship the ugly version on day one. Feedback beats polish every time.',
        story: 'Lost my first client over a late reply. Now I answer within the hour.',
        question: 'What is one tool you pay for but never open?',
        humor: 'My backlog is not a list. It is a museum of good intentions.',
      };
      const newsItems: number = c.meta?.newsItems ?? 0;
      const researchItems: number = c.meta?.researchItems ?? 0;
      return plan.map((type, i) => ({
        text: `${texts[type] ?? texts.opinion} (${String.fromCharCode(97 + (i % 26))})`,
        type,
        source: newsItems > 0 && i < 3 ? (i % newsItems) + 1 : null,
        source_ids: researchItems > 0 && i % 2 === 0 ? [(i % researchItems) + 1] : [],
      }));
    }
    case 'draft': {
      const format = c.meta?.format ?? 'contrarian_one_liner';
      if (format === 'from_idea') {
        return {
          variants: [
            'Shipped ugly v0.1 to 12 users. Three left. Feedback beat polish.',
            'I answered support in under an hour after losing a client once.',
            'What is one feature you shipped before it felt ready?',
          ],
        };
      }
      return {
        text: `[MOCK ${format}] Shipped the ugly v0.1 to 12 users. Three churned. Feedback beat polish.`,
        source_ids: [1],
      };
    }
    case 'critique': {
      const min = c.meta?.minScore ?? 6;
      const localHits: string[] = c.meta?.localHits ?? [];
      const pass = localHits.length === 0;
      return {
        voiceMatch: pass ? 8 : 4,
        specificity: pass ? 8 : 5,
        originality: pass ? 7 : 4,
        bannedHits: localHits,
        pass: pass && 8 >= min,
        rewrite: pass ? null : 'Shipped ugly v0.1 to 12 users. Three left. I answer support in under an hour now.',
        notes: pass ? '[MOCK] solid' : '[MOCK] rewrote banned/weak phrasing',
      };
    }
    case 'learn':
      return {
        rules: (c.meta?.discardGroups ?? [])
          .filter((g: any) => g.ids.length >= 3)
          .map((g: any) => ({ rule_text: `[MOCK] Avoid drafts that are "${g.reason}" (user discarded ${g.ids.length} like this).`, supporting_event_ids: g.ids })),
        contradicted_rule_ids: [],
      };
    case 'digest': {
      const cands: { n: number; title: string }[] = c.meta?.candidates ?? [];
      return cands.slice(0, c.meta?.want ?? 10).map((x) => ({
        candidate: x.n,
        headline: `[MOCK] Update ${x.n}: something notable happened`,
        fact_summary: `[MOCK] A development was reported in the niche (item ${x.n}). Open the source link for the details.`,
        category: 'industry',
      }));
    }
    case 'ping':
      return { reply: 'pong' };
  }
}
