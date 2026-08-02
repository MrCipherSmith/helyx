# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Locate the pure decisions in cli.ts and their call sites |
| T2 | implement | Extract into `cli-flags.ts`, `host-memory.ts`, `stop-hook.ts` and rewire cli.ts |
| T3 | test | Cover all five decisions, pinning current behaviour including its quirks |
| T4 | review | Verify (typecheck, lint, tests, health, manual CLI run), draft PR, Codex review |

## Notes

- T1 is complete: the six sites and their purity are recorded in `context.md`.
- T2 moves bodies unchanged except where a filesystem call becomes a
  parameter. `availableMemoryMb` stays in `cli.ts` as the thin reader.
- T3 pins behaviour as it is. A quirk that looks like a defect is recorded in
  `journal.md` for a separate decision, not fixed here.
- T4's manual run of `helyx --help` and `helyx ps` is AC9 and is not optional:
  nothing tests the top-level dispatch the rewire passes through.
