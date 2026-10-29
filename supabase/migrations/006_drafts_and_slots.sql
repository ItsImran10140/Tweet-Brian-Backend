-- 006_drafts_and_slots.sql
-- Safe to re-run.

create table if not exists public.drafts (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  text text not null,
  original_text text,
  edited_text text,
  tweet_type text,
  format_id text,
  format_label text,
  material_source text,
  material_label text,
  material_id text,
  style_match_score numeric,
  critique jsonb,
  niche text,
  kind text,
  source_name text,
  source_url text,
  source_headline text,
  verify_note text,
  brain_version text,
  batch_id text,
  pipeline text,
  status text not null default 'pending'
    check (status in (
      'pending', 'liked', 'discarded', 'scheduled', 'posting', 'posted', 'failed', 'published'
    )),
  scheduled_at timestamptz,
  posted_at timestamptz,
  published_at timestamptz,
  feedback text,
  discard_reason text,
  sources jsonb,
  refine_action text,
  refined_at timestamptz,
  source_idea text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists drafts_user_id_idx on public.drafts (user_id);
create index if not exists drafts_user_status_idx on public.drafts (user_id, status);
create index if not exists drafts_scheduled_at_idx on public.drafts (scheduled_at);

drop trigger if exists drafts_set_updated_at on public.drafts;
create trigger drafts_set_updated_at
  before update on public.drafts
  for each row execute function public.set_updated_at();

create table if not exists public.posting_slots (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  day_of_week integer not null check (day_of_week between 0 and 6),
  time text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists posting_slots_user_id_idx on public.posting_slots (user_id);
create unique index if not exists posting_slots_user_day_time_uidx
  on public.posting_slots (user_id, day_of_week, time);

drop trigger if exists posting_slots_set_updated_at on public.posting_slots;
create trigger posting_slots_set_updated_at
  before update on public.posting_slots
  for each row execute function public.set_updated_at();
