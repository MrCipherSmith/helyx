# Flow Journal

- 2026-08-03T11:10:43.390Z - flow created
- 2026-08-03T11:12:34.649Z - task-added: T5: fake-sql: recording tagged template, programmed rows, [] default, survives .catch on an unawaited result
- 2026-08-03T11:12:34.736Z - task-added: T6: fake-permission-ctx: PermissionContext + StatusManager double reusing hold-counter + MCP double
- 2026-08-03T11:12:34.821Z - task-added: T7: rewire skill-handlers.test.ts onto the shared fake sql, delete its FakeSql
- 2026-08-03T11:12:34.905Z - task-added: T8: permissions.ts: one 600_000, optional permissionTimeoutMs on the context, handle() passes it through
- 2026-08-03T11:12:34.989Z - task-added: T9: permission-lifecycle.test.ts: four exits of pollForResponse, three early returns of handle()
- 2026-08-03T11:12:35.076Z - task-added: T10: test-db.ts: provision, migrate, drop; availability verdict instead of a throw
- 2026-08-03T11:12:35.166Z - task-added: T11: rewire jsonb-cast-v1.32.test.ts onto test-db.ts, remove the DATABASE_URL check and tag cleanup
- 2026-08-03T11:12:35.256Z - task-added: T12: migrate() from empty and idempotent on the provisioned database
- 2026-08-03T11:12:35.341Z - task-added: T13: VERIFY the skip path by actually running bun test against an unreachable server
- 2026-08-03T11:12:35.425Z - task-added: T14: VERIFY the four exits by removing the finally and confirming all four fail, then restoring it
- 2026-08-03T11:12:35.510Z - task-added: T15: VERIFY the early-return assertions fail when the guards are removed
- 2026-08-03T11:12:35.595Z - task-added: T16: full gate: typecheck, lint, test, dupes=1, health run
- 2026-08-03T11:12:42.689Z - frozen: 14 criteria; checksum recorded
- 2026-08-03T11:12:42.773Z - started

## What happened

### The fixtures found their own defects, twice, and both times a real caller found them

Neither was theoretical, and neither would have been caught by testing the
fixture in isolation. Both came from the first genuine use.

**The fake `sql` could not be overridden.** Programs match in registration order
and the first match wins, which is right — it lets a narrow program shadow a
broad one. But a shared `ordinaryWorld()` helper registers the ordinary answers
first, so a test overriding one query was silently ignored and asserted against
the helper's answer instead of its own. Two tests failed on the first run and
they were right to. Programming the same match twice now replaces the first.

**The test-database helper dropped the database this very run had provisioned.**
Stray cleanup asked `pg_stat_activity` which databases had no live connections
and dropped those — and postgres.js connects lazily, so a database nobody has
queried yet is indistinguishable from one whose owner is dead. The pid is in the
name; cleanup now asks whether that process is still alive.

### The one thing that could not be done from inside a test file

`memory/db.ts` builds its connection from `CONFIG.DATABASE_URL` at import time,
and `bun test` runs every file in one process. By the time any test file runs,
the connection may already be bound — so a test cannot point itself at a
different database, and `migration-registry.test.ts` importing `memory/db.ts`
was enough to decide the matter for everybody.

Two consequences. Migrations run in a subprocess (`bun memory/db.ts` with
`DATABASE_URL` set), which is slower than an in-process call and is the
difference between a fixture that is safe and one that is usually safe. And the
provisioning moved into a preload (`bunfig.toml` → `tests/preload.ts`), which is
the only place early enough to matter.

That last part is larger than the plan described, and it is what made AC12
honest: the jsonb test writes through `sessionManager.register`, so pointing
*that* at a throwaway database is not something the test file can arrange for
itself. Before this, those tests wrote to whatever `DATABASE_URL` named — in
practice the developer's own database — and undid themselves by deleting rows
they had tagged.

### The verification tasks earned their place

T14 removed the `finally` from `pollForResponse` and confirmed all four exits
fail, then restored it — a test for a `finally` that passes without the
`finally` is testing nothing.

