# The watchdog that keeps sessions alive is itself unwatched

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C7)

## Problem

`scripts/tmux-watchdog.ts` reads every session's terminal and decides, from the
text on it, whether to wake the operator: a permission prompt waiting for an
answer, a session stuck in an editor, a credential prompt, a crash, a spinner
that means work is still happening. 470 of its 500 instrumented lines are
uncovered — 6%.

Those decisions are made by pattern-matching a terminal, which is the most
brittle input in the system. A regex that stops matching costs an operator a
session that waits for ever; one that starts matching too much costs a
notification on every message. Both failures are silent, and the file has been
changed repeatedly — `keryx` flow 001 fixed a stripper that made a working
session look hung, flow 005 fixed classifiers that fired on any mention of the
word "permission", and flow 008 found a pane parser that failed silently
because it read un-stripped ANSI.

Nothing tests them.

## Expected Outcome

- Every detector is tested against terminal text of the shape it really sees,
  including the near-misses that must not fire.
- The alert cooldown is tested, because an alert that repeats every poll is how
  an operator learns to ignore the channel.
- Reading the active sessions from the database is tested, including the case
  where the query fails and the watchdog must carry on rather than stop.

## Out of Scope

- The poll loop itself, which shells out to tmux on every iteration.
- Sending to Telegram, covered by the same shape of test elsewhere.
