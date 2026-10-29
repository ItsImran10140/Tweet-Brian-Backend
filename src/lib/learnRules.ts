import { z } from 'zod';
import { db } from '../data';
import { loadBrain } from './brain';
import { llmJson } from './llm';

const MAX_ACTIVE_LEARNED = 15;
const STALE_DAYS = 60;
const LearnSchema = z.object({
  rules: z.array(z.object({ rule_text: z.string().min(5), supporting_event_ids: z.array(z.string()) })).default([]),
  contradicted_rule_ids: z.array(z.string()).default([]),
});

export async function learnForUser(userId: string) {
  const events = await db.all('feedback_events', (e) => e.user_id === userId);
  const now = new Date();
  const report = { added: 0, retired_stale: 0, retired_contradicted: 0, skipped: [] as string[] };

  const cutoff = new Date(now.getTime() - STALE_DAYS * 864e5).toISOString();
  report.retired_stale = await db.update('learned_rules',
    (r) => r.user_id === userId && r.source === 'learned' && !r.retired_at && (r.last_applied_at ?? r.created_at) < cutoff,
    { retired_at: now.toISOString() });

  if (events.length < 3) return { ...report, note: 'fewer than 3 feedback events, nothing to learn yet' };

  const groups: Record<string, string[]> = {};
  for (const e of events.filter((x) => x.kind === 'discard' && x.discard_reason)) (groups[e.discard_reason] ??= []).push(e.id);
  const discardGroups = Object.entries(groups).map(([reason, ids]) => ({ reason, ids }));
  const edits = events.filter((e) => e.kind === 'edit').map((e) => ({ id: e.id, original: e.original_text, edited: e.edited_text }));
  const active = await db.all('learned_rules', (r) => r.user_id === userId && !r.retired_at && r.source === 'learned');

  const result = await llmJson({
    kind: 'learn', brain: loadBrain().text,
    meta: { discardGroups },
    user: `Find consistent patterns in this feedback. A rule needs 3+ supporting events that agree. Return JSON {"rules":[{"rule_text":"","supporting_event_ids":[]}],"contradicted_rule_ids":[]}.\n\nDiscard events grouped by reason: ${JSON.stringify(discardGroups)}\n\nEdits (original -> edited): ${JSON.stringify(edits)}\n\nCurrently active learned rules: ${JSON.stringify(active.map((r) => ({ id: r.id, rule: r.rule_text })))}`,
  }, LearnSchema);

  const ok = new Set(active.map((r) => r.id));
  for (const id of result.contradicted_rule_ids) {
    if (ok.has(id)) {
      await db.update('learned_rules', (r) => r.id === id, { retired_at: now.toISOString() });
      report.retired_contradicted++;
    }
  }

  const mine = new Set(events.map((e) => e.id));
  for (const rule of result.rules) {
    const ids = [...new Set(rule.supporting_event_ids)].filter((id) => mine.has(id));
    if (ids.length < 3) { report.skipped.push(`"${rule.rule_text}" (only ${ids.length} valid supporting events)`); continue; }
    const activeCount = (await db.all('learned_rules', (r) => r.user_id === userId && !r.retired_at && r.source === 'learned')).length;
    if (activeCount >= MAX_ACTIVE_LEARNED) { report.skipped.push(`"${rule.rule_text}" (cap of ${MAX_ACTIVE_LEARNED} reached)`); continue; }
    const dup = await db.get('learned_rules', (r) => r.user_id === userId && !r.retired_at && r.rule_text.toLowerCase() === rule.rule_text.toLowerCase());
    if (dup) continue;
    await db.insert('learned_rules', { user_id: userId, source: 'learned', rule_text: rule.rule_text, supporting_event_ids: ids, last_applied_at: null, retired_at: null });
    report.added++;
  }
  return report;
}

export async function learnForAllUsers() {
  const out: Record<string, unknown> = {};
  for (const u of await db.all('users')) out[u.id] = await learnForUser(u.id).catch((e) => ({ error: e.message }));
  return out;
}
