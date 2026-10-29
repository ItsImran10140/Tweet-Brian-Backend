import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { config } from '../../config';
import { AppError } from '../../errors';
import { ensureFreshDigest } from '../../digest/pipeline';
import { safetyCheck } from '../../digest/safety';
import { defaultNiche, latestDigest } from '../../digest/store';
import { contextForAccount, ensureStyleCard } from '../../references/service';
import { eligibleTweets } from '../../references/style/eligibility';
import type { TweetFormat } from '../../references/style/exemplars';
import { loadBrain } from '../brain';
import { db } from '../db';
import { llmJson } from '../llm';
import { normalizeStyleCard } from '../voiceStyleCard';
import { voiceSlidersPrompt } from '../voiceSliders';
import { validateTweet } from '../validateTweet';
import { findBannedHits } from './banned';
import { critiqueAndMaybeRewrite, styleMatchScore } from './critique';
import { assignFormats } from './formats';
import { buildMaterialPool, pickMaterialForBatch } from './material';
import {
  researchPromptBlock,
  researchSummary,
  resolveDraftSources,
  runResearch,
} from '../research';
import { GenerationStageLog } from './stageLog';
import type { GenerateOptions } from './types';

const DraftSchema = z.object({
  text: z.string(),
  source_ids: z.array(z.number()).optional().default([]),
});

