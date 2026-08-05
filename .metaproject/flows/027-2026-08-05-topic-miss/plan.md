# Implementation Plan

Status: formalized

## Approach

Two changes, each in the narrowest place that can see the problem.

**Detection at the transport, not at the call sites.** Every channel send —
message, photo, poll, edit — passes through `telegramRequest` in
`channel/telegram.ts`. That function holds both the request body (which carries
the requested `message_thread_id`) and the parsed result (which carries the one
Telegram actually used), so it is the only place where the comparison costs
nothing and cannot be forgotten by a new call site. `bot/streaming.ts:24`
already makes this comparison for its own single case; putting it in the
transport generalises that rather than adding a second copy.

**A probe Telegram answers honestly.** `sendChatAction` was the wrong question:
measured against thread `999999`, it returns `ok`. The only call that
distinguishes a live topic is one that produces a message, because a live topic
echoes `message_thread_id` back and a deleted one does not. The probe is
therefore a real message, deleted in a `finally` so it disappears whether it
landed in the topic or in General.

### Rejected alternatives

- **`editForumTopic` with the current name** — no visible message, but it
  renames a topic the operator may have renamed on purpose via `/topic_rename`.
  A validity check must not mutate what it checks.
- **Failing the send on a thread miss** — Telegram delivered the message. A
  caller told it failed would resend, producing two copies in General instead
  of one.
- **Auto-nulling `forum_topic_id` on a miss** — a transient oddity would then
  destroy a live mapping. Detection reports; `/forum_clean` decides.

## Steps

1. `reportThreadMiss(method, body, result)` in `channel/telegram.ts`, called
   from `telegramRequest` on every successful response. Guards: requested
   thread must be a number, result must be an object carrying a `message_id`.
2. Replace the `sendChatAction` probe in `ForumService.validateTopicExists`
   with a send-and-delete probe; keep the existing error classification, keep
   "unrelated error → assume valid".
3. Tests for both, driving the real functions.
4. CHANGELOG entry.

## Risks

- **A noisy log if a topic is deleted and the session keeps answering.** One
  error line per send is the intended volume — the condition means the system
  is misdelivering — and D2 (error-stream watch) will aggregate it later.
- **The probe is visible for a moment.** `/forum_clean` is an admin command run
  rarely; the probe is deleted immediately. Accepted deliberately: the
  alternative is a check that cannot detect the thing it exists to detect.
