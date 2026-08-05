# I/O Layer Coverage — Specification

Version: 1.0.0

## 1. Identity

| Field | Value |
|---|---|
| Package | `io-layer-coverage-2026-08-05` |
| Kind | `implementation-plan` |
| Owner | `tests/` — the code under test is not modified except where a test proves a defect |
| Gate | `keryx health run`, coverage soft floor 60% |
| Predecessor | Flows 001–008, recorded in `.metaproject/flows/` and summarised in the stale note this package supersedes |

## 2. Fixture surface (existing — to be used, not rebuilt)

| Fixture | Provides | Use when |
|---|---|---|
| `tests/fixtures/test-db.ts` | A real Postgres database provisioned per run and dropped after; migrations applied in a subprocess so the developer's own database cannot be reached | The code under test issues real SQL |
| `tests/preload.ts` | Suite-wide provisioning and `NO_DATABASE_MESSAGE` skip path | Always — it is the preload |
| `tests/fixtures/fake-sql.ts` | An assertable SQL double | The code under test must not reach a database at all |
| `tests/fixtures/fake-fetch.ts` | HTTP doubles | Provider, Telegram HTTP, Ollama |
| `tests/fixtures/fake-telegram.ts` | Recording stand-in for `channel/telegram.ts`, with restore | Channel-side sends |
| `tests/fixtures/fake-permission-ctx.ts` | Permission-flow context | Permission handling |

A run without a reachable Postgres server must still pass, skipping the
database tests with `NO_DATABASE_MESSAGE`. That path is part of the contract
and is itself asserted.

## 3. Order of work

Ranked by estimated uncovered lines weighted by operational risk. Each row is
one flow.

| # | Target | Now | Target | Why here |
|---|---|---|---|---|
| C1 | `scripts/supervisor.ts` | 44.61% | ≥ 75% | Top hotspot (churn × complexity 355 776); broke twice in one week; about to gain two loops from the self-observability package |
| C2 | `mcp/server.ts` | 7.89% | ≥ 60% | Every MCP tool call and the Stop hook enter here; ~760 uncovered lines |
| C3 | `memory/summarizer.ts` | 7.58% | ≥ 60% | Holds the D1 defect from self-observability; untested when it silently produced nothing for weeks |
| C4 | `bot/media.ts` + `utils/tts.ts` | 5.59% / 5.54% | ≥ 55% | The voice path the operator uses on every message; currently fails its first provider on every synthesis with nobody testing the fallback chain |
| C5 | `bot/commands/admin.ts` | 3.65% | ≥ 55% | Admin actions restart, stop and rebuild things; the least reversible code in the repository |
| C6 | `mcp/dashboard-api.ts` | 3.66% | ≥ 50% | Most uncovered lines of any file (~1139) and the lowest operational risk — deliberately last |
| C7 | `scripts/tmux-watchdog.ts` | 6.00% | ≥ 50% | Session survival; ~650 uncovered lines |

`channel/status.ts` (62.94%) and `mcp/tools.ts` (39.88%) are not in the plan:
both are above the point where the next test costs more than it returns, and
neither is a hotspot the way the supervisor is.

## 4. What each flow delivers

For every row in §3:

1. Tests against the real behaviour, using §2 fixtures.
2. Any defect found is fixed in the same flow and named in the flow's record —
   flows 001–008 found seven this way, and finding none would be the surprise.
3. Per-file coverage before and after, quoted in the flow's completion note.
4. No production code changed except a proven defect or a seam that cannot be
   tested otherwise; a seam added for testing is called out and justified.

## 5. Health gate integration

| Item | Contract |
|---|---|
| Command | `keryx health run` |
| Required source | `tests` must report `available`; the 2026-08-04 run recorded `missing` and that is fixed before the gate is trusted |
| Coverage source | `scripts/coverage-summary.ts` bridges Bun's output into the Istanbul summary health reads |
| Baseline | Re-recorded once after C1 lands, so regression detection compares against a run in which all sources were live |
| Floor | 60%, unchanged |

## 6. Record correction

```bash
keryx memory supersede .metaproject/memory/task-notes/coverage-programme-state.md \
  --by .metaproject/memory/task-notes/<new-note>.md
```

The superseding note states: the `test-postgres` fixture named as the blocker
exists and is in use; the measured position on 2026-08-05 (47.90% lines, 43.65%
functions, 1443 tests); the C1–C7 order; and that extraction remains spent.

Never hand-edit the note — the memory module owns its own index.

## 7. Data contracts

None. This package adds tests and one memory note. No schema, no config, no
runtime surface.

## 8. Acceptance criteria

| # | Criterion |
|---|---|
| A1 | Line coverage ≥ 60% on `bun test --coverage tests/unit/` |
| A2 | `scripts/supervisor.ts` ≥ 75% lines |
| A3 | `keryx health run` reports gate PASS with `tests: available` |
| A4 | The suite passes with no Postgres server reachable, skipping database tests via `NO_DATABASE_MESSAGE` |
| A5 | `bun run dupes` reports no new duplicated definitions |
| A6 | Every defect found during the work is fixed and recorded in its flow |
| A7 | The stale programme note is superseded through `keryx memory supersede` |
| A8 | `tsc --noEmit` clean; whole suite green |
