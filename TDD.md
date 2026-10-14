# Deevaa OS — Technical Design v0.1 (implementation baseline)

## Product constraints
- Semi-autonomous, human governed. No consequential external writes without payload-specific approval.
- Notion is first canonical **human-readable** task/project store. A separate ephemeral/durable execution store will be required for idempotency, run locks and approvals; do not rely on Notion transactions.
- Cloud-hosted, app-first. Native Deevaa planning calendar + Google Calendar as external input/sync later.
- Minimal manual maintenance: integrations import state and agents prepare work; users approve and correct exceptions.
- Data separation: employer-confidential systems prohibited without employer authorization; sensitive personal reflection/health/financial context opt-in.

## Runtime modules
1. **Next.js app**: React dashboard, server API endpoints, authentication, approval inbox.
2. **Notion adapter**: reads typed tasks, eventually writes safe task state after user/standing policy approval. Retry only idempotent reads; paginate; handle API limits and version changes.
3. **Google Calendar adapter**: OAuth2, read calendars, time zones, all-day and recurring events; event ownership; future two-way sync with explicit approval and conflict policy.
4. **Planner**: rule-gated shortlist ranked by urgency, impact, deadline certainty, duration, context, capacity, emotional friction. LLM may explain/rerank but not override hard constraints.
5. **Agent orchestrator**: Chief of Staff invokes Project and Career/Research agents using validated JSON schemas and bounded budgets. Tools operate under service-side grants.
6. **Scheduler**: n8n Cloud triggers authenticated worker every morning and on selected signals. Persist run status before delivery. At-least-once triggers need deduplication.
7. **Execution store**: managed SQL/KV reserved for `AgentRun`, `Approval`, `SyncCursor`, `EventDedup`, `CalendarBlock` and idempotency locks. Not a second manually maintained task list.
8. **Identity and permissions**: session authentication, signed server requests, rate limits, secrets in cloud env, scoped OAuth, token rotation, source-level ACL.

## Notion schemas
`Deevaa Tasks`: Name(title), Status(select), Priority(select), Due(date), Duration(number), Context(select), Energy(select). Add stable `ExternalKey` text, `Project` relation, `LastVerified` date, `SourceLink` URL, `Blocker` text when sync is implemented.
`Deevaa Projects`: Name(title), Status(select), Goal(text/relation), Next Review(date), Outcome(text), Owner(select). Do not ingest private material automatically.
`Deevaa Goals`: Name(title), Horizon(select), SuccessMetric(text), Priority(select), Status(select).
`Deevaa Preferences`: config keyed by fields or private settings; source labels and confirmation markers.
`Deevaa Approvals`: optional human-visible linked cards; **execution lock and exact signed approval payload remain in service store**.

## Lifecycle and state machine
Capture → Ready → In progress → Waiting / Blocked → Done; unknown / conflicting external states marked `Needs Verification`, not silently Done. A comment posted on PR means 'response sent / awaiting review', not 'PR merged'.

## Briefing flow
- Schedule at user-configured local time → acquire distributed run lock → fetch selectively authorized sources → normalize and deduplicate → detect data gaps → calculate capacity around meetings/travel/prep → select top 3 outcomes + four blocks → write plan/run to service store → deliver app inbox notification → record ack/corrections.
- Morning brief can display only if authenticated. Stale calendar: warn, do not claim free time.
- MVP first vertical slice in this ZIP implements **only fetch, normalize and recommendation**; no distributed locks or delivery.

## Calendar intelligence
Canonical `CalendarBlock`: id, title, start/end UTC, local timezone, source, externalId, calendarId, isHardCommitment, isAllDay, owner, status, syncVersion, updatedAt. Hard commitments never auto-move. Soft task blocks can be rescheduled within user-defined windows, with transition/commute buffers. Two-way sync requires external event `etag`, dedup keys and conflict resolution. Never overwrite event modifications blindly.

## Approval policy
A: pre-authorized selective reads. B: generation/research/drafts. C: internal low-risk changes under standing policy with audit. D: external writes (send email, change meetings, publish, book) require exact payload review and explicit per-action approval. E: payments, sensitive data disclosure, broad deletion blocked in MVP. Approvals expire and are payload-hash/account bound.

## Acceptance tests for first useful release
- Notion ready tasks appear, Done/Waiting excluded from action suggestions.
- Calendar events rendered from authorized user account; disconnected case clearly labeled.
- In 5-10 minutes, only task with estimated duration fitting window is proposed; never claim completion for task only drafted/submitted.
- No external writes possible by default; incorrect source credentials fail visibly.
- Production app authenticated before real sources are connected.
- Scheduled cloud job stores and delivers one briefing/run per user per local date; duplicate trigger produces no second delivery.
- Source unavailable → stale warning, no fabricated free slots.

## First vertical-slice backlog (ordered)
| # | Deliverable | Size | Definition of done |
|---|---|---|---|
| 1 | Deploy safe demo preview | S | Builds on Vercel without secrets; accessible only to owner if private |
| 2 | App auth + session guard | M | All pages and APIs require authenticated user; unauthorized request fails |
| 3 | Create Notion tasks database + integration | S | Live read success; data fields parsed correctly |
| 4 | Google OAuth connect | M | Read-only calendar works and refreshes; tokens encrypted |
| 5 | Planner capacity engine | M | Avoid meetings+buffers; low-energy mode respects realistic constraints |
| 6 | Persistent briefing record | M | Plans survive refresh and produce audit/run history |
| 7 | n8n Cloud daily schedule | M | Local timezone aware, duplicate-safe, scheduled delivery to in-app inbox |
| 8 | Task reconciliation | M | Completed/waiting items not presented as ready; corrections recorded |
| 9 | Gmail read-only signal agent | M | Scope limited, source links, no unsolicited emails sent |
| 10 | Review & approval queue | M | Payload diff visible, expiry, reject/approve exact action |
| 11 | Automated regression tests | M | Bad tokens, stale events, duplicates, task states, injection and policy failures |

## Honest same-day milestone
Today: runnable demo and source adapters. With API credentials: connected Notion + Google read view after OAuth setup. Not possible to call it always-on and autonomous until auth, scheduled trigger, durable run storage and delivery are implemented and tested.
