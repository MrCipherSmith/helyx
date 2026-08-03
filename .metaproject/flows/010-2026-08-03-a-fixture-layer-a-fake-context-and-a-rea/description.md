# A fixture layer — a fake context and a real, isolated test database

Status: formalized
Source: user description

## Problem

The eight extraction flows took every decision that could be lifted into a pure
function and covered it. What is left uncovered is not undiscovered logic; it is
I/O. The six least-covered files — the supervisor, the database layer, the TTS
client, the admin commands, the LLM client, the summarizer — hold 3452 uncovered
lines between them, and every one of them talks to Postgres, to Telegram, to a
subprocess or to a network API.

There is nothing left to extract from them that would be honest. `handle()` in
`channel/permissions.ts` is 200 lines that are *about* talking to a database and
a chat API; the part that could be a pure function already is one. To cover the
rest, a test has to be able to stand a fake world up around it.

Two of these fakes already exist, written twice, informally:

- `tests/unit/skill-handlers.test.ts` carries a `FakeSql` class — a tagged
  template that matches on query text and returns programmed rows.
- `tests/unit/jsonb-cast-v1.32.test.ts` decides whether a database is available
  by reading `process.env.DATABASE_URL`, and then runs **against whatever that
  points at** — in practice the developer's real database — cleaning up
  afterwards by tag.

That second one is the sharper problem. A test that writes to the live database
and tidies up by convention is one failed assertion away from leaving rows
behind, and one typo away from deleting the wrong ones. It also cannot test
anything destructive, which is most of what a database layer does.

So this flow adds no coverage of its own. It builds the thing that makes the
remaining coverage possible, and it absorbs the two hand-rolled fakes so there
is one of each rather than one per test file — the same lesson flows 007–009
were about, applied before the duplication has a chance to spread across the
dozen test files step 3 will add.

## Expected Outcome

Three fixtures under `tests/fixtures/`.

**A fake `sql`.** A tagged template that records every query — normalised text
and parameter values, in order — and returns rows programmed by query pattern.
Two details matter and neither is obvious. Unmatched queries return `[]` rather
than throwing, because production code reads `rows.length` on paths a test is
not exercising and a throw there would fail the test for the wrong reason. And
the returned object has to survive `.catch()` being called on a result nobody
awaits: `permissions.ts` has three fire-and-forget updates written exactly that
way, and a fake that only works when awaited would silently drop them.

**A fake permission context.** The whole `PermissionContext`, plus a recording
`StatusManager` double and an MCP double. The status double implements
`holdAwaitingPermission` with the real lease semantics — idempotent release,
depth counting — because that is the behaviour under test, not scaffolding
around it. The MCP double records each `notification()`, which is how a test
sees what was actually returned to Claude Code.

**A real test database.** Provisioned per run, migrated with the project's own
`migrate()`, dropped at the end. Isolated, so a test may truncate, corrupt or
drop anything in it. When no Postgres is reachable it says so and the tests that
need it skip with a message naming what to start, so `bun test` stays green on a
machine that has never run this project.

The two existing hand-rolled fakes are migrated onto the shared ones, so the
count of each stays at one.

### The one production change

`handle()` calls `pollForResponse(..., 600_000, ...)` while `pollForResponse`
already declares `timeoutMs = 600_000` as its default. The literal is written
twice, and because the call site passes it explicitly the default is dead.

That duplication is also what makes one of the four exits untestable: the
timeout path cannot be reached through the public entry point in less than ten
minutes. Dropping the literal from the call site and letting the context supply
an override fixes both — the constant lives in one place, and a test can ask for
a short timeout without reaching past the public surface.

### What it unblocks

Immediately: the item deferred from flow 006. `pollForResponse` leaves four
ways — answered, resolved in the terminal, timed out, thrown — and the waiting
hold is released in a `finally` precisely so that no hand-written list of exits
can be incomplete. That claim has never been tested. It can be now.

After that, step 3 of the programme: the supervisor, the database layer and the
LLM client, in that order.

## Out of Scope

- Covering the supervisor, `memory/db.ts`, `claude/client.ts` or the admin
  commands. That is step 3 and it is deliberately a separate flow — this one is
  judged by whether the fixtures work, not by the coverage number.
- Fakes for TTS, the LLM client or subprocess spawning. Build them when a flow
  needs them; a fixture written ahead of its first caller is a guess.
- Wiring the test database into CI. The helper skips cleanly without one, and
  what CI should provision is a decision to make when step 3 has shown how much
  of the suite actually needs it.
