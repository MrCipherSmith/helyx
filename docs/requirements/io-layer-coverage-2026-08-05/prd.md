# I/O Layer Coverage — PRD

Version: 1.0.0

## 1. Problem

The quality gate has been WARN for weeks for one reason: coverage below the
soft floor. The eight-flow programme that raised it from 15.71% to 19.22% ended
with an honest conclusion — extraction is spent, what is left is I/O, and I/O
cannot be covered without fixtures.

The fixtures were then built. Coverage is now 47.90%. Nobody wrote down that
the blocker was gone, so the recorded state of the programme still says it is
blocked, and the next reader — human or agent — starts from a false position.

That is the actual problem this package solves twice over: finish the work, and
stop the record from lying about it.

## 2. Measurements

All figures below are from `bun test --coverage tests/unit/` on the working
tree, 2026-08-05, with 1443 tests passing.

### 2.1 Position

| Metric | Value |
|---|---|
| Lines | 47.90% |
| Functions | 43.65% |
| Soft floor | 60% |

### 2.2 Where the uncovered lines are

Uncovered lines estimated as file length × (1 − line coverage) — an estimate,
because Bun reports percentages and not counts, and stated as one:

| File | Line cov | Est. uncovered | Health hotspot rank |
|---|---|---|---|
| `mcp/dashboard-api.ts` | 3.66% | ~1139 | — |
| `scripts/supervisor.ts` | 44.61% | ~861 | 1st (355 776) |
| `mcp/server.ts` | 7.89% | ~760 | 8th (39 192) |
| `utils/tts.ts` | 5.54% | ~665 | — |
| `scripts/tmux-watchdog.ts` | 6.00% | ~650 | — |
| `bot/commands/admin.ts` | 3.65% | ~477 | — |
| `channel/status.ts` | 62.94% | ~461 | 3rd (192 432) |
| `memory/summarizer.ts` | 7.58% | ~446 | — |
| `bot/media.ts` | 5.59% | ~425 | — |
| `mcp/tools.ts` | 39.88% | ~415 | — |

Two things changed since the 2026-08-03 note. `memory/db.ts`, then the second
worst file at 578 uncovered lines, has left the list entirely — that is the
fixture layer working. `scripts/supervisor.ts` went from 1075 uncovered to
~861 and from 0% to 44.61%, and is still the top hotspot in the repository by
churn × complexity.

### 2.3 The gate is reading a stale number

`.metaproject/data/health/artifacts/latest.md` was generated 2026-08-04 at
commit `76f6b94` and records 30.13% with `tests: missing` among its sources —
the run did not read the project's test results at all, and took coverage from
an imported summary. The gate is therefore reporting a number 17 points below
the measured one, from a run that could not see the tests.

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
| S1 | Line coverage ≥ 60% | `bun test --coverage tests/unit/` |
| S2 | Health gate PASS on coverage | `keryx health run` |
| S3 | `tests: available` in the health sources table | same run |
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
