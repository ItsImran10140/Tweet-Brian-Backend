# Localhost test guide — required onboarding + free batch

Small checklist for verifying the first-run flow on your machine.

## 0. Apply the migration

In the Supabase SQL editor (or CLI), run:

`supabase/migrations/012_free_generation_gates.sql`

This creates `global_daily_counters` and `save_free_generation_batch` (atomic free-batch save).

## 1. Limits (one file)

Edit `config.yml` → `limits:` (or copy from `config.example.yml`):

| Key | Default | Meaning |
|-----|---------|---------|
| `free_batches_per_user` | `1` | Free draft batches per new user |
| `free_generations_global_per_day` | `200` | Global circuit breaker (UTC day) |
| `paid_drafts_per_day` | `50` | Paid generate quota |
| `paid_posts_per_day` | `20` | Paid schedule/publish quota |
| `generate_per_hour` | `30` | Per-user rate limit on gen endpoints |

Restart the API after changes (`npm run dev` in `tweet-brain`).

## 2. Start apps

```bash
# API
cd tweet-brain
ALLOW_TEST_AUTH=1 npm run dev

# Frontend
cd "Frontend - Copy/app"
npm run dev
```

Open `http://localhost:5173`.

## 3. Manual UI path

1. **Sign in** with Google (new account or one with `onboarding_completed = false`).
2. You should land on **onboarding only** — typing `/` or `/posts` redirects back until complete.
3. Answer a few steps, **refresh the tab** — you resume at the saved section (DB + local).
4. Finish onboarding → voice profile → **Go home** → generation screen.
5. First **Generate drafts** creates one normal-sized batch (uses `daily_tweet_limit`).
6. Double-click Generate — second call should fail with “already running” or paywall after the first succeeds; only one batch is saved.
7. After the free batch: edit/copy drafts OK; **Generate again**, **Schedule**, **Post**, **From idea**, **Refine** show the paywall.
8. Set `free_generations_global_per_day: 0` temporarily, restart, try free generate on a fresh user → message *Free drafts are paused for today, subscribe to continue* and an `[ALERT]` line in the API logs.

## 4. Direct API checks (locked endpoints)

With a Supabase access token (or `ALLOW_TEST_AUTH=1` + `x-test-user-id`):

```bash
# Before onboarding completes → 403 onboarding_required
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/tweets

# After free batch, unpaid → 402 paywall
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{}" http://localhost:3001/api/tweets/generate

curl -s -X PATCH -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"scheduledAtUtc\":null}" http://localhost:3001/api/tweets/SOME_ID/schedule
```

Onboarding + me stay allowed while incomplete:

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/me
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/onboarding/draft
```

## 5. Automated tests

```bash
cd tweet-brain
npm test -- test/gates-free-gen.test.ts test/entitlement-endpoints.test.ts
```

Covers: double-click lock, generation-failure not consuming free batch (guard), resume cursor preference, calling locked routes without a plan.
