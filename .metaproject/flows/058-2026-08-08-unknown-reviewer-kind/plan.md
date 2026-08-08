# Implementation Plan

Status: formalized

## Approach

Turn the two-test-and-fallthrough dispatch in `runOne` into an exhaustive
`switch`, and give the default branch a `never`-typed parameter. That is the
whole idea: the compiler, not a reviewer, is what notices the next kind added
without being wired up. `unhandledKind(kind: never, reviewer)` only accepts a
call once every known kind has been handled above it.

The status path (`getReviewerStatuses`) has the same fallthrough and needs the
same answer, but it is a DB-reading loop and not directly testable — so the row
it produces is extracted into a pure `unknownKindStatus()`, which is. Both paths
phrase the reason through one `unknownKindDetail()`, so they cannot drift.

## Steps

1. `unknownKindDetail(kind)` — the single phrasing.
2. `unhandledKind(kind: never, reviewer)` → failed `ReviewerReport`.
3. `unknownKindStatus(reviewer)` → unavailable `ReviewerStatus`, `probed: true`.
4. `runOne`: switch on all three known kinds, default → `unhandledKind`.
5. `getReviewerStatuses`: `if (r.kind !== "provider")` → `unknownKindStatus`, above
   the provider lookup so it cannot reach one.
6. Tests: run path, status path, the two agreeing, and an orphaned provider row
   still reading `unknown provider`.
7. Prove AC6 by temporarily adding a fourth kind and watching typecheck fail.

## Risks

- `probed: true` on the unknown-kind status could read as "we tested it". It is
  the honest value — the build definitively cannot run it — and the docstring
  says why, since `probed` exists precisely to stop unearned green ticks.
- The status branch keys on `!== "provider"` rather than an exhaustive switch:
  the loop `continue`s out of each known kind above it, so an exhaustive form
  would need restructuring the whole loop. Out of proportion to the fix.
