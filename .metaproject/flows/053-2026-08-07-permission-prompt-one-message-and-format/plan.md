# Implementation Plan

Status: ready

## Approach

Compose the prompt as one HTML message and keep the two-message split as the
fallback for oversized content, rather than always splitting. Telegram accepts
an inline keyboard on a message containing a `<pre>` block, so nothing about the
buttons has to change.

Rebuild the post-tap text from the database row instead of reading it back off
the message. `permission_requests` already stores what the prompt was rendered
from, so the edit does not need the message to be its own source of truth — and
a rebuilt text can carry `parse_mode: HTML`, which is what the current path
cannot do.

Rejected: keeping two messages and editing both on tap. It doubles the API
calls on every answer, leaves the ordering visible to the operator, and does
nothing about the formatting loss.

Rejected: sending the diff as a document or photo. Unreadable inline, and a
picture of a diff cannot be copied.

## Steps

1. Extract the keyboard into one exported helper so `channel/permissions.ts`
   and `scripts/tmux-watchdog.ts` stop carrying separate copies.
2. Add a renderer that composes header + tool line + fenced change into one
   HTML string, shortening the path to its last two segments, and reports
   whether the result fits Telegram's 4096-character limit.
3. `channel/permissions.ts`: send the single message when it fits; fall back to
   the existing preview-then-prompt pair when it does not.
4. Persist what the prompt was rendered from, so the tap handler can rebuild it.
5. `bot/callbacks.ts`: rebuild the edited text from the stored fields, send it
   with `parse_mode: HTML`, and keep the outcome prefixes (`✅ Allowed`,
   `✅ Always allowed: <tool>`, `❌ Denied`).
6. Unit tests for the renderer, the size fallback, and the rebuilt edit.

## Risks

- Editing with HTML fails if the stored text is not escaped consistently.
  Mitigated by escaping in one place, in the renderer, and testing the edit
  path against a payload containing `<`, `&` and a fenced block.
- Old pending requests created before this change have no stored render fields.
  The tap handler must fall back to the current behaviour for them rather than
  throwing.
