-- 002_profiles_and_brain.sql
-- Safe to re-run.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  timezone text not null default 'Asia/Kolkata',
  daily_tweet_limit integer not null default 10 check (daily_tweet_limit between 1 and 30),
  preferred_generation_time text not null default '09:00',
  twitter_handle text,
  niche text not null default 'tech',
  account_tier text not null default 'free' check (account_tier in ('free', 'premium')),
  tier_source text not null default 'fallback' check (tier_source in ('fallback', 'manual', 'api')),
  tier_checked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create table if not exists public.brain_answers (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  step text,
  brain_version text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

create index if not exists brain_answers_user_id_idx on public.brain_answers (user_id);

drop trigger if exists brain_answers_set_updated_at on public.brain_answers;
create trigger brain_answers_set_updated_at
  before update on public.brain_answers
  for each row execute function public.set_updated_at();

create table if not exists public.personality_profiles (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  brain_version text,
  summary text,
  computed_scores jsonb,
  dimensions jsonb,
  thinking_style jsonb,
  lenses jsonb,
  persona_card jsonb,
  style_fingerprint jsonb,
  voice_style_confidence numeric,
  voice_style_sample_count integer,
  voice_guidance text,
  voice_sliders jsonb,
  do_list jsonb,
  dont_list jsonb,
  open_questions jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id)
);

create index if not exists personality_profiles_user_id_idx on public.personality_profiles (user_id);

drop trigger if exists personality_profiles_set_updated_at on public.personality_profiles;
create trigger personality_profiles_set_updated_at
  before update on public.personality_profiles
  for each row execute function public.set_updated_at();
