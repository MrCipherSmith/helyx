# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A test against a real (or disposable-but-real) Postgres instance
  proves the conservation invariant for `utils/telegram-rate-budget.ts`'s
  local allowance: refreshing/leasing while the local remainder is nonzero
  never discards that remainder — the post-refresh local balance is the old
  remainder plus the new grant, not just the new grant.
- AC2: A test proves an idle local allowance (no pending send, no consumer
  calling for a token) does not move the shared `telegram_rate_budget` row
  for its lane — dozens of idle allowances running concurrently leave the
  shared bucket's `tokens`/`updated_at` untouched by their own activity.
- AC3: A test proves an active sender is not starved by concurrently-idle
  allowances contending for the same lane — under simulated concurrent
  idle + active load, the active sender obtains a slot within a bounded
  time proportional to real demand, not blocked by idle allowances holding
  or re-leasing tokens they do not use.
- AC4: A test proves `pending_replies` are recovered by a periodic worker
  independent of bot process startup — a reply left in a durable pending
  state (simulating an internal-timeout failure) is delivered without
  requiring a bot restart, within the worker's bounded interval.
- AC5: A test proves the `pending_replies` premark/unmark around a send
  attempt is awaited and state-machine-driven (`pending → sending →
  delivered`/`failed`), not fire-and-forget — a simulated crash between
  premark and send leaves the row in a state recovery can act on, not
  silently marked delivered.
- AC6: A test proves the Stop-hook path in `mcp/server.ts` does not publish
  `turn_closed` when the Telegram send result is `{ ok: false }` — the reply
  stays in a durable pending state instead of the turn being reported closed
  as if delivery succeeded.
- AC7: A test proves a partially-delivered multi-chunk reply
  (`sendReplyChunks()`) is not recorded as fully delivered when a
  non-first chunk fails — the persisted/recoverable state reflects which
  chunks actually went out.
- AC8: A test proves an inbound `message_queue` row is not marked delivered
  before its downstream MCP notification is acknowledged, and that a
  notification reject (fast reject or deadline) reverts the row to a
  retryable state rather than leaving/marking it delivered
  (`channel/poller.ts`).
- AC9: A test proves `scripts/supervisor.ts`'s rescue path successfully
  re-queues an unanswered message against the real schema, including the
  `idx_queue_msgid_dedup` unique index on `(chat_id, message_id)` — run
  against a real/disposable Postgres instance with that index in place, not
  a fake-SQL mock that does not model the constraint.
- AC10: `bun run typecheck` is clean and the full `bun test tests/unit/`
  suite passes (excluding any pre-existing unrelated failures already
  present on `main` before this flow, named explicitly if any remain).
