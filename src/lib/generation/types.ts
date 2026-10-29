export interface GenerateOptions {
  /** extra material to react to */
  topic?: string;
  /** override the user's daily_tweet_limit for this run */
  count?: number;
  /** which niche digest to read */
  niche?: string;
  /** build today's digest first if it is missing or stale (default true) */
  refreshDigest?: boolean;
  /** Override config generation.pipeline for this request (A/B). */
  pipeline?: 'multi' | 'single';
  /**
   * When false, build draft rows in memory and return them without writing to the DB.
   * Used so free batches can be claimed + inserted in one transaction after LLM success.
   */
  persist?: boolean;
}
