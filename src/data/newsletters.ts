import { getSupabase } from './client';
import type { Row } from './db';

function throwSb(error: { message: string } | null, action: string): never {
  throw new Error(`Supabase ${action} failed: ${error?.message ?? 'unknown'}`);
}

export async function listCatalog(): Promise<Row[]> {
  const { data, error } = await getSupabase().from('newsletters').select('*').order('name');
  if (error) throwSb(error, 'list newsletters');
  return data ?? [];
}

export async function listUserSelections(userId: string): Promise<Row[]> {
  const { data, error } = await getSupabase()
    .from('user_newsletters')
    .select('*, newsletters(*)')
    .eq('user_id', userId);
  if (error) throwSb(error, 'list user_newsletters');
  return data ?? [];
}

export async function setUserNewsletter(userId: string, newsletterId: string, isSource = true): Promise<Row> {
  const { data, error } = await getSupabase()
    .from('user_newsletters')
    .upsert({ user_id: userId, newsletter_id: newsletterId, is_source: isSource }, { onConflict: 'user_id,newsletter_id' })
    .select('*')
    .single();
  if (error) throwSb(error, 'upsert user_newsletters');
  return data as Row;
}

export async function removeUserNewsletter(userId: string, newsletterId: string): Promise<void> {
  const { error } = await getSupabase()
    .from('user_newsletters')
    .delete()
    .eq('user_id', userId)
    .eq('newsletter_id', newsletterId);
  if (error) throwSb(error, 'delete user_newsletters');
}
