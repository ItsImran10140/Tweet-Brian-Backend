# Deploy tweet-brain on Render (Free)

Checklist for everything that must be done outside this repo. Do **not** commit real secret values.

## Known limits (Free plan)

- Free web services **spin down** after ~15 minutes without inbound traffic. Use an external pinger on `GET /health` every 5 minutes (see below).
- Cold start after sleep is typically **~30–60s**. The first request (or health check) after idle may be slow.
- **Single instance only.** Per-IP / per-user rate limits and in-process generation/digest locks live in memory — a second instance would not share them.
- Ephemeral disk: files under `data/` (including `generation-logs/`) are **not** durable across deploys/restarts. Stage disk logging is **off** in production unless you set `GENERATION_LOG_STAGES=true`.
- `brain/` files are **read-only at runtime** (shipped with the repo). That is fine on Render.
- `config.yml` is gitignored. Niche digest feeds live there. Without a `config.yml` on the server, niches default to empty and the daily digest cron will not schedule niches. Either:
  - Change the Render **Build Command** to  
    `npm install && cp config.example.yml config.yml`  
    (env vars still override API keys), or
  - Add a secrets-free `config.yml` (niches only) via another safe path you control.

## Manual checklist

### a. Create the web service

1. Push this repo to GitHub/GitLab (or connect the local git remote Render will use).
2. In [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**, point at the repo root that contains `render.yaml`, **or** create a **Web Service** manually:
   - Runtime: **Node**
   - Plan: **Free**
   - Build: `npm install`
   - Start: `npm start`
   - Health check path: `/health`

### b. Fill in env vars

In the service → **Environment**, set every secret listed in `render.yaml` / `.env.example` (at minimum):

| Variable | Notes |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend only — never expose to the frontend |
| `GEMINI_API_KEY` / `OPENROUTER_API_KEY` | At least one required to start |
| `FRONTEND_URL` | Real frontend origin (see c) |
| `ADMIN_KEY` | Protects `/api/admin/*` |
| `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`, `X_TOKEN_ENCRYPTION_KEY` | X OAuth |
| `POLAR_ENVIRONMENT`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_PRODUCT_*`, `POLAR_SUCCESS_URL` | Billing |

Blueprint already sets `NODE_VERSION=20`, `NODE_ENV=production`, `CRON_ENABLED=true`. Render injects `PORT` automatically.

### c. CORS — `FRONTEND_URL`

Set `FRONTEND_URL` to your real frontend origin (scheme + host, no trailing path), e.g. `https://your-app.vercel.app`. Localhost origins stay allowlisted in code.

### d. Polar webhook

1. In Polar → Webhooks, set delivery URL to:  
   `https://<my-service>.onrender.com/webhooks/polar`
2. Copy the signing secret into `POLAR_WEBHOOK_SECRET` on Render.
3. Keep `POLAR_ENVIRONMENT` / product IDs / OAT aligned with sandbox vs production.

### e. X OAuth redirect

1. In the X developer portal, add callback:  
   `https://<my-service>.onrender.com/auth/x/callback`
2. Set the same value in `X_REDIRECT_URI` on Render.

### f. Frontend API base URL

Point the frontend production env at:  
`VITE_API_BASE_URL=https://<my-service>.onrender.com/api`  
`VITE_API_ORIGIN=https://<my-service>.onrender.com`  

Also set `FRONTEND_URL=https://app.tweet-brain.com` on Render (CORS + X OAuth return).

### g. Keep-awake pinger

Create a monitor so the free instance does not sleep:

- **UptimeRobot**: HTTP(s), URL `https://<my-service>.onrender.com/health`, interval **5 minutes** (HEAD or GET both work).
- **Or cron-job.org**: every 5 minutes, **GET** the same `/health` URL.

Optional: a second **daily** job hitting `GET /keepalive` (tiny DB read) to reduce chance of a free Supabase project pausing.

### h. Verify

```bash
curl -sS https://<my-service>.onrender.com/health
# expect HTTP 200 JSON: {"ok":true,"service":"tweet-brain",...}

curl -sSI -X HEAD https://<my-service>.onrender.com/health
# expect HTTP 200
```

In Render **Logs**, confirm lines like:

- `[cron] daily niche digest scheduled: ...` (if niches are configured)
- `[cron] hourly generation + daily learning scheduled`

After **30+ minutes** with no real user traffic, the service should stay **Live** (pinger traffic counts).

## Local production smoke test

```bash
cd tweet-brain
npm install
set NODE_ENV=production
npm start
# other terminal:
curl -sS http://localhost:3001/health
curl -sSI -X HEAD http://localhost:3001/health
```

(PowerShell: `$env:NODE_ENV="production"; npm start`)

You still need a valid `.env` (or env vars) with at least one LLM key and Supabase for a full boot; `/health` itself does not touch DB or LLM.
