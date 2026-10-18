# Deevaa OS v0.3: Conversational Chief of Staff

A private, single-owner Next.js app that reads your Notion tasks, Google Calendar, and (optionally) Gmail and prepares one grounded daily briefing: top outcomes, Focus / Close / Maintain / Expand blocks placed only in real free time, a "Needs attention" list, a morning email digest, and a "find my next action" picker.

New in v0.3: you can **tell Deevaa what changed in plain language** ("I submitted the PR, waiting on review; my parents arrive October 21 so I need to prepare the apartment"). Deevaa extracts tasks and status changes, matches them against Notion, and, only if you have turned on task updates, creates or updates the Notion tasks, reads each one back to verify it, shows you exactly what changed with links, and refreshes the plan. Every chat change can be undone.

What Deevaa will **not** do: send messages, create or change calendar events, publish, buy, submit applications, delete Notion pages you made, or mark work complete because you said you intend to do it. Ordinary ChatGPT or other chat conversations do **not** sync automatically; only messages typed into Deevaa's chat or sent to the signed intake API are processed. If a source is not connected or fails, the app says so instead of inventing tasks or free time.

## How it works

```
Browser ── session cookie ──▶ middleware (Auth.js) ──▶ /api/briefing, /api/chat, /api/blueprint, /api/feedback
Scheduler ── Bearer CRON_SECRET ──▶ /api/cron ──▶ lock ──▶ Notion + Google Calendar (read-only) ──▶ planner ──▶ store
            ── Bearer CRON_SECRET ──▶ /api/jobs ──▶ agent registry ──▶ Gmail (read-only) ──▶ today’s briefing email digest
Your tools ── Bearer + HMAC ──▶ /api/intake ──▶ same intake pipeline as chat

Chat message ─▶ extract (rules, or OpenAI JSON checked by a strict schema) ─▶ ground against your exact words
             ─▶ match existing Notion tasks ─▶ standing permission? ── no ─▶ stored as a proposal you can apply later
                                                                  └─ yes ─▶ write ─▶ read back and verify ─▶ refresh briefing
```

- **Notion** is the system of record for tasks. The operational store (Postgres) holds briefings, runs, locks, chat history, intake operations, your Life Blueprint, recommendation feedback, encrypted token references and the audit trail.
- **Planner** rules run first: only `Ready` / `In Progress` tasks with no Blocker and resolved `Blocked By` dependencies are executable. Sleep (10:30 PM–7:00 AM), 10-minute preparation before meetings and 10-minute transitions after are protected.
- **AI is optional.** Without `OPENAI_API_KEY`, chat extraction uses deterministic rules and briefings use deterministic wording. With it, model output is validated against strict schemas and then re-checked by code; the model never decides what is written or what Deevaa tells you it did.

## Conversational intake

Open the **Chat** panel on the dashboard and describe what changed. For each message Deevaa shows one row per item: *Created*, *Updated*, *No change*, *Needs you* (ambiguous match), *Proposed* (writes are off) or *Failed*, with the Notion link, the exact field changes, and the words of yours it was based on.

Safety rules enforced in code, not just in the prompt:

- **Grounded only.** Every extracted item must quote words that appear in your message. Hypotheticals ("if I ever…", "for example") are dropped. Dates are recomputed from the words you used, in America/Los_Angeles; a deadline is never invented. "Before Oct 19" becomes due Oct 18 and says so.
- **Intent is not completion.** Done or Waiting updates require that you said it happened ("I submitted", "it's done"), not that you plan to.
- **Update, don't duplicate.** A new task that closely matches an open one is reported as already tracked. Status changes need one clearly best match; otherwise nothing is written and Deevaa asks which task you meant.
- **Standing permission.** Writes run only after you turn on **Task updates from chat** in Connections. It covers creating and updating internal Notion tasks only, is off by default, and can be turned off any time. When it is off, items are saved as proposals with an **Apply to Notion** button.
- **Verified writes.** Each create or update is read back from Notion and compared field by field. Creates are never blindly retried; a lost response is recovered through an `ExternalKey` written on the page. A permission, schema or rate-limit error stops the remaining writes and says which ones did not happen.
- **Idempotent.** Each message carries an `Idempotency-Key`. Resending it returns the original result and never writes twice. One message is processed at a time per user.
- **Undo.** **Undo these changes** moves pages Deevaa created to Notion's trash and restores the previous values on pages it updated. A page you edited in Notion after Deevaa's write is left alone and reported.
- **Personal context stays a suggestion.** Goals, preferences, capacity notes and reflections from chat become *pending suggestions* in the Life Blueprint. They do not affect anything until you confirm them.

