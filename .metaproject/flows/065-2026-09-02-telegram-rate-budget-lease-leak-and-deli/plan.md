# Plan

No brainstorm/interview round needed: the incident report already diagnosed
the exact mechanism and a specific recommended fix shape for each of the
three P0 areas, with file/line references. This is a bug-fix flow, not a
design-space decision — the plan below follows the report's own
recommendations (section 13) directly rather than proposing alternatives.

## Approach

### P0-A: `utils/telegram-rate-budget.ts`

Replace the unconditional `setInterval`-driven lease loop in
`createLocalAllowance()` with on-demand leasing:

- Lease is requested only when a caller needs to send and the local
  allowance is insufficient (currently: any caller of the local allowance
  reads a value refreshed blindly every `REFRESH_INTERVAL_MS`, regardless of
  whether anything is waiting to send).
- On refresh/lease, **add** the newly granted tokens to the existing local
  remainder — never overwrite it. This alone closes the "unspent local
  balance destroyed" leak described in the report's 4.1/4.2.
- Keep the existing `leaseBudget()` DB primitive (atomic `UPDATE ... FOR
  UPDATE`) — the double-spend protection there is correct and already
  covered by tests (AC2 of flow 064). Only the caller-side accounting in
  `createLocalAllowance()` is wrong.
- Preserve `FAILOPEN_GRANT`/`LEASE_TIMEOUT_MS` fail-open behavior (AC4 of
  flow 064) — a DB hiccup must still not silently mute every project.

### P0-B: `channel/tools.ts`, `channel/recovery.ts`, `mcp/server.ts`

- Add a bounded periodic worker (interval, not just `main.ts` bot-startup
  path) that calls the same recovery logic `deliverPendingReplies()` runs at
  startup today.
- Introduce an explicit state column/enum on `pending_replies`
  (`pending → sending → delivered` / `failed`) and make the premark/unmark in
  `channel/tools.ts:536-550` `await`ed and tied to the actual send attempt,
  not fire-and-forget.
- In `mcp/server.ts:370-396`, check the Stop-hook Telegram send result's
  `.ok` before publishing `turn_closed`; on failure, leave the reply in a
  durable pending state instead of closing the turn as successful.
- Track delivery state per chunk in `sendReplyChunks()` (`channel/tools.ts`
  ~100-131/585-643) so a partial failure is not recorded as full delivery,
  and recovery/resend targets only the missing chunks.

### P0-C: `channel/poller.ts`, `scripts/supervisor.ts`

- Replace the boolean `delivered` semantics on `message_queue` with explicit
  states (`queued/inflight/delivered`) plus an owner lease and re-claim
  expiry, so a row is not marked delivered until the downstream MCP
  notification is actually acknowledged (`channel/poller.ts:353-378` marks
  it too early today).
- On any notification reject — fast reject or deadline — revert the row to a
  retryable state instead of only logging (`channel/poller.ts:480-500`).
- Make the notification path idempotent so a crash-recovery replay cannot
  produce an unsafe duplicate delivery.
- Fix `scripts/supervisor.ts`'s rescue re-insert (~1895-1905): replace the
  plain `INSERT` (which collides with `idx_queue_msgid_dedup` on
  `(chat_id, message_id)`) with an `UPSERT`/explicit reset of the existing
  row so rescue actually rescues instead of silently failing on every
  attempt.

## Sequencing

TDD per project convention: for each area, write the failing test first
(T5/T7/T9), then the implementation that makes it pass (T6/T8/T10). Areas
are independent of each other (different files, different tables) and can
be implemented in any order; P0-A is sequenced first only because it is the
report's own top priority (it is the mechanism actively destroying the
shared budget right now) and is the smallest, most self-contained change.

## Rejected Alternatives

- **Rewrite the whole rate-budget module around a single global timer with
  request-driven leasing from scratch.** The report explicitly offers this
  as one option ("or introduce a fair, centralized request-driven model")
  but the simpler on-demand-lease-plus-conservation fix closes the
  documented leak with a much smaller, more reviewable diff, and keeps the
  already-tested DB-side atomic lease primitive untouched.
- **Only patch `4df5176`-style amplifier reduction further (P1 status
  amplification work).** Explicitly out of scope — the report is clear this
  does not fix the root cause, only lowers how fast it manifests.
