# Reviewer reports are printed and forgotten

Status: formalized
Source: user description → package `docs/requirements/reviewer-operations-2026-08-05` (gap G2)

## Problem

`scripts/review.ts` is 34 lines: run every enabled reviewer, print each report
to stdout, exit. `runReviewers` returns a structure that would serialize
directly — `{ mode, reports[] }` with `reviewerId`, `label`, `model`, `ok`,
`content`, `error` — and the wrapper renders it to a terminal and drops it.

Consequences, all of them observed during this programme:

- The second review of a branch cannot know what the first one said. Flow 030
  went three rounds; nothing but this conversation records what rounds one and
  two claimed, or which of it was wrong.
- A finding dismissed with a reason has to be dismissed again next time, with
  the reason reconstructed from memory.
- `keryx memory ingest --from-review <path>` exists in the memory module's CLI
  surface. Nothing in this repository has ever produced a file for it: the
  receiver was built and the sender never was.

## Expected Outcome

- Every run leaves two files: one machine-readable record of the run, and one
  Markdown rendering that a person reads and that `keryx memory ingest
  --from-review` accepts.
- `scripts/review.ts` keeps its output contract exactly — the reports on stdout
  and the bare `SELF` line that CLAUDE.md turns into a self-review — because a
  change there silently changes how every agent in this repo reviews code.
- Artifacts are bounded. A directory of ten-minute reviews that grows for ever
  is a defect this flow would be introducing.

## Out of Scope

- Ingesting into project memory automatically. The artifact makes it possible;
  deciding that a finding is true stays a deliberate act.
- Reviewer availability polling and scheduled reviews — the other two flows of
  this package, both of which are more useful once runs persist.
- Changing prompts, diff budgets or token budgets. Those are measured and
  settled.
