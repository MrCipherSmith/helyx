# Helyx v1.58.1 Release Notes

**Released:** 2026-09-02

A same-day incident response to v1.58.0's own shared rate limiter: it was
quietly starving itself, and a reply stuck by that starvation had no way to
recover short of a lucky bot restart. Both are fixed, plus the idle-reminder
spam this range's status-tick fix already reduces the root cause of.

## What's New

### The shared rate limiter was draining itself

v1.58.0 introduced one Postgres-backed budget shared across every project's
`channel.ts` subprocess. What shipped alongside it: an unconditional lease
every few seconds, whether or not anything was waiting to send, and a refresh
that discarded any unspent local remainder instead of keeping it. Idle
subprocesses were quietly draining the shared bucket on their own — 0 real
Telegram `429`s in the incident window, 43 internal "waiting for a rate-limit
slot" timeouts. The limiter was fighting Telegram's ceiling that was never
actually reached.

Leasing is now on-demand: nothing is requested from the shared bucket until a
subprocess has genuinely sent something through it, and a lease correctly
adds to whatever local balance is left rather than replacing it.

### A stuck reply had no way back except a restart

Before this release, a reply that failed to send (rate-limit timeout,
transient Telegram error) sat in `pending_replies` until the bot process
happened to restart — the only thing that ever re-checked it. A bounded
periodic worker now retries stuck replies on its own schedule, and an
explicit `pending → sending → delivered / failed / partial` state replaces
the boolean that couldn't tell "never tried" from "currently sending" from
"partially succeeded."

Inbound messages had a matching gap: a row was marked delivered to the
operator's chat before Claude had actually been notified, so a notification
that failed fast left the message looking delivered while nobody ever saw
it. It's now only marked delivered once notification actually succeeds.

A follow-up review caught two remaining crash-only gaps — a real process
death, not just a slow retry, could still permanently strand a message in
either fix above — and closed both before this shipped.

### Idle-reminder spam, traced to its root cause

Sessions with nothing queued for hours were getting a fresh "still idle"
Telegram message every hour instead of one message edited in place — the
same status-tick waste that fed the rate-limiter starvation above. Both are
fixed together: the reminder now edits itself for its second and third ping
and then goes quiet, and the status tick that update piggybacked on no
longer spends a shared-budget token on ticks where nothing visible changed.

## Upgrade

Two Postgres migrations landed in this range (v54: `pending_replies.status`;
v55: `message_queue.claimed_at`) — both already applied to the running
database as of this release.

**This release touches all three halves, and all three are already live.**
The bot container was rebuilt at 14:45 UTC on 2026-09-02, confirmed healthy
with both migrations applied. `helyx-admin.service` (the host process running
`scripts/supervisor.ts` and `scripts/tmux-watchdog.ts`) was restarted
separately in the same window — it does not share a restart path with the
bot container or the CLI sessions, and both of this release's supervisor-side
fixes ship only there. CLI sessions were bounced immediately after. Nothing
further to deploy for this release.

One side effect of that restart sequence, not a defect in this release:
`tmux-watchdog.ts`'s idle-reminder counter lives in the daemon's own memory,
not in Postgres, so each of today's admin-daemon restarts (four total,
including this release's) reset it — already-idle projects re-sent their
first reminder after every restart before settling back onto the real hourly
cooldown. Flagged for a future fix; not part of this release's scope.

## Note on CI

`Build` is green on the code commit in this range (`1602e29`, merged as
`f3b5111`) — both `test` and `build` jobs passed on PR #116 before merge.