T15 removed each early-return guard in turn. The first attempt exposed a weak
test: with the session guard gone, the no-session case was still caught by the
*next* guard, so the test passed and was asserting the wrong one of the two. It
now provides a chat on purpose, so only the session guard can stop it.

### Numbers

Tests 720 → 739. Health 62 → 63. Coverage unchanged at 19.6%, as intended —
this flow adds no coverage, it makes coverage possible. `bun run dupes` still
reports 1.
- 2026-08-03T11:24:55.832Z - task-done: T1: Collect remaining context
- 2026-08-03T11:24:55.918Z - task-done: T2: Implement per plan
- 2026-08-03T11:24:56.007Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T11:24:56.092Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T11:24:56.177Z - task-done: T5: fake-sql: recording tagged template, programmed rows, [] default, survives .catch on an unawaited result
- 2026-08-03T11:24:56.262Z - task-done: T6: fake-permission-ctx: PermissionContext + StatusManager double reusing hold-counter + MCP double
- 2026-08-03T11:24:56.348Z - task-done: T7: rewire skill-handlers.test.ts onto the shared fake sql, delete its FakeSql
- 2026-08-03T11:24:56.431Z - task-done: T8: permissions.ts: one 600_000, optional permissionTimeoutMs on the context, handle() passes it through
- 2026-08-03T11:24:56.515Z - task-done: T9: permission-lifecycle.test.ts: four exits of pollForResponse, three early returns of handle()
- 2026-08-03T11:24:56.601Z - task-done: T10: test-db.ts: provision, migrate, drop; availability verdict instead of a throw
- 2026-08-03T11:24:56.685Z - task-done: T11: rewire jsonb-cast-v1.32.test.ts onto test-db.ts, remove the DATABASE_URL check and tag cleanup
- 2026-08-03T11:24:56.774Z - task-done: T12: migrate() from empty and idempotent on the provisioned database
- 2026-08-03T11:24:56.864Z - task-done: T13: VERIFY the skip path by actually running bun test against an unreachable server
- 2026-08-03T11:24:56.952Z - task-done: T14: VERIFY the four exits by removing the finally and confirming all four fail, then restoring it
- 2026-08-03T11:24:57.045Z - task-done: T15: VERIFY the early-return assertions fail when the guards are removed
- 2026-08-03T11:24:57.130Z - task-done: T16: full gate: typecheck, lint, test, dupes=1, health run
- 2026-08-03T11:25:11.328Z - ac-confirmed: AC1: tests/fixtures/fake-sql.ts: queries[] records {text (whitespace-collapsed, params as ?), raw, values} at call time
- 2026-08-03T11:25:11.412Z - ac-confirmed: AC2: program()/programSequence(); unmatched query resolves to [] — asserted by skill-handlers tests that never program most queries
- 2026-08-03T11:25:11.495Z - ac-confirmed: AC3: result is a real Promise; permission-lifecycle exercises the three fire-and-forget .catch() updates and db.count() sees them
- 2026-08-03T11:25:11.583Z - ac-confirmed: AC4: makePermissionWorld() — 12 tests in permission-lifecycle.test.ts construct and run PermissionHandler with no db/network/fs
- 2026-08-03T11:25:11.669Z - ac-confirmed: AC5: FakeStatusManager delegates to the real HoldCounter; 'two prompts in one chat' asserts double-release counts once and depth
- 2026-08-03T11:25:11.752Z - ac-confirmed: AC6: FakeMcp.notifications + behaviors(); asserted in all four exits and all four early returns
- 2026-08-03T11:25:11.841Z - ac-confirmed: AC7: provisionTestDatabase(): CREATE DATABASE helyx_test_<pid>_<n>, migrate via subprocess, drop WITH FORCE; 'it is disposable' drops a table
- 2026-08-03T11:25:11.926Z - ac-confirmed: AC8: databaseAvailable() returns a verdict; verified by running the full suite against 127.0.0.1:1 — 731 pass, 10 skip, 0 fail
- 2026-08-03T11:25:12.010Z - ac-confirmed: AC9: four exits, four separate tests; T14 removed the finally and all four failed; exit 4 asserts rejects.toThrow
- 2026-08-03T11:25:12.096Z - ac-confirmed: AC10: three early returns; T15 removed each guard in turn and exactly its own test failed
- 2026-08-03T11:25:12.182Z - ac-confirmed: AC11: 600_000 appears once (asserted from source); override honoured; default-applies test proves the loop polls rather than exiting
- 2026-08-03T11:25:12.267Z - ac-confirmed: AC12: skill-handlers.test.ts FakeSql class deleted; jsonb-cast-v1.32.test.ts has no DATABASE_URL check and no tag cleanup
- 2026-08-03T11:25:12.349Z - ac-confirmed: AC13: 'migrations were applied from empty' + 'migrating again is a no-op' — schema_versions max and row count unchanged
- 2026-08-03T11:25:12.433Z - ac-confirmed: AC14: typecheck clean, lint 0 errors, 739 pass 0 fail, dupes reports 1, health 63 (improved)

