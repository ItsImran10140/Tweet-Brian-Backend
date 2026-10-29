import { getSupabase } from './client';
import type { Row } from './db';

function throwSb(error: { message: string } | null, action: string): never {
  throw new Error(`Supabase ${action} failed: ${error?.message ?? 'unknown'}`);
}

export async function getDailyUsage(userId: string, usageDate: string): Promise<Row | null> {
  const { data, error } = await getSupabase()
    .from('daily_usage')
    .select('*')
    .eq('user_id', userId)
    .eq('usage_date', usageDate)
    .maybeSingle();
  if (error) throwSb(error, 'get daily_usage');
  return data as Row | null;
}

export async function incrementDailyUsage(
  userId: string,
  usageDate: string,
  deltas: { drafts_generated?: number; drafts_posted?: number; llm_calls?: number },
): Promise<Row> {
  const existing = await getDailyUsage(userId, usageDate);
  const next = {
    user_id: userId,
    usage_date: usageDate,
    drafts_generated: (existing?.drafts_generated ?? 0) + (deltas.drafts_generated ?? 0),
    drafts_posted: (existing?.drafts_posted ?? 0) + (deltas.drafts_posted ?? 0),
    llm_calls: (existing?.llm_calls ?? 0) + (deltas.llm_calls ?? 0),
    metadata: existing?.metadata ?? {},
  };
  const { data, error } = await getSupabase()
    .from('daily_usage')
    .upsert(next, { onConflict: 'user_id,usage_date' })
    .select('*')
    .single();
  if (error) throwSb(error, 'upsert daily_usage');
  return data as Row;
}
