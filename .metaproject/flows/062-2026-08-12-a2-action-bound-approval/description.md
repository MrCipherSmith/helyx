# A2: approval bound to an action fingerprint

Status: ready
Source: docs/requirements/keryx-adoption-2026-08-12 (area A2)

## Problem

`CLAUDE.md` records the same incident twice: an agent asked "перезапускаю?", got
"да", and restarted the half of the system the operator was not asking about —
leaving the other half dead with nothing saying so.

The existing defence, `claimRestart` (`scripts/admin-daemon.ts:342`, called at
:416, :494, :522, backed by `utils/restart-lease.ts`), is a **mutex**. It answers
"is another restart already running". It cannot answer "is this the restart that
was approved", because nothing ties the operator's "да" to a described action.

`bun cli.ts bounce` run on the host does not call `claimRestart` at all, so it
can still race a Telegram-triggered restart.

## Expected Outcome

An approval authorizes exactly one action, identified by a coarse fingerprint
over what the operator would notice — which half of the system, which project,
what downtime. A grant that does not match the action about to run is not a
grant. Grants are single-use and short-lived, with one bounded exemption: an
autonomous actor (`scripts/tmux-watchdog.ts`) holds a narrow standing grant so
that unattended recovery of a wedged session keeps working.

The lease stays. Fingerprint and lease answer different questions and both are
asked.

## Out of Scope

- Reworking `perm:always:` into a bounded grant. It touches the permission flow
  on every tool call, not a family of five commands, and belongs in its own
  package.
- Any change to the operator's conversational channel. Per policy P-1.0 of the
  source package, nothing in this flow inspects, gates, delays or withholds a
  message between the operator and a session.
- The other four adoption areas (A1, A3, A4, A5).
