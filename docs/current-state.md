# Deevaa OS current state

Updated October 17, 2026. This describes the repository after Four-Block Planner V2. It is not a claim that a live Google or Notion account was exercised in this session.

## Stack

- Next.js 15, React 19, TypeScript, Auth.js (next-auth 5 beta)
- Drizzle schema with idempotent SQL migrations in `lib/db/migrations.ts`
- Postgres when `DATABASE_URL` is set; embedded PGlite otherwise. Production refuses to start without `DATABASE_URL`
- Vitest, ESLint, `npm run typecheck`, `npm run env:check`, `npm run smoke`
- CI: `.github/workflows/ci.yml`

## What already worked and was kept

- Single-owner Google sign-in, origin checks, encrypted OAuth refresh tokens
- Notion as the human task store, with verified writes, undo, and `notion_task_write`
- Read-only Google Calendar and Gmail
- `gmail.morning` at 07:00 America/Los_Angeles via `GET /api/jobs` (Railway `*/15`)
- Chat intake, Life Blueprint versions, four-block planner V2, deadline radar
- Idempotency keys `agent:{id}:{user}:{localDate}` and `cron:{user}:{date}`

n8n is not a second scheduler. A future n8n workflow may call the same bearer-protected `/api/jobs` route.

## What this pass added

- Settings: timezone, quiet hours, pause-all, maintenance mode, agent budgets, feature flags
- Editable life areas, canonical status projection, reconciliation preview
- Gmail buckets, incremental message cursor, dry run (`/api/jobs?dry=1`), draft approvals that cannot send
- Calendar overlap alerts, prep proposals, sync-token capture when Google returns one, tentative flag
- Chief of Staff queries and a tired-day / hard-stop planning mode
- Durable `agent_runs`, tool decisions, and approval payloads with hash, expiry, and exactly-once resume
- Pages: Today, Chat, Life Blueprint, Projects, Agents, Approvals, Calendar, Memory, Settings
- Specialist runs for project sweep, open-source candidate, GDE brief, consultancy draft, EB-1A packet, life checklist, and private memory
- Orchestrator handoffs, task locks, quiet hours
- `GET /api/v1/today` and local proposed calendar blocks for a later client
- Worker heartbeat table

## Routes

| Path | Auth | Role |
|---|---|---|
| `/api/health` | public | Process and store kind |
| `/api/cron`, `/api/jobs`, `/api/intake` | bearer or HMAC | Existing schedulers and intake |
| `/api/settings`, `/api/account`, `/api/life-areas` | session | Governance |
| `/api/notes` | session | Voice or pasted notes through intake |
| `/api/agents`, `/api/approvals`, `/api/memory` | session | Runtime surfaces |
| `/api/projects`, `/api/calendar` | session | Notion projection and calendar proposals |
| `/api/v1/today` | session | Mobile-shaped briefing read |
| `/api/workers/heartbeat` | session | Cloud or local worker heartbeat |

## Planner V2

`buildBriefing` composes FOCUS / CLOSE / MAINTAIN / EXPAND from a context snapshot (Notion, calendar, Blueprint routines, confirmed intake, digest ids, pending approvals, feedback). Suggested candidates never write Notion. Waiting work is follow-up Close only when stale, and its Notion id never lands on a block. Gmail morning still only merges a digest; it does not replan. See `docs/planner-v2-snapshots.md`.

## Gmail 7:00 behavior

The agent is still `gmail.morning` in `lib/agents/registry.ts`. A successful run merges one digest into today's briefing. Replays of the same local date collapse. A dry run uses a separate idempotency key ending in `:dry`, so it does not block the real run. Pause-all and maintenance mode skip the job. Draft replies are approval rows with `send: false`. The Gmail scope stays readonly, and an approved `gmail.send` is recorded as not sent.

No deployed cron observation was made in this session. The dashboard "Scheduled briefing" row is still the place to confirm a live run.

## Blockers that need the owner

- Live Notion write capability (Insert and Update content) and a connected workspace
- Production `DATABASE_URL`, fresh secrets, and one observed `/api/cron` and `/api/jobs` call
- Optional `OPENAI_API_KEY` and `INTAKE_TOKEN`
- GitHub credentials are not configured. The open-source agent prepares a candidate and refuses merge; it does not open a pull request
- No purchases, sends, or public posts are possible from this code