Limits: 30 messages per hour, 4,000 characters per message.

## Life Blueprint and next-action feedback

### One-time Blueprint import

In **Life Blueprint → Import Life Blueprint**, paste or upload your `life-blueprint-import.md` export (keep this file local; it is gitignored). Deevaa builds a **preview only** until you click **Approve import**. The preview shows Blueprint lines by section, Notion tasks (active, waiting, done, ideas), skipped items, and uncertain dates. Approval saves a new Blueprint version, writes tasks through the same verified Notion path as chat, and refreshes the briefing. Re-importing the same document (same content hash) returns the prior result without duplicating records. Export metadata (no raw seed file): `GET /api/blueprint/export`. Wipe Blueprint data only: `DELETE /api/blueprint` (Notion tasks stay).

The **Life Blueprint** panel holds versioned, editable context: goals, quarterly priorities, active and paused projects, routines, preferences, recurring commitments, scheduling constraints, energy patterns, boundaries, experiments, lessons and general context. Saving creates a new version; a stale tab cannot overwrite a newer save.

Only confirmed Blueprint entries influence ranking, and every effect is shown as a reason: supporting a quarterly priority (+25), an active project (+12) or a goal (+10), or belonging to a paused project (−15). Matching uses the task title and the Notion `Project` field.

**Find my next action** now counts 2 minutes of setup time, so a 5-minute task does not fit a 5-minute window. Under the suggestion you can answer **Done**, **Not now** (hidden for 3 hours), **Not possible here** (hidden in that context for 7 days) or **Wrong recommendation** (ranked lower for 14 days). **Done** updates the Notion task to Done, verified, only when task updates are on; otherwise Deevaa records it and asks you to mark it in Notion.

## Needs attention

Each briefing lists, from Notion data only: blocked or waiting-for-input tasks with a deadline within 7 days, overdue tasks, tasks due within 2 days, and Waiting tasks with no Notion edit for 7 days ("consider following up"). Deevaa only warns; it never contacts anyone.

## External intake API

Disabled unless `INTAKE_TOKEN` (32+ characters) is set; it returns `404` otherwise. Use it from tools you control, such as an Apple Shortcut, a custom GPT action or a script. It runs the same pipeline as chat for the `ALLOWED_EMAIL` owner, with the same limits, and still needs the standing permission to write.

```
POST /api/intake
Authorization: Bearer $INTAKE_TOKEN
Idempotency-Key: <8-100 of A-Z a-z 0-9 - _>        # reuse it on retries
X-Deevaa-Timestamp: <unix seconds, within 5 minutes>
X-Deevaa-Signature: hex(HMAC-SHA256(INTAKE_TOKEN, "<timestamp>.<idempotency key>.<raw body>"))
Content-Type: application/json

{"message": "I finished the visa form and I'm waiting on the consulate."}
```

```bash
BODY='{"message":"I need to renew my passport by November 3."}'
TS=$(date +%s); KEY=$(uuidgen)
SIG=$(printf '%s' "$TS.$KEY.$BODY" | openssl dgst -sha256 -hmac "$INTAKE_TOKEN" -hex | sed 's/^.* //')
curl -sS https://YOUR_DOMAIN/api/intake -H "Authorization: Bearer $INTAKE_TOKEN" \
  -H "Idempotency-Key: $KEY" -H "X-Deevaa-Timestamp: $TS" -H "X-Deevaa-Signature: $SIG" \
  -H 'Content-Type: application/json' --data "$BODY"
```

The response contains `messageId`, `writes` (`applied`, `proposed`, `partial`, `failed` or `none`), `items`, `clarifications` and `reply`. Results also appear in the dashboard chat history.

## Local setup

Requirements: Node 20.6+.

