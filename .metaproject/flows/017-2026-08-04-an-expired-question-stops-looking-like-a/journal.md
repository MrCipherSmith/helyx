# Flow Journal

- 2026-08-04T07:29:40.155Z - flow created
- 2026-08-04T07:29:40.371Z - task-added: T5: expireRequest with the keyboard removed
- 2026-08-04T07:29:40.596Z - task-added: T6: wire every wait-ending path to it
- 2026-08-04T07:29:40.845Z - task-added: T7: tests
- 2026-08-04T07:29:41.075Z - frozen: 5 criteria; checksum recorded
- 2026-08-04T07:29:41.295Z - started

## What happened

The timestamps told the story, and they told a different one than I expected.

The tool call was rejected at 16:14:46. The request row was created at 16:15:03
— seventeen seconds *later*. The hook had already been launched, and it went on
to post three questions to a chat whose session was no longer waiting for them.
Then it waited out its full nine and a half minutes.

So the disconnect handling added in flow 012 was not broken. It never fired,
because the client never disconnected: Claude Code abandoned the tool call and
left the hook process running. There is no signal to listen for. A running hook
cannot learn that its work has become moot.

That reframes the fix. The root cause is not reachable from here, so what is
left is the consequence: three messages with live-looking buttons that nobody is
waiting on. Now they say so — the keyboard comes off and the message gains a
line — at the moment the wait ends rather than at the moment someone taps.

Recorded as open, honestly: detecting abandonment would need a signal Claude
Code does not send, or a poll of session tool state that does not exist.

### One thing the tests made me get right

`expireRequest` claims the row before editing anything, and does nothing if the
claim comes back empty. Without that, a question answered a moment earlier would
have its message rewritten to say it expired — turning a correct answer into a
visible lie, which is worse than the stale button it was meant to fix.
- 2026-08-04T07:30:09.126Z - task-done: T1: Collect remaining context
- 2026-08-04T07:30:09.337Z - task-done: T2: Implement per plan
- 2026-08-04T07:30:09.549Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-04T07:30:09.765Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-04T07:30:09.966Z - task-done: T5: expireRequest with the keyboard removed
- 2026-08-04T07:30:10.175Z - task-done: T6: wire every wait-ending path to it
- 2026-08-04T07:30:10.382Z - task-done: T7: tests
- 2026-08-04T07:30:10.589Z - ac-confirmed: AC1: claims with RETURNING, edits every placed message, empty keyboard plus a line
- 2026-08-04T07:30:10.785Z - ac-confirmed: AC2: an empty claim edits nothing — rewriting an answered question to expired would be a visible lie
- 2026-08-04T07:30:11.004Z - ac-confirmed: AC3: timeout, mid-wait clientGone, and registration-time clientGone all route through expireRequest
- 2026-08-04T07:30:11.228Z - ac-confirmed: AC4: reply_markup asserted to be an empty inline_keyboard
- 2026-08-04T07:30:11.442Z - ac-confirmed: AC5: typecheck clean, lint 0 errors, 983 tests, dupes 2 documented

## Review: the same complaint, one step earlier

**A partial delivery left live buttons too.** If the second of three sends
failed, the request was *deleted* — and the first question was already on the
operator's screen with a working keyboard and no row behind it. Tapping it found
nothing. That is precisely the state this flow exists to remove, moved one step
earlier and missed because the test asserted only that the delete happened.

Two changes. Message ids are recorded as each one lands rather than once at the
end, so the cleanup can find a message that is already on screen. And the
partial-delivery path expires rather than deletes, which routes it through the
same keyboard-retirement everything else uses.

**A failed edit was swallowed, permanently.** The row is claimed before the edits
run, so a Telegram refusal — which the helper returns rather than throws — left
the keyboard live with no second chance and nothing said anywhere. Edits now
report their result, are retried once, and a persistent failure is logged
naming the message. Logging is not a repair; a keyboard that stays live *and*
says nothing is strictly worse than one that stays live and is recorded.

The reviewer also confirmed what the guard already did right: an answered
request cannot be rewritten as expired, because both writes require the other
column to be null.

Tests 983 → 987.

### And the id write itself could fail

Recording each message id was written with `.catch(() => {})`. If a send landed
and its id write failed, the message sat on the operator's screen with a live
keyboard that *nothing stored could find again* — every later cleanup would look
at the row, see no id, and leave it there for good.

Two changes. The write returns the row it updated, so a failure is visible
rather than assumed; and when it fails, the call is withdrawn using the ids this
function still holds in memory, handed to `expireRequest` directly. Tested by
failing the write and asserting the keyboard came down anyway.

The test that "counts persistence attempts" was fair criticism: counting two
writes proves nothing about what happens when one of them does not land.

Tests 987 → 991.
- 2026-08-04T07:44:48.631Z - ac-confirmed: AC1: claims with RETURNING; edits every message, keyboard removed, retried once, persistent failure logged
- 2026-08-04T07:44:48.721Z - ac-confirmed: AC3: timeout, mid-wait, registration-time, partial delivery, and a failed id write all route through expireRequest
- 2026-08-04T07:44:48.811Z - ac-confirmed: AC5: typecheck clean, lint 0 errors, 988 tests, dupes 2 documented
