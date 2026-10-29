# Tweet Brain (merged backend)

One backend that connects your three projects:

| Old project | Now lives in | What it does here |
|---|---|---|
| `tweet-brain-backend` | `src/lib`, `src/routes`, `brain/` | Onboarding questions, scoring, profile synthesis, tweet generation, feedback learning, daily cron |
| `tweet-brain-reference-accounts` | `src/references` | Connect Twitter/X accounts whose **style** you want, fetch their tweets, build style context |
| *(new)* niche digest | `src/digest` | Once a day, collect what is happening in your field from official feeds, GitHub, Hacker News and a capped Parallel search, verify it, and store short facts with source links |

```
 onboarding answers ──► PROFILE (who you are, how you sound)  ┐
 reference accounts ──► STYLE CONTEXT (how they write)         ├─► LLM (Gemini, fallback OpenRouter) ─► validated tweet drafts
 niche digest       ──► MATERIAL (what is happening now)       ┘                                         │
                                                                                like / discard / edit ◄──┘ (the app learns rules from this)
```

Everything runs in **one server on one port (3001)**. Data is stored in a local JSON file (`data/db.json`), so there is nothing to install besides Node.

---

## 1. Set up (5 minutes)

Requires **Node 20 or newer** (`node -v`).

```bash
cd tweet-brain
npm install
```

Open **`config.yml`** and paste your keys (it is already created for you, keys are empty):

```yaml
llm:
  provider: gemini              # main model
  fallback_provider: openrouter # used automatically if Gemini errors or runs out of quota
  gemini:
    api_key: "PASTE_GEMINI_KEY"
    model: gemini-3.5-flash-lite
  openrouter:
    api_key: "PASTE_OPENROUTER_KEY"
    model: openrouter/free
```

- **Gemini key:** https://aistudio.google.com/apikey (free, no card).
- **OpenRouter key:** https://openrouter.ai/keys. `openrouter/free` lets OpenRouter pick a currently-free model for you.
- Leave both keys empty and the server runs in **MOCK mode** (fake answers, no cost) so you can test all the plumbing first.
- Environment variables (or a `.env` file) override `config.yml`. Copy `.env.example` to `.env` and fill in what you have:

| Variable | Needed for | Where to get it |
|---|---|---|
| `GEMINI_API_KEY` | Real tweets and digest summaries | https://aistudio.google.com/apikey (free) |
| `OPENROUTER_API_KEY` | Automatic fallback model | https://openrouter.ai/keys (free models) |
| `PARALLEL_API_KEY` | Web-search layer of the digest (optional) | https://platform.parallel.ai (free allowance 5,000 requests/month) |
| `ADMIN_KEY` | Protect `/api/admin/*` (optional locally) | Make up any long random string |
| `ALERT_WEBHOOK_URL` or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Failure alerts (optional) | Slack/Discord webhook, or @BotFather on Telegram |
| `X_BEARER_TOKEN`, `TWITTERAPI_IO_KEY` | Reading other accounts' tweets (optional, paste works without) | developer.x.com, twitterapi.io |

  With **no keys at all** the server runs in MOCK mode, so you can test every endpoint first.
- **Restart the server after every change to `config.yml`.**

> **Gemini model names change often**, and free-tier limits differ per model (reports in Sep 2026: `gemini-3.5-flash-lite` allows far more free requests per day than `gemini-3.8-flash`, which writes better but runs out fast). If you get a 404 or 429, change `llm.gemini.model` and check your limits in AI Studio.

Start the server:

```bash
npm run dev
```

You should see which LLM is active:

```
Tweet Brain running on http://localhost:3001
  LLM         : gemini:gemini-3.5-flash-lite  ->  openrouter:openrouter/free
```

Check your keys (admin only): set `ADMIN_KEY` in `.env`, then:

```bash
curl -H "x-admin-key: YOUR_ADMIN_KEY" http://localhost:3001/api/llm/test
```

