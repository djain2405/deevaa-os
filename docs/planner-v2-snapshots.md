# Planner V2 before / after snapshots

These are deterministic fixture outcomes from `tests/planner-v2.test.ts`. They document why Close, Maintain, and Expand were empty in V1.

| Case | V1 | V2 |
|---|---|---|
| Parents arrive + road trip | Focus = generic weekly report. Close empty (`duration` missing). Maintain empty (no Home/regex + duration). Expand empty by design. | Maintain takes guest-room / hosting. Close takes rental-car confirmation. Focus can stay on real work. |
| TDLI slides submitted | Waiting task excluded. Close empty. | Still not Focus. Close stays empty unless the wait is stale; copy is `No grounded action found`. |
| Matt letter sent, awaiting review | Waiting id never on blocks. | Same. Follow-up Close uses a derived id, never the Waiting Notion id. |
| Exhausted day | High-energy skipped; planned share 45%. | Same, with tired defaults 20 / 2 / 5 / 5 instead of dropping tasks for missing duration. |
| Creative-app energy | Expand assigned no task (`Open time, no task assigned`). | Expand gets a suggested growth step from Blueprint goals, labeled not a commitment. |
| No outstanding Close | `No ready task of 15 minutes or less.` | `No grounded action found`. No filler task. |
| Calendar absent | Unscheduled, no start/end. | Same. No invented meetings. |
| Conflicting deadlines | Rank by priority + due + project name. | Impact + date + personal Blueprint can beat a job-titled task. |
| Stale / duplicate sources | Each source could reappear. | One merge key; completed chat/Notion/digest items do not return. |

V1 `planBlocks` remains as `planBlocksV1` for comparison. `gmail.morning` still only merges a digest and does not replan.
