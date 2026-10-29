-- 009_learning.sql
-- Safe to re-run.

create table if not exists public.feedback_events (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  tweet_id text,
  kind text,
  discard_reason text,
  original_text text,
  edited_text text,
  refine_action text,
  learning_processed boolean default false,
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists feedback_events_user_id_idx on public.feedback_events (user_id);

drop trigger if exists feedback_events_set_updated_at on public.feedback_events;
create trigger feedback_events_set_updated_at
  before update on public.feedback_events
  for each row execute function public.set_updated_at();

create table if not exists public.learned_rules (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text,
  rule_text text not null,
  supporting_event_ids jsonb,
  last_applied_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists learned_rules_user_id_idx on public.learned_rules (user_id);

drop trigger if exists learned_rules_set_updated_at on public.learned_rules;
create trigger learned_rules_set_updated_at
  before update on public.learned_rules
  for each row execute function public.set_updated_at();

create table if not exists public.style_learnings (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending',
  summary text,
  lessons jsonb,
  style_card_patch jsonb,
  edit_event_ids jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists style_learnings_user_id_idx on public.style_learnings (user_id);

drop trigger if exists style_learnings_set_updated_at on public.style_learnings;
create trigger style_learnings_set_updated_at
  before update on public.style_learnings
  for each row execute function public.set_updated_at();
