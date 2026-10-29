-- 004_newsletters.sql
-- Shared catalog + per-user selections. Safe to re-run.

create table if not exists public.newsletters (
  id text primary key default gen_random_uuid()::text,
  name text not null,
  author text,
  description text,
  sender_email text,
  url text,
  avatar_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists newsletters_set_updated_at on public.newsletters;
create trigger newsletters_set_updated_at
  before update on public.newsletters
  for each row execute function public.set_updated_at();

create table if not exists public.user_newsletters (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users (id) on delete cascade,
  newsletter_id text not null references public.newsletters (id) on delete cascade,
  is_source boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, newsletter_id)
);

create index if not exists user_newsletters_user_id_idx on public.user_newsletters (user_id);

drop trigger if exists user_newsletters_set_updated_at on public.user_newsletters;
create trigger user_newsletters_set_updated_at
  before update on public.user_newsletters
  for each row execute function public.set_updated_at();
