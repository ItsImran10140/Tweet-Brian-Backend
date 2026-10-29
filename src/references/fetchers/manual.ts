import { AppError } from '../../errors';
import type { RawTweet } from '../types';

/**
 * SOURCE 3 - Manual paste / import. Always works, needs no keys.
 *
 * Accepted input:
 *  - `text`: a big pasted block. Tweets are separated by a line containing only `---`.
 *      If there are no `---` lines, blank lines separate tweets.
 *      If there are no blank lines either, every line is one tweet.
 *  - `tweets`: an array of strings or objects { text, createdAt?, likeCount?, retweetCount?, replyCount?, quoteCount? }
 */

export type SplitMode = 'dashes' | 'blank_lines' | 'single_lines' | 'single_tweet' | 'array';

export interface ManualTweetObject {
  text: string;
  createdAt?: string;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  url?: string;
}

const MAX_TWEET_CHARS = 4000; // X long posts can exceed 280

export function splitPastedText(input: string): { parts: string[]; mode: SplitMode } {
  const text = input.replace(/\r\n?/g, '\n').trim();
  if (!text) return { parts: [], mode: 'single_tweet' };

  if (/^\s*---\s*$/m.test(text)) {
    return { parts: text.split(/^\s*---\s*$/m), mode: 'dashes' };
  }
  if (/\n\s*\n/.test(text)) {
    return { parts: text.split(/\n\s*\n/), mode: 'blank_lines' };
  }
  const lines = text.split('\n');
  if (lines.length > 1) return { parts: lines, mode: 'single_lines' };
  return { parts: [text], mode: 'single_tweet' };
}

function cleanPart(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

export function parseManualInput(input: { text?: string; tweets?: (string | ManualTweetObject)[] }): {
  tweets: RawTweet[];
  mode: SplitMode;
  skipped: number;
} {
  const out: RawTweet[] = [];
  let skipped = 0;
  let mode: SplitMode = 'array';

  const push = (obj: ManualTweetObject) => {
    const text = cleanPart(obj.text ?? '');
    if (!text || /^RT @\w+/.test(text)) {
      skipped++;
      return;
    }
    if (text.length > MAX_TWEET_CHARS) {
      skipped++;
      return;
    }
    let createdAt: string | undefined;
    if (obj.createdAt) {
      const ms = Date.parse(obj.createdAt);
      createdAt = Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
    }
    out.push({
      text,
      createdAt,
      likeCount: obj.likeCount,
      retweetCount: obj.retweetCount,
      replyCount: obj.replyCount,
      quoteCount: obj.quoteCount,
      isReply: /^@\w/.test(text),
      url: obj.url,
    });
  };

  if (input.tweets && input.tweets.length > 0) {
    for (const t of input.tweets) push(typeof t === 'string' ? { text: t } : t);
  } else if (input.text && input.text.trim()) {
    const split = splitPastedText(input.text);
    mode = split.mode;
    for (const p of split.parts) push({ text: p });
  } else {
    throw new AppError(400, 'nothing_to_import', 'Provide either "text" or a non-empty "tweets" array.', 'Separate pasted tweets with a line containing only ---');
  }

  if (out.length === 0) {
    throw new AppError(400, 'nothing_to_import', 'No usable tweets found in the input.');
  }
  return { tweets: out, mode, skipped };
}
