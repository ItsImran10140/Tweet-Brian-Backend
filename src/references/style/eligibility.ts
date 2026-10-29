import { cleanForAnalysis } from '../../lib/text';
import type { StoredTweet } from '../types';

/** Tweets worth learning style from: original posts with real text (not replies, not link-only). */
export function isStyleEligible(t: StoredTweet): boolean {
  if (t.isReply) return false;
  return cleanForAnalysis(t.text).length >= 12;
}

export function eligibleTweets(tweets: StoredTweet[]): StoredTweet[] {
  return tweets.filter(isStyleEligible);
}

export function engagementScore(t: StoredTweet): number {
  return t.likeCount + 2 * t.retweetCount + 1.5 * t.replyCount + 2 * t.quoteCount;
}

export function hasAnyMetrics(tweets: StoredTweet[]): boolean {
  return tweets.some((t) => engagementScore(t) > 0);
}
