# Admin commands restart, stop and rebuild things, and none of them is tested

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C5)

## Problem

`bot/commands/admin.ts` is 3.65% covered — 449 uncovered lines. It is the
operator's console: status, pending permissions, statistics, logs, the tool
inventory.

Its handlers are the ones a person reaches for when something is already wrong,
which is the worst moment for one of them to answer with an exception instead
of a number. Each reads the database directly and formats what it finds, and
none of that formatting has ever been executed by a test.

## Expected Outcome

- The handlers that report state are driven end to end against a database that
  answers, and against one that does not.
- The empty case is covered for each: no pending permissions, no logs, no
  sessions. It is the case an operator sees most often and the one most likely
  to divide by zero.

## Out of Scope

- The handlers that act rather than report — restart, stop, rebuild — which are
  reached through `/system` and the admin daemon, and whose tests belong with
  the daemon.
- `utils/admin-format.ts`, which is pure, extracted and already tested.
