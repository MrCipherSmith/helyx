# Implementation Plan

Status: frozen

## Approach

One lease, taken before any restart is spawned and released when it ends.

The lease has to hold in the one situation it exists for, which is a stack that
is already broken. That rules out putting it in Postgres alone: `/up` through
`scripts/host-ingress.ts` is armed precisely when the bot is dead, and when the
whole stack is down the database is down with it. A guard that cannot be
consulted at the moment it matters is not a guard.

So the lease is a file on the host, held by whoever spawns the work:
`admin-daemon.ts` and `host-ingress.ts` both spawn, both run on the host, and a
file is visible to both with the database in any state. Taking it is an
`O_CREAT | O_EXCL` write — the operation is atomic, so two daemons cannot both
believe they took it, which a read-then-write would allow.

The database keeps a copy for the operator, not for correctness. The enqueue-time
check in `bot/commands/system.ts` runs in the container and cannot see the host's
file, so it goes on answering from what it can see — and its answer improves for
free once the row stops flipping to `done` in a second (below). The lease is what
actually decides; the row is what explains.

**Staleness is a timestamp, not a heartbeat.** A restart that dies leaves its
file behind, and a lease nobody can break is a stack nobody can restart — worse
than the race it replaced. The file carries the owner and the time it was taken;
a lease older than the longest restart can take is stale and may be broken by the
next taker, which logs that it did so. No heartbeat: the work is detached and
frequently kills the process that would have to send one.

**The row stops lying.** `bounce`, `host_restart` and `full_restart` no longer
report `ok` at spawn. They report that the work was *scheduled*, and the row
stays `processing` until the detached script releases the lease — which is also
what closes the ~1s window in the existing same-name check, without touching it.

### Alternatives considered

*Keeping the guard in Postgres only.* Simplest, and wrong for the case above:
`/up` exists for when Postgres is unreachable.

*An advisory lock in Postgres.* Same objection, plus the lock dies with the
connection and `host_restart` deliberately kills the process holding it.

*A lock file with no expiry.* Correct until the first crash, then the operator
has to know which file to delete — from a Telegram client, with the stack down.

## Steps

1. `utils/restart-lease.ts`: `takeRestartLease(owner)` / `releaseRestartLease()`
   / `readRestartLease()`. Atomic create, owner and timestamp in the file, stale
   leases breakable with a logged reason. Pure enough to test against a
   temporary directory.
2. `scripts/admin-daemon.ts`: take the lease before spawning `bounce`,
   `host_restart`, `full_restart`; refuse with the holder and its age when it is
   held; leave the row `processing` rather than `done`.
3. `scripts/restart-host-run.ts` and the `full_restart` inner command: release
   the lease and close the row when the work finishes, however it finishes.
4. `scripts/host-ingress.ts`: `/up` takes the same lease and says so when it
   cannot, instead of running a second bring-up.
5. Tests: two takers, one winner; a stale lease is breakable and a fresh one is
   not; release makes the next take succeed; a refusal names the holder.

## Risks

- **A lease leaked by a path that never releases** wedges restarts until it goes
  stale. Mitigated by the expiry, and by releasing in a `finally` rather than on
  the success path — but the detached scripts can be killed outright, which is
  why the expiry is the real answer and not the backstop.
- **The expiry is a guess.** Too short and it breaks a live restart's lease; too
  long and a crashed one blocks recovery. It is set from the longest thing a
  restart does — a Docker build — with margin, and stated as a constant with the
  reasoning next to it rather than a number in three files.
- **Two doors, one file.** If `host-ingress.ts` and `admin-daemon.ts` ever run
  with different working directories or different users, they would take
  different files and exclude nothing. The path is absolute and derived from one
  place for that reason.
