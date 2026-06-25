# PRD: Message Delivery Resilience When Target Session Is Offline

## 1. Overview

Two related gaps in message delivery when a Claude Code session is restarting or unavailable:
1. Voice messages are silently dropped when the target session is disconnected.
2. Messages queued for a disconnected session have no timeout — they wait indefinitely with no escalation path.

This PRD covers fixes for both gaps.

---

## 2. Context

| Field        | Value |
|---|---|
| Product      | Helyx Telegram bot |
| Modules      | `bot/media.ts`, `scripts/supervisor.ts`, `channel/poller.ts` |
| User Role    | Bot user sending voice/text messages to Claude Code sessions |
| Tech Stack   | Bun + TypeScript, PostgreSQL (`message_queue` table), Telegram Bot API |

---

## 3. Problem Statement

### 3.1 Voice messages dropped on disconnected session

`handleVoice()` in `bot/media.ts` calls `routeMessage()` at message arrival time. If the route is `disconnected`, the handler exits immediately with an error reply — no transcription, no queuing. When the session restarts, the voice message is gone.

Text messages (`text-handler.ts`) behave correctly: a disconnected session with a known `session_id` queues the message and notifies the user it will be delivered on restart.

### 3.2 No timeout fallback for queued messages

`scripts/supervisor.ts › checkStuckQueue()` detects messages that remain `delivered = false` for >5 minutes, sends a Telegram alert with action buttons, and attempts `proj_start`. It does **not** forward the actual message content to any fallback channel. If the session never recovers, the content is lost to the user.

---

## 4. Goals

- G-1: Voice messages survive a session restart (transcribe → queue → deliver on reconnect).
- G-2: Messages stuck in queue for longer than a configurable threshold (default 10 min) are forwarded to a fallback Telegram channel so the user can read/re-act on them.
- G-3: Forwarding is idempotent — a message is forwarded exactly once, not on every supervisor cycle.
- G-4: Graceful degradation — if no fallback channel is configured, log a warning and skip forwarding without crashing.

---

## 5. Non-Goals

- NG-1: Changing how the supervisor alerts or restarts sessions (existing behavior preserved).
- NG-2: Automatic re-injection of forwarded messages into another session's queue (user decides what to do after reading in the fallback channel).
- NG-3: Retry logic for the transcription step itself.
- NG-4: Handling `session_id = 0` (unmapped topics) — existing error reply is correct for that case.

---

## 6. Functional Requirements

### FR-1 — Voice queuing on disconnected session

When a voice message arrives for a `disconnected` route with a known `session_id` (≠ 0):

1. Proceed with download and transcription (do not early-exit).
2. On successful transcription, insert a row into `message_queue` for that `session_id` exactly as the text handler does.
3. Reply to the user with the transcribed text + "message queued, will deliver on session restart" (same UX as text messages).
4. On transcription failure, reply with the existing error message.

The `route` object is captured before transcription (as today). The `session_id` in the route is the intended target and does not change if Felix or another session registers first.

### FR-2 — Schema: `forwarded_at` column on `message_queue`

Add a nullable `TIMESTAMPTZ` column `forwarded_at` to `message_queue`. Default `NULL`. Set to `NOW()` when a message is forwarded to the fallback channel. The supervisor's stuck-queue query excludes rows where `forwarded_at IS NOT NULL`.

### FR-3 — Supervisor forwarding step

In `checkStuckQueue()`, after the existing alert (step 5 in current flow), add step 6:

For each stuck message (`delivered = false`, `forwarded_at IS NULL`, age > threshold):

1. Resolve fallback target: `JOINBOX_TOPIC_ID` env var if set, else `SUPERVISOR_CHAT_ID` + `SUPERVISOR_TOPIC_ID`.
2. If no fallback target configured → log `[supervisor] no fallback channel configured, skipping forward` and skip.
3. Post to Telegram:
   ```
   📬 Stuck message forwarded
   Project: <project>
   Session: #<session_id>
   From: <from_user>
   ---
   <content>
   ```
4. Update `message_queue SET forwarded_at = NOW() WHERE id = <id>`.

### FR-4 — Configurable timeout

`STUCK_QUEUE_FORWARD_MINUTES` env var (integer, default `10`). The supervisor uses this threshold for forwarding. The existing 5-minute alert threshold remains unchanged.

---

## 7. Non-Functional Requirements

- NFR-1: No extra DB round-trips in the hot path (voice download/transcription). The `forwarded_at` column only adds to the supervisor background loop.
- NFR-2: The `forwarded_at` migration must be additive (no lock on large tables — the column defaults to NULL).
- NFR-3: Telegram rate limits — forwarding messages in sequence with existing retry/backoff logic used elsewhere in `supervisor.ts`.

---

## 8. Constraints

- C-1: The `route` object (including `session_id`) must be captured **before** the `enqueueForTopic` call and **must not** be re-resolved inside the async queue task (current design, must not change).
- C-2: `message_queue` `ON CONFLICT (chat_id, message_id)` unique constraint applies to voice queuing; use the Telegram `message_id` as dedup key (same as CLI text path).
- C-3: Supervisor runs as a separate process (`scripts/admin-daemon.ts`), so env vars must be available there.

