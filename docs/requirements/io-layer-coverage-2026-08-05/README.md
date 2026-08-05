# I/O Layer Coverage

Version: 1.1.0

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

Measured on 2026-08-05 against the working tree. The first version of this
package quoted 47.90%, which is Bun's text-reporter aggregate over the files it
loaded; the lcov record counts every instrumented line and answers 36.25%. The
gap to the floor is larger than first published, not smaller.

| Metric | Value | Source |
|---|---|---|
| Line coverage | 36.25% (7369 of 20329) | `bun run health` — lcov, the file the gate imports |
| Soft floor | 60% | health gate |
| Last recorded health reading | 30.13%, gate WARN | `.metaproject/data/health/artifacts/latest.md`, 2026-08-04, `76f6b94` |

The gate was reading a four-day-old import and ignoring a changed-scope test
report; `bun run health` now sequences the three steps so it cannot. PRD §2.3
has the diagnosis.

**Merged, not deployed** (2026-08-05). Every flow in this package is squash-merged
into `main`; none of it is running. The bot container and the channel
subprocesses still carry the pre-programme code, and the status here stays
`spec ready` until a rebuild and a session bounce make it true — the vocabulary
in [`../roadmap.md`](../roadmap.md) reserves `implemented` for deployed code,
and this programme spent a flow (034) on exactly that distinction.

Measured again on 2026-08-05 after the flows below: **42.61%** by the same lcov
record (36.25% → 42.61%), suite 1443 → 1644 tests. Still under the 60% floor;
the gate reads WARN and says so honestly, which is what flow 034 was for.

Flows: 034 (the gate itself), 035 `scripts/supervisor.ts`, 037
`memory/summarizer.ts`, 038 `utils/tts.ts`, 039 `bot/media.ts`, 040
`mcp/dashboard-api.ts`, 041 `scripts/tmux-watchdog.ts`, 042
`bot/commands/admin.ts` — PRs #70, #71, #72, #73, #77, #74, #75, #76.

**036 `mcp/server.ts` landed** (PR #79). It was blocked from 18:35 to 20:20 on
2026-08-05 on a decision the flow would not make for itself: its router was an
anonymous arrow inside `createServer`, reachable only through a function that
binds a fixed port and can call `process.exit(1)`. The maintainer chose the
extraction, and `handleMcpRequest(req, res, bot)` is now exported — a move, not
a rewrite. Coverage 8.49% → 23.98%, over the refusals only; the routes that
succeed write rows and start background work and are left for a seam of their
own.

All sixteen flows of this programme are now merged. None of them is deployed.

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