```bash
npm install
cp .env.example .env.local
# Generate local secrets (values are written to the file, not printed)
printf 'AUTH_SECRET=%s\nTOKEN_ENCRYPTION_KEY=%s\nCRON_SECRET=%s\n' \
  "$(openssl rand -base64 33)" "$(openssl rand -base64 32)" "$(openssl rand -hex 32)" >> .env.local
# Then edit .env.local: set ALLOWED_EMAIL, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, NOTION_* (remove the blank duplicates)
npm run db:migrate     # Postgres only; the embedded local store migrates itself
npm run notion:setup   # creates "Deevaa Tasks" and prints its ids
npm test
npm run dev            # http://localhost:3000
```

Without `DATABASE_URL`, local development uses an embedded Postgres (PGlite) in `./.data/pglite`. Production refuses to start without `DATABASE_URL`.

If your shell exports any of the app's variables (for example from another project), they override `.env.local`. Start with a clean environment if sign-in reports `invalid_client`.

## Google OAuth setup (sign-in, calendar, and Gmail)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Calendar API** and the **Gmail API**.
2. Configure the **OAuth consent screen** (External, Testing is fine for one user). Add your Google account as a test user. Add scopes `openid`, `email`, `profile`, `https://www.googleapis.com/auth/calendar.readonly`, and `https://www.googleapis.com/auth/gmail.readonly`.
3. Create an **OAuth client ID** of type *Web application*. Add authorized redirect URIs, for local and production:
   - `http://localhost:3000/api/auth/callback/google` (app sign-in)
   - `http://localhost:3000/api/google/callback` (calendar connection)
   - `http://localhost:3000/api/google/gmail/callback` (Gmail connection)
   - `https://YOUR_DOMAIN/api/auth/callback/google`
   - `https://YOUR_DOMAIN/api/google/callback`
   - `https://YOUR_DOMAIN/api/google/gmail/callback`
4. Put the client ID and secret in `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`, and your address in `ALLOWED_EMAIL`.
5. Sign in, then select **Connect Google Calendar** and **Connect Gmail (read-only)** on the dashboard. Each grant is separate. Deevaa requests only the readonly scope, refuses modify/send/compose, and stores the refresh token encrypted (AES-256-GCM, bound to your user id and provider).

Sign-in itself requests identity scopes only. Calendar and Gmail are independent, revocable grants. **Disconnect** revokes that grant with Google and deletes the stored token. The Gmail agent never sends, labels, or marks mail read.

## Notion setup

