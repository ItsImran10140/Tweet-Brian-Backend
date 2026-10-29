/**
 * Single data-access surface used by the rest of the app.
 * Backed by Supabase Postgres (service role). Call sites must await.
 */
import { randomUUID } from 'node:crypto';
import { getSupabase } from './client';
import { physicalTable, type Table, USER_TABLES, SHARED_TABLES } from './tables';

export type Row = Record<string, any>;
export type { Table };
export { USER_TABLES, SHARED_TABLES, LOGICAL_TABLES as TABLES } from './tables';

function throwSb(error: { message: string; code?: string; details?: string } | null, action: string): never {
  const msg = error?.message ?? 'unknown error';
  throw new Error(`Supabase ${action} failed: ${msg}${error?.details ? ` (${error.details})` : ''}`);
}

async function selectAll(physical: string): Promise<Row[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from(physical).select('*');
  if (error) throwSb(error, `select ${physical}`);
  return (data ?? []) as Row[];
}

/** Map DB draft row → legacy generated_tweets shape (published_at alias). */
function fromDraftRow(row: Row): Row {
  const out = { ...row };
  if (out.posted_at && !out.published_at) out.published_at = out.posted_at;
  if (out.status === 'posted' && !out.published_at) {
    /* keep posted */
  }
  return out;
}

function toDraftPatch(patch: Row): Row {
  const out = { ...patch };
  if (out.published_at !== undefined && out.posted_at === undefined) {
    out.posted_at = out.published_at;
  }
  if (out.status === 'published') out.status = 'posted';
  return out;
}

async function loadPostingSlots(userId: string): Promise<Row[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from('posting_slots').select('*').eq('user_id', userId);
  if (error) throwSb(error, 'select posting_slots');
  return (data ?? []).map((s) => ({
    id: s.id,
    dayOfWeek: s.day_of_week,
    time: s.time,
    enabled: s.enabled,
  }));
}

async function replacePostingSlots(userId: string, slots: Row[]): Promise<void> {
  const sb = getSupabase();
  const { error: delErr } = await sb.from('posting_slots').delete().eq('user_id', userId);
  if (delErr) throwSb(delErr, 'clear posting_slots');
  if (!slots.length) return;
  const rows = slots.map((slot) => ({
    id: String(slot.id ?? `${slot.dayOfWeek}-${String(slot.time).replace(':', '')}`),
    user_id: userId,
    day_of_week: Number(slot.dayOfWeek),
    time: String(slot.time),
    enabled: Boolean(slot.enabled),
  }));
  const { error } = await sb.from('posting_slots').upsert(rows);
  if (error) throwSb(error, 'upsert posting_slots');
}

async function hydrateUser(row: Row | undefined): Promise<Row | undefined> {
  if (!row) return undefined;
  const posting_slots = await loadPostingSlots(String(row.id));
  return { ...row, posting_slots };
}

export const db = {
  async all(t: Table, pred: (r: Row) => boolean = () => true): Promise<Row[]> {
    const physical = physicalTable(t);
    let rows = await selectAll(physical);
    if (physical === 'drafts' || t === 'generated_tweets') rows = rows.map(fromDraftRow);
    if (physical === 'profiles' || t === 'users') {
      const hydrated: Row[] = [];
      for (const r of rows) {
        const u = await hydrateUser(r);
        if (u) hydrated.push(u);
      }
      rows = hydrated;
    }
    return rows.filter(pred);
  },

  async get(t: Table, pred: (r: Row) => boolean): Promise<Row | undefined> {
    const rows = await db.all(t, pred);
    return rows[0];
  },

  async insert(t: Table, row: Row): Promise<Row> {
    const physical = physicalTable(t);
    const sb = getSupabase();
    let payload: Row = {
      id: row.id ?? randomUUID(),
      created_at: row.created_at ?? new Date().toISOString(),
      ...row,
    };

    if (physical === 'profiles' || t === 'users') {
      const { posting_slots, ...profile } = payload;
      if (!profile.id) throw new Error('profiles.id is required (must match auth.users id)');
      const { data, error } = await sb.from('profiles').upsert(profile).select('*').single();
      if (error) throwSb(error, 'upsert profiles');
      if (Array.isArray(posting_slots)) await replacePostingSlots(String(profile.id), posting_slots);
      return (await hydrateUser(data as Row))!;
    }

    if (physical === 'drafts' || t === 'generated_tweets') {
      payload = toDraftPatch(payload);
      if (payload.status === 'published') payload.status = 'posted';
    }

    const { data, error } = await sb.from(physical).insert(payload).select('*').single();
    if (error) throwSb(error, `insert ${physical}`);
    let out = data as Row;
    if (physical === 'drafts') out = fromDraftRow(out);
    return out;
  },

  async update(t: Table, pred: (r: Row) => boolean, patch: Row): Promise<number> {
    const physical = physicalTable(t);
    const matches = await db.all(t, pred);
    if (!matches.length) return 0;
    const sb = getSupabase();
    let n = 0;

    for (const match of matches) {
      const { posting_slots, ...restPatch } = patch;
      let body = { ...restPatch };

      if (physical === 'drafts' || t === 'generated_tweets') body = toDraftPatch(body);

      if (Object.keys(body).length) {
        const { error } = await sb.from(physical).update(body).eq('id', match.id);
        if (error) throwSb(error, `update ${physical}`);
      }

      if ((physical === 'profiles' || t === 'users') && Array.isArray(posting_slots)) {
        await replacePostingSlots(String(match.id), posting_slots);
      }
      n++;
    }
    return n;
  },

  async remove(t: Table, pred: (r: Row) => boolean): Promise<number> {
    const matches = await db.all(t, pred);
    if (!matches.length) return 0;
    const physical = physicalTable(t);
    const sb = getSupabase();
    const ids = matches.map((r) => r.id);
    const { error } = await sb.from(physical).delete().in('id', ids);
    if (error) throwSb(error, `delete ${physical}`);
    return matches.length;
  },

  async upsertByUser(t: Table, userId: string, patch: Row): Promise<Row> {
    const existing = await db.get(t, (r) => r.user_id === userId);
    if (existing) {
      await db.update(t, (r) => r.id === existing.id, { ...patch, updated_at: new Date().toISOString() });
      return (await db.get(t, (r) => r.id === existing.id))!;
    }
    return db.insert(t, { user_id: userId, ...patch, updated_at: new Date().toISOString() });
  },
};
