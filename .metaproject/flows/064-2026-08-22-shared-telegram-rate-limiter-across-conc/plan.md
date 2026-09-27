# Implementation Plan

Status: refined after T1 context collection (2026-08-22) — design updated, not yet implemented

## Alternatives considered

- **A. Postgres-backed shared token bucket** (recommended). All ~10
  `channel.ts` subprocesses already share one Postgres instance for session
  leases (`sessions.lease_owner`/`lease_expires_at`). Add a small table
  (e.g. `telegram_rate_budget(bucket text primary key, tokens numeric,
  updated_at timestamptz)`) and an atomic `UPDATE ... SET tokens = ...
  WHERE tokens >= 1 RETURNING tokens` (or a Postgres function) that every
  outbound Telegram call acquires before sending; refill on a schedule or
  lazily by elapsed time. No new infrastructure — reuses what's already
  the single point every process already trusts.
- **B. Centralize sending through `bot.ts`.** Route every outbound Telegram
  call from each `channel.ts` subprocess through a small internal
  HTTP endpoint on the central bot container, which owns one in-memory
  token bucket. Correct and DB-latency-free, but a bigger change: needs a
  new internal API + auth, and a fallback for when the bot container is
  briefly down (subprocesses currently send directly and don't depend on
  bot.ts being up).
- **C. Separate sidecar coordinator.** A small dedicated process just for
  rate limiting. Rejected for now — adds a process to keep alive for a
  problem Postgres already solves for the lease system.

**Chosen: A**, for lowest new-infrastructure risk, but refined per T1
findings (see context.md / journal.md 2026-08-22): each subprocess opens
its own Postgres pool (`memory/db.ts`: `max: 10`) and ~10 subprocesses
already run concurrently, so a naive acquire-per-send would add a new,
previously-unprecedented DB round trip on every typing tick (every 4s per
active session) on top of existing load, with no prior precedent in this
codebase for that call volume. **Design change: lease a slice of the
budget periodically, not one DB call per send.** Each subprocess asks
Postgres roughly every 5s ("grant me up to N sends for the next window")
via one atomic `UPDATE ... RETURNING`, then spends that local allowance
in-process without further DB hits until the next lease — cuts the new DB
call volume by roughly the ratio of typing-ticks-per-lease-window instead
of matching it 1:1, while still enforcing a real shared budget with ~5s
granularity (already the same order as the existing 8s status-edit floor,
so no new lag class is introduced).

No advisory locks (`pg_advisory_lock`) — the codebase deliberately moved
away from those to the lease-column + TTL pattern already used for
session ownership, specifically to avoid orphaned locks on pool
reconnects (CHANGELOG.md:2416). The token-bucket lease follows the same
`UPDATE ... SET tokens = tokens - :n WHERE tokens >= :n RETURNING tokens`
shape already precedented in `utils/action-approval-grant.ts`.

## Steps

1. Migration: append one entry to the `migrations` array in `memory/db.ts`
   (next version after current top; `docker logs` showed v51 at last
   check — confirm current top before picking the number) creating
   `telegram_rate_budget(bucket text primary key, tokens numeric, updated_at
   timestamptz)`, seeded with one row for the single global bucket (the
   limit is per-chat and there is currently exactly one chat in play).
2. Add a small leaf module (doc-comment style matching `channel/telegram.ts`'s
   header) exposing `leaseBudget(n: number): Promise<{granted: number}>` —
   one atomic `UPDATE ... RETURNING`, refilling by elapsed-time-since-
   `updated_at` rather than a separate timer/cron.
3. Give each subprocess a local in-memory allowance (refreshed via
   `leaseBudget` on a ~5s timer, independent of any individual send), and
   have `channel/telegram.ts`'s `telegramRequest` and `utils/typing.ts`'s
   `startTypingRaw` check/decrement that local allowance before sending —
   this is the actual per-call gate; the DB call only happens on the
   lease refresh, not per send.
4. Fail-open: if `leaseBudget`'s DB call fails or times out, grant a
   small conservative local allowance anyway (log a warning) rather than
   blocking sends indefinitely — a DB hiccup must not silently mute every
   project's status updates (AC4).
5. When the local allowance is exhausted mid-window, queue the call to
   wait for the next lease refresh rather than erroring — mirror
   `telegramRequest`'s existing 429 wait-and-retry shape so callers don't
   need to change.
6. Load-test locally: simulate 3-4 concurrent `channel.ts`-like callers
   leasing/spending against the same bucket row and confirm combined
   throughput stays under the configured budget with no double-spend
   under concurrent `UPDATE`s (AC2).
7. Roll out to one project first — `helyx`'s own session is easiest to
   observe live via `/tmp/channel-helyx.log` — watch for a real
   multi-project-concurrent window, then roll out to the rest (AC3).

## Risks

- A shared budget that's too conservative makes *every* status update
  feel laggier, even when only one project is actually active — the
  refill rate needs headroom for the single-session case, not just the
  worst-case concurrent one.
- The lease window (~5s) trades exactness for DB load: a burst that lands
  right after a lease refresh could still exceed the per-chat budget
  within that window. Acceptable given Telegram's own 429 retry already
  provides a hard backstop; not acceptable if window is set too wide.
- Advisory-lock-free `UPDATE ... RETURNING`-based token bucket under real
  concurrent access needs correctness testing — a naive read-then-write
  race would let the budget be double-spent (AC2 exists specifically for
  this).
- Postgres becomes a (lighter, batched) dependency on Telegram sends where
  it wasn't before; fail-open (step 4 / AC4) is required, not optional.
