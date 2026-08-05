# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A send that requests `message_thread_id` and receives a result without it, or with a different one, logs at error level naming the requested thread and where the message landed; proved by a test driving the real `sendTelegramMessage` against a stubbed transport.
- AC2: A send whose requested thread is echoed back logs nothing, and a send that requested no thread logs nothing; both proved by test.
- AC3: A response carrying no `message_id` (a method such as `deleteMessage`, whose result is `true`) is never reported as a thread miss; proved by test.
- AC4: The send still reports success when Telegram answered `ok`, so no caller resends a delivered message; asserted in the same tests.
- AC5: `validateTopicExists` returns `false` for a topic id whose send comes back without the thread, and `true` when the thread is echoed; proved by tests driving the real method with a recording `Api` double.
- AC6: `validateTopicExists` deletes its probe in both outcomes, including when the probe landed in General; proved by test.
- AC7: An explicit `message thread not found` error yields `false` with nothing to clean up, and an unrelated failure (rate limit) yields `true`, so `/forum_clean` cannot erase a live mapping on a transient error; proved by tests.
- AC8: Whole unit suite green and `tsc --noEmit` clean.
- AC9: The change is recorded in `CHANGELOG.md` under Unreleased.
- AC10: Every reviewer round on the draft PR ends with no unresolved finding.
