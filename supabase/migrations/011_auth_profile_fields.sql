-- 011_auth_profile_fields.sql
-- Display + funnel fields used by Google auth / whoami. Safe to re-run.

alter table public.profiles
  add column if not exists name text,
  add column if not exists avatar_url text,
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists free_generation_used boolean not null default false;
