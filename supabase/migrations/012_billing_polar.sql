-- 012_billing_polar.sql
-- Entitlement status for Polar subscriptions / lifetime / refunds.
-- Safe to re-run.

alter table public.entitlements
  add column if not exists status text not null default 'none';

comment on column public.entitlements.status is
  'Billing status: none | active | canceled | past_due | refunded | revoked';

comment on column public.entitlements.entitlement_key is
  'Plan key: lifetime | monthly | yearly (or other product keys)';

comment on column public.entitlements.ends_at is
  'Current period end (null for lifetime)';

create index if not exists purchases_lifetime_completed_idx
  on public.purchases (product_id, status)
  where status in ('completed', 'paid');
