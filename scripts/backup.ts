/**
 * Export all Tweet Brain Supabase tables to a timestamped JSON file.
 *
 * Run (from tweet-brain/):
 *   npm run backup
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (backend only).
 * Writes: data/backups/tweet-brain-YYYYMMDD-HHMMSS.json
 *
 * Restore: see supabase/README.md → "Backups".
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from '../src/config';
import { getSupabase } from '../src/data';

/** Physical Postgres tables owned by this app (order does not matter for export). */
export const BACKUP_TABLES = [
  'profiles',
  'brain_answers',
  'personality_profiles',
  'user_writing_samples',
  'experience_items',
  'reference_accounts',
  'newsletters',
  'user_newsletters',
  'digest_items',
  'digest_raw_items',
  'digest_runs',
  'digest_usage',
  'digest_blocklist',
  'drafts',
  'posting_slots',
  'feedback_events',
  'learned_rules',
  'style_learnings',
  'social_accounts',
  'x_oauth_states',
  'purchases',
  'entitlements',
  'processed_webhook_events',
  'daily_usage',
  'global_daily_counters',
] as const;

const PAGE = 1000;

async function fetchAll(table: string): Promise<unknown[]> {
  const sb = getSupabase();
  const rows: unknown[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE - 1;
    const { data, error } = await sb.from(table).select('*').range(from, to);
    if (error) {
      // Table may not exist yet (migration not applied) — skip with a note.
      if (/does not exist|schema cache|Could not find/i.test(error.message)) {
        console.warn(`  skip ${table}: ${error.message}`);
        return [];
      }
      throw new Error(`Failed reading ${table}: ${error.message}`);
    }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function main() {
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example → .env first.');
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const dir = path.join(ROOT, 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const outPath = path.join(dir, `tweet-brain-${stamp}.json`);

  console.log(`Backing up ${BACKUP_TABLES.length} tables → ${outPath}`);
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of BACKUP_TABLES) {
    process.stdout.write(`  ${table}… `);
    const rows = await fetchAll(table);
    tables[table] = rows;
    counts[table] = rows.length;
    console.log(`${rows.length} rows`);
  }

  const payload = {
    exported_at: new Date().toISOString(),
    supabase_url: config.supabase.url,
    tables,
    counts,
  };

  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  const mb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(2);
  console.log(`\nDone. ${mb} MB → ${outPath}`);
  console.log('Keep this file offline. It may contain OAuth tokens and user content.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
