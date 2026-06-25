# PRD (AI-readable): Message Delivery Resilience

## FEATURE_ID: MDR-001
## STATUS: Draft
## CREATED: 2026-06-25

---

## PROBLEM_SCOPE

```yaml
affected_files:
  - bot/media.ts:195-220          # handleVoice — early-exit on disconnected
  - scripts/supervisor.ts:390-452  # checkStuckQueue — no forward step
  - memory/db.ts                   # message_queue table definition

current_behavior:
  voice_disconnected:
    - routeMessage() returns mode=disconnected
    - handleVoice exits at line ~214: no transcription, no queuing
    - User gets error reply
    - Voice content: LOST

  text_disconnected:
    - text-handler.ts line ~94: queues to message_queue[session_id]
    - User gets "queued, will deliver" notice
    - Delivered when session reconnects via channel/poller.ts

  stuck_queue_supervisor:
    - checkStuckQueue() fires on schedule
    - Detects delivered=false AND created_at < NOW() - '5 minutes'
    - Action: proj_start attempt → alert with buttons
    - Message CONTENT: never forwarded anywhere

desired_behavior:
  voice_disconnected:
    - Transcribe audio
    - Queue transcribed text to message_queue[session_id] 
    - User gets "transcribed + queued" notice
    - Deliver when session reconnects (same as text path)

  stuck_queue_supervisor:
    - After existing alert step: forward content to fallback channel
    - Fallback channel: JOINBOX_TOPIC_ID (preferred) OR SUPERVISOR_CHAT_ID+SUPERVISOR_TOPIC_ID
    - Idempotent: track with forwarded_at timestamp on message_queue row
    - Configurable threshold: STUCK_QUEUE_FORWARD_MINUTES (default: 10)
```

---

## SCHEMA_CHANGES

```sql
-- Migration: add forwarded_at column
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ DEFAULT NULL;

-- Index for supervisor query (optional but recommended)
CREATE INDEX IF NOT EXISTS idx_message_queue_forward_candidates
  ON message_queue (session_id, created_at)
  WHERE delivered = false AND forwarded_at IS NULL;
```

---

## IMPLEMENTATION_SPEC

### CHANGE-1: bot/media.ts — handleVoice

```
LOCATION: handleVoice(), after route resolution

REMOVE (lines ~213-221):
  if (route.mode === "disconnected") {
    await replyInThread(ctx, "⚠️ Нет активной CLI-сессии...");
    return;
  }

ADD instead:
  if (route.mode === "disconnected" && route.sessionId === 0) {
    // No mapped session — can't queue
    await replyInThread(ctx, "⚠️ Нет активной сессии для этого топика.\n...");
    return;
  }
  // If disconnected with known session_id: continue to transcribe and queue

LOCATION: Inside enqueueForTopic callback, after successful transcription (line ~312)

CHANGE: route.mode === "cli" check → also handle disconnected path
  if (route.mode === "cli" || route.mode === "disconnected") {
    // same queue insertion code
    // for disconnected: update statusMsg to "queued for delivery on restart"
  }

STATUS_MESSAGE_for_disconnected:
  "🎤 Transcribed: {text}\n⏳ Сессия {sessionName} перезапускается — доставлю автоматически."
```

### CHANGE-2: scripts/supervisor.ts — checkStuckQueue

```
LOCATION: checkStuckQueue(), after sendAlertWithButtons()

ADD forwarding step:
  ENV_VARS_USED:
    - STUCK_QUEUE_FORWARD_MINUTES (int, default 10)
    - JOINBOX_TOPIC_ID (optional, preferred fallback topic)
    - SUPERVISOR_CHAT_ID (existing)
    - SUPERVISOR_TOPIC_ID (existing, fallback if no JOINBOX_TOPIC_ID)

  QUERY_for_forward_candidates:
    SELECT mq.id, mq.session_id, mq.chat_id, mq.from_user, mq.content, s.project
    FROM message_queue mq
    JOIN sessions s ON s.id = mq.session_id
    WHERE mq.delivered = false
      AND mq.forwarded_at IS NULL
      AND mq.created_at < NOW() - make_interval(mins => STUCK_QUEUE_FORWARD_MINUTES)

  FOR EACH row:
    1. resolve_fallback():
         if JOINBOX_TOPIC_ID set AND SUPERVISOR_CHAT_ID set → {chat: SUPERVISOR_CHAT_ID, topic: JOINBOX_TOPIC_ID}
         elif SUPERVISOR_CHAT_ID set AND SUPERVISOR_TOPIC_ID set → {chat: SUPERVISOR_CHAT_ID, topic: SUPERVISOR_TOPIC_ID}
         else → null (log warning, skip)
    
    2. if fallback resolved:
         text = format_forward_message(row)
         await tgPost("sendMessage", { chat_id, message_thread_id, text, parse_mode: "HTML" })
         await sql`UPDATE message_queue SET forwarded_at = NOW() WHERE id = ${row.id}`
         log("[supervisor] forwarded stuck message #${id} to fallback channel")

  FORWARD_MESSAGE_FORMAT:
    📬 <b>Stuck message forwarded</b>
    Project: <code>{project}</code>
    Session: #<code>{session_id}</code>
    From: {from_user}
    Queued: {age_minutes}m ago
    ———
    {content}
```

