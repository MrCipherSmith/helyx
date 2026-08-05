# Coverage to Sixty — PRD

Version: 1.0.0

## 1. Problem

The health gate has read WARN for weeks for one reason: line coverage below the
60% soft floor. Two programmes have now been run at it.

The first, eight flows in early August, extracted pure logic out of I/O-bound
files and raised coverage from 15.71% to 19.22%. It ended with an honest
conclusion: extraction was spent, and what remained was I/O.

The second, sixteen flows on 2026-08-05, covered the I/O layer file by file and
raised coverage from 36.25% to 43.30% — 1400 lines, in a day. It also produced
the finding this document exists for.

**The cost was not in choosing what to test. It was in standing in for the
database.** Almost every uncovered line in this repository sits behind a `sql`
call, and the programme paid for that fifteen times over:

- Replacing `memory/db.ts` through the module registry works in a small file
  and breaks in a large one. In `tests/unit/media-delivery.test.ts` it
  re-evaluated the module graph behind `bot/media.ts` — most of the bot — and
  left `services/provider-service.ts` half-initialised for four tests in
  `reviewer-service.test.ts` and one migration test. Nine replaced modules and
  then five both did it, in every arrangement tried.
- The alternative was a hand-built seam per file: `MediaDeps` in
  `bot/media.ts`, `RunShell` in `utils/supervisor-status.ts`,
  `TurnSummaryDeps` in `mcp/server.ts`, `scheduledReviewDeps` in
  `scripts/supervisor.ts`. Each is a production change, written once per file,
  reviewed once per file.

Repeating that method for the remaining 3312 lines means roughly twenty more
flows and twenty more seams. That is the wrong shape of work, and this document
proposes changing it before the next flow starts rather than after.

## 2. Measurements

From `coverage/lcov.info` via `scripts/coverage-summary.ts` — the file the
health gate imports — on 2026-08-05 with 1661 tests passing.

### 2.1 Position

| Metric | Value |
|---|---|
| Lines | 43.30% (8589 of 19835) |
| Soft floor | 60% (11901 lines) |
| Gap | 3312 lines |

### 2.2 Where the uncovered lines are

Exact counts, not estimates.

| File | Covered | Uncovered | Total |
|---|---|---|---|
| `mcp/dashboard-api.ts` | 18.25% | 766 | 937 |
| `mcp/server.ts` | 23.98% | 504 | 663 |
| `mcp/tools.ts` | 39.88% | 407 | 677 |
| `scripts/tmux-watchdog.ts` | 18.89% | 395 | 487 |
| `bot/commands/admin.ts` | 21.46% | 322 | 410 |
| `bot/media.ts` | 26.76% | 301 | 411 |
| `bot/commands/providers.ts` | 7.95% | 301 | 327 |
| `scripts/supervisor.ts` | 73.57% | 300 | 1135 |
| `channel/status.ts` | 62.94% | 282 | 761 |
| `bot/callbacks.ts` | 14.59% | 281 | 329 |
| `bot/text-handler.ts` | 7.07% | 276 | 297 |
| `bot/commands/session.ts` | 6.57% | 270 | 289 |
| `bot/commands/supervisor-actions.ts` | 4.95% | 269 | 283 |
| `sessions/manager.ts` | 17.63% | 257 | 312 |
| `memory/long-term.ts` | 4.69% | 244 | 256 |
| `utils/curator.ts` | 5.43% | 209 | 221 |
| `bot/commands/codex.ts` | 3.37% | 201 | 208 |
| `bot/commands/forum.ts` | 5.80% | 195 | 207 |
| `bot/commands/projects.ts` | 3.23% | 180 | 186 |

Those nineteen files hold 5960 uncovered lines — enough for the whole gap with
room to spare, and no file outside them is worth opening first.

### 2.3 What they have in common

Thirteen of the nineteen are command handlers or route handlers: they read a
Telegram update or an HTTP request, run one or more queries, and send a reply.
Their uncovered lines are not branches that need cleverness to reach. They are
straight lines that need a database.

