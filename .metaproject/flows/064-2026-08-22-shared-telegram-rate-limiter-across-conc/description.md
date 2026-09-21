# Shared Telegram rate limiter across concurrent project channel.ts sessions

Status: formalized (operator + assistant investigation, 2026-08-22)
Source: operator report — "Telegram обрубает" status/typing traffic

## Problem

Every project (~10 currently: helyx, keryx, arena, goodai, goodai-base,
vantage-frontend, vantage-backend, carlson-bot, kesha-voice-kit, deprecated)
runs its own `channel.ts` subprocess, and every one of them talks to the
*same* Telegram bot token and the *same* chat_id — the group is one
supergroup, and project topics are just `message_thread_id`s inside it.
Telegram rate-limits are enforced per chat_id, not per topic.

Each subprocess already throttles itself (status-message edits floored at
5s — see `channel/status.ts` `MIN_EDIT_INTERVAL_MS`, now 8s after this
flow's prerequisite fix — plus a typing indicator every 4s), but none of
them know about each other. When more than one project topic is active at
once, their combined traffic to the one chat_id exceeds Telegram's actual
per-chat budget (documented in code as "~20/min"). Observed directly in
`/tmp/channel-helyx.log`: a ~4-hour window on 2026-08-21 05:06–09:16 with
dozens of `"Telegram rate limit — retrying"` warnings and one
session-lease force-steal, which reads to the operator as the topic
randomly freezing or failing to update.

Three cheap, low-risk mitigations already shipped ahead of this flow
(see `fix/telegram-rate-limit-backoff`, commit f4b88a0): typing-indicator
429 backoff, dropping the typing indicator entirely in forum mode, and
raising the status-edit floor 5s → 8s. They reduce the odds of collision
but do not remove it — with enough simultaneously-active sessions the
*combined* rate can still exceed the per-chat budget no matter how high a
single session's own floor is raised, because there is still no shared
budget between processes.

## Expected Outcome

Outbound Telegram traffic for status edits, typing indicators, and replies
across all concurrently-running project sessions is governed by one shared
rate budget for the bot token/chat, so no single project topic can push the
group over Telegram's limit and no other topic's status updates stall
because of it. "Telegram rate limit — retrying" should stop appearing in
channel-*.log under normal multi-project concurrent use.

## Out of Scope

- Changing what gets sent (status text, spinner cadence, typing UX) beyond
  what already shipped ahead of this flow.
- Moving status/reply delivery out of the per-project `channel.ts`
  subprocess model entirely (e.g. consolidating all channel logic into the
  central `bot.ts` process) — that's a much larger redesign; this flow is
  scoped to *rate-limiting* the existing architecture, not replacing it.
- The unrelated `"pending reply delivery failed" / "chat not found"` noise
  seen on every bot container restart — a separate, already-flagged issue.
