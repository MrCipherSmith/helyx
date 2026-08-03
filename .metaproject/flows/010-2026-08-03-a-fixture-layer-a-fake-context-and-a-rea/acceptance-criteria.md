# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `tests/fixtures/fake-sql.ts` exports a fake `sql` tagged template that records every query in call order — the query text with parameters replaced by placeholders, and the parameter values — and exposes them for assertion.
- AC2: The fake `sql` returns rows programmed per query pattern; a query matching no programmed pattern resolves to `[]` rather than throwing, so a path the test is not exercising cannot fail it for the wrong reason.
- AC3: The fake `sql` result survives `.catch()` on a value nobody awaits, and such a query is still recorded — `permissions.ts` has three fire-and-forget updates written that way and a fake that only works when awaited would silently drop them.
- AC4: `tests/fixtures/fake-permission-ctx.ts` builds a complete `PermissionContext` together with a `StatusManager` double and an MCP double, such that `new PermissionHandler(ctx, status)` constructs and runs with no database, no network and no filesystem beyond what the test provides.
- AC5: The `StatusManager` double implements `holdAwaitingPermission` with the real lease semantics — releasing twice counts once, and concurrent holds release only when the last one does — and records `updateStatus` texts in call order.
- AC6: The MCP double records every `notification()` call with its params, so a test can assert which `behavior` was returned and how many notifications were sent.
- AC7: `tests/fixtures/test-db.ts` provisions a Postgres database dedicated to the run, applies the project's own `migrate()` to it, and drops it when the run ends — a test using it may truncate or destroy any table in it without touching a real database.
- AC8: When no Postgres is reachable, `test-db.ts` reports unavailability instead of throwing, and every test that needs it is skipped with a message naming what to start; `bun test` completes green with no database present.
- AC9: A test drives `pollForResponse` through all four exits — answered, resolved externally, timed out, and an exception thrown mid-poll — and asserts for each that the waiting hold was released. Each of the four is a separate assertion, and the thrown case asserts the exception still propagates.
- AC10: A test drives `handle()`'s three early returns — a duplicate request, no session, and no chat for the session — and asserts for each what was and was not sent: no MCP notification and no Telegram call on the duplicate path, and no Telegram call on the other two.
- AC11: The `600_000` timeout literal appears once in `channel/permissions.ts`, and `PermissionContext` carries an optional override that `handle()` passes to `pollForResponse`; a test asserts the override is honoured and that the default applies when it is absent.
- AC12: `tests/unit/skill-handlers.test.ts` uses the shared fake `sql` instead of its own `FakeSql` class, and `tests/unit/jsonb-cast-v1.32.test.ts` uses `test-db.ts` instead of `process.env.DATABASE_URL` — the ad-hoc versions are gone, not left alongside.
- AC13: A test asserts `migrate()` brings the provisioned database up from empty and is idempotent on a second call — this is what proves the helper actually migrates rather than appearing to.
- AC14: `bun run typecheck`, `bun run lint` and `bun test` pass, and `bun run dupes` still reports exactly 1 — the deliberate, documented `unquote` idiom.
