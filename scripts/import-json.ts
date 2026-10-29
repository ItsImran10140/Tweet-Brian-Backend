/**
 * One-time import: copy rows from data/db.json into Supabase for YOUR auth user.
 * Does NOT modify or delete db.json.
 *
 * Prerequisites:
 * 1. Run supabase/migrations/001…010 in the SQL editor.
 * 2. Google sign-in so auth.users has your row.
 * 3. .env has SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, IMPORT_USER_ID=<your auth uuid>
 * 4. Optional: IMPORT_SOURCE_USER_ID=<legacy id from db.json users[]>
 *
 * Run: npx tsx scripts/import-json.ts
 */
import fs from 'node:fs';
import { config } from '../src/config';
import { getSupabase } from '../src/data/client';

type Row = Record<string, any>;

function loadJson(): Record<string, Row[]> {
  const file = config.dataFile;
  if (!fs.existsSync(file)) {
    throw new Error(`No JSON file at ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function pickSourceUser(users: Row[], forced?: string): Row {
  if (forced) {
    const u = users.find((x) => x.id === forced);
    if (!u) throw new Error(`IMPORT_SOURCE_USER_ID ${forced} not found in db.json users`);
    return u;
  }
  const ranked = [...users].sort((a, b) => {
    const score = (u: Row) =>
      (Array.isArray(u.posting_slots) && u.posting_slots.length ? 10 : 0) +
      (u.niche ? 1 : 0) +
      (u.timezone ? 1 : 0);
    return score(b) - score(a);
  });
  if (!ranked.length) throw new Error('db.json has no users');
  return ranked[0];
}

async function upsert(table: string, row: Row, onConflict?: string) {
  const sb = getSupabase();
  const q = onConflict ? sb.from(table).upsert(row, { onConflict }) : sb.from(table).upsert(row);
  const { error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
}

async function main() {
  const targetId = process.env.IMPORT_USER_ID?.trim();
  if (!targetId) {
    throw new Error('Set IMPORT_USER_ID in .env to your auth.users UUID (after Google sign-in).');
  }

  const { data: authUser, error: authErr } = await getSupabase().auth.admin.getUserById(targetId);
  if (authErr || !authUser?.user) {
    throw new Error(`IMPORT_USER_ID ${targetId} is not in auth.users. Sign in with Google first.`);
  }

  const db = loadJson();
  const source = pickSourceUser(db.users ?? [], process.env.IMPORT_SOURCE_USER_ID?.trim());
  const srcId = String(source.id);
  console.log(`Importing legacy user ${srcId} → ${targetId}`);
  console.log(`Reading ${config.dataFile} (left untouched)`);

  const remap = (rows: Row[] | undefined) => (rows ?? []).filter((r) => r.user_id === srcId || r.id === srcId);

  // Profile
  const { posting_slots, id: _legacyId, ...profileFields } = source;
  await upsert(
    'profiles',
    {
      ...profileFields,
      id: targetId,
      updated_at: new Date().toISOString(),
    },
    'id',
  );
  console.log('profiles: 1');

  // Posting slots
  if (Array.isArray(posting_slots) && posting_slots.length) {
    await getSupabase().from('posting_slots').delete().eq('user_id', targetId);
    const slotRows = posting_slots.map((s: Row) => ({
      id: String(s.id ?? `${s.dayOfWeek}-${String(s.time).replace(':', '')}`),
      user_id: targetId,
      day_of_week: Number(s.dayOfWeek),
      time: String(s.time),
      enabled: Boolean(s.enabled),
    }));
    const { error } = await getSupabase().from('posting_slots').upsert(slotRows);
    if (error) throw new Error(`posting_slots: ${error.message}`);
    console.log(`posting_slots: ${slotRows.length}`);
  }

  const mapUser = (r: Row) => ({ ...r, user_id: targetId });

  async function copyTable(logical: string, physical: string, rows: Row[], transform: (r: Row) => Row = mapUser) {
    let n = 0;
    for (const r of rows) {
      const row = transform(r);
      await upsert(physical, row, 'id');
      n++;
    }
    console.log(`${physical}: ${n}`);
  }

  await copyTable('onboarding_drafts', 'brain_answers', remap(db.onboarding_drafts));
  await copyTable('personality_profiles', 'personality_profiles', remap(db.personality_profiles));
  await copyTable('user_writing_samples', 'user_writing_samples', remap(db.user_writing_samples));
  await copyTable('experience_items', 'experience_items', remap(db.experience_items));
  await copyTable('reference_accounts', 'reference_accounts', remap(db.reference_accounts));
  await copyTable('feedback_events', 'feedback_events', remap(db.feedback_events));
  await copyTable('learned_rules', 'learned_rules', remap(db.learned_rules));
  await copyTable('style_learnings', 'style_learnings', remap(db.style_learnings));
  await copyTable('social_accounts', 'social_accounts', remap(db.social_accounts));

  // Drafts: map published → posted
  const drafts = remap(db.generated_tweets).map((r) => {
    const status = r.status === 'published' ? 'posted' : r.status;
    return {
      ...r,
      user_id: targetId,
      status,
      posted_at: r.posted_at ?? r.published_at ?? null,
    };
  });
  await copyTable('generated_tweets', 'drafts', drafts, (r) => r);

  // Shared digests (once)
  for (const [physical, key] of [
    ['digest_items', 'digest_items'],
    ['digest_raw_items', 'digest_raw_items'],
    ['digest_runs', 'digest_runs'],
    ['digest_usage', 'digest_usage'],
    ['digest_blocklist', 'digest_blocklist'],
  ] as const) {
    await copyTable(key, physical, db[key] ?? [], (r) => r);
  }

  console.log('Done. Old JSON file was not modified.');
  console.log(`Test: curl -H "x-user-id: ${targetId}" http://localhost:3001/api/users/me`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
