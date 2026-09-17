# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

T1-T4 are the scaffold checklist `keryx flow init` creates. T1 is done (context
collected inline — see `context.md`); T2-T4 are closed as superseded by the
split below, which names one file per task so a failure points at a file rather
than at "the implementation".

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Collect remaining context — done, see `context.md` |
| T2 | implement | ~~Implement per plan~~ — superseded by T5, T6, T8, T9, T10 |
| T3 | test | ~~Add/adjust tests~~ — superseded by T7 |
| T4 | review | ~~Self-review and prepare draft PR~~ — superseded by T11 |
| T5 | implement | Migration: `projects.autostart`, `session_state_events`, `host_state` (`memory/db.ts`) |
| T6 | implement | `sessions/restore-plan.ts`: `decideStartSet` + snapshot codec, pure |
| T7 | test | Unit tests for `decideStartSet` and the snapshot codec (AC1-AC4) |
| T8 | implement | `cli.ts`: snapshot before kill, start only the decided set, record the boot id |
| T9 | implement | `scripts/admin-daemon.ts`: `proj_start`/`proj_stop` audit + single-project fallback |
| T10 | implement | `sessions/state-machine.ts`: durable `session_state_events` row per transition |
| T11 | review | Verification gate: `bun run typecheck`, `bun test tests/unit/`, `bun run dupes` |

T11 is a task rather than a sentence in the plan on purpose: this repository's
recorded failure is a verification step that was identified and then skipped,
and `keryx flow complete` runs a gate over tasks, not over prose.
