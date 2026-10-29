/**
 * Restore tables from a backup JSON produced by scripts/backup.ts.
 *
 * DANGEROUS: upserts into live Supabase. Prefer a fresh project or confirm you
 * intend to overwrite rows with the same primary keys.
 *
 *   npm run restore -- data/backups/tweet-brain-YYYYMMDD-HHMMSS.json
 *
 * Optional: RESTORE_TABLES=profiles,drafts  (comma list; default = all in file)
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config';
import { getSupabase } from '../src/data';
import { BACKUP_TABLES } from './backup';

const PAGE = 200;

async function upsertBatch(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const sb = getSupabase();
  for (let i = 0; i < rows.length; i += PAGE) {
    const chunk = rows.slice(i, i + PAGE);
    const { error } = await sb.from(table).upsert(chunk);
    if (error) throw new Error(`upsert ${table}: ${error.message}`);
  }
}

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: npm run restore -- data/backups/tweet-brain-….json');
    process.exit(1);
  }
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
    process.exit(1);
  }

  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    exported_at?: string;
    tables?: Record<string, Record<string, unknown>[]>;
  };
  if (!raw.tables || typeof raw.tables !== 'object') {
    console.error('Invalid backup: missing tables object.');
    process.exit(1);
  }

  const allow = process.env.RESTORE_TABLES
    ? new Set(process.env.RESTORE_TABLES.split(',').map((s) => s.trim()).filter(Boolean))
    : null;

  const order: string[] = [...BACKUP_TABLES].filter((t) => raw.tables![t]);
  for (const t of Object.keys(raw.tables)) {
    if (!order.includes(t)) order.push(t);
  }

  console.log(`Restoring from ${filePath} (exported ${raw.exported_at ?? 'unknown'})`);
  console.log('This upserts by primary key into your live database.\n');

  for (const table of order) {
    if (allow && !allow.has(table)) continue;
    const rows = raw.tables[table] ?? [];
    if (!rows.length) {
      console.log(`  ${table}: 0 rows (skip)`);
      continue;
    }
    process.stdout.write(`  ${table}: ${rows.length} rows… `);
    await upsertBatch(table, rows);
    console.log('ok');
  }

  console.log('\nRestore finished. Spot-check in Supabase Table Editor, then GET /keepalive.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
