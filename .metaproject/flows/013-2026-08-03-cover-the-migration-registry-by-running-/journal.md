# Flow Journal

- 2026-08-03T19:13:21.356Z - flow created
- 2026-08-03T19:13:21.578Z - task-added: T5: runMigrations takes its connection; migrate() wraps it
- 2026-08-03T19:13:21.769Z - task-added: T6: provisionTestDatabase --no-migrate
- 2026-08-03T19:13:21.955Z - task-added: T7: migrations-apply.test.ts: empty database, every migration, real schema assertions
- 2026-08-03T19:13:22.143Z - task-added: T8: full gate and coverage record
- 2026-08-03T19:13:22.353Z - frozen: 10 criteria; checksum recorded
- 2026-08-03T19:13:22.558Z - started

## What happened

The whole flow is one observation: `memory/db.ts` was not untested because
nobody had written tests. It was untested because everything that ran it ran it
in another process.

Flow 010 introduced the subprocess deliberately — `sql` binds to
`CONFIG.DATABASE_URL` at import, and at that point no test could redirect it. The
preload from that same flow then removed the reason: `DATABASE_URL` is now set
before anything imports, so a connection can simply be passed in.

Making `runMigrations` take its connection turned eight hundred lines of schema
from invisible into executed-and-asserted. The assertions are named tables and
named columns rather than counts, because a count passes while the one table
some query needs is missing.

One test earns its place quietly: a database missing only the last migration is
brought up by exactly that one. That is the ordinary production case — a deploy
adding migrations to a database that already has the earlier ones — and it was
the only path nothing exercised.

### Numbers

`memory/db.ts`: 24.31% → **96.81%** of lines, 4.65% → **91.46%** of functions.
Project coverage 25.72% → **44.21%**. Tests 875 → 884.
- 2026-08-03T19:14:01.192Z - task-done: T1: Collect remaining context
- 2026-08-03T19:14:01.417Z - task-done: T2: Implement per plan
- 2026-08-03T19:14:01.636Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T19:14:01.849Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T19:14:02.058Z - task-done: T5: runMigrations takes its connection; migrate() wraps it
- 2026-08-03T19:14:02.294Z - task-done: T6: provisionTestDatabase --no-migrate
- 2026-08-03T19:14:02.491Z - task-done: T7: migrations-apply.test.ts: empty database, every migration, real schema assertions
- 2026-08-03T19:14:02.683Z - task-done: T8: full gate and coverage record
- 2026-08-03T19:14:02.907Z - ac-confirmed: AC1: runMigrations(db = sql); migrate() calls it with the module connection, CLI and entrypoint unchanged
- 2026-08-03T19:14:03.118Z - ac-confirmed: AC2: MigrationRun returns from, to and applied names
- 2026-08-03T19:14:03.332Z - ac-confirmed: AC3: provisionTestDatabase({migrate:false}) skips the subprocess
- 2026-08-03T19:14:03.529Z - ac-confirmed: AC4: all of them run, from nothing — from 0, to the top version, applied length equals the registry
- 2026-08-03T19:14:03.725Z - ac-confirmed: AC5: fourteen tables asserted by name, each reported individually so the failure names the missing one
- 2026-08-03T19:14:03.963Z - ac-confirmed: AC6: archived_at, status, tmux_target, provider_id, model, forwarded_at, expired_at asserted at the end
- 2026-08-03T19:14:04.166Z - ac-confirmed: AC7: schema_versions versions and names match the registry exactly
- 2026-08-03T19:14:04.378Z - ac-confirmed: AC8: second run applies nothing; deleting the last version row brings up exactly that migration
- 2026-08-03T19:14:04.600Z - ac-confirmed: AC9: registry tests run without a database; the rest use describe.skip
- 2026-08-03T19:14:04.802Z - ac-confirmed: AC10: typecheck clean, lint 0 errors, 884 tests, dupes 1, memory/db.ts 96.81% lines