Lean probes: `GET /health` (no DB) and `GET /keepalive` (tiny DB read — use this daily to keep a free Supabase project from pausing). See `supabase/README.md` for keepalive + weekly backup (`npm run backup`) / restore.

### Quick automatic check

With the server running, in a second terminal:

```bash
npm run smoke
```

It runs the whole flow (user, onboarding, reference account, niche digest, generate, like) and prints PASS/FAIL per step. With real keys it makes about 5 LLM calls.

---

## 2. Test in Postman

1. Postman > **Import** > `postman/tweet-brain.postman_collection.json`.
2. Run the requests **top to bottom**. The collection saves ids for you (`userId`, `refId`, `tweetId`) and sends the `x-user-id` header automatically.
3. Order: **0 Setup** (health, LLM test, *Create user*) → **1 Onboarding** → **2 Reference accounts** → **3 Niche digest** → **4 Tweets**.

Postman not needed for a quick look: `GET /api/overview` (header `x-user-id`) shows everything connected so far.

---

## 3. Answering the psychology questions

Open **http://localhost:3001/onboarding** for a simple browser form. It saves your answers to the same onboarding draft as the other options, then builds and displays your profile when enough answers are complete. Your browser remembers the user id so you can continue the draft later.

Or pick one of these:

### Option A: terminal (easiest)

```bash
npm run onboard
```

It asks every question in your terminal, one at a time (free text, 1-5 ratings, A/B choices, lenses, your own posts), saves after each section, and at the end offers to build your profile. Press Ctrl+C any time and run it again: it resumes and keeps earlier answers. It also creates your user and prints the id so you can paste it into the Postman variable `userId`.

### Option B: Postman

1. **1b. Get the fill-in template** shows every question with its id and how to answer it.
2. **1c. Save ALL answers**: edit the JSON body:
   - `persona.q1 ... q10`: your text answers (`""` skips one; `q10` is a list of topics).
   - `thinking.t1 ... t15`: a number from 1 (strongly disagree) to 5 (strongly agree).
   - `voice.v1 ... v8`: `"A"`, `"B"` or `"neither"` for which example sounds more like you.
   - `lenses`: up to 2 from `lens_options` in the template.
   - `samples`: 3-10 of your own real past posts.
3. The response shows progress and what is missing. You can send it in pieces; each save is merged. Wrong values (a rating of 9, voice `"C"`) are rejected with a clear message and nothing is saved.
4. When `ready_to_synthesize` is `true`: **1g. Build my profile**.

If you leave any `TYPE YOUR ANSWER` text in the persona answers, step 1g refuses to run and tells you which ones.

**Using your own X account for the writing samples:** put your handle in *Create user*, add a Twitter key (section 4), then run **1e** (or type `fetch` in the terminal script). It picks your 10 best recent posts. No key? Paste 3-10 posts into `samples`.

---

## 4. Connect Twitter accounts and the niche digest

### Reference accounts (style you want to borrow)

For each account you admire, a style profile is built from its tweets: voice, rhythm, hooks, formatting, plus real example tweets. The generator copies the **form**, never the wording (a validator rejects drafts that copy 6+ words in a row from a reference tweet).

Three ways to get the tweets, use any mix:

| Source | Setup in `config.yml` | Notes |
|---|---|---|
| **Paste** | nothing | Always works. Copy 20+ tweets from the profile page, separate with a line containing only `---`. |
| **X API** | `twitter.x_bearer_token` | Official. Reading *other* accounts' posts may need paid credits on your X developer plan. |
| **twitterapi.io** | `twitter.twitterapi_io_key` | Third party, pay per call, no X approval. |

`POST /api/references` with `{"handle":"IndieHackers","syncNow":true,"analyze":true}` tries the API sources; add `"text":"tweet\n---\ntweet"` to paste instead. The exact text sent to the LLM for an account is visible at `GET /api/references/:id/context?format=text`.

