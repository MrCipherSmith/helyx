# Helyx v1.55.0 Release Notes

**Released:** 2026-08-06

A release about knowing what the system is doing — and about the commands you
reach for when it is not doing it.

## What's New

### One restart at a time

Three restart commands — `bounce`, `host_restart`, `full_restart` — spawned
their work detached and reported success in about a second while it ran for
minutes. The only guard checked for a row of *the same name*, so the window was
that second, and two differently-named restarts were never excluded from each
other at all. Pressing "🔄 Bounce" and then "♻️ Полный рестарт" ran two
`tmux kill-session` sequences over one session name, each tearing down the
windows the other had just created, both logs reporting success. `/up` from the
host was a third door with no check.

They now share a lease. It is a file rather than a database row because `/up` is
used when the stack is down, and when the stack is down Postgres is down with
it. A lease older than fifteen minutes may be broken by the next taker, which
says so in the log — a lease nobody can break is a stack nobody can restart.

The queue row stops lying with it: the three commands report the work as
*running* and stay `processing` until the detached work closes them, which is
also what closed the one-second window in the older check.

### A status that says whether anything is still moving

The status message answered "how long" and "what did it do". Neither is the
question, which is *is it still moving* — a turn thinking for four minutes and
one that died three minutes ago rendered identically.

It now carries the age of the last event (`⧗ 3s`, `⧗ 4m`), a line naming the
subagents currently running — including one spawned that has not written a line
yet, which is exactly when the status used to go quiet — and one line of what is
happening now, derived from the last tool call rather than generated.

### A spoken recap that is not cut off mid-word

The voice recap was truncated at 700 characters, mid-word. The ceiling is now
what a Telegram message can actually carry, measured after HTML escaping rather
than before, and a cut lands on a sentence end. The recap text goes out whole
and collapsed; the **audio** is what gets divided, so a long recap arrives as one
block of text and the several tracks to hear it in.

### Fixes found by review

- `docker restart` was the one step in the admin daemon without a timeout, on a
  single-threaded command queue — a hung dockerd held every later command behind
  it, in the situation those buttons exist to recover from.
- Review artifacts grew without bound on the scheduled path: pruning was the
  caller's job and only the manual CLI did it.
- `/now` accepted a transcript of any age and could report a session that ended
  days ago as the live one.
- The completion notice under-reported edits across turns.

## Upgrade

No database migrations. No new environment variables.

`HELYX_RESTART_LEASE` optionally moves the restart lease off its default path
(`$XDG_RUNTIME_DIR`, falling back to the temporary directory). It needs setting
only if the admin daemon and the host ingress cannot share that directory.

**This release touches all three halves and needs all three restarted:** rebuild
and restart the bot container, bounce the sessions so the channel subprocess
picks up the status and recap changes, and restart the admin daemon for the
restart lease. The daemon restart is itself one of the commands this release
changes, so do it last.

## Note on CI

The `test` job — typecheck, lint, unit tests, duplicate check — passed on the
merged commit. The `build` job never ran: GitHub's Actions service returned
`Service Unavailable` when resolving action metadata across five attempts, so no
job step executed. The bundle check that job performs was run locally instead
and is recorded here rather than left to be assumed.