export async function generateMultiPipeline(userId: string, opts: GenerateOptions = {}) {
  const user = await db.get('users', (u) => u.id === userId);
  const profile = await db.get('personality_profiles', (p) => p.user_id === userId);
  if (!user) throw new AppError(404, 'user_not_found', 'user not found');
  if (!profile) {
    throw new AppError(400, 'no_profile', 'No personality profile yet.', 'Finish onboarding first.');
  }

  const niche = opts.niche ?? user.niche ?? defaultNiche();
  let digestRefresh: unknown;
  if (opts.refreshDigest !== false) {
    digestRefresh = await ensureFreshDigest(niche).catch((e) => ({
      ran: false,
      reason: `digest refresh failed: ${(e as Error).message}`,
    }));
  }

  const brain = loadBrain();
  const refs = await db.all('reference_accounts', (r) => r.user_id === userId && (r.tweets ?? []).length > 0);
  const rules = await db.all('learned_rules', (r) => r.user_id === userId && !r.retired_at);
  const digest = await latestDigest(niche);
  const news = digest.items.map((d: any, i: number) => ({ n: i + 1, row: d }));
  const persona = profile.persona_card ?? {};
  const styleFingerprint = normalizeStyleCard(profile.style_fingerprint);
  const count = opts.count ?? user.daily_tweet_limit ?? 10;
  const batchId = randomUUID();
  const log = new GenerationStageLog(batchId);

  await Promise.all(refs.map((r) => ensureStyleCard(userId, r.id)));

  // ---- 0) Fresh research: live web only (newsletters removed) ----
  const research = await runResearch(userId, { topic: opts.topic, niche });
  log.record(
    'research',
    { query: research.query },
    {
      web: research.web.length,
      findings: research.findings.length,
      research_status: research.research_status,
      research_error: research.research_error ?? null,
    },
  );
  const researchBlock = researchPromptBlock(research);

  // ---- 1) Pick material ----
  const materialPool = await buildMaterialPool({
    userId,
    personaStories: persona.stories,
    topic: opts.topic,
    digestItems: news.map((x) => ({
      n: x.n,
      headline: x.row.headline,
      fact: x.row.fact_summary,
      sourceName: x.row.source_name,
    })),
    referenceAngles: refs.map((r) => ({
      handle: r.handle,
      admireReason: r.admire_reason,
      structurePatterns: r.style?.profile?.tweetStructurePatterns ?? r.style?.profile?.signatureMoves ?? [],
    })),
  });
  const materials = pickMaterialForBatch(materialPool, count);
  log.record('pick_material', { poolSize: materialPool.length, count }, materials.map((m) => ({ id: m.id, source: m.source, label: m.label })));

  // ---- 2) Pick formats (varied) ----
  const formats = assignFormats(count, news.length > 0);
  log.record(
    'pick_formats',
    { count, preferNews: news.length > 0 },
    formats.map((f) => ({ id: f.id, label: f.label })),
  );

  // Reference context for drafting (structure only)
  const uniqueLegacy = [...new Set(formats.map((f) => f.legacyType))] as TweetFormat[];
  const perAccountBudget = Math.max(3000, Math.floor(config.style.contextCharBudget / Math.max(refs.length, 1)));
  const refBlocks: string[] = [];
  const refWarnings: string[] = [];
  for (const r of refs) {
    try {
      const built = await contextForAccount(userId, r.id, {
        charBudget: perAccountBudget,
        formats: uniqueLegacy,
        fewShotCount: config.style.structuralFewShotMax,
      });
      if (!built.text || built.layers.skipped) {
        refWarnings.push(built.layers.skipReason ?? `@${r.handle}: skipped`);
        continue;
      }
      refBlocks.push(built.text);
    } catch (err) {
      refWarnings.push(`@${r.handle}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const writerProfile = {
    personaCard: persona,
    voiceGuidance: profile.voice_guidance,
    styleFingerprint,
    voiceSliders: voiceSlidersPrompt(profile.voice_sliders),
    doList: profile.do_list,
    dontList: profile.dont_list,
  };
  const styleCardJson = JSON.stringify(styleFingerprint, null, 2);
  const banned = config.generation.bannedPatterns;

  const systemBase = [
    '<writer_profile>\n' + JSON.stringify(writerProfile, null, 2) + '\n</writer_profile>',
    rules.length ? '<rules>\n' + JSON.stringify(rules.map((r) => ({ source: r.source, rule: r.rule_text })), null, 2) + '\n</rules>' : '',
    refBlocks.length
      ? '<reference_styles>\nSTRUCTURE AND RHYTHM ONLY. Never copy wording, facts, or stories.\n\n' +
        refBlocks.join('\n\n') +
        '\n</reference_styles>'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const refSamples = refs.flatMap((r) => eligibleTweets(r.tweets).map((t) => t.text)).slice(0, 2000);
  const ctx = {
    bannedWords: persona.bannedWords ?? [],
    offLimitsTopics: persona.offLimitsTopics ?? [],
    usesHashtags: !!styleFingerprint.usesHashtags,
    referenceSamples: refSamples,
  };
  const safetyCtx = {
    digestText: news.map((x) => `${x.row.headline} ${x.row.fact_summary}`).join(' '),
    digestShingles: [...new Set(news.flatMap((x) => (x.row.shingles ?? []) as string[]))],
    profileText: JSON.stringify([persona, profile.voice_guidance, opts.topic ?? '']),
  };

  const rejectLog: { text: string; reasons: string[]; draftIndex: number }[] = [];
  const saved = [];

  for (let i = 0; i < count; i++) {
    const material = materials[i];
    const format = formats[i];

    // ---- 3) Draft ----
    const draftPrompt = {
      format: { id: format.id, label: format.label, brief: format.brief },
      material: { source: material.source, label: material.label, text: material.text },
      research_findings: research.findings.length,
      requirements: [
        research.findings.length
          ? 'Each draft MUST use at least one concrete, recent fact from <live_research> and set source_ids to those numbers.'
          : 'No live research findings available — write from style/profile and set source_ids to [].',
        'Only if a finding truly cannot support this format/material, return source_ids: [].',
        'Match the user style card: sentence rhythm, contraction habits, openings/closings, formality.',
        'Max 280 characters. No hashtags unless styleFingerprint.usesHashtags is true.',
        'Reference styles are for structure only — never copy their wording, facts, or stories.',
      ],
    };
    log.record('draft_input', draftPrompt, null, i);

    let draftText = '';
    let draftSourceIds: number[] = [];
    try {
      const drafted = await llmJson(
        {
          kind: 'draft',
          brain: brain.text,
          system: systemBase,
          temperature: 0.85,
          maxTokens: 1024,
          meta: { format: format.id, material: material.source },
          user: `Write ONE tweet.

FORMAT (${format.label}):
${format.brief}

MATERIAL (user-owned context — do not invent biography):
${material.text}

${researchBlock}

USER STYLE CARD:
${styleCardJson}

HARD REQUIREMENTS:
${
  research.findings.length
    ? '- You MUST use at least one concrete, recent fact from <live_research>; paraphrase, never invent stats\n- Set "source_ids" to the <live_research> numbers you used\n- Only if none of the findings can honestly support this tweet, set "source_ids" to []'
    : '- No live research findings — set "source_ids" to []'
}
- User's own sentence rhythm and contraction habits from the style card
- Never copy wording/facts/stories from <reference_styles>
- Avoid banned patterns: ${banned.slice(0, 8).join('; ')}…

Return JSON: { "text": "...", "source_ids": [<live_research numbers you used, or empty>] }`,
        },
        DraftSchema,
      );
      draftText = drafted.text.trim().slice(0, 280);
      draftSourceIds = drafted.source_ids ?? [];
    } catch (err) {
      log.record('draft_error', draftPrompt, { error: err instanceof Error ? err.message : String(err) }, i);
      rejectLog.push({ text: '', reasons: [`draft_failed: ${err instanceof Error ? err.message : String(err)}`], draftIndex: i });
      continue;
    }
    log.record('draft_output', { format: format.id, material: material.id, source_ids: draftSourceIds }, { text: draftText }, i);

    // ---- 4) Critique + rewrite ----
    let critique;
    try {
      critique = await critiqueAndMaybeRewrite({
        draft: draftText,
        formatLabel: format.label,
        materialLabel: material.label,
        styleCardJson,
        bannedPatterns: banned,
      });
    } catch (err) {
      log.record('critique_error', { draft: draftText }, { error: err instanceof Error ? err.message : String(err) }, i);
      critique = {
        voiceMatch: 5,
        specificity: 5,
        originality: 5,
        bannedHits: findBannedHits(draftText, banned),
        pass: false,
        rewrite: null,
        notes: 'critique_failed',
      };
    }
    log.record('critique_output', { draft: draftText }, critique, i);

    let finalText = critique.rewrite?.trim() || draftText;
    if (critique.rewrite) {
      log.record('rewrite_output', { before: draftText }, { text: finalText }, i);
    }

    // Local banned re-check after rewrite
    const postHits = findBannedHits(finalText, banned);
    if (postHits.length) {
      critique.bannedHits = [...new Set([...critique.bannedHits, ...postHits])];
      critique.pass = false;
    }

    const v = validateTweet(finalText, ctx);
    const sg = safetyCheck(finalText, safetyCtx);
    const reasons = [...v.reasons, ...sg.reasons];
    if (reasons.length) {
      rejectLog.push({ text: finalText, reasons, draftIndex: i });
      log.record('rejected', { text: finalText }, { reasons }, i);
      continue;
    }

    const matchScore = styleMatchScore(critique);
    const src = material.digestIndex ? news.find((x) => x.n === material.digestIndex)?.row : undefined;
    const sources = resolveDraftSources(research, draftSourceIds);
    const liveKind = sources.some((s) => s.type === 'web');

    const row = {
      id: randomUUID(),
      user_id: userId,
      text: finalText,
      original_text: draftText,
      edited_text: critique.rewrite ? finalText : null,
      tweet_type: format.legacyType,
      format_id: format.id,
      format_label: format.label,
      material_source: material.source,
      material_label: material.label,
      material_id: material.id,
      sources,
      style_match_score: matchScore,
      critique: {
        voiceMatch: critique.voiceMatch,
        specificity: critique.specificity,
        originality: critique.originality,
        bannedHits: critique.bannedHits,
        pass: critique.pass,
        notes: critique.notes,
      },
      niche,
      kind: liveKind || src ? 'news' : 'evergreen',
      source_name: sources[0]?.title ?? src?.source_name ?? null,
      source_url: sources[0]?.url ?? src?.source_url ?? null,
      source_headline: sources[0]?.title ?? src?.headline ?? null,
      verify_note: sources.length || src ? 'Check the source link before you post.' : null,
      brain_version: brain.version,
      batch_id: batchId,
      pipeline: 'multi',
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    const persist = opts.persist !== false;
    const savedRow = persist ? await db.insert('generated_tweets', row) : row;
    saved.push(savedRow);
    log.record('saved', { draftIndex: i }, { id: savedRow.id, style_match_score: matchScore, format: format.id, material: material.source, sources: sources.length }, i);
  }

  if (opts.persist !== false) {
    await db.update('learned_rules', (r) => r.user_id === userId && !r.retired_at, { last_applied_at: new Date().toISOString() });
  }
  const stageSummary = log.summary();

  const researchMeta = researchSummary(research, saved);

  return {
    batch_id: batchId,
    pipeline: 'multi' as const,
    requested: count,
    saved: saved.length,
    dropped_after_retries: rejectLog.length,
    research: researchMeta,
    used: {
      niche,
      digest_date: digest.digest_date,
      digest_items: news.map((x) => ({ n: x.n, headline: x.row.headline, source: x.row.source_name })),
      reference_accounts: refs.map((r) => r.handle),
      reference_blocks_used: refBlocks.length,
      reference_warnings: refWarnings,
      topic: opts.topic?.trim() || null,
      learned_rules: rules.length,
      material_pool_size: materialPool.length,
      formats: formats.map((f) => f.id),
      live_web: research.web.length,
      research_status: research.research_status,
      research_error: research.research_error ?? null,
    },
    ...(digestRefresh ? { digest_refresh: digestRefresh } : {}),
    news_tweets: saved.filter((t) => t.kind === 'news').length,
    evergreen_tweets: saved.filter((t) => t.kind === 'evergreen').length,
    rejected_drafts: rejectLog,
    stage_log: {
      log_file: stageSummary.log_file,
      stages: stageSummary.stages,
      // Full entries included for debugging; file has the durable copy
      entries: stageSummary.entries,
    },
    tweets: saved,
  };
}
