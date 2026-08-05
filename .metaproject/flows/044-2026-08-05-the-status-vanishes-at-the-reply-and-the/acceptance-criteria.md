# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Sending a reply no longer deletes the status message; the status survives the reply while the session is still active.
- AC2: Activity arriving after a reply re-opens a status when none is open, proved by test.
- AC3: A status is not re-opened when the operator has undelivered messages waiting, proved by test.
- AC4: The status closes after a defined idle window with no activity, and the closing is the existing summary-and-unpin, proved by test.
- AC5: Activity after the close re-opens a new status rather than editing the closed one, proved by test.
- AC6: `getBusyChats()` does not report a chat whose only status is a continuation, proved by test.
- AC7: The status moves to the bottom of the topic when a reply or a delivered user message lands after it, at most once per such event and never per edit, proved by test.
- AC8: `schedulePostReplyCheck` and the comment in `channel/tools.ts` that promises it are removed, and no reference to either remains.
- AC9: The decisions — re-open, close, move — live in a pure module and are tested directly rather than through timers.
- AC10: No test in this flow sends a Telegram message, opens a socket, or waits out a real idle window.
- AC11: Whole unit suite green, `tsc --noEmit` clean, and the change recorded in `CHANGELOG.md`.
- AC12: Every reviewer round on the draft PR ends with no unresolved finding in the files this flow changes.
