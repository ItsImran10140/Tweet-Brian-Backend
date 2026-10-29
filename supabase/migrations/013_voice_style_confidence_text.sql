-- 013_voice_style_confidence_text.sql
-- voice_style_confidence is categorical ('high' | 'medium' | 'low'), not numeric.
-- Safe to re-run.

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'personality_profiles'
      and column_name = 'voice_style_confidence'
      and data_type = 'numeric'
  ) then
    alter table public.personality_profiles
      alter column voice_style_confidence type text
      using (
        case
          when voice_style_confidence is null then null
          when voice_style_confidence >= 0.8 then 'high'
          when voice_style_confidence >= 0.5 then 'medium'
          else 'low'
        end
      );
  end if;
end $$;

alter table public.personality_profiles
  drop constraint if exists personality_profiles_voice_style_confidence_check;

alter table public.personality_profiles
  add constraint personality_profiles_voice_style_confidence_check
  check (
    voice_style_confidence is null
    or voice_style_confidence in ('high', 'medium', 'low')
  );
