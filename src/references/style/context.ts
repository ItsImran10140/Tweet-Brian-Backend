import { config } from '../../config';
import { cleanForAnalysis } from '../../lib/text';
import type { ReferenceAccount, StoredTweet, StyleProfile, StyleStats } from '../types';
import { selectRecent, selectStructuralFewShot, type TweetFormat } from './exemplars';
import { statsToBullets } from './stats';

/**
 * Assembles style layers into ONE text block for the generation prompt:
 *   Layer 1  <style_profile> + <style_stats>   (structural card)
 *   Layer 2  <structure_examples>              (3–5 format-relevant few-shots)
 *   Layer 3  <recent_tweets>                   (optional raw recent; trimmed first)
 *
 * Hard rule baked into the block: examples are for structure and rhythm only —
 * never copy wording, facts, or stories.
 */

export interface ContextOptions {
  /** free-text hint from the user, e.g. why they admire this account */
  note?: string;
  fewShotCount?: number;
  rawRecentCount?: number;
  charBudget?: number;
  /** Formats in the current generation batch — used to pick structurally relevant examples. */
  formats?: TweetFormat[];
  /** Prefer these tweet keys (usually the ones used to build the style card). */
  preferExampleKeys?: string[];
}

export interface BuiltContext {
  text: string;
  layers: {
    profileIncluded: boolean;
    statsIncluded: boolean;
    fewShotCount: number;
    rawRecentCount: number;
    skipped?: boolean;
    skipReason?: string;
  };
  chars: number;
  fewShotTweets: StoredTweet[];
  recentTweets: StoredTweet[];
}

const TAG_RE =
  /<\/?(tweet|reference_style|style_profile|style_stats|structure_examples|example_tweets|recent_tweets|why_the_user_admires_it|structure_only_rules)[^>]*>/gi;
const safe = (s: string) => s.replace(TAG_RE, '').trim();

const STRUCTURE_ONLY_RULES = `STRUCTURE ONLY — these examples are for structure and rhythm.
- Copy the shape: hook type, beat order, line-break rhythm, length, concreteness level.
- NEVER copy wording, phrases, facts, numbers, names, or stories from the examples.
- NEVER mention the reference account.
- Write in the user's own voice and from the user's own material.`;

function bullets(items: string[]): string {
  return items.map((i) => `- ${safe(i)}`).join('\n');
}

function profileBlock(p: StyleProfile): string {
  const parts: string[] = [];
  if (p.voiceSummary) parts.push(`Voice: ${safe(p.voiceSummary)}`);
  const tone = p.tone || p.toneDescriptors.join(', ');
  if (tone) parts.push(`Tone: ${safe(tone)}`);
  if (p.hookTypes?.length) parts.push(`Hook types:\n${bullets(p.hookTypes)}`);
  else if (p.hooksAndOpeners.length) parts.push(`Hooks and openers:\n${bullets(p.hooksAndOpeners)}`);
  if (p.tweetStructurePatterns?.length) parts.push(`Tweet structure patterns:\n${bullets(p.tweetStructurePatterns)}`);
  if (p.averageLength) parts.push(`Average length: ${safe(p.averageLength)}`);
  if (p.lineBreakRhythm) parts.push(`Line-break rhythm: ${safe(p.lineBreakRhythm)}`);
  else if (p.formattingRules.length) parts.push(`Formatting habits:\n${bullets(p.formattingRules)}`);
  if (p.concreteness) parts.push(`Concrete vs abstract: ${safe(p.concreteness)}`);
  if (p.humorFrequency) parts.push(`Humor: ${safe(p.humorFrequency)}`);
  if (p.sentenceStructure) parts.push(`Sentence structure: ${safe(p.sentenceStructure)}`);
  if (p.signatureMoves.length) parts.push(`Signature moves:\n${bullets(p.signatureMoves)}`);
  if (p.doList.length) parts.push(`Do (structure):\n${bullets(p.doList)}`);
  if (p.dontList.length) parts.push(`Don't:\n${bullets(p.dontList)}`);
  return parts.join('\n');
}

