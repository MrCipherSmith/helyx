# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A snapshot of a session is built from its transcript alone, with no message queued and no turn taken, proved by test.
- AC2: The snapshot reports what was last done and how long ago, proved by test.
- AC3: The snapshot reports the live subagents and what each is doing, proved by test.
- AC4: The snapshot distinguishes waiting on a permission prompt, waiting on an open question, working, and idle, proved by test.
- AC5: A session with no transcript produces a snapshot that says so rather than an error, proved by test.
- AC6: The card is rendered by a pure function, tested directly, including the case where the model's two lines are absent.
- AC7: The local model's failure costs the two lines and nothing else — the facts still render, proved by test.
- AC8: Pressing the command again edits the same message rather than sending a new one, proved by test.
- AC9: The button that asks the session queues through `message_queue` like any message, and does not bypass the turn, proved by test.
- AC10: No test in this flow calls a model, opens a socket, or reads the operator's real `~/.claude`.
- AC11: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
