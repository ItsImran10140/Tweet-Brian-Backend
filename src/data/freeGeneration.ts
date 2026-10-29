import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { AppError } from '../errors';
import { getSupabase } from './client';
import type { Row } from './db';

function throwSb(error: { message: string; code?: string } | null, action: string): never {
  throw new Error(`Supabase ${action} failed: ${error?.message ?? 'unknown'}`);
}

export async function getGlobalFreeCount(usageDate: string): Promise<number> {
  const { data, error } = await getSupabase()
    .from('global_daily_counters')
    .select('free_generations')
    .eq('usage_date', usageDate)
    .maybeSingle();
  if (error) throwSb(error, 'get global_daily_counters');
  return Number(data?.free_generations ?? 0);
}

/** Strip DB-only fields so the RPC insert payload stays clean. */
export function draftPayload(row: Row): Row {
  const {
    id,
    text,
    original_text,
    edited_text,
    tweet_type,
    format_id,
    format_label,
    material_source,
    material_label,
    material_id,
    style_match_score,
    critique,
    niche,
    kind,
    source_name,
    source_url,
    source_headline,
    verify_note,
    brain_version,
    batch_id,
    pipeline,
    status,
    sources,
  } = row;
  return {
    id: id ?? randomUUID(),
    text,
    original_text: original_text ?? text,
    edited_text: edited_text ?? null,
    tweet_type: tweet_type ?? null,
    format_id: format_id ?? null,
    format_label: format_label ?? null,
    material_source: material_source ?? null,
    material_label: material_label ?? null,
    material_id: material_id ?? null,
    style_match_score: style_match_score ?? null,
    critique: critique ?? null,
    niche: niche ?? null,
    kind: kind ?? null,
    source_name: source_name ?? null,
    source_url: source_url ?? null,
    source_headline: source_headline ?? null,
    verify_note: verify_note ?? null,
    brain_version: brain_version ?? null,
    batch_id: batch_id ?? null,
    pipeline: pipeline ?? null,
    status: status ?? 'pending',
    sources: sources ?? null,
  };
}

/**
 * Persist a free batch and mark free_generation_used in one DB transaction (RPC).
 * On failure (including FREE_USED / FREE_PAUSED), nothing is consumed.
 */
export async function saveFreeGenerationBatch(userId: string, drafts: Row[]): Promise<{ inserted: number }> {
  const payload = drafts.map(draftPayload);
  const { data, error } = await getSupabase().rpc('save_free_generation_batch', {
    p_user_id: userId,
    p_drafts: payload,
    p_global_limit: config.limits.freeGenerationsGlobalPerDay,
    p_free_batches_per_user: config.limits.freeBatchesPerUser,
  });

  if (error) {
    const msg = error.message ?? '';
    if (msg.includes('FREE_PAUSED')) {
      console.error(
        `[ALERT] Free draft circuit breaker hit during save. user=${userId} limit=${config.limits.freeGenerationsGlobalPerDay}`,
      );
      throw new AppError(
        503,
        'free_paused',
        'Free drafts are paused for today, subscribe to continue',
        'Subscribe for unlimited generation, or try again tomorrow.',
      );
    }
    if (msg.includes('FREE_USED') || msg.includes('FREE_DISABLED')) {
      throw new AppError(
        402,
        'paywall',
        'Subscribe to unlock more drafts.',
        'You can still view, edit, and copy your free drafts.',
      );
    }
    if (msg.includes('NO_DRAFTS')) {
      throw new AppError(422, 'no_drafts', 'Generation produced no drafts to save.', 'Retry once; your free batch was not used.');
    }
    throwSb(error, 'save_free_generation_batch');
  }

  return { inserted: Number((data as { inserted?: number })?.inserted ?? payload.length) };
}

/**
 * Fallback when the RPC is not deployed yet: conditional update + inserts + rollback on failure.
 * Prefer the RPC for true single-transaction semantics.
 */
export async function saveFreeGenerationBatchFallback(userId: string, drafts: Row[]): Promise<{ inserted: number }> {
  const sb = getSupabase();
  const day = new Date().toISOString().slice(0, 10);

  if (config.limits.freeBatchesPerUser <= 0) {
    throw new AppError(402, 'paywall', 'Free drafts are not available. Subscribe to generate.');
  }

  const globalCount = await getGlobalFreeCount(day);
  if (globalCount >= config.limits.freeGenerationsGlobalPerDay) {
    console.error(`[ALERT] Free draft circuit breaker hit: ${globalCount}/${config.limits.freeGenerationsGlobalPerDay} on ${day}. user=${userId}`);
    throw new AppError(503, 'free_paused', 'Free drafts are paused for today, subscribe to continue');
  }

  const { data: claimed, error: claimErr } = await sb
    .from('profiles')
    .update({ free_generation_used: true })
    .eq('id', userId)
    .eq('free_generation_used', false)
    .select('id')
    .maybeSingle();
  if (claimErr) throwSb(claimErr, 'claim free_generation_used');
  if (!claimed) {
    throw new AppError(402, 'paywall', 'Subscribe to unlock more drafts.');
  }

  const payload = drafts.map((d) => ({ ...draftPayload(d), user_id: userId }));
  try {
    const { error: insErr } = await sb.from('drafts').insert(payload);
    if (insErr) throw insErr;

    await sb.from('global_daily_counters').upsert(
      { usage_date: day, free_generations: globalCount + 1 },
      { onConflict: 'usage_date' },
    );
    // Re-read and set to max(existing, globalCount+1) via increment if race — best-effort without RPC.
    const { data: counter } = await sb.from('global_daily_counters').select('free_generations').eq('usage_date', day).maybeSingle();
    if (counter && Number(counter.free_generations) <= globalCount) {
      await sb.from('global_daily_counters').update({ free_generations: globalCount + 1 }).eq('usage_date', day);
    }

    return { inserted: payload.length };
  } catch (err) {
    await sb.from('profiles').update({ free_generation_used: false }).eq('id', userId);
    throw err;
  }
}

/** Use RPC when available; otherwise fallback. */
export async function persistFreeBatch(userId: string, drafts: Row[]): Promise<{ inserted: number }> {
  try {
    return await saveFreeGenerationBatch(userId, drafts);
  } catch (err) {
    if (err instanceof AppError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // Missing function → fallback for local/dev before migration is applied.
    if (/save_free_generation_batch|Could not find the function|PGRST202/i.test(message)) {
      console.warn('[freeGeneration] RPC missing; using fallback claim+insert. Apply migration 012.');
      return saveFreeGenerationBatchFallback(userId, drafts);
    }
    throw err;
  }
}