function tweetsBlock(tag: 'structure_examples' | 'example_tweets' | 'recent_tweets', tweets: StoredTweet[]): string {
  if (tweets.length === 0) return '';
  const body = tweets.map((t) => `<tweet>\n${safe(cleanForAnalysis(t.text))}\n</tweet>`).join('\n');
  return `<${tag}>\n${body}\n</${tag}>`;
}

/** Empty context when an account has nothing usable — generation continues without it. */
export function emptyStyleContext(account: Pick<ReferenceAccount, 'handle'>, reason: string): BuiltContext {
  return {
    text: '',
    layers: {
      profileIncluded: false,
      statsIncluded: false,
      fewShotCount: 0,
      rawRecentCount: 0,
      skipped: true,
      skipReason: reason,
    },
    chars: 0,
    fewShotTweets: [],
    recentTweets: [],
  };
}

export function buildStyleContext(
  account: Pick<ReferenceAccount, 'handle'>,
  tweets: StoredTweet[],
  style: { stats: StyleStats; profile: StyleProfile | null; exampleTweetKeys?: string[] } | undefined,
  opts: ContextOptions = {},
): BuiltContext {
  if (!tweets.length) {
    return emptyStyleContext(account, `No tweets stored for @${account.handle}`);
  }

  const maxFew = opts.fewShotCount ?? config.style.structuralFewShotMax;
  const minFew = Math.min(config.style.structuralFewShotMin, maxFew);
  const rawRecentCount = opts.rawRecentCount ?? config.style.rawRecentCount;
  const budget = opts.charBudget ?? config.style.contextCharBudget;
  const formats = opts.formats ?? [];
  const preferKeys = opts.preferExampleKeys ?? style?.exampleTweetKeys ?? [];

  let fewShot = selectStructuralFewShot(tweets, formats, {
    min: minFew,
    max: maxFew,
    preferKeys,
  });
  let recent = selectRecent(tweets, rawRecentCount, new Set(fewShot.map((t) => t.key)));

  const head = (): string => {
    const lines: string[] = [];
    if (style?.profile) lines.push(`<style_profile>\n${profileBlock(style.profile)}\n</style_profile>`);
    if (style?.stats) lines.push(`<style_stats>\n${statsToBullets(style.stats).map((l) => `- ${l}`).join('\n')}\n</style_stats>`);
    return lines.join('\n');
  };

  const assemble = (): string => {
    const noteLine = opts.note ? `<why_the_user_admires_it>${safe(opts.note).slice(0, 400)}</why_the_user_admires_it>` : '';
    const rules = `<structure_only_rules>\n${STRUCTURE_ONLY_RULES}\n</structure_only_rules>`;
    const inner = [noteLine, rules, head(), tweetsBlock('structure_examples', fewShot), tweetsBlock('recent_tweets', recent)]
      .filter(Boolean)
      .join('\n');
    return `<reference_style account="@${account.handle}">\n${inner}\n</reference_style>`;
  };

  let text = assemble();
  // Trim to budget: drop raw recent tweets first, then few-shot from the tail (keep at least minFew when possible).
  while (text.length > budget && recent.length > 0) {
    recent = recent.slice(0, -1);
    text = assemble();
  }
  while (text.length > budget && fewShot.length > minFew) {
    fewShot = fewShot.slice(0, -1);
    text = assemble();
  }
  while (text.length > budget && fewShot.length > 1) {
    fewShot = fewShot.slice(0, -1);
    text = assemble();
  }

  return {
    text,
    layers: {
      profileIncluded: Boolean(style?.profile),
      statsIncluded: Boolean(style?.stats),
      fewShotCount: fewShot.length,
      rawRecentCount: recent.length,
    },
    chars: text.length,
    fewShotTweets: fewShot,
    recentTweets: recent,
  };
}