---

## 9. Edge Cases

- E-1: Transcription takes long; session restarts and becomes active before transcription finishes → message arrives to an active session (no issue — poller picks it up immediately).
- E-2: Multiple messages stuck for the same session → forward each one individually; do not batch/truncate content.
- E-3: Forwarded message is later delivered (session eventually restarts after >threshold) → `delivered = true` is set normally; `forwarded_at` remains set. User sees both the forwarded notice and the session reply. Acceptable.
- E-4: `SUPERVISOR_CHAT_ID` is the same chat as the session's `chat_id` → forward anyway; the topic IDs differ.
- E-5: Voice transcription returns `null` (empty audio) → do not queue; existing error reply stands.
- E-6: `JOINBOX_TOPIC_ID` is set but `SUPERVISOR_CHAT_ID` is not → log warning and skip (cannot resolve the chat to post to).

---

## 10. Acceptance Criteria (Gherkin)

```gherkin
Feature: Voice message survives disconnected session

  Scenario: Voice arrives while session is restarting
    Given a forum topic mapped to project "hypercape"
    And the "hypercape" session status is "disconnected"
    When a user sends a voice message to that topic
    Then the bot downloads and transcribes the audio
    And inserts a row in message_queue for the "hypercape" session_id
    And replies "🎤 Transcribed: <text>\n⏳ Session restarting — will deliver on reconnect"
    When the "hypercape" session comes back online
    Then the poller delivers the queued transcription to that session

  Scenario: Voice arrives when no session is mapped (session_id = 0)
    Given a forum topic with no project mapping
    When a user sends a voice message to that topic
    Then the bot replies "⚠️ No active session for this topic"
    And does NOT attempt transcription

Feature: Stuck message forwarding

  Scenario: Message stuck beyond forward threshold
    Given a message in message_queue with delivered = false
    And created_at is 11 minutes ago (threshold = 10)
    And forwarded_at IS NULL
    And SUPERVISOR_CHAT_ID and SUPERVISOR_TOPIC_ID are set
    When checkStuckQueue runs
    Then the message content is posted to the supervisor channel
    And message_queue SET forwarded_at = NOW() for that row
    And on the next supervisor cycle the row is excluded from forwarding

  Scenario: No fallback channel configured
    Given SUPERVISOR_CHAT_ID is not set
    And a message is stuck beyond the forward threshold
    When checkStuckQueue runs
    Then no Telegram message is sent
    And a warning is logged: "[supervisor] no fallback channel configured, skipping forward"
    And forwarded_at remains NULL

  Scenario: Forwarded message later delivered
    Given a message with forwarded_at IS NOT NULL and delivered = false
    When the session restarts and the poller delivers the message
    Then delivered = true is set normally
    And forwarded_at is not changed
```

---

## 11. Verification

### Manual test plan

1. Start bot + admin-daemon with a mapped forum topic.
2. Stop the Claude Code session for that project.
3. Send a voice message to that topic — verify: transcribed text appears, "queued" notice shown.
4. Start the session — verify: message delivered to session.
5. Stop the session again. Send a text message. Wait 11 minutes (or reduce threshold via env var).
6. Verify: forwarded message appears in supervisor channel. `forwarded_at` set in DB.
7. Restart session — verify: message still delivered, no duplicate forward.

### DB verification

```sql
-- Check forwarded messages
SELECT id, session_id, content, created_at, forwarded_at, delivered
FROM message_queue
WHERE forwarded_at IS NOT NULL
ORDER BY created_at DESC;
```

### Observability

- `[supervisor] forwarded stuck message #<id> to fallback channel` — log line on success.
- `[supervisor] no fallback channel configured, skipping forward` — log line when env vars missing.
- Existing `appendLog` calls in `handleVoice` should cover voice queuing path.

---

## 12. Files to Change

| File | Change |
|---|---|
| `bot/media.ts` | Remove early-exit for `disconnected` in `handleVoice`; add queue+notify path |
| `scripts/supervisor.ts` | Add forwarding step in `checkStuckQueue`; read `STUCK_QUEUE_FORWARD_MINUTES` |
| `memory/db.ts` or migration file | Add `forwarded_at TIMESTAMPTZ` column to `message_queue` |
| `scripts/admin-daemon.ts` | Document/pass `JOINBOX_TOPIC_ID` env var |

---

## 13. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Transcription cost increase (voice processed even for dead sessions) | Low | Voice messages for truly dead sessions are rare; benefit outweighs cost |
| Forwarded content in supervisor channel is noisy if many sessions die | Medium | `forwarded_at` dedup + per-project grouping in forward message |
| DB migration on live system | Low | `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL` — non-blocking |
| Double-delivery (forwarded + session delivers) | Low | Acceptable per E-3; message in supervisor is read-only notification, not injected into another session |
