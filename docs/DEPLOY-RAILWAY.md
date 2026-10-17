# Deploy Deevaa on Railway (recommended)

Always-on Next.js + Postgres so you can sign in from any browser and the nightly briefing runs without your laptop. Same app also deploys to Vercel; Railway avoids short serverless timeouts on chat, import, and Blueprint Notion publish.

## Prerequisites

- GitHub repo: `djain2405/deevaa-os`
- [Railway](https://railway.com) account (GitHub login)
- Google Cloud OAuth client (Web application) with Calendar API enabled
- Notion integration token and `NOTION_DATA_SOURCE_ID` (from `npm run notion:setup`)

## 1. Create the project

1. **New Project** → **Deploy from GitHub repo** → select `deevaa-os`.
2. Add **PostgreSQL** to the project (Railway plugin).
3. Open the **web service** → **Settings** → **Networking** → **Generate domain** (e.g. `deevaa-os-production.up.railway.app`).
4. Copy the Postgres **`DATABASE_URL`** from the database service variables (or reference `${{Postgres.DATABASE_URL}}` in the web service).

Build and start are defined in [`railway.toml`](../railway.toml) (`npm run build`, `npm run start` with `PORT`).

## 2. Environment variables (web service)

Generate **new** production secrets; do not copy local `.env.local` values for `AUTH_SECRET`, `TOKEN_ENCRYPTION_KEY`, or `CRON_SECRET`.

| Variable | Required | Notes |
|---|---|---|
| `APP_URL` | yes | `https://YOUR_RAILWAY_DOMAIN` (no trailing slash). At startup the app copies this into `AUTH_URL` when unset—Auth.js **only** reads `AUTH_URL` for OAuth callbacks (not `APP_URL` alone). Without it you may land on `https://localhost:8080/login?error=Configuration`. |
| `AUTH_URL` | no | Optional override. If unset, set automatically from `APP_URL` or `RAILWAY_PUBLIC_DOMAIN`. |
| `AUTH_SECRET` | yes | `openssl rand -base64 33` |
| `AUTH_GOOGLE_ID` | yes | Same OAuth client as local is fine |
| `AUTH_GOOGLE_SECRET` | yes | |
| `ALLOWED_EMAIL` | yes | Your Google account |
| `DATABASE_URL` | yes | From Railway Postgres |
| `TOKEN_ENCRYPTION_KEY` | yes | `openssl rand -base64 32` |
| `NOTION_TOKEN` | yes | |
| `NOTION_DATA_SOURCE_ID` | yes | Or `NOTION_DATABASE_ID` |
| `NOTION_PARENT_PAGE_ID` | recommended | Parent page shared with integration (Blueprint page + setup) |
| `CRON_SECRET` | yes | `openssl rand -hex 32` (≥16 chars) |
| `OPENAI_API_KEY` | no | |
| `INTAKE_TOKEN` | no | ≥32 chars to enable `/api/intake` |
| `NODE_ENV` | auto | Railway sets `production` |

Do **not** set `ALLOW_EMBEDDED_DB` in production.

## 3. Google OAuth redirect URIs

In Google Cloud Console → your OAuth client → **Authorized redirect URIs**, add (keep localhost entries for local dev):

- `https://YOUR_RAILWAY_DOMAIN/api/auth/callback/google`
- `https://YOUR_RAILWAY_DOMAIN/api/google/callback`

## 4. Database schema

On **deevaa-os** startup, the app runs idempotent SQL migrations against `DATABASE_URL` (same as embedded PGlite locally). You do **not** need to run `npm run db:migrate` from your laptop unless you prefer to.

`DATABASE_URL` on the web service should reference Postgres with a **variable reference** (e.g. `${{Postgres.DATABASE_URL}}`). That hostname (`postgres.railway.internal`) only works **inside Railway** — it will not work from your Mac.

Optional manual migrate (only if you enable Postgres public access and copy the resolved `DATABASE_PUBLIC_URL` value, not the `${{…}}` template):

```bash
DATABASE_URL="postgresql://..." npm run db:migrate
```

## 5. Deploy and verify

1. Push to `main` or trigger **Deploy** in Railway.
2. Open `https://YOUR_RAILWAY_DOMAIN/login` and sign in with `ALLOWED_EMAIL`.
3. **Connections**: connect Google Calendar; turn on Notion task updates / Blueprint publish if you want writes.
4. **Life Blueprint**: save once (local version in Postgres; optional Notion page publish).

### Scheduler (`/api/cron`)

[`railway.toml`](../railway.toml) defines a cron at `0 5 * * *` UTC that runs [`scripts/trigger-cron.sh`](../scripts/trigger-cron.sh). That script needs `APP_URL` and `CRON_SECRET` on the **web** service.

Manual check:

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" "https://YOUR_RAILWAY_DOMAIN/api/cron"
```

Expect `200` with `"outcome":"created"` the first time for tomorrow’s date, then `"duplicate"` on repeat. The dashboard **Scheduled briefing** row should show a cron run after this (with the browser closed).

Alternative: keep using [`vercel.json`](../vercel.json) cron if you deploy to Vercel instead.

## 6. What does not migrate from local

Embedded PGlite (`./.data/pglite`) is **not** uploaded. Production Postgres starts empty:

- Sign in creates your user row.
- Reconnect Google Calendar (new encrypted refresh token).
- Re-save Life Blueprint (and publish to Notion if enabled).

Notion tasks are unchanged (same workspace).

## Semi-autonomous milestones (later)

- Keep Postgres as the execution store (runs, locks, audit, Blueprint versions).
- Add more schedules as HTTP calls to `/api/cron` or new locked job routes—not laptop cron.
- Long-running agent work: add a second Railway **worker** service that claims `runs` rows; keep the web service for UI and short API calls.

## Troubleshooting

| Symptom | Check |
|---|---|
| `DATABASE_URL is required in production` | `DATABASE_URL` set on web service; redeploy |
| `invalid_client` on sign-in | Redirect URIs and `AUTH_GOOGLE_*`; shell env not overriding Railway vars |
| Calendar connect fails | `APP_URL` matches public URL; `TOKEN_ENCRYPTION_KEY` set before first connect |
| Cron never runs | Railway cron enabled; `APP_URL` + `CRON_SECRET`; run manual `curl` first |
| Blueprint save slow / timeout | Railway has no 10s cap; Vercel Hobby may—prefer Railway for this app |