**What "connect my own account" means right now:** the app reads **public tweets by handle** (for your writing samples and, if you want, as a reference). There is no "Log in with X" button and the app **does not post** to X. Those come later with a frontend (X OAuth is needed for posting).

### Niche digest (what is happening in your field)

No newsletters and no scraping of anyone's articles. One shared digest per niche, built once a day on autopilot:

```
SCHEDULER (cron 04:00)
  1 COLLECT    official feeds + GitHub releases (Tier 1) | Hacker News (Tier 2) | Parallel search (Tier 3, capped)
  2 DEDUPE     same story from several sources becomes ONE cluster
  3 VERIFY     kept only if it has a Tier 1/2 source OR two independent domains (a lone search hit is dropped)
  4 SUMMARIZE  LLM call #1: short facts in its own words; code rejects any copied 6-word run
  5 STORE      digest_items = fact + source link. Raw excerpts (300 chars) are deleted after 48h
tweet generation (per user, LLM call #2) reads that digest, then every draft goes through the safety gate
```

The sources live in `config.yml > digest > niches`. Add your own feeds, GitHub repos and search queries there. **A dead feed never breaks a run**: it is skipped and listed in the run report.

**Failure behaviour:** if sources, Parallel or the LLM fail, the previous digest keeps being served and an alert goes to your Slack/Discord webhook or Telegram (if configured).

**Parallel budget:** each entry under `search:` costs 1 request per niche per day (already-fetched results are reused). `parallel.monthly_cap` (default 4000) is a hard stop. See usage at `GET /api/admin/digest/usage`. Without a Parallel key the digest runs on feeds, GitHub and Hacker News only.

**Safety gate on every tweet** (code, no LLM): rejects copied wording from a source, invented first-person experience ("I tested...", "we shipped..."), numbers that are not in the digest or the user's profile, and accusations about named people or companies. News tweets carry `source_url` and a "check the source before you post" note.

**Takedown:** `POST /api/admin/digest/blocklist {"domain":"example.com"}` blocks a domain for all future runs and removes what is already stored from it immediately.

---

## 5. Generate tweets

After building your profile, use the **Generate tweets** section on http://localhost:3001/onboarding. Choose a count, optionally enter a topic, and submit to see the generated drafts.

`POST /api/tweets/generate`:

```json
{ "count": 10, "refresh_digest": true, "topic": "optional extra thing to react to" }
```

About 60% of the batch (`digest.news_share`) reacts to a digest item and carries `source_url`; the rest is evergreen. If today's digest is missing or older than 26 hours it is built first. The response lists what was used (`used.digest_items`, `used.reference_accounts`), `news_tweets` / `evergreen_tweets`, the saved tweets, and any drafts the validator rejected (too long, banned words, hashtags, copied phrases, AI clichés from your brain file). Then:

- `POST /api/tweets/:id/like`
- `POST /api/tweets/:id/discard` with `{"reason":"too_generic"}`
- `POST /api/tweets/:id/edit` with `{"text":"..."}`

After 3+ consistent discards/edits the nightly job turns the pattern into a rule (`POST /api/dev/run-learning` runs it now). `PATCH /api/profile` adds hard rules (banned words, off-limits topics). A cron also generates a batch each morning at each user's `preferred_generation_time` (turn off with `server.cron_enabled: false`).

---

## 6. Endpoint list

Header for everything except those marked *open* or *admin*: `x-user-id: <id from POST /api/users>`. *admin* endpoints need no user, but need `x-admin-key: <ADMIN_KEY>` if you set `ADMIN_KEY`.

