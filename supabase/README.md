# Supabase setup (Tweet Brain)

## Step 1 — Migrations

In the Supabase SQL editor, run these files **in order** (safe to re-run):

1. `migrations/001_extensions_and_helpers.sql`
2. `migrations/002_profiles_and_brain.sql`
3. `migrations/003_references_and_samples.sql`
4. `migrations/004_newsletters.sql`
5. `migrations/005_digests.sql`
6. `migrations/006_drafts_and_slots.sql`
7. `migrations/007_social_and_oauth.sql`
8. `migrations/008_billing_and_usage.sql`
9. `migrations/009_learning.sql`
10. `migrations/010_rls.sql`
11. `migrations/011_auth_profile_fields.sql`
12. `migrations/012_billing_polar.sql`

**Test:** run 001→012 twice; second pass must not error. Confirm tables in Table Editor.

Brain psych-test files stay in the repo (`brain/brain-file.md`, `questions.json`, `ipip-big5.json`) — not in the database.

## Step 2 — Environment

Copy `.env.example` → `.env` and set at least:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` (backend only; never ship to the frontend)

**Test:** `npm run dev` then `GET http://localhost:3001/health`.

## Step 3 — Google Auth + profile

1. Enable **Google** under Supabase → Authentication → Providers (disable email magic-link / password if you want Google-only).
2. Add redirect URL: `http://localhost:5173/auth/callback` (and your production URL).
3. Frontend: set `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` in `.env.local`.
4. After Google sign-in the app calls `GET /api/me` (Bearer token) which creates `profiles` idempotently.

**Test:** sign in → `GET /api/me` returns `id`, `state`, `onboarding_completed`, `plan` → other `/api/*` calls send `Authorization: Bearer <access_token>`.

## Step 4 — Import legacy JSON (optional, once)

Leave `data/db.json` as backup. After you have your auth user id:

```bash
# .env
IMPORT_USER_ID=<your-auth-uuid>
# optional:
IMPORT_SOURCE_USER_ID=<legacy-db.json-user-id>

npm run import-json
```

**Test:** row counts in Supabase; `GET /api/overview` with `x-user-id`.

## Keepalive (stop free-plan pause)

Supabase free projects pause after inactivity. Ping the backend once a day so it does a tiny DB read:

1. Deploy the API (or keep it running somewhere).
2. In any uptime monitor (UptimeRobot, Cron-job.org, GitHub Actions cron, etc.) create a **daily** HTTPS GET to:

   `https://YOUR_API_HOST/keepalive`

3. Expect HTTP 200 and JSON like `{ "ok": true, "db": "ok", "ms": 12 }`.
4. Lean liveness (no DB): `GET /health` → `{ "ok": true, "service": "tweet-brain" }`.

**Test locally:** with `npm run dev` running:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/keepalive
```

## Backups (weekly)

Export every app table to a timestamped JSON file (uses the **backend** service-role key only):

```bash
cd tweet-brain
npm run backup
# → data/backups/tweet-brain-YYYYMMDD-HHMMSS.json
```

**Weekly habit:** run `npm run backup` once a week (or schedule Task Scheduler / cron). Copy the file off the machine (Drive, S3, etc.). `data/backups/` is gitignored — backups can contain OAuth tokens and user content.

**Restore** (upserts by primary key into the live DB — confirm the target project first):

```bash
npm run restore -- data/backups/tweet-brain-YYYYMMDD-HHMMSS.json
# optional: only some tables
# Windows PowerShell:
#   $env:RESTORE_TABLES="profiles,drafts"; npm run restore -- data/backups/….json
```

After restore: spot-check Table Editor, then `curl http://localhost:3001/keepalive`.

## Hardening notes

- `/api/*` user routes require `Authorization: Bearer <supabase access token>` and are scoped to that user id.
- `/api/admin/*`, `/api/llm/test`, `/api/dev/*` require header `x-admin-key: <ADMIN_KEY>`. If `ADMIN_KEY` is unset, those routes return 503 (closed), not open.
- Global IP + per-user rate limits apply (`LIMITS_IP_PER_MINUTE`, `LIMITS_API_PER_MINUTE`).
- Errors go through one handler; logs redact tokens/secrets. Clients never get raw 500 messages.

## Notes

- App code talks only to `src/data/` (service-role client). `src/lib/db.ts` is a thin re-export.
- `SUPABASE_SERVICE_ROLE_KEY` must exist **only** in backend `.env` / host secrets — never in `Frontend - Copy/app` (that app uses `VITE_SUPABASE_ANON_KEY` only).
- `data/db.json` is no longer written. Ask before deleting it or `lib/db.ts`.
- Generation stage logs (`data/generation-logs/*.jsonl`) are unchanged debug files.
