# Deevaa OS implementation tracker

Evidence for this pass: `npm test` (planner V2 plus existing Gmail 7am / jobs / planner V1 contracts), `npx tsc --noEmit`, `npx eslint .`. Gmail digest idempotency in `tests/jobs.test.ts` still passes.

Live Google, Notion, and GitHub calls are not part of that evidence. Those stay listed as blockers.

| Phase | Status | Depends on | Acceptance evidence | Blocker |
|---|---|---|---|---|
| 00 Baseline | Complete in repo | none | `docs/current-state.md`, CI workflow, env check, smoke | Live boot on Railway not rechecked here |
| 01 Platform | Complete in repo | 00 | Settings, pause, correlation id, export without tokens, delete keeps Notion | Token revocation against Google needs a connected account |
| 02 Life model | Complete in repo | 01 | Life areas seed, canonical status, conflict preview, Blueprint values/identity/non-negotiables | Live Notion backlog was not re-imported here |
| 03 Capture | Complete in repo | 02 | Thursday catch-up test; imported notes use `processMessage` | Unusual phrasing can still extract nothing |
| 04 Gmail | Complete in repo, live run unverified | 03 | Buckets, cursor replay, unsent drafts, dry-run key | No observed 7:00 America/Los_Angeles production run |
| 05 Calendar | Complete in repo | 01 | Conflict and prep tests; no Google write scope | Sync token is stored only when Google returns `nextSyncToken` |
| 06 Chief of Staff | Complete in repo | 02–05 | 30-minute, waiting-on, before-date, and tired-day tests | Answers require a connected Notion read in the live app |
| 07 Runtime | Complete in repo | 01 | Two queued runs; approval resumes once; `gmail.send` stays unsent; merge and secret disclosure denied | — |
| 08 Surfaces | Complete in repo | 07 | Routes for Today, Chat, Blueprint, Projects, Agents, Approvals, Calendar, Memory, Settings | Signed-in click-through needs Google login |
| 09 Project manager | Complete in repo | 07 | Sweep summarizes blockers and next actions without a second task database | Does not write Notion by itself |
| 10 Open source | Candidate only | 07 | Artifact has `merge: denied` and `github.pr.open` needs approval | Does not create a branch, run a repo test suite, or open a PR |
| 11 GDE / research | Complete in repo | 07 | Opportunities without an https citation are dropped | Does not fetch the live web |
| 12 Consultancy | Complete in repo | 07, 15 | Drafts exclude reflection text and do not send | No prospect is contacted |
| 13 EB-1A | Complete in repo | 07 | Packet text has no eligibility claim | Not a legal opinion |
| 14 Life ops | Complete in repo | 07 | Arrival checklist recognizes open work and does not invent travel time | External booking stays approval-gated and unimplemented |
| 15 Memory | Complete in repo | 01 | Create, isolate, and exclude reflections from consultancy context | — |
| 16 Orchestration | Complete in repo | 07–15 | Quiet hours suppress coordination; one agent per task; handoff record | Does not run for days unattended without the existing cron |
| 17 Evaluation | Complete in repo | 16 | Injection strip, replay-safe jobs, tired-day and approval tests are in Vitest | No separate load test or backup drill |
| 18 Extensions | Started, optional | 05, 07 | `GET /api/v1/today`, proposed local blocks, worker heartbeat | No mobile binary and no native calendar sync product |

## Phase notes

### 00

Tasks: inventory, current-state doc, env schema, lint, CI, smoke. Done when the app's checks pass without changing planner behavior. Evidence: commands above.

### 01

Tasks: `user_settings`, correlation id on audit events, export/delete, pause-all, maintenance. Credentials remain encrypted and are omitted from export.

### 02

Tasks: seeded life areas, `canonicalStatus`, `reconciliationPreview`, Blueprint fields `values`, `identity`, `nonNegotiables`. Notion statuses are not replaced.

### 03

Tasks: passive "submitted" and "sent for review" stay Waiting. "Can wait" becomes Inbox. Notes API calls the chat pipeline.

### 04

Tasks: buckets, history cursor of seen Gmail ids, dry run, draft approvals. Send stays off.

### 05

Tasks: overlap detection, prep proposals with `write: false`, optional sync token persistence, tentative events.

### 06

Tasks: block roles `deep_focus`, `commitments`, `life_logistics`, `recovery` alongside FOCUS/CLOSE/MAINTAIN/EXPAND. Query handlers. Tired mode skips high-energy tasks and lowers the planned share. `hardStop` trims free windows.

### 07

Tasks: `agent_definitions`, `agent_runs`, `tool_invocations`, `approval_requests`. Worker drain and `resumeAfterApproval`. Gmail morning mirrors a runtime row and keeps the old `runs` idempotency key.

### 08

Tasks: navigation and the routes listed above. Settings also sit on the home dashboard.

### 09–15

Tasks: `runSpecialist` registers against the same run and approval tables. Each consequential external tool is `approval` or `deny`.

### 16

Tasks: `coordinate` assigns life tasks to life ops and urgent work to the project manager, takes a task lock, and records a handoff. Quiet hours return no assignments.

### 17

Tasks: the new tests cover injection, duplicate job collapse, approval replay, privacy, and capacity. Releases are not yet gated on a load or restore drill.

### 18

Tasks: proposed blocks live in `calendar_blocks` and do not call Google. `/api/v1/today` reads the stored briefing. Heartbeats record a worker id. A Mac mini or local model was not purchased.

### Planner V2

Tasks: context snapshot, candidate pipeline, per-lens compose, planTrace, block feedback (`replace` / `shrink` / `skip` / `complete` / `not_relevant` / `postpone` / `explain`). Evidence: `tests/planner-v2.test.ts`, `tests/planner.test.ts`, `tests/gmail.test.ts`, `tests/jobs.test.ts`. Suggested candidates do not write Notion. `gmail.morning` merge-without-replan is unchanged.

## Known issues

- One owner account
- Rule-based extraction misses unusual wording on purpose
- Parallel first-time life-area seeding is conflict-safe; a failed unique insert no longer fails the Gmail job
- `npm audit` still reports the pre-existing PostCSS advisory in Next build tooling
- Approving `gmail.send` marks the approval executed and records `sent: false`
