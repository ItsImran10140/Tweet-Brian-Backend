-- 008_billing_and_usage.sql
-- Safe to re-run.

create table if not exists public.purchases (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text,
  provider_payment_id text,
  product_id text,
  amount_cents integer,
  currency text,
  status text not null default 'completed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists purchases_user_id_idx on public.purchases (user_id);

drop trigger if exists purchases_set_updated_at on public.purchases;
create trigger purchases_set_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

create table if not exists public.entitlements (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  entitlement_key text not null,
  active boolean not null default true,
  source_purchase_id text references public.purchases (id) on delete set null,
  starts_at timestamptz,
  ends_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, entitlement_key)
);

create index if not exists entitlements_user_id_idx on public.entitlements (user_id);

drop trigger if exists entitlements_set_updated_at on public.entitlements;
create trigger entitlements_set_updated_at
  before update on public.entitlements
  for each row execute function public.set_updated_at();

create table if not exists public.processed_webhook_events (
  id text primary key default gen_random_uuid()::text,
  event_id text not null unique,
  provider text,
  payload jsonb,
  processed_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists processed_webhook_events_set_updated_at on public.processed_webhook_events;
create trigger processed_webhook_events_set_updated_at
  before update on public.processed_webhook_events
  for each row execute function public.set_updated_at();

create table if not exists public.daily_usage (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  drafts_generated integer not null default 0,
  drafts_posted integer not null default 0,
  llm_calls integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, usage_date)
);

create index if not exists daily_usage_user_id_idx on public.daily_usage (user_id);

drop trigger if exists daily_usage_set_updated_at on public.daily_usage;
create trigger daily_usage_set_updated_at
  before update on public.daily_usage
  for each row execute function public.set_updated_at();
