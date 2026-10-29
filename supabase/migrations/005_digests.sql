-- 005_digests.sql
-- Shared niche digests and pipeline tables. Safe to re-run.

create table if not exists public.digest_items (
  id text primary key default gen_random_uuid()::text,
  niche text not null,
  digest_date text not null,
  rank integer,
  headline text,
  fact_summary text,
  category text,
  source_name text,
  source_url text,
  supporting jsonb,
  trust_tier integer,
  published_at text,
  shingles jsonb,
  run_id text,
  confirmed_by_domains jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists digest_items_niche_date_idx on public.digest_items (niche, digest_date);

drop trigger if exists digest_items_set_updated_at on public.digest_items;
create trigger digest_items_set_updated_at
  before update on public.digest_items
  for each row execute function public.set_updated_at();

create table if not exists public.digest_raw_items (
  id text primary key,
  niche text not null,
  kind text,
  url text,
  title text,
  excerpt text,
  source_name text,
  trust_tier integer,
  published_at text,
  fetched_at timestamptz,
  fetch_date text,
  payload jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists digest_raw_items_niche_idx on public.digest_raw_items (niche);
create index if not exists digest_raw_items_fetched_at_idx on public.digest_raw_items (fetched_at);

drop trigger if exists digest_raw_items_set_updated_at on public.digest_raw_items;
create trigger digest_raw_items_set_updated_at
  before update on public.digest_raw_items
  for each row execute function public.set_updated_at();

create table if not exists public.digest_runs (
  id text primary key default gen_random_uuid()::text,
  niche text,
  trigger text,
  status text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  collected integer,
  confirmed integer,
  items_saved integer,
  error text,
  report jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists digest_runs_set_updated_at on public.digest_runs;
create trigger digest_runs_set_updated_at
  before update on public.digest_runs
  for each row execute function public.set_updated_at();

create table if not exists public.digest_usage (
  id text primary key default gen_random_uuid()::text,
  provider text not null,
  niche text,
  date text,
  month text,
  requests integer not null default 0,
  ok boolean,
  status text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists digest_usage_provider_month_idx on public.digest_usage (provider, month);

drop trigger if exists digest_usage_set_updated_at on public.digest_usage;
create trigger digest_usage_set_updated_at
  before update on public.digest_usage
  for each row execute function public.set_updated_at();

create table if not exists public.digest_blocklist (
  id text primary key default gen_random_uuid()::text,
  domain text not null unique,
  reason text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists digest_blocklist_set_updated_at on public.digest_blocklist;
create trigger digest_blocklist_set_updated_at
  before update on public.digest_blocklist
  for each row execute function public.set_updated_at();
