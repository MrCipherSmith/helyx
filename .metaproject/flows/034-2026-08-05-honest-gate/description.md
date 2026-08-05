# The quality gate judges by a stale number, and the record says the programme is blocked when it is not

Status: formalized
Source: user description → package `docs/requirements/io-layer-coverage-2026-08-05` (R4, R5)

## Problem

Three separate untruths, all measured on 2026-08-05.

**The gate read a number four days old.** `coverage/coverage-summary.json` was
written on 2026-08-04 and nothing regenerates it, so every `keryx health run`
since has judged the project on that file. Regenerating it moved the reading
from 30.13% to 36.25% — the work of the last four days was invisible to the
gate that exists to see it.

**`tests` reported `missing` while 1540 tests passed.** Not a broken
configuration: health wants a project-scope test report, and the newest artifact
is normally written by the post-commit hook, which runs a *changed*-scope
selection. Running `keryx test run` first makes the same source report
`available` with 1540 passed. The gate was reading the wrong run, not no run.

**And the numbers this programme published were estimates.** The io-layer
package's measurement table derived uncovered line counts from file length ×
uncovered fraction, because Bun's text reporter emits percentages. The lcov
record has exact counts, and they differ: `mcp/dashboard-api.ts` is 947
uncovered rather than ~1139, `scripts/supervisor.ts` 580 rather than ~861. The
ranking survives; the figures do not.

**Plus a record that says the programme is blocked.**
`.metaproject/memory/task-notes/coverage-programme-state.md` (2026-08-03) names
a `test-postgres` fixture as deferred and "blocking everything else". It exists,
and `tests/preload.ts` and five test files use it.

## Expected Outcome

- One command produces an honest gate reading: fresh coverage, a project-scope
  test run, then health — in that order, because the order is the defect.
- The published measurements are the exact ones, and say where they come from.
- The memory note reflects reality, superseded through the memory module rather
  than edited by hand.

## Out of Scope

- Raising coverage. That is the rest of block C, and it starts after this.
- Changing the floor, the scoring or the gate's rules.
- Fixing the 213 eslint findings the honest run reports.