`tests/fixtures/test-db.ts` already provisions a real Postgres database per test
run and drops it afterwards. It is used by `tests/preload.ts` and five test
files. It was built during the first programme, and the second programme barely
touched it.

## 3. The two methods

### 3.1 Method A — a seam per file

What the last programme did. A `Deps` interface in the file under test, a
`setXDeps()` or a parameter, production code routed through it.

- **For:** no database needed, tests stay in milliseconds, works for network and
  subprocess collaborators too.
- **Against:** a production change per file; reviewers reasonably ask why the
  shape of the code is being changed for the tests; and the seam covers the
  lines *it* touches, not the lines behind them. `bot/media.ts` went from 5.59%
  to 26.76% this way and still has 301 uncovered lines.

### 3.2 Method B — the real database

Tests run the handler whole, against the per-run database the repository
already builds.

- **For:** one test walks a hundred lines instead of ten, so the gap closes
  roughly three times faster; the tests are honest — they catch a malformed
  query, a missing column, a broken migration, none of which a fake `sql` can
  ever fail on; no production change at all.
- **Against:** the suite needs Postgres and gets slower; a shared database
  between tests needs discipline about what each one leaves behind.

### 3.3 Recommendation

**B for the thirteen handler files. A for the six that are not.**

`scripts/tmux-watchdog.ts` talks to tmux, `utils/tts.ts` to synthesis
providers, `claude/client.ts` to a model API, `channel/status.ts` to Telegram.
No database helps there, and those already have seams or can take one cheaply.

On this split the gap is roughly 8 to 12 flows, not 20 to 30 — and the tests
that come out of it are worth more than the number they move.

## 4. Proposed order

| # | Flow | Files | Method | Uncovered |
|---|---|---|---|---|
| 1 | The fixture itself | `tests/fixtures/test-db.ts` | — | Make it the standard way to open a handler test: one helper that gives a test a database, a session row and a chat, and cleans up after itself. Nothing else in this list starts before it. |
| 2 | Dashboard routes | `mcp/dashboard-api.ts` | B | 766 |
| 3 | MCP tools | `mcp/tools.ts` | B | 407 |
| 4 | MCP server, the success paths | `mcp/server.ts` | A + B | 504 |
| 5 | Session and project commands | `bot/commands/session.ts`, `bot/commands/projects.ts` | B | 450 |
| 6 | Provider and codex commands | `bot/commands/providers.ts`, `bot/commands/codex.ts` | B | 502 |
| 7 | Callbacks and supervisor actions | `bot/callbacks.ts`, `bot/commands/supervisor-actions.ts` | B | 550 |
| 8 | Text handler and forum commands | `bot/text-handler.ts`, `bot/commands/forum.ts` | B | 471 |
| 9 | Memory and curator | `memory/long-term.ts`, `utils/curator.ts` | B | 453 |
| 10 | Sessions manager | `sessions/manager.ts` | A + B | 257 |
| 11 | The watchdog's alert paths | `scripts/tmux-watchdog.ts` | A | 395 |
| 12 | Whatever the number says is left | — | — | measured, not guessed |

Flow 1 is not optional and not a chore. Every flow after it either uses one
shared way of opening a database or invents its own, and the last programme is
the evidence for what "invents its own" costs.

## 5. The question worth asking first

Is 60% the goal, or is it inherited?

The floor is soft and the gate reports WARN, not FAIL. If the goal is instead
"the paths that can fail badly are covered", this list reorders: `sessions/manager.ts`
and `bot/callbacks.ts` climb, and `mcp/dashboard-api.ts` — the biggest file,
whose guards are already tested — drops. The two orderings are not the same
work, and picking the number by default is how a programme ends up optimising
for the number.

This PRD assumes the floor, because the floor is what the gate reads. If that
assumption is wrong, §4 is the wrong table and should be rewritten before the
first flow starts.

## 6. Out of scope

- E2E in CI, which is block D of the previous roadmap and still waits on the
  same decision it waited on then.
- Raising the floor, lowering the floor, or turning WARN into FAIL.
