# Implementation Plan

Status: formalized

## Approach

The summarizer imports its collaborators rather than receiving them — `sql`,
the LLM client, long-term and short-term memory — so the doubles go in by module
replacement. That is the honest tool here, and the repository already says so:
`tests/fixtures/fake-telegram.ts` documents the same decision for the same
reason, and threading four parameters through production code to suit a test
would change the design to suit the test.

A fixture installs recording doubles for `claude/client.ts`, `memory/long-term.ts`
and `memory/short-term.ts`, and restores them afterwards — restoring matters,
because `mock.module` is process-wide and `bun test` runs every file in one
process.

`sql` comes from the existing `FakeSql`.

Coverage follows behaviour, not the other way round: the cases chosen are the
ones that decide whether anything is written at all.

- **`trySummarize`** — too few messages, a model that returns nothing, a summary
  the triage rejects, and the path where it is kept.
- **`summarizeWork`** — the same shape from the other entry point.
- **`extractProjectKnowledge`** — no project path, too few messages, a model
  that answers with prose instead of facts, and facts that are saved.
- **`touchIdleTimer` / `cleanupStaleTimers` / `stopAllTimers`** — the timer
  lifecycle, with the clock replaced. A timer left behind writes a summary for a
  session that has ended.

### Rejected alternatives

- **Stub `globalThis.fetch`.** The LLM client picks a transport from the
  environment — Anthropic SDK or an OpenAI-compatible endpoint — so a fetch stub
  covers whichever one this machine happens to use, and the test would pass here
  and mean nothing elsewhere.
- **Add dependency parameters to the summarizer.** A larger production change
  than the tests are worth, and one that changes the module's shape for every
  caller.

## Steps

1. `tests/fixtures/fake-memory-deps.ts` — install and restore the doubles.
2. `tests/unit/summarizer.test.ts` — the cases above.
3. Re-measure and record before and after.
4. CHANGELOG entry.

## Risks

- **Module replacement leaks into other files.** Restored in `afterEach` from a
  pristine snapshot of the real values, the pattern `fake-telegram` documents.
- **The tests pin current behaviour, including anything wrong with it.** Where a
  case looks wrong it is named in the test rather than asserted silently.
