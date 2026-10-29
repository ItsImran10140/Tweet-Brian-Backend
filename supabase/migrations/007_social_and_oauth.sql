-- 007_social_and_oauth.sql
-- Safe to re-run.

create table if not exists public.social_accounts (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null default 'x',
  status text not null default 'connected',
  x_user_id text,
  handle text,
  display_name text,
  avatar_url text,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  expires_at timestamptz,
  scopes jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists social_accounts_user_id_idx on public.social_accounts (user_id);
create unique index if not exists social_accounts_user_platform_uidx
  on public.social_accounts (user_id, platform);

drop trigger if exists social_accounts_set_updated_at on public.social_accounts;
create trigger social_accounts_set_updated_at
  before update on public.social_accounts
  for each row execute function public.set_updated_at();

create table if not exists public.x_oauth_states (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  state text not null unique,
  code_verifier text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists x_oauth_states_user_id_idx on public.x_oauth_states (user_id);

drop trigger if exists x_oauth_states_set_updated_at on public.x_oauth_states;
create trigger x_oauth_states_set_updated_at
  before update on public.x_oauth_states
  for each row execute function public.set_updated_at();
