# Deevaa OS — Same-day vertical slice v0.1

A **real runnable application scaffold**, not yet a deployed autonomous agent. Built against original PRD's semi-autonomous model: Notion initial source of truth, cloud app, future scheduled agents and approval gates.

## What works immediately
- Responsive Next.js dashboard at `/`
- Four-block planning from live Notion tasks **if configured**, otherwise clearly labeled demo tasks
- Context/energy/time micro-action selector (one task)
- Read-only Google Calendar feed **if configured**, with missing-data warnings
- Read-only `/api/briefing` JSON
- Authenticated `/api/cron` dry-run endpoint (no persistence/delivery yet)

## Quick start
```
cp .env.example .env.local
npm install
npm run dev
```
Open http://localhost:3000. DEMO MODE is explicit until credentials are supplied.

## Notion configuration
1. Create a **regular Notion database** named `Deevaa Tasks` with these exact properties:
   - `Name` — Title
   - `Status` — Select: `Inbox`, `Ready`, `In Progress`, `Waiting`, `Blocked`, `Done`, `Canceled`, `Waiting for User`
   - `Priority` — Select: `Urgent`, `High`, `Medium`, `Low`
   - `Due` — Date
   - `Duration` — Number (minutes)
   - `Context` — Select: `Anywhere`, `Phone`, `Laptop`, `Home`
   - `Energy` — Select: `Low`, `Medium`, `High`
2. Create a Notion **internal integration** and share only this database with the integration.
3. Put `NOTION_TOKEN` and `NOTION_DATABASE_ID` in `.env.local` (never commit). If the database is configured using a newer data-source-only API structure, update the query adapter in `lib/sources.ts` to query `/v1/data_sources/{id}/query` using a compatible version header.
4. Run the app and confirm `Notion: Connected`.

## Google Calendar
Create a Google Cloud OAuth client, enable Google Calendar API, and obtain a refresh token with `https://www.googleapis.com/auth/calendar.readonly` for your own account. Add server-side `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` to `.env.local`. Never paste tokens in chat. **Note:** v0 reads only timed events on the primary calendar; all-day events, multiple calendars, DST offsets, and recurring scheduling require the Phase 1 improvements in the TDD.

## Cloud deployment
Deploy via Vercel connected to a private GitHub repository. Set server-only env vars in Vercel project settings and protect the entire app behind authentication **before entering live personal data**. Current v0 is an **unprotected local/demo scaffold**, not production-safe. DO NOT deploy with private Notion/Google credentials unless app-level authentication has been installed. Production scheduling and persistence not yet implemented.

## What is NOT finished
- No real background scheduled job, persisted briefing, task write-back, approvals, multi-user login or OAuth connect button.
- No Gmail ingestion, Github checker, specialized research agents, or OpenAI inference yet.
- Calendar availability is not calculated; blocks are suggestions, not reserved time.
- No event source reconciliation or safe notion writes.

Read `TDD.md` for exact next implementation steps and honest scope boundaries.
