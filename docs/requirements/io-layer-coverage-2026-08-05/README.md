# I/O Layer Coverage

Version: 1.0.0

## Purpose

Take the quality gate from WARN to PASS by covering the layer that was left
uncovered on purpose — database, network, subprocess and Telegram I/O — now
that the fixture work which blocked it is done.

## Status

`spec ready` — no new work started. This package continues the eight-flow
coverage programme recorded in
`.metaproject/memory/task-notes/coverage-programme-state.md` (2026-08-03) and
**corrects it**: that note names a `test-postgres` fixture helper as deferred
and "blocking everything else". It is not deferred. `tests/fixtures/test-db.ts`
exists, provisions a real database per run and drops it afterwards, and is used
by `tests/preload.ts` and five test files. The blocker named in the note is
closed; the note is stale and should be superseded rather than trusted.

Measured on 2026-08-05 against the working tree:

| Metric | Value | Source |
|---|---|---|
| Line coverage | 47.90% | `bun test --coverage tests/unit/` |
| Function coverage | 43.65% | same run |
| Soft floor | 60% | health gate |
| Last recorded health reading | 30.13%, gate WARN | `.metaproject/data/health/artifacts/latest.md`, 2026-08-04, `76f6b94` |

The health artifact is a day and several merges behind the working tree; §2 of
the PRD says what to do about that, since a gate reading a stale number is its
own defect.

## Document Index

| File | Contents |
|------|----------|
| [README.md](README.md) | This file — purpose, status, measured position |
| [prd.md](prd.md) | Problem, measurements, requirements, success criteria, risks |
| [specification.md](specification.md) | Target files in order, fixture surface, acceptance criteria |

## Scope

In scope:

- Covering the highest uncovered-lines × risk files, in order, on top of the
  existing fixture layer.
- Making the health gate read the project's tests again — the last run recorded
  `tests: missing`.
- Superseding the stale memory note so the next reader is not told the
  programme is blocked when it is not.

Out of scope, and why:

- Raising the soft floor, or lowering it to make the gate green. The floor is
  60 and stays 60.
- Extraction refactors. The programme's own arithmetic says extraction is
  spent: what remains is I/O, and I/O needs fixtures, not more pure modules.
- E2E in CI — a separate, decision-blocked item on the roadmap.
- Chasing a percentage for its own sake. Every file in the plan is chosen by
  risk; the number is a consequence, not the target.

## Related Modules

| Area | Path | Relevance |
|------|------|-----------|
| Database fixture | `tests/fixtures/test-db.ts` | Real database per run; the unblocker |
| Test preload | `tests/preload.ts` | Provisions the database for the suite |
| HTTP fixture | `tests/fixtures/fake-fetch.ts` | Network doubles |
| Telegram fixture | `tests/fixtures/fake-telegram.ts` | Channel send doubles |
| SQL double | `tests/fixtures/fake-sql.ts` | For code that must not reach a real database |
| Health module | `.metaproject/data/health/artifacts/latest.md` | The gate being moved |
| Programme history | `.metaproject/memory/task-notes/coverage-programme-state.md` | Prior state — stale, to be superseded |
