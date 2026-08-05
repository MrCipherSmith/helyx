# I/O Layer Coverage — PRD

Version: 1.1.0

## 1. Problem

The quality gate has been WARN for weeks for one reason: coverage below the
soft floor. The eight-flow programme that raised it from 15.71% to 19.22% ended
with an honest conclusion — extraction is spent, what is left is I/O, and I/O
cannot be covered without fixtures.

The fixtures were then built. Coverage is now 36.25%. Nobody wrote down that
the blocker was gone, so the recorded state of the programme still says it is
blocked, and the next reader — human or agent — starts from a false position.

That is the actual problem this package solves twice over: finish the work, and
stop the record from lying about it.

## 2. Measurements

All figures below are from `bun test --coverage tests/unit/` on the working
tree, 2026-08-05, with 1540 tests passing.

### 2.1 Position

| Metric | Value |
|---|---|
| Lines | 36.25% (7369 of 20329) |
| Soft floor | 60% |
| Tests | 1540, all passing |

Exact, from `coverage/lcov.info` via `scripts/coverage-summary.ts` — the same
file the health gate imports.

**This corrects an earlier figure in this document.** The first version quoted
47.90%, which is Bun's own text-reporter aggregate over the files it loaded; the
lcov record counts every instrumented line and answers 36.25%. The gap to the
floor is therefore larger than this package first claimed, not smaller, and the
plan below is ordered by the exact numbers.

### 2.2 Where the uncovered lines are

Exact counts, not estimates. The first version of this table derived them from
file length × uncovered fraction and overstated most of them — `dashboard-api`
by 200 lines, `supervisor` by 280.

| File | Line cov | Uncovered | Health hotspot rank |
|---|---|---|---|
| `mcp/dashboard-api.ts` | 3.66% | 947 | — |
| `mcp/server.ts` | 8.49% | 701 | 8th (39 192) |
| `scripts/supervisor.ts` | 52.03% | 580 | 1st (355 776) |
| `utils/tts.ts` | 5.54% | 529 | — |
| `scripts/tmux-watchdog.ts` | 6.00% | 470 | — |
| `bot/commands/admin.ts` | 3.65% | 449 | — |
| `mcp/tools.ts` | 39.88% | 407 | — |
| `bot/media.ts` | 5.59% | 405 | — |
| `memory/summarizer.ts` | 17.44% | 322 | — |
| `bot/commands/providers.ts` | 7.95% | 301 | — |
| `channel/status.ts` | 62.94% | 282 | 3rd (192 432) |
| `bot/callbacks.ts` | 14.59% | 281 | — |

By directory, the same figures: `bot` 11.2% (598 of 5328), `mcp` 15.2% (391 of
2577), `memory` 34.3%, `scripts` 43.6%, `services` 52.3%, `utils` 52.7%,
`channel` 69.3%.

Two things changed since the 2026-08-03 note. `memory/db.ts`, then the second
worst file at 578 uncovered lines, has left the list entirely — that is the
fixture layer working. `scripts/supervisor.ts` went from 1075 uncovered to 580 and from 0% to 52.03%,
and is still the top hotspot in the repository by churn × complexity.

### 2.3 Why the gate was reading a stale number

Two sequencing defects, both diagnosed on 2026-08-05 and both fixed by
`bun run health`:

- **Coverage is imported, and nothing regenerated it.**
  `coverage/coverage-summary.json` was four days old, so every gate run judged
  the project on it. Regenerating moved the reading 30.13% → 36.25%.
- **`tests` reported `missing` while 1540 tests passed.** Health wants a
  project-scope test report, and the newest artifact is normally written by the
  post-commit hook, which runs a *changed*-scope selection. `keryx test run`
  first makes the same source report `available`.

## 3. Goal

Line coverage at or above the 60% soft floor, reached by covering the riskiest
uncovered code first, with the health gate reading current numbers from a run
that includes the tests.

## 4. Users

| User | Need |
|---|---|
| Maintainer | A gate that says PASS because the code is tested, not because the floor moved |
| Agent (future session) | A truthful record of where the programme stands |
| Operator | Fewer defects of the kind flows 001–008 kept finding in untested I/O — a working session reported as hung, a crash loop reported as green |

## 5. Requirements

### R1 — cover by risk, in order

Work proceeds file by file in the order given in the specification, which ranks
by uncovered lines weighted by hotspot score, not by uncovered lines alone.
`scripts/supervisor.ts` leads despite not having the most uncovered lines: it
is the top hotspot, it broke twice in one week, and it is the module the
[self-observability](../self-observability-2026-08-05/README.md) package is
about to extend.

### R2 — the fixture layer is used, not duplicated

Every new test uses the existing fixtures: `tests/fixtures/test-db.ts` for a
real database, `fake-fetch.ts` for network, `fake-telegram.ts` for channel
sends, `fake-sql.ts` where a real database would be dishonest. A test that
introduces a fifth way to fake Postgres is a defect, not coverage.

### R3 — no coverage theatre

A test that executes a line without asserting the behaviour of that line does
not count as covering it. Reviews of this work reject assertions on internals
where a behavioural assertion was available.

### R4 — the health run reads the tests

`keryx health run` must report `tests: available`. Whatever caused
`tests: missing` in the 2026-08-04 run is fixed before the gate result is used
to judge this package.

### R5 — the record is corrected

`.metaproject/memory/task-notes/coverage-programme-state.md` is superseded
through `keryx memory supersede`, not hand-edited, with a note that records:
the fixture blocker is closed, the measured position on 2026-08-05, and the
remaining plan.

## 6. Success Criteria

| # | Criterion | How it is verified |
|---|---|---|
| S1 | Line coverage ≥ 60% | `bun run health` — the lcov figure the gate imports, not the text reporter's |
| S2 | Health gate PASS on coverage | `keryx health run` |
| S3 | `tests: available` in the health sources table | same run — `bun run health` sequences a project-scope test run before the gate |
| S4 | `scripts/supervisor.ts` ≥ 75% lines | per-file coverage |
| S5 | No new fixture duplicates existing ones | `bun run dupes` report does not grow |
| S6 | The memory note reflects reality | `keryx memory search` returns the superseding note |
| S7 | Every bug found on the way is recorded | flows 001–008 found seven; this work records what it finds the same way |

## 7. Risks

| Risk | Consequence | Mitigation |
|---|---|---|
| Tests written to move a number | Coverage rises, defects survive | R3, plus review of every test against the behaviour it claims |
| The real-database fixture makes the suite slow or flaky in CI | The suite gets skipped, which is worse than uncovered | The fixture already degrades to `NO_DATABASE_MESSAGE` when no server is reachable; keep that path exercised |
| Covering `mcp/dashboard-api.ts` first because it is the biggest | Most uncovered lines, lowest operational risk — effort spent where failures are cheapest | R1 ranks by risk; the dashboard is scheduled after the supervisor and the MCP server |
| The gate passes and attention leaves | Coverage decays back | The floor stays 60; regression against baseline is already part of the health run |
| Another package edits `supervisor.ts` at the same time | Merge pain | Self-observability lands first; this package covers what that one leaves |

## 8. Recommendation

Sequence this package **after** self-observability, not before. Both touch
`scripts/supervisor.ts`, self-observability adds two loops to it, and covering
a file that is about to grow two loops means writing the tests twice. Start
with R4 and R5 — a correct gate reading and a correct record cost an hour
between them and change what everything after is measured against.
