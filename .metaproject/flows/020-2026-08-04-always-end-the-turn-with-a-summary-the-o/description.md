# Always end the turn with a summary the operator can read

Status: ready
Source: operator report with a screenshot, 2026-08-04

## Problem

A session's final message never leaves the terminal. Only what the session
explicitly sends through the `reply` tool reaches Telegram — so when a turn ends
without one, the operator gets nothing at all. The status message simply stops
on whatever line the terminal drew last, and there is no way to tell finished
from hung.

Three failures compound it, all visible in the one screenshot:

1. **No summary.** The turn ended, the status froze mid-thought, nothing else
   arrived.
2. **A false alarm followed.** The response guard announced "Claude думает уже
   5+ мин" while the session was in fact waiting for the operator to press a
   button. Silence and blocked-on-the-operator are not the same state, and the
   guard cannot currently tell them apart.
3. **The terminal's own question menu leaked into the status** — "3. Досылать +
   пометка", "Enter to select · Esc to cancel". The operator already has the
   buttons; the mirrored menu is noise that reads as garbage.

The operator's words: "непонятно где конец, на чём остановился".

## Expected Outcome

- Every turn ends with a message in the project topic. If the session did not
  send one, the bot sends the final assistant message from the transcript.
- The guard stays quiet while a question is open — that is not silence.
- The interactive prompt does not appear in the status pane.

## Out of Scope

- Changing what the session chooses to write. This is about delivery, not
  content.
- The voice rendering, which the operator asked to leave alone.
- Any change to keryx.