| Method + path | Purpose |
|---|---|
| `GET /health` *open* | Server, active LLMs, brain file check |
| `GET /api/llm/test` *open* | Test each LLM key |
| `POST /api/users` *open* | Create user `{niche?, twitter_handle?, timezone?, daily_tweet_limit?, preferred_generation_time?}` |
| `GET/PATCH/DELETE /api/users/me` | Read / change / delete me and all my data |
| `GET /api/overview` | Everything connected so far |
| `GET /api/onboarding/questions` | Raw questions |
| `GET /api/onboarding/template` | Fill-in template + how to answer |
| `PUT /api/onboarding/draft` | Save answers (validated, merged) |
| `GET /api/onboarding/draft` | Progress + what is missing |
| `POST /api/onboarding/own-tweets` | Use your own X posts as samples |
| `POST /api/onboarding/score` | Scores computed in code (no LLM) |
| `POST /api/onboarding/synthesize` | Build profile (LLM) |
| `GET /api/references/status` | Which tweet sources are configured |
| `POST /api/references` | Connect account (`syncNow`, `text`, `analyze`) |
| `GET /api/references`, `GET /:id`, `DELETE /:id` | List / details / remove |
| `POST /api/references/:id/sync` | Fetch via API |
| `POST /api/references/:id/tweets/import` | Paste tweets |
| `GET/DELETE /api/references/:id/tweets` | See / clear stored tweets |
| `POST /api/references/:id/analyze`, `GET /:id/style`, `GET /:id/context` | Style profile + exact LLM context |
| `GET /api/digest` | Today's digest for my niche (short facts + source links) |
| `GET /api/digest/niches` | Niches defined in config.yml |
| `POST /api/admin/digest/dry-run?niche=tech[&include_search=1]` *admin* | Preview: collect + verify, no LLM, nothing saved |
| `POST /api/admin/digest/run?niche=tech[&force_search=1]` *admin* | Build the digest now |
| `GET /api/admin/digest/status`, `/runs`, `/usage`, `/raw` *admin* | Sources, per-source reports, Parallel budget, collected excerpts |
| `GET/POST /api/admin/digest/blocklist`, `DELETE /:domain` *admin* | Takedown / unblock a domain |
| `POST /api/admin/digest/test-alert`, `/purge` *admin* | Test alerts / delete old data now |
| `POST /api/tweets/generate` | Generate |
| `GET /api/tweets?status=pending\|liked\|discarded` | List |
| `POST /api/tweets/:id/like \| discard \| edit` | Feedback |
| `GET/PATCH /api/profile` | Profile + learned rules / add hard rules |
| `POST /api/dev/run-generation-cron?force=1`, `POST /api/dev/run-learning` *open* | Run jobs now |

Errors always look like `{"error":{"code","message","hint"}}`: read the `hint`.

---

## 7. Things you should know

