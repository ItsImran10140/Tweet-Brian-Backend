/** Logical table names used by existing app code → physical Postgres tables. */
export const LOGICAL_TABLES = [
  'users',
  'personality_profiles',
  'onboarding_drafts',
  'user_writing_samples',
  'experience_items',
  'reference_accounts',
  'newsletter_sources',
  'newsletter_digests',
  'digest_raw_items',
  'digest_items',
  'digest_runs',
  'digest_usage',
  'digest_blocklist',
  'generated_tweets',
  'feedback_events',
  'learned_rules',
  'style_learnings',
  'social_accounts',
  'x_oauth_states',
  // physical / new names also accepted
  'profiles',
  'brain_answers',
  'drafts',
  'posting_slots',
  'newsletters',
  'user_newsletters',
  'purchases',
  'entitlements',
  'processed_webhook_events',
  'daily_usage',
] as const;

export type Table = (typeof LOGICAL_TABLES)[number];

const PHYSICAL: Record<string, string> = {
  users: 'profiles',
  onboarding_drafts: 'brain_answers',
  generated_tweets: 'drafts',
  // legacy unused newsletter tables → no physical write; mapped for delete-all-user
  newsletter_sources: 'user_newsletters',
  newsletter_digests: 'user_newsletters',
};

export function physicalTable(logical: string): string {
  return PHYSICAL[logical] ?? logical;
}

export const SHARED_TABLES: Table[] = [
  'digest_raw_items',
  'digest_items',
  'digest_runs',
  'digest_usage',
  'digest_blocklist',
  'newsletters',
  'processed_webhook_events',
];

/** Per-user tables cleared on account delete (logical names used by app code). */
export const USER_TABLES: Table[] = [
  'personality_profiles',
  'onboarding_drafts',
  'user_writing_samples',
  'experience_items',
  'reference_accounts',
  'generated_tweets',
  'feedback_events',
  'learned_rules',
  'style_learnings',
  'social_accounts',
  'x_oauth_states',
  'posting_slots',
  'user_newsletters',
  'purchases',
  'entitlements',
  'daily_usage',
];
