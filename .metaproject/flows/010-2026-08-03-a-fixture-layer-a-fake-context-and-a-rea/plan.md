# Implementation Plan

Status: formalized

## Approach

Build the three fixtures against a real caller rather than in the abstract, and
migrate the two hand-rolled versions onto them in the same change. A fixture
written without a caller is a guess about what the caller will need; a fixture
whose first two callers are tests that already existed is one that has been
proved twice before it is committed.

The order is: fake `sql` first (both other pieces depend on its shape), then the
permission context, then the real test database — which is the least entangled
and the most likely to hit environment trouble, so it goes where its failure
cannot block the rest.

Every verification below is a task, not a sentence. Prose in a plan blocks
nothing; a task gates `flow complete`.

## Steps

1. `tests/fixtures/fake-sql.ts` — the recording tagged template. Programmed by
   `{ match: string | RegExp, rows: unknown[] }`, matched in registration order,
   first match wins. Records `{ text, values }` per call. Result is a real
   Promise so `.catch()` and `await` both work; recording happens at call time,
   not at resolution, so a fire-and-forget query is recorded too.

2. `tests/fixtures/fake-permission-ctx.ts` — the context, the status double and
   the MCP double. The status double's `holdAwaitingPermission` reuses
   `utils/hold-counter.ts` rather than reimplementing the lease: that module
   exists, is tested, and a second implementation of it in a fixture would be
   the exact defect flows 007–009 were about.

3. Rewire `tests/unit/skill-handlers.test.ts` onto the shared fake and delete
   its `FakeSql`. First real caller.

4. `channel/permissions.ts` — remove the duplicated `600_000` from the call
   site, add `permissionTimeoutMs?: () => number` to `PermissionContext`, and
   have `handle()` pass it through when present.

5. `tests/unit/permission-lifecycle.test.ts` — the four exits of
   `pollForResponse` and the three early returns of `handle()`, each a separate
   assertion. This is the deferred flow-006 item and the reason step 2 exists.

6. `tests/fixtures/test-db.ts` — provision, migrate, drop. Connects to the
   maintenance database to `CREATE DATABASE`, points `DATABASE_URL` at the new
   one before importing `memory/db.ts` so `migrate()` runs against it, and drops
   it in teardown. Returns an availability verdict rather than throwing when no
   server answers.

7. Rewire `tests/unit/jsonb-cast-v1.32.test.ts` onto `test-db.ts`, removing the
   `process.env.DATABASE_URL` check and the tag-based cleanup. Second real
   caller, and the one that stops a test writing to the developer's database.

8. Add the `migrate()` from-empty and idempotence test on the provisioned
   database.

9. **Verify the skip path**: run `bun test` with the fixture pointed at an
   unreachable server and confirm the suite is green and the skipped tests say
   what to start. Not "the code has a fallback" — actually run it.

10. **Verify the four exits are four**: temporarily remove the `finally` from
    `pollForResponse` and confirm the AC9 test fails on every one of the four
    cases, then restore it. A test for a `finally` that passes without the
    `finally` is testing nothing.

11. **Verify the fake is not lying**: confirm the AC10 assertions fail if the
    early-return guards are removed, so they are testing the guards rather than
    the fake's default `[]`.

12. Full gate: `bun run typecheck`, `bun run lint`, `bun test`, `bun run dupes`,
    `keryx health run`.

## Risks

- **The fake diverges from postgres.js.** `sql` is not only a tagged template —
  it is also callable for identifier and array interpolation
  (``sql`... IN ${sql(ids)}` ``), which `jsonb-cast` uses. If the fake does not
  support that shape, step 7 fails. Mitigation: step 7 is a real caller and will
  surface it; the fake supports the callable form or the flow says so.

- **`migrate()` binds to `CONFIG.DATABASE_URL` at import time.** The env var has
  to be set before the first import of `memory/db.ts` anywhere in the process.
  Bun hoists static imports, so the helper must use dynamic import, and any test
  file that also statically imports `memory/db.ts` will defeat it. Mitigation:
  the helper does the dynamic import itself and the rewired test uses only what
  the helper hands back.

- **Test databases leak on a hard failure.** A dropped process leaves the
  database behind. Mitigation: names carry a fixed prefix and the helper drops
  any stale database sharing it at startup, so the leak self-heals on the next
  run rather than accumulating.

- **The 10-minute timeout is load-bearing in production.** Changing where the
  constant lives must not change its value. AC11 requires the default to apply
  when no override is given, which is the assertion that catches it.
