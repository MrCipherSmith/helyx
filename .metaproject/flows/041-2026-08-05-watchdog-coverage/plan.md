# Implementation Plan

Status: formalized

## Approach

The detectors are pure functions over the lines of a pane. They are not
exported, so the flow exports them for the tests with the comment saying so —
the pattern `botDownState` established in `scripts/supervisor.ts` and that this
programme has already used four times.

Nothing else changes. Every test drives the real function over text shaped like
a real terminal, including the cases that must *not* match: a spinner line that
is not a spinner, the word "permission" in ordinary output, an editor's name
mentioned rather than running.

`fetchActiveSessions` already takes `sql` as a parameter, so `FakeSql` reaches
it with no module replacement at all.

### Rejected alternatives

- **Test through the poll loop.** It shells out to tmux on every iteration; the
  decisions are reachable directly and the loop adds only noise.
- **Assert on regexes rather than on the functions.** The patterns are already
  visible in the source; what is worth pinning is what the function concludes
  from a pane.

## Steps

1. Export the detectors and the cooldown check for the tests.
2. `tests/unit/watchdog-detectors.test.ts`.
3. Re-measure and record before and after.
4. CHANGELOG entry.

## Risks

- **Exporting for tests widens the module's surface.** Each export carries the
  comment saying why, and none of them is called from anywhere else.
- **Terminal fixtures drift from what tmux really produces.** They are written
  from the shapes the source itself documents, and where a fixture is a guess
  it is named as one.
