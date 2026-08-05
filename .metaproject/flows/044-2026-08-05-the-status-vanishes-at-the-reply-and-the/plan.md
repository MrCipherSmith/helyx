# Implementation Plan

Status: formalized

## Approach

### The reply stops closing the turn

`handleTelegramTool`'s `reply` case calls `deleteStatusMessage`. It will call a
narrower thing: the step is over, the turn may not be. The status stays, its
stage line switches to what the monitor last reported, and the closing summary
— the `✅ …` edit that `renderFinal` writes and the unpin beside it — happens
when the turn actually ends.

### The turn ends on silence

The monitor is the only thing that knows. An idle timer, re-armed by every
`updateStatus`, closes the status after `CONTINUATION_IDLE_MS` with no activity
at all. That is a decision about elapsed time and belongs in a pure function
next to `runResponseGuard`, so it can be stepped in a test rather than waited
out.

### A status can be re-opened

`updateStatus` currently refuses to create one. It will create a *continuation*
when three things hold: there is no open status, the activity arrived after the
last reply, and the operator has no messages waiting — the last because the
poller is about to open a fresh status for the next turn and two would fight.
That is exactly the decision `schedulePostReplyCheck` was written to make, so
that method and the comment that lies about it are deleted rather than wired up:
a timer that checks once, twenty seconds late, is a worse version of the thing
it is being replaced by.

### A continuation does not make the chat busy

`getBusyChats()` reports every chat with an open status, and the poller holds
new user messages back for those, so that each message gets its own turn. A
continuation status must not do that: it is not a turn in progress, it is the
tail of one. `StatusState` gains a flag; `getBusyChats` skips continuations.

Without this the feature would silently trade one silence for another — the
operator's own messages would sit in the queue behind a status that no longer
means what the poller thinks it means.

### The status moves to the bottom, at most once per event

Pinned already (`pinChatMessage`, silent), so it is always findable. But a
status created before a reply sits above it in the timeline, and after five
messages it is off the screen. So: when something else lands in the topic — a
reply sent, or a user message delivered — the status is re-sent at the bottom
and re-pinned, the old message deleted.

Bound to the event, never to the edit: edits run every few seconds and moving on
each would be a blizzard. One reply or one delivered message earns at most one
move.

## Steps

1. `utils/status-continuation.ts` — the pure decisions: should a status
   re-open, should it close, should it move. Tested directly.
2. `channel/status.ts` — continuation state, idle close, move-on-event,
   `getBusyChats` skipping continuations; `schedulePostReplyCheck` deleted.
3. `channel/tools.ts` — the reply ends the step, not the turn; the false
   comment removed.
4. Tests, CHANGELOG, measurement.

## Risks

- **A status that never closes.** The idle timer is the only thing that ends
  it, so its test matters more than the rest: no activity for the window closes
  it exactly once, and late activity re-opens rather than resurrects.
- **Two statuses in one chat.** The pending-message check and the generation
  counter already guard this; the tests state it as a property.