1. **`brain/brain-file.md` is the placeholder** that was in your upload (`/health` shows a warning). Replace it with your real brain file. Keep the `---` front matter with `brain_version:`, a **Synthesis Instructions** section (the JSON shape the profile step expects), and the **Banned AI phrases** bullets.
2. **`brain/instruments/ipip-big5.json` has only 2 sample items.** The Big Five section is optional; paste the 50 public-domain IPIP items there if you want it scored.
3. **Auth is a dev shortcut**: the `x-user-id` header. Replace with real login before making this public.
4. **Database** is a JSON file (`data/db.json`). Fine for local and a handful of users; swap `src/lib/db.ts` and `src/references/store.ts` for Postgres/Supabase later.
5. **The feed URLs in `config.example.yml` are starting points I could not test from my environment.** Run `POST /api/admin/digest/dry-run` first: it lists every source as ok/FAIL. Replace failing ones with the real RSS/Atom URL (often `/feed`, `/rss` or `/atom`).
6. **Legal basics, not legal advice:** the digest stores facts in its own words plus links, keeps only 300-character excerpts for 48 hours, never trains on source text, and has a blocklist for takedowns. Read the terms of each source and of Parallel (Customer Terms) before going public, and have a lawyer glance at your Terms of Service and Privacy Policy.
7. **Posting to X is not built.** Drafts are copied or opened in X's compose window by the frontend; automatic posting needs the paid X API.
8. Untrusted text (tweets, digest sources) is wrapped in tagged blocks with an instruction to ignore commands inside it.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `LLM: MOCK mode` at startup | No key found. Paste a key in `config.yml` and restart. |
| `/api/llm/test` Gemini 404 | Wrong/unavailable model name. Try `gemini-3.5-flash-lite` or `gemini-3.8-flash`. |
| Gemini 429 | Free-tier limit. The OpenRouter fallback answers automatically; or wait / switch model. |
| `Every LLM provider failed` | Run `/api/llm/test`; fix the key or model it names. |
| `placeholder_answers` on synthesize | Replace the `TYPE YOUR ANSWER` texts in persona answers. |
| `x_api_forbidden` / `x_api_payment_required` | Your X plan cannot read other accounts. Use twitterapi.io or paste tweets. |
| Digest says `empty` | Nothing new and confirmed was found, or every source failed. Run the dry-run and read `sources`; the previous digest is still served. |
| A feed shows `HTTP 403/404` in the dry-run | Wrong URL or the site blocks bots. Use another feed URL or remove it. |
| `401 admin_key_required` | `ADMIN_KEY` is set: send it as the `x-admin-key` header (Postman variable `adminKey`). |
| `parallel_payment_required` / `parallel_rate_limited` | Free allowance used up or rate limited. The run continues on feeds only. |
| `401 unknown_user` | Run *Create user* (or `npm run onboard`) and send its id in `x-user-id`. After deleting `data/db.json`, create a new user. |
| Config error on startup | The message names the exact key. YAML needs spaces (no tabs). |

## 9. Scripts

`npm run dev` (auto-restart) · `npm start` · `npm run onboard` · `npm run smoke` · `npm run polar:diagnose` · `npm test` (13 tests, no keys or internet needed) · `npm run typecheck`

---

## Polar sandbox vs production

Polar uses a **separate sandbox server**, not a test-mode flag on production ([sandbox docs](https://polar.sh/docs/integrate/sandbox)). The SDK picks the host from `POLAR_ENVIRONMENT` only (`sandbox` → `sandbox-api.polar.sh`, `production` → `api.polar.sh`).

| Value | Sandbox | Production |
|---|---|---|
| `POLAR_ENVIRONMENT` | `sandbox` | `production` |
| `POLAR_ACCESS_TOKEN` | OAT from [sandbox.polar.sh](https://sandbox.polar.sh) (Settings → Developers) | OAT from [polar.sh](https://polar.sh) — **not interchangeable** with sandbox |
| `POLAR_WEBHOOK_SECRET` | Signing secret from the **sandbox** webhook endpoint | Signing secret from the **production** webhook endpoint |
| `POLAR_PRODUCT_LIFETIME_19` / `_29` / `MONTHLY` / `YEARLY` | Product IDs created in sandbox | Product IDs created in production (different IDs) |
| `POLAR_SUCCESS_URL` | Local/staging app URL with `{CHECKOUT_ID}` | Live app URL with `{CHECKOUT_ID}` |

Suggested OAT scopes: `products:read`, `checkouts:read`, `checkouts:write`, `customer_sessions:write`. After filling `.env`, run `npm run polar:diagnose` (prints environment and product checks; never prints secrets). Webhook route: `POST /webhooks/polar` verifies the **raw** body signature and returns **403** on invalid signatures.

**Local sandbox:** Polar cannot deliver webhooks to `localhost`. After checkout, `/welcome` calls `POST /api/billing/confirm` with `checkout_id` and grants access when Polar reports `succeeded`. For full webhook testing locally, run `polar auth login --sandbox` then `polar webhook listen http://localhost:3001/webhooks/polar` and set `POLAR_WEBHOOK_SECRET` to the secret the CLI prints ([docs](https://polar.sh/docs/integrate/cli/webhooks)).
