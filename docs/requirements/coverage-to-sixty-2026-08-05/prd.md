# Coverage to Sixty — PRD

Version: 1.1.0

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

Ordered by what fails badly, per §5. Line counts are what each flow is worth,
not why it is where it is.

| # | Flow | Files | Method | Uncovered | Why here |
|---|---|---|---|---|---|
| 1 | The fixture itself | `tests/fixtures/test-db.ts` | — | — | One helper that gives a test a database, a session row and a chat, and cleans up after itself. Nothing else starts before it, because the alternative is every flow inventing its own — which is what the last programme cost. |
| 2 | Sessions manager | `sessions/manager.ts` | A + B | 257 | A session is the unit of work in this system. When registration or disconnection is wrong, a session exists in the database and not in tmux, or the reverse, and the operator finds out by a topic going quiet. |
| 3 | Callbacks | `bot/callbacks.ts` | B | 281 | Every button in every menu lands here. A wrong branch is a press that does nothing, and Telegram shows nothing either way. |
| 4 | Text handler and forum commands | `bot/text-handler.ts`, `bot/commands/forum.ts` | B | 471 | The path every message takes, and the routing that decides which session hears it. Its failures misdeliver rather than error. |
| 5 | Session and project commands | `bot/commands/session.ts`, `bot/commands/projects.ts` | B | 450 | Start, stop, switch. These act on the running system. |
| 6 | Supervisor actions and admin | `bot/commands/supervisor-actions.ts`, `bot/commands/admin.ts` | B | 591 | What an operator reaches for when something is already wrong — the worst moment for a handler to throw. |
| 7 | Memory and curator | `memory/long-term.ts`, `utils/curator.ts` | B | 453 | Silent by nature: the summarizer produced nothing for weeks and nothing noticed (flow 037). |
| 8 | The watchdog's alert paths | `scripts/tmux-watchdog.ts` | A | 395 | It is what notices a stuck session. Flow 041 covered its detectors; the notifying half is still dark. |
| 9 | Provider and codex commands | `bot/commands/providers.ts`, `bot/commands/codex.ts` | B | 502 | Configuration rather than operation — wrong here is visible immediately. |
| 10 | MCP tools | `mcp/tools.ts` | B | 407 | Large, and every tool call goes through it, but its dispatcher is now covered at both ends (flows 036, 043). |
| 11 | Dashboard routes | `mcp/dashboard-api.ts` | B | 766 | The biggest single number in the table, and last on purpose: its two guards are already tested, and what is left is route bodies behind them. |
| 12 | Whatever the number says is left | — | — | measured | Re-measured, not guessed. |

By flow 8 the floor is crossed on the arithmetic; by flow 11 it is crossed with
room. Either way the ordering above is the point, and the number is the
by-product.

## 5. The question, answered

*Is 60% the goal, or is it inherited?*

**Answered by the maintainer on 2026-08-05: it is a minimum, not a target.**

That settles the ordering. Work is ordered by what fails badly, not by what
yields the most lines; the number is a floor that gets crossed on the way
rather than a score to optimise. §4 is ordered accordingly and no longer leads
with `mcp/dashboard-api.ts`, which is the largest file but whose guards — the
JWT check and the origin check, the two things a browser can reach — are
already covered by flow 040.

The practical difference: a programme aimed at the number opens the biggest
file first and closes the gap in eight flows. A programme aimed at the risk
opens `sessions/manager.ts` and `bot/callbacks.ts` first, crosses 60% a flow or
two later, and covers the code whose failure loses a session or drops a button
press before it covers a route that already answers 401 correctly.

## 6. Out of scope

- E2E in CI, which is block D of the previous roadmap and still waits on the
  same decision it waited on then.
- Raising the floor, lowering the floor, or turning WARN into FAIL.
