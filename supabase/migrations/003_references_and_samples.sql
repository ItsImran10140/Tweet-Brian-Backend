-- 003_references_and_samples.sql
-- Safe to re-run.

create table if not exists public.reference_accounts (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  handle text not null,
  display_name text,
  preferred_source text,
  admire_reason text not null default '',
  tweets jsonb not null default '[]'::jsonb,
  style jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists reference_accounts_user_id_idx on public.reference_accounts (user_id);
create unique index if not exists reference_accounts_user_handle_uidx
  on public.reference_accounts (user_id, lower(handle));

drop trigger if exists reference_accounts_set_updated_at on public.reference_accounts;
create trigger reference_accounts_set_updated_at
  before update on public.reference_accounts
  for each row execute function public.set_updated_at();

create table if not exists public.user_writing_samples (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  sample_text text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists user_writing_samples_user_id_idx on public.user_writing_samples (user_id);

drop trigger if exists user_writing_samples_set_updated_at on public.user_writing_samples;
create trigger user_writing_samples_set_updated_at
  before update on public.user_writing_samples
  for each row execute function public.set_updated_at();

create table if not exists public.experience_items (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  text text not null,
  tags jsonb not null default '[]'::jsonb,
  source text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists experience_items_user_id_idx on public.experience_items (user_id);

drop trigger if exists experience_items_set_updated_at on public.experience_items;
create trigger experience_items_set_updated_at
  before update on public.experience_items
  for each row execute function public.set_updated_at();