## Review: REQUEST_CHANGES, and it was right about most of it

Six major findings and two minor. All eight taken.

**The fake `sql` was eager where postgres.js is lazy** (F-005). A postgres.js
query is dispatched by `.then`/`.catch`/`.finally`, not by being written. The
fake recorded at construction — so deleting the `.catch()` from the
fire-and-forget insert in `utils/skill-handlers.ts` would have stopped
production sending the query while the assertions kept passing. A fixture that
cannot fail when the code breaks is worse than none. The query is now lazy and
`queries` means "sent", not "written".

**Restoring the Telegram module put the fake back** (F-004). An ESM namespace
has live bindings: the namespace captured before mocking starts reporting the
fakes once `mock.module` runs, so the restore installed them under the real
names and every later file in the process inherited them. Values are now
snapshotted at fixture import. Verified by reintroducing the old restore — the
new identity assertion fails, and passes again once fixed.

**An application variable could authorise DDL on a real server** (F-001).
`DATABASE_URL` points at staging on some machines, and this fixture issues
`CREATE DATABASE` and `DROP DATABASE … WITH (FORCE)`. It now refuses any
non-loopback host unless `TEST_DATABASE_URL` names it deliberately.

**The pid in a database name means nothing across hosts** (F-003). A shared
server sees pid 3412 from several machines. The name now carries a host tag and
cleanup judges only its own host's databases.

**A stale marker was taken as proof of isolation** (F-002). `HELYX_TEST_DATABASE`
inherited from a parent shell would have satisfied the check while the run wrote
to the real database. The preload clears it before probing and on any
provisioning failure, and the jsonb suite's safety check moved from a sibling
test into a `beforeAll` gate — as a test it would have gone red while its
siblings carried on writing.

**The timeout tests could not fail for the right reason** (F-006). "Finished
within five seconds" and "polled at least three times" are both true of a
four-second override and a five-second default. They now capture the value
actually forwarded: exactly `1234`, and exactly `undefined` when there is no
override.

Minor: the `sql(value)` fragment overload was a stub with no caller and is gone
(F-007) — the same rule this flow's own description states about fixtures
written ahead of their first caller. A migration failure after `CREATE DATABASE`
leaked the database, since the caller gets a throw rather than a handle; it is
dropped before rethrowing (F-008).

Tests 739 → 754.

## Re-review: seven fixed, one genuinely still open

F-001 was right to stay open. `0.0.0.0` was in the loopback allowlist and is not
a loopback address — it is the unspecified address, which as a destination
usually resolves to this machine and sometimes does not. "Usually" is the wrong
standard for something that issues `DROP DATABASE … WITH (FORCE)`. Removed, and
`permittedServer` is now exported and covered directly: loopback allowed,
`0.0.0.0` and a remote host refused, both allowed when named in
`TEST_DATABASE_URL`.

Also took the diagnostic caveat on F-008: a failing cleanup no longer masks the
migration error that caused it, since that message is the one worth reading.

Tests 754 → 759.
