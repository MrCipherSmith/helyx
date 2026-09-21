# Telegram rate-budget lease leak and delivery recoverability (P0 fixes from 2026-09-02 incident report)

Status: frozen scope, driven from a completed read-only investigation.
Source: `docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md`
(untracked, not yet committed — treat as the authoritative input spec for this
flow, do not edit it as part of this work).

## Problem

`utils/telegram-rate-budget.ts`'s `createLocalAllowance()` runs an
unconditional `setInterval` (every 5s) that leases up to 4 tokens from the
shared Postgres `telegram_rate_budget` table and **overwrites** the local
`tokens` remainder with the new grant instead of adding to it. Any unspent
local balance is silently discarded, even while the process is idle. This has
drained the shared rate budget in production since commit `3f93fa0`
(2026-08-22), and the priority/background lane split in `7827271`
(2026-08-31) made it worse — each process now runs two independent leak loops
instead of one.

Confirmed by the report with runtime evidence: 0 real Telegram `429`s vs. 43
internal "waiting for a rate-limit slot" timeouts in the observed log window.
This is entirely self-inflicted internal starvation — real outbound sends
never reach the Telegram API at all when this happens.

The same report also documents three independent delivery-loss mechanisms
that compound the symptom (reply "disappears" until a lucky restart):

- `pending_replies` are only recovered from `main.ts`'s bot-startup path
  (`channel/recovery.ts`'s `deliverPendingReplies()`); there is no periodic
  worker, so a reply stuck by the rate-limit timeout stays invisible until
  the next bot restart.
- The pre-send `pending_replies` premark/unmark (`channel/tools.ts:536-550`)
  is fire-and-forget, not awaited, and not tied to the actual send outcome by
  an explicit state machine — a crash between premark and send makes a
  never-sent reply look delivered.
- A partially-delivered multi-chunk reply (`sendReplyChunks()`,
  `channel/tools.ts` ~100-131/585-643) is recorded as fully delivered even
  when a later chunk failed; recovery has no way to know which chunk is
  missing.
- Inbound `message_queue` rows are marked `delivered=true` in
  `channel/poller.ts:353-378` **before** the downstream MCP notification is
  acknowledged, so a crash or a fast-reject notification loses the row
  silently (`channel/poller.ts:480-500` only logs a fast reject today, it
  does not revert `delivered=false`).
- `scripts/supervisor.ts`'s rescue re-insert (~1895-1905) does a plain
  `INSERT`, which collides with the `idx_queue_msgid_dedup` unique index on
  `(chat_id, message_id)` already occupied by the delivered row it is trying
  to rescue — the rescue silently fails on every attempt.

## Expected Outcome

Scoped to the report's **P0** priorities (section 13) only:

**P0-A — stop the internal budget leak** (`utils/telegram-rate-budget.ts`):
remove the unconditional periodic lease; lease on-demand only when the local
balance is insufficient for a pending send; never discard an unspent local
remainder on refresh; if leases are still batched, give them a TTL and return
the unused remainder. Target invariant, made verifiable by a test: tokens
leased from the shared bucket == real Telegram transport attempts + explicitly
returned/expired remainder. An idle process must not move the shared bucket.

**P0-B — make outbound reply delivery recoverable**
(`channel/tools.ts`, `channel/recovery.ts`, `mcp/server.ts`): run a bounded
periodic recovery worker, not just bot-startup recovery; await premark/unmark
and drive them through an explicit `pending → sending → delivered/failed`
state machine; check the Stop-hook Telegram send result's `.ok`
(`mcp/server.ts:370-396`) before publishing `turn_closed`; track per-chunk
delivery state so a partial multi-chunk reply is not recorded as fully
delivered and recovery can resend only the missing chunks.

**P0-C — fix inbound queue acknowledgement**
(`channel/poller.ts`, `scripts/supervisor.ts`): do not mark a
`message_queue` row delivered before a successful downstream notification ack;
replace the boolean with explicit `queued/inflight/delivered` states plus an
owner lease and re-claim expiry; revert to a retryable state on any
notification reject (fast or deadline); make the notification path idempotent;
replace supervisor's colliding `INSERT` rescue with a correct
`UPSERT`/reset of the existing row.

Each of the three areas ships with the conservation/recovery/acknowledgement
tests the report calls out as currently missing (section 14, items 1-4 and
6-12 as applicable to P0 scope) — this is TDD work per project convention:
failing tests first, then the fix that makes them pass.

## Out of Scope

- P1 items from the report (centralizing all Telegram traffic through one
  transport/rate coordinator, reducing status-edit amplification further,
  recovery accounting after a successful pending-recovery run) — real,
  documented, but not this flow's scope.
- Rewriting or "fixing" the incident report file itself.
- The already-shipped, already-merged flow 064 (shared rate limiter feature)
  and flow 061 (limit-vs-hang distinction) — this flow fixes a defect inside
  code those flows shipped, it does not revisit their own scope.
- `4df5176` (idle-reminder cap, status clock-only-tick dedup) — already
  merged; this flow does not redo or revert it, only fixes what it did not
  fix (the report is explicit that `4df5176` removed one amplifier, not the
  leak itself).