### CHANGE-3: memory/db.ts or migration

```
ADD: ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS forwarded_at TIMESTAMPTZ DEFAULT NULL;
```

---

## INVARIANTS

```yaml
- session_id_immutable_in_voice_task: >
    route.sessionId captured before enqueueForTopic() must NOT be re-resolved
    inside the async task. This is already the architecture; must not change.

- forwarded_at_set_once: >
    supervisor query always filters forwarded_at IS NULL.
    Once set, forwarded_at is never reset.

- delivered_takes_priority: >
    If a message is delivered (delivered=true), it is excluded from
    stuck-queue detection entirely. No need to check forwarded_at there.

- session_id_zero_early_exit: >
    voice messages for session_id=0 routes must still early-exit
    (no project mapping, nothing to queue for).
```

---

## ACCEPTANCE_CRITERIA (machine-parseable Gherkin)

```gherkin
@MDR-001-voice
Feature: Voice message resilience on disconnected session

  @happy-path
  Scenario: Voice queued when session is disconnected
    Given session "hypercape" with status "disconnected" and known session_id
    And forum topic mapped to "hypercape"
    When user sends voice to that topic
    Then bot calls transcribe(audioData)
    And inserts row: message_queue{session_id=hypercape_id, delivered=false}
    And replies with text containing "Transcribed" AND "перезапускается"
    When session "hypercape" status changes to "active"
    Then poller delivers the queued row

  @edge-case
  Scenario: Voice for unmapped topic (session_id=0)
    Given forum topic with no project mapping (session_id=0)
    When user sends voice
    Then bot replies error WITHOUT calling transcribe()
    And NO row inserted in message_queue

  @edge-case
  Scenario: Voice transcription returns null
    Given session is disconnected with known session_id
    When user sends voice AND transcription returns null
    Then NO row inserted in message_queue
    And bot replies transcription error

@MDR-001-forward
Feature: Stuck message forwarding to fallback channel

  @happy-path
  Scenario: Forward after threshold with fallback configured
    Given message_queue row: delivered=false, forwarded_at=NULL, age=11min
    And STUCK_QUEUE_FORWARD_MINUTES=10
    And SUPERVISOR_CHAT_ID and SUPERVISOR_TOPIC_ID set
    When checkStuckQueue() executes
    Then tgPost("sendMessage") called with content of the row
    And UPDATE message_queue SET forwarded_at=<timestamp> WHERE id=<id>
    And next checkStuckQueue() cycle does NOT re-forward this row

  @happy-path
  Scenario: Prefer JOINBOX_TOPIC_ID when set
    Given SUPERVISOR_CHAT_ID set AND JOINBOX_TOPIC_ID set
    When checkStuckQueue() forwards a message
    Then message_thread_id in tgPost = JOINBOX_TOPIC_ID

  @edge-case
  Scenario: No fallback configured
    Given SUPERVISOR_CHAT_ID is not set
    When checkStuckQueue() finds stuck messages past threshold
    Then tgPost NOT called
    And log contains "[supervisor] no fallback channel configured, skipping forward"
    And forwarded_at remains NULL

  @edge-case
  Scenario: Message delivered after forwarding (late recovery)
    Given message with forwarded_at IS NOT NULL and delivered=false
    When session restarts and poller marks delivered=true
    Then delivered=true is set
    And forwarded_at unchanged (not reset)
    And no duplicate forward occurs
```

---

## ENV_VARS_REFERENCE

```yaml
STUCK_QUEUE_FORWARD_MINUTES:
  type: integer
  default: 10
  used_by: scripts/supervisor.ts
  description: Minutes after which stuck messages are forwarded to fallback channel

JOINBOX_TOPIC_ID:
  type: integer (Telegram thread/topic id)
  default: null
  used_by: scripts/supervisor.ts, scripts/admin-daemon.ts
  description: Preferred fallback topic for forwarded stuck messages.
               If set, used instead of SUPERVISOR_TOPIC_ID for forwards.
               Requires SUPERVISOR_CHAT_ID to be set for the chat reference.

SUPERVISOR_CHAT_ID:
  type: string (Telegram chat id)
  existing: true
  used_by: scripts/admin-daemon.ts, scripts/supervisor.ts

SUPERVISOR_TOPIC_ID:
  type: integer
  existing: true
  used_by: scripts/admin-daemon.ts, scripts/supervisor.ts
```
