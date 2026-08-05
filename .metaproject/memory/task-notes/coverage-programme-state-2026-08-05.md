# Coverage programme: the blocker is closed and the numbers are exact

Version: 1.0.0
Type: task-note
Status: accepted
Confidence: high
Supersedes: task-notes/coverage-programme-state.md
Valid-From: 2026-08-05
Recorded-At: 2026-08-05

## Summary

Supersedes `coverage-programme-state.md` (2026-08-03), which records the
programme as blocked on a `test-postgres` fixture. That fixture exists and is in
use. The measured position on 2026-08-05 is 36.25% of lines (7369 of 20329) with
1540 tests passing, and the remaining work is covering the I/O layer in the
order recorded in `docs/requirements/io-layer-coverage-2026-08-05`.

## Details

### What the old note got wrong

It names step 2 — "a `test-postgres` helper, deferred from flow 006 and blocking
everything else" — as the thing preventing progress. `tests/fixtures/test-db.ts`
provisions a real database per run and drops it afterwards, and
`tests/preload.ts` plus five test files use it. The blocker was closed and
nobody wrote that down, so the next reader — human or agent — started from a
false position.

### The measurement, and why an earlier figure was wrong

36.25% of lines, exact, from `coverage/lcov.info` via
`scripts/coverage-summary.ts` — the same file the health gate imports.

An earlier revision of the io-layer package published 47.90%. That is Bun's
text-reporter aggregate over the files it loaded during a run; the lcov record
counts every instrumented line. The gap to the 60% floor is therefore larger
than was published, not smaller. Uncovered counts per file were likewise
estimated from file length and overstated — `mcp/dashboard-api.ts` by 200 lines,
`scripts/supervisor.ts` by 280.

### Two sequencing defects in the gate itself

Both diagnosed 2026-08-05 and both fixed by `bun run health`, which runs
coverage, then a project-scope test report, then the gate:

- Coverage is imported and nothing regenerated it, so the gate judged the
  project on a four-day-old file: 30.13% against a real 36.25%.
- `tests` reported `missing` while 1540 tests passed. Health wants a
  project-scope report, and the newest artifact is normally written by the
  post-commit hook, which runs a *changed*-scope selection.

### Where the uncovered lines actually are

| File | Line cov | Uncovered |
|---|---|---|
| `mcp/dashboard-api.ts` | 3.66% | 947 |
| `mcp/server.ts` | 8.49% | 701 |
| `scripts/supervisor.ts` | 52.03% | 580 |
| `utils/tts.ts` | 5.54% | 529 |
| `scripts/tmux-watchdog.ts` | 6.00% | 470 |
| `bot/commands/admin.ts` | 3.65% | 449 |
| `mcp/tools.ts` | 39.88% | 407 |
| `bot/media.ts` | 5.59% | 405 |

`memory/db.ts`, the second-worst file in the old note at 578 uncovered lines,
has left the list entirely. That is the fixture layer working.

### What remains

Seven flows, ordered by uncovered lines weighted by operational risk, in
`docs/requirements/io-layer-coverage-2026-08-05` §3. `scripts/supervisor.ts`
leads despite no longer having the most uncovered lines: it is the top hotspot
by churn × complexity and gained three loops in one day.

## Provenance

- Source: manual
- Link: `docs/requirements/io-layer-coverage-2026-08-05`; `.metaproject/flows/034-2026-08-05-honest-gate`
- Created: 2026-08-05
- Updated: 2026-08-05

## Related Scopes

- Module: scripts, mcp, bot, utils, memory
- Entity: coverage, quality gate, test fixtures
- Files: scripts/coverage-summary.ts, tests/fixtures/test-db.ts, package.json
- Skills: health, testing, flow-orchestrator

## Tags

coverage, programme-state, gate, measurement, supersedes

## Changelog

- 1.0.0 - Recorded after measuring the gate honestly and finding the earlier figure was a different statistic.