1. In Notion, open **Settings, Connections, Develop or manage integrations** (or [notion.so/my-integrations](https://www.notion.so/my-integrations)) and create an internal connection. Copy its token into `NOTION_TOKEN`.
2. Capabilities: **Read content** is enough for briefings. Chat task updates and undo also need **Insert content** and **Update content**.
3. Share the parent page with the connection (page ••• menu, Connections). Paste the page link or id into `NOTION_PARENT_PAGE_ID`.
4. Run `npm run notion:setup`. It creates **Deevaa Tasks** (Notion API `2025-09-03`) and prints `NOTION_DATABASE_ID` and `NOTION_DATA_SOURCE_ID`.

Already have a database? Set `NOTION_DATA_SOURCE_ID` (or `NOTION_DATABASE_ID`) and run `npm run notion:setup -- --check`, or `-- --fix` to add missing optional properties (needs Update content).

### Schema

| Property | Type | Required | Notes |
|---|---|---|---|
| Name (any title property) | title | yes | |
| Status | select or status | yes | Inbox, Ready, In Progress, Waiting, Waiting for User, Blocked, Done, Canceled, Needs Verification. Notion's default "Not started / In progress / Done" also map. Unknown values become Needs Verification. |
| Priority | select | no | Urgent, High, Medium, Low (P0–P3 also map) |
| Due | date | no | |
| Duration | number | no | Minutes. Tasks without it are only considered for Focus, with an explicit 45-minute assumption. |
| Context | select | no | Anywhere, Phone, Laptop, Home |
| Energy | select | no | Low, Medium, High |
| Blocker | text | no | Any text makes the task non-executable |
| Blocked By | relation (same database) | no | Executable only when every linked task is Done or Canceled |
| ExternalKey | text | no | Deduplicates mirrored records; Deevaa writes `deevaa:…` keys to recover lost creates |
| SourceLink | url | no | Shown as "Evidence" |
| Project | text or select | no | Used for Blueprint alignment |
| NextAction | text | no | Set by chat (for example "Waiting for review") |
| LastVerified | date | no | Stamped on each Deevaa write; the write is then read back and checked |

Chat writes skip properties your database does not have and report them. A Status property of Notion's *status* type must already contain the option being written.

## Deployment

**Recommended:** [Railway + Postgres](docs/DEPLOY-RAILWAY.md) — always-on Node, no short serverless timeouts, nightly cron via [`railway.toml`](railway.toml). Use this if you want access from anywhere and future scheduled agent work.

### Vercel + managed Postgres

1. Create a Postgres database (Neon, Supabase, or Vercel Postgres) and copy its connection string.
2. Import the private GitHub repo into Vercel.
3. In **Project Settings, Environment Variables** (Production), set: `APP_URL` (your `https://` origin), `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `ALLOWED_EMAIL`, `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `NOTION_TOKEN`, `NOTION_DATA_SOURCE_ID`, and optionally `OPENAI_API_KEY` and `INTAKE_TOKEN`. Generate production secrets fresh; do not reuse local ones.
4. Apply the schema once against production: `DATABASE_URL="…" npm run db:migrate`. Migrations are idempotent.
5. Add the production redirect URIs in Google Cloud (see above). Deploy.
6. Sign in on the deployed URL, connect Google Calendar and Gmail, and turn on task updates there if you want them. Tokens and permissions are per environment.

## Scheduling

[`vercel.json`](vercel.json) declares a daily cron at `0 5 * * *` (05:00 UTC, which is 10 PM PDT or 9 PM PST). Vercel sends `GET /api/cron` with `Authorization: Bearer $CRON_SECRET`. Each call generates **tomorrow's** briefing in America/Los_Angeles, including the Needs attention list.

On Railway, [`railway.toml`](railway.toml) also runs `*/15 * * * *` → `GET /api/jobs`. The in-app agent registry runs `gmail.morning` when the local hour in America/Los_Angeles is 7. Idempotency key `agent:{id}:{user}:{yyyy-MM-dd}` plus a lock mean one successful digest per agent per local date. The digest is merged into **today’s** stored briefing (`emailDigest`) and does not regenerate the plan or write Notion tasks.

- Idempotency key `cron:{user}:{date}` plus a database lock mean duplicate or concurrent briefing triggers produce one run and one briefing.
- A failed or lock-blocked run returns a non-2xx status and can be retried.
- If a source that worked before starts failing, the previous good briefing is kept and the dashboard warns.

**Scheduling is not active until the app is deployed and a cron call has been observed while no browser is open.** The dashboard's "Scheduled briefing" row shows the last recorded scheduler run. To verify after deploying: `curl -i -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron` should return `200` with `"outcome":"created"`, then `"duplicate"`. Then wait for the 05:00 UTC run and confirm a run with trigger `cron` appears.

Gmail digest: connect Gmail on the Railway site, then `curl -i -H "Authorization: Bearer $CRON_SECRET" "https://YOUR_DOMAIN/api/jobs?force=1"` (or use **Run Gmail digest** on the dashboard). A 7:00 AM Pacific run should fill **Email (this morning)**.

## API

| Route | Auth | Purpose |
|---|---|---|
| `GET /api/briefing?date=YYYY-MM-DD` | session | Stored briefing, last run, connections, recent feedback |
| `POST /api/briefing/regenerate` | session, same origin, `Idempotency-Key` | Regenerate today or tomorrow. 30 per day. |
| `GET` / `POST` / `DELETE /api/chat` | session, same origin, `Idempotency-Key` on POST | History; process a message; clear history (Notion and audit are kept) |
| `POST /api/chat/apply`, `POST /api/chat/undo` | session, same origin, task-update permission | Apply a proposal; undo a message's changes |
| `GET` / `POST /api/permissions` | session, same origin | Read or grant/revoke `notion_task_write` (the only grantable permission) |
| `GET` / `PUT` / `POST /api/blueprint` | session, same origin | Read; save a new version (`409` if stale); confirm or dismiss a suggestion |
| `POST /api/feedback` | session, same origin | Next-action feedback. 200 per day. |
| `POST /api/intake` | `Bearer INTAKE_TOKEN` + HMAC signature | External intake (see above) |
| `GET` / `POST /api/cron` | `Bearer CRON_SECRET` | Generate tomorrow's briefing |
| `GET` / `POST /api/jobs` | `Bearer CRON_SECRET` | Run due agents (Gmail morning digest at 7:00 PT) |
| `POST /api/jobs/gmail` | session, same origin, `Idempotency-Key` | Manual Gmail digest for today. 10 per day. |
| `POST /api/google/connect`, `GET /api/google/callback`, `POST /api/google/disconnect` | session (+ signed state) | Read-only calendar OAuth |
| `POST /api/google/gmail/connect`, `GET /api/google/gmail/callback`, `POST /api/google/gmail/disconnect` | session (+ signed state) | Read-only Gmail OAuth |

Every private response is `Cache-Control: private, no-store`. Client errors are generic. Server logs record operation names and status codes only; tokens, emails, message text, task titles and event text are not logged.

## Tests

`npm test` runs the Vitest suite against an in-memory Postgres (PGlite) with mocked Notion, Google and OpenAI HTTP. Beyond the v0.2 coverage (auth gate, origin checks, Notion reads, calendar DST and OAuth, planner, AI fallback, idempotent scheduling), v0.3 and the morning Gmail agent add:

- Intake end to end: one message producing several verified Notion records and a refreshed briefing; updating instead of duplicating; replayed idempotency keys; recovery of a create whose response was lost; hypotheticals and intentions not written; relative and DST-crossing dates; no invented deadlines; ambiguous matches; empty Notion; proposals then apply; revoked permission; permission, schema and rate-limit failures stopping later writes; undo, including refusal when a page was edited afterwards; AI output that is malformed or tries to claim actions.
- Life Blueprint: only confirmed entries change ranking; paused projects rank lower; stale saves rejected.
- Next action: setup time, and each feedback effect; Done writes to Notion only with permission.
- Needs attention: each warning type, and nothing when Notion is unavailable.
- External intake: disabled without a token; bad token, signature, timestamp and tampered body rejected; replay safe; same permission as chat; no credentials in responses.
- Morning Gmail agent: promotions/social excluded; disconnected/revoked sources warn without inventing mail; duplicate jobs in the same local date collapse; schema-invalid model output dropped; send/modify scopes refused; digest merge does not wipe top outcomes.

`npm run typecheck` and `npm run build` must also pass. There is no lint script or ESLint configuration in this project yet.

## Implementation tracker

Blueprint progress, acceptance evidence, and live-account blockers are in [docs/implementation-tracker.md](docs/implementation-tracker.md). The architecture snapshot is [docs/current-state.md](docs/current-state.md).

## Status

**Implemented and tested with mocked providers:** everything above.

**Set up against real services locally:** Google sign-in and the Notion database. No real Notion write, OpenAI extraction or deployed cron run has been observed yet; chat writes against the real workspace need the steps below first.

**Needs owner action:**
- Turn on **Insert content** and **Update content** for the Notion connection, run `npm run notion:setup -- --fix` to add Project, NextAction and LastVerified, then turn on **Task updates from chat** in the app.
- Optional: `OPENAI_API_KEY` for model extraction, and `INTAKE_TOKEN` for the external API.
- Production: Postgres `DATABASE_URL`, fresh secrets, Vercel deployment, production redirect URIs, and the first observed cron run. Until then, scheduling is configured but not active.

**Known limits and risks:**
- One owner account only.
- Rule-based extraction handles common phrasings; unusual wording may be missed or need a clarification. It errs toward writing nothing.
- Notion's query index can lag a few seconds; the refreshed briefing merges verified writes over the latest read to cover this.
- Undo cannot restore a page that was edited in Notion after Deevaa's write; it reports it instead.
- Calendar list selection follows Google's "shown" calendars; travel time is not modelled.
- `npm audit` reports a PostCSS advisory in Next.js build tooling; the suggested fix requires a breaking upgrade to Next 16.

## Non-goals in this milestone

No email or message sending, no calendar writes, no publishing, purchases, applications or legal submissions, no GitHub writes, no Gmail, finance or health integrations, and no multi-user organizations.
