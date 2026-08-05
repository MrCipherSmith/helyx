# Coverage to Sixty

Version: 1.0.0

## Purpose

Take the quality gate from WARN to PASS by closing the remaining 3312 lines
between 43.30% and the 60% soft floor — and decide *how* to close them before
starting, because the last programme proved that the method matters more than
the list.

## Status

`draft` — written 2026-08-05 at the maintainer's request after the
sixteen-flow observability programme landed. Nothing started. The maintainer
runs it after the pending rebuild and restart.

| Metric | Value | Source |
|---|---|---|
| Line coverage | 43.30% (8589 of 19835) | `coverage/lcov.info` via `scripts/coverage-summary.ts` — the file the gate imports |
| Soft floor | 60% | health gate |
| Lines needed | 3312 | arithmetic on the two above |
| Tests | 1661, all passing | `bun test tests/unit` |

For scale: the sixteen flows of 2026-08-05 moved 36.25% → 43.30%, about 1400
lines. This asks for 2.4 times that again.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, measured position |
| [prd.md](prd.md) | The problem, the two methods, the recommendation, the order |

## The proposal in one paragraph

Do not repeat the last programme. Fifteen of its sixteen flows spent most of
their effort building a way to stand in for the database, one file at a time,
and two of those arrangements broke tests in other files before they worked.
The database is not an obstacle to be mocked around fifteen more times — the
repository already provisions a real one per test run. Cover the command
handlers against that, where one test walks a hundred lines instead of ten, and
keep hand-built seams for the places a database cannot help: network,
subprocess, Telegram.
