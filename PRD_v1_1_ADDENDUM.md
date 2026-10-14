# Deevaa OS PRD v1.1 — Addendum to original 20-section PRD

**Status**: Proposed implementation baseline; original v1.0 remains controlling except for explicitly approved product choices below.

## Locked product decisions
1. Database: **Notion** for first release's canonical goals/projects/tasks. Backend execution state may use a small transactional store for locks/audit; no duplicate human-managed task manager.
2. Hosting: **cloud-hosted**.
3. Delivery: **dedicated Deevaa app**, with in-app daily briefing/notifications. Other channels later.
4. Google Calendar and personal Gmail are intended integrations with user-approved, least-privilege OAuth.
5. Semi-autonomous: automatic read/research/draft/internal updates within scope; approvals before consequential external actions.

## Additions to functional requirements
- **FR-13 Native calendar**: own soft/hard event model, day/week/month view, proposed flexible task blocks, Google source reconciliation; never silently alter other peoples' commitments.
- **FR-14 Micro-execution**: propose one task that fits actual available time, required device/location/energy and dependencies, allowing 'rest/transition' as an outcome.
- **FR-15 Blueprint context**: support user-confirmed long-term priorities, identity principles, goal-to-task traceability. Sensitive context opt-in.
- **FR-16 State reconciliation**: track submitted, approved, completed, waiting, blocked distinctly; preserve provenance; no assumed success.
- **FR-17 Realistic capacity**: commute, preparation, meeting buffers, sleep/energy constraints; no overbooking. Missing travel inputs yield uncertainty.
- **FR-18 Exception radar**: new blocker, approaching deadline, stalled waiting item, connector failure; throttle and deduplicate alerts.
- **FR-19 Reflection feedback**: optional user-confirmed lessons; no psychological inference presented as fact.
- **FR-20 Minimal manual upkeep**: user never required to maintain duplicate planning boards; autonomous reconciliation is default where authorized.

## Native calendar MVP vs later
MVP: read connected Google Calendar, show events in app, intelligently propose internal task blocks without changing external events. Later: full independent scheduling UX, encrypted OAuth token management, event write-back approvals, recurring event synchronization, conflict handling and multi-calendar support.

## Launch exit criteria
The production application is not declared autonomous until: credentials are scoped and secured; app login is enforced; cloud schedule runs independently; dedup/locks prevent duplicate delivery; briefings persist; users can inspect and correct state; and no unauthorized consequential action is possible.

## Risk notes
The original PRD prefers Notion first. Notion's API cannot act as a transaction engine for exactly-once scheduled execution; use isolated execution metadata storage when enabling writes/schedulers. This is infrastructure only and does not reverse the Notion choice.
