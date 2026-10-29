/**
 * Supabase service-role client (backend only).
 *
 * Setup / local test:
 * 1. Run supabase/migrations/001…010 in order in the SQL editor (twice to confirm idempotent).
 * 2. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example).
 * 3. npm run dev — GET /health should succeed.
 * 4. After Google sign-in, set IMPORT_USER_ID and run: npx tsx scripts/import-json.ts
 *
 * Never expose the service-role key to the frontend. RLS still protects user-scoped client access.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const { url, serviceRoleKey } = config.supabase;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill both values from your Supabase project settings (service_role secret).',
    );
  }
  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
