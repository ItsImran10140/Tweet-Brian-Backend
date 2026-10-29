-- 010_rls.sql
-- Enable RLS; users only see their rows; shared tables are read-only for authenticated.
-- Service role bypasses RLS. Safe to re-run.

-- Helper: drop + recreate a policy idempotently
-- (Postgres has no create-or-replace for policies.)

-- ---------- user-owned tables ----------

alter table public.profiles enable row level security;
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select using (auth.uid() = id);
drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles for insert with check (auth.uid() = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles for delete using (auth.uid() = id);

alter table public.brain_answers enable row level security;
drop policy if exists brain_answers_all_own on public.brain_answers;
create policy brain_answers_all_own on public.brain_answers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.personality_profiles enable row level security;
drop policy if exists personality_profiles_all_own on public.personality_profiles;
create policy personality_profiles_all_own on public.personality_profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.reference_accounts enable row level security;
drop policy if exists reference_accounts_all_own on public.reference_accounts;
create policy reference_accounts_all_own on public.reference_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.user_writing_samples enable row level security;
drop policy if exists user_writing_samples_all_own on public.user_writing_samples;
create policy user_writing_samples_all_own on public.user_writing_samples
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.experience_items enable row level security;
drop policy if exists experience_items_all_own on public.experience_items;
create policy experience_items_all_own on public.experience_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.user_newsletters enable row level security;
drop policy if exists user_newsletters_all_own on public.user_newsletters;
create policy user_newsletters_all_own on public.user_newsletters
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.drafts enable row level security;
drop policy if exists drafts_all_own on public.drafts;
create policy drafts_all_own on public.drafts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.posting_slots enable row level security;
drop policy if exists posting_slots_all_own on public.posting_slots;
create policy posting_slots_all_own on public.posting_slots
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.social_accounts enable row level security;
drop policy if exists social_accounts_all_own on public.social_accounts;
create policy social_accounts_all_own on public.social_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.x_oauth_states enable row level security;
drop policy if exists x_oauth_states_all_own on public.x_oauth_states;
create policy x_oauth_states_all_own on public.x_oauth_states
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.purchases enable row level security;
drop policy if exists purchases_all_own on public.purchases;
create policy purchases_all_own on public.purchases
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.entitlements enable row level security;
drop policy if exists entitlements_all_own on public.entitlements;
create policy entitlements_all_own on public.entitlements
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.daily_usage enable row level security;
drop policy if exists daily_usage_all_own on public.daily_usage;
create policy daily_usage_all_own on public.daily_usage
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.feedback_events enable row level security;
drop policy if exists feedback_events_all_own on public.feedback_events;
create policy feedback_events_all_own on public.feedback_events
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.learned_rules enable row level security;
drop policy if exists learned_rules_all_own on public.learned_rules;
create policy learned_rules_all_own on public.learned_rules
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

alter table public.style_learnings enable row level security;
drop policy if exists style_learnings_all_own on public.style_learnings;
create policy style_learnings_all_own on public.style_learnings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- shared / catalog (read-only for authenticated) ----------

alter table public.newsletters enable row level security;
drop policy if exists newsletters_select_authenticated on public.newsletters;
create policy newsletters_select_authenticated on public.newsletters
  for select to authenticated using (true);

alter table public.digest_items enable row level security;
drop policy if exists digest_items_select_authenticated on public.digest_items;
create policy digest_items_select_authenticated on public.digest_items
  for select to authenticated using (true);

alter table public.digest_raw_items enable row level security;
drop policy if exists digest_raw_items_select_authenticated on public.digest_raw_items;
create policy digest_raw_items_select_authenticated on public.digest_raw_items
  for select to authenticated using (true);

alter table public.digest_runs enable row level security;
drop policy if exists digest_runs_select_authenticated on public.digest_runs;
create policy digest_runs_select_authenticated on public.digest_runs
  for select to authenticated using (true);

alter table public.digest_usage enable row level security;
drop policy if exists digest_usage_select_authenticated on public.digest_usage;
create policy digest_usage_select_authenticated on public.digest_usage
  for select to authenticated using (true);

alter table public.digest_blocklist enable row level security;
drop policy if exists digest_blocklist_select_authenticated on public.digest_blocklist;
create policy digest_blocklist_select_authenticated on public.digest_blocklist
  for select to authenticated using (true);

-- Webhook event ids: no client access (service role only)
alter table public.processed_webhook_events enable row level security;
drop policy if exists processed_webhook_events_no_client on public.processed_webhook_events;
-- Intentionally no policies for authenticated/anon — service role only.
