export type SourceName = 'x_api' | 'third_party' | 'manual';
/** auto = try each configured source in order until one works; all = run every configured source and merge. */
export type SyncSource = SourceName | 'auto' | 'all';

/** A tweet as it comes out of any fetcher, before it is stored. */
export interface RawTweet {
  /** Real tweet id when available (x_api / third_party). Manual tweets get no id. */
  id?: string;
  text: string;
  createdAt?: string; // ISO string
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  quoteCount?: number;
  isReply?: boolean;
  isRetweet?: boolean;
  url?: string;
}

/** A tweet as stored in the database. */
export interface StoredTweet {
  /** Stable internal id: `tw_<sha1 of normalized text>` so the same tweet is never stored twice. */
  key: string;
  tweetId?: string;
  text: string;
  createdAt?: string;
  likeCount: number;
  retweetCount: number;
  replyCount: number;
  quoteCount: number;
  isReply: boolean;
  source: SourceName;
  addedAt: string;
}

export interface ReferenceAccount {
  id: string;
  handle: string; // without @
  displayName?: string;
  preferredSource: SyncSource;
  createdAt: string;
  lastSyncAt?: string;
  lastSyncSource?: SourceName;
}

export interface StyleStats {
  tweetCount: number;
  avgChars: number;
  medianChars: number;
  avgWords: number;
  pctWithLineBreaks: number;
  pctWithEmoji: number;
  pctWithHashtag: number;
  pctWithQuestion: number;
  pctEndingWithQuestion: number;
  pctWithExclamation: number;
  pctStartingLowercase: number;
  pctWithNumbers: number;
  pctListLike: number;
  pctWithEmDash: number;
  pctWithEllipsis: number;
  pctThreadStarters: number;
  topOpeners: { phrase: string; count: number }[];
  topHashtags: { tag: string; count: number }[];
  topEmoji: { emoji: string; count: number }[];
  topWords: { word: string; count: number }[];
}

/**
 * Structural style card for a reference account.
 * Describes HOW the account writes (hooks, patterns, rhythm) — never what to say.
 */
export interface StyleProfile {
  voiceSummary: string;
  toneDescriptors: string[];
  sentenceStructure: string;
  vocabulary: string;
  hooksAndOpeners: string[];
  formattingRules: string[];
  recurringTopics: string[];
  signatureMoves: string[];
  doList: string[];
  dontList: string[];
  /** Structural fields used at generation time */
  hookTypes: string[];
  tweetStructurePatterns: string[];
  averageLength: string;
  lineBreakRhythm: string;
  tone: string;
  concreteness: string;
  humorFrequency: string;
}

export interface StoredStyle {
  accountId: string;
  generatedAt: string;
  tweetsAnalyzed: number;
  /** Keys of the top-performing tweets used to build the card (and preferred as few-shot pool). */
  exampleTweetKeys: string[];
  /** True when fewer than style.top_performing_min eligible tweets were available. */
  lowCoverage?: boolean;
  /** True when this result was served from cache (no new LLM call). */
  fromCache?: boolean;
  stats: StyleStats;
  /** null when no LLM is configured, or the LLM call failed / no data. */
  profile: StyleProfile | null;
  profileError?: string;
}

/** A connected reference account as stored in the `reference_accounts` table (one row per user + handle). */
export interface RefAccountRow {
  id: string;
  user_id: string;
  handle: string; // without @
  display_name?: string;
  preferred_source: SyncSource;
  /** why the user admires this account (free text, shown to the LLM as a hint) */
  admire_reason: string;
  created_at: string;
  last_sync_at?: string;
  last_sync_source?: SourceName;
  tweets: StoredTweet[];
  style: StoredStyle | null;
}
