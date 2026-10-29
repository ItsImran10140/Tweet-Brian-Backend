-- 012_free_generation_gates.sql
-- Global free-generation circuit breaker + atomic free-batch save.
-- Safe to re-run.

create table if not exists public.global_daily_counters (
  usage_date date primary key,
  free_generations integer not null default 0 check (free_generations >= 0),
  updated_at timestamptz not null default timezone('utc', now())
);

drop trigger if exists global_daily_counters_set_updated_at on public.global_daily_counters;
create trigger global_daily_counters_set_updated_at
  before update on public.global_daily_counters
  for each row execute function public.set_updated_at();

alter table public.global_daily_counters enable row level security;
-- Service role only; no authenticated policies (backend uses service role).

-- Atomically: check global free cap, claim free_generation_used, insert drafts.
-- Raises with message FREE_PAUSED | FREE_USED | FREE_DISABLED on conflict/limit.
create or replace function public.save_free_generation_batch(
  p_user_id uuid,
  p_drafts jsonb,
  p_global_limit integer,
  p_free_batches_per_user integer default 1
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (timezone('utc', now()))::date;
  v_count integer;
  v_claimed boolean := false;
  v_draft jsonb;
  v_id text;
  v_inserted integer := 0;
begin
  if p_free_batches_per_user <= 0 then
    raise exception 'FREE_DISABLED' using errcode = 'P0001';
  end if;

  if p_drafts is null or jsonb_typeof(p_drafts) <> 'array' or jsonb_array_length(p_drafts) = 0 then
    raise exception 'NO_DRAFTS' using errcode = 'P0001';
  end if;

  insert into public.global_daily_counters (usage_date, free_generations)
  values (v_today, 0)
  on conflict (usage_date) do nothing;

  select free_generations into v_count
  from public.global_daily_counters
  where usage_date = v_today
  for update;

  if coalesce(v_count, 0) >= p_global_limit then
    raise exception 'FREE_PAUSED' using errcode = 'P0001';
  end if;

  update public.profiles
  set free_generation_used = true, updated_at = timezone('utc', now())
  where id = p_user_id and free_generation_used = false
  returning true into v_claimed;

  if not coalesce(v_claimed, false) then
    raise exception 'FREE_USED' using errcode = 'P0001';
  end if;

  for v_draft in select * from jsonb_array_elements(p_drafts)
  loop
    v_id := coalesce(v_draft->>'id', gen_random_uuid()::text);
    insert into public.drafts (
      id, user_id, text, original_text, edited_text, tweet_type, format_id, format_label,
      material_source, material_label, material_id, style_match_score, critique, niche, kind,
      source_name, source_url, source_headline, verify_note, brain_version, batch_id, pipeline,
      status, sources, created_at, updated_at
    ) values (
      v_id,
      p_user_id,
      coalesce(v_draft->>'text', ''),
      v_draft->>'original_text',
      v_draft->>'edited_text',
      v_draft->>'tweet_type',
      v_draft->>'format_id',
      v_draft->>'format_label',
      v_draft->>'material_source',
      v_draft->>'material_label',
      v_draft->>'material_id',
      nullif(v_draft->>'style_match_score', '')::numeric,
      case when v_draft ? 'critique' then v_draft->'critique' else null end,
      v_draft->>'niche',
      v_draft->>'kind',
      v_draft->>'source_name',
      v_draft->>'source_url',
      v_draft->>'source_headline',
      v_draft->>'verify_note',
      v_draft->>'brain_version',
      v_draft->>'batch_id',
      v_draft->>'pipeline',
      coalesce(nullif(v_draft->>'status', ''), 'pending'),
      case when v_draft ? 'sources' then v_draft->'sources' else null end,
      timezone('utc', now()),
      timezone('utc', now())
    );
    v_inserted := v_inserted + 1;
  end loop;

  update public.global_daily_counters
  set free_generations = free_generations + 1,
      updated_at = timezone('utc', now())
  where usage_date = v_today;

  return jsonb_build_object('ok', true, 'inserted', v_inserted, 'usage_date', v_today);
end;
$$;

revoke all on function public.save_free_generation_batch(uuid, jsonb, integer, integer) from public;
grant execute on function public.save_free_generation_batch(uuid, jsonb, integer, integer) to service_role;
