# Implementation Plan

Status: formalized

## Approach

The handlers take a grammY `Context` and read `sql` from the module, so the
tests give them a context double that records what was said, and replace
`memory/db.ts` with `FakeSql` for the duration of each test.

Installed in `beforeEach` and restored in `afterEach`, never at module scope:
a top-level `mock.module` in this repository leaked into five tests in other
files earlier today, and the containment is the whole difference.

The cases are chosen for what an operator meets:

- **Something to report** — rows exist, and the numbers reach the reply.
- **Nothing to report** — no pending permissions, no rows at all. This is the
  common case and the one where an average over zero is written.
- **A database that will not answer** — the handler must say so rather than
  throw into the command dispatcher.

### Rejected alternatives

- **Test the formatting helpers instead.** They are pure, extracted, and
  already tested; what is untested is the handler that calls them.
- **Drive the real bot.** These take a context; a real bot adds a network and
  proves nothing more.

## Steps

1. `tests/unit/admin-commands.test.ts` with a context double and `FakeSql`.
2. Re-measure and record before and after.
3. CHANGELOG entry.

## Risks

- **Module replacement leaking.** Contained per test, and the whole suite is run
  to prove it — the failure mode is other files, so the file alone passing means
  nothing.
- **Tests pin current formatting.** Only the facts are asserted — a number, a
  name, an empty-state sentence — not the exact punctuation around them.
