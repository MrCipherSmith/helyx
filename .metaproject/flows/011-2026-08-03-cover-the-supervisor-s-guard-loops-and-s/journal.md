# Flow Journal

- 2026-08-03T13:18:28.764Z - flow created
- 2026-08-03T13:20:27.276Z - task-added: T5: fake-fetch.ts: recording fetch, programmed by URL, unmatched throws naming the URL
- 2026-08-03T13:20:27.363Z - task-added: T6: preload: network guard — any unfaked fetch throws
- 2026-08-03T13:20:27.448Z - task-added: T7: rewire provider-service.test.ts off its hand-rolled globalThis.fetch swap
- 2026-08-03T13:20:27.531Z - task-added: T8: export checkUnansweredMessages, checkHungSessions, checkStuckQueue — signatures untouched
- 2026-08-03T13:20:27.614Z - task-added: T9: supervisor-unanswered.test.ts: re-injected row, reaction, already-requeued refusal, dedup window
- 2026-08-03T13:20:27.700Z - task-added: T10: supervisor-hung.test.ts: alert and buttons, incident row, already-alerted edit path, spinner, no-RunShell
- 2026-08-03T13:20:27.784Z - task-added: T11: supervisor-queue.test.ts: stuck item alert and log, silence on a healthy queue
- 2026-08-03T13:20:27.874Z - task-added: T12: VERIFY nothing in the suite reaches the network, by the guard's counter
- 2026-08-03T13:20:27.960Z - task-added: T13: VERIFY the tests assert effects: empty each loop body and confirm its tests fail
- 2026-08-03T13:20:28.041Z - task-added: T14: full gate: typecheck, lint, test, dupes=1, health, supervisor uncovered-lines before/after
- 2026-08-03T13:20:40.246Z - frozen: 16 criteria; checksum recorded
- 2026-08-03T13:20:40.334Z - started

## What happened

### The network was reachable from tests, and that was the default

`scripts/supervisor.ts` reads `TELEGRAM_BOT_TOKEN` and `SUPERVISOR_CHAT_ID` at
import, `.env` is loaded automatically under `bun test`, and its alert helpers
call `fetch` directly. Nothing was wrong with the existing suite — it simply had
never called one of these loops. The first honest test would have posted to the
real bot, in the real supervisor chat, on the first run.

So the guard came first, before a single supervisor test existed. `fetch` now
throws unless a test installs a fake, and the run's supervisor credentials are
replaced with fake ones in the preload — where they have to be set, since the
constants bind at import. Two effects: a test can assert what an alert would
have contained, and anything that ever slipped past the guard would carry a
token that authenticates as nobody.

The whole suite stayed green with the guard installed, which is the proof: any
real network call would have thrown.

### Three fixture defects, all found by real callers

**The guard threw synchronously where `fetch` rejects.** Code written against
`fetch` handles failure through the returned promise — the supervisor's own
`tgPost(...).catch(() => {})` does exactly that. A synchronous throw would crash
callers that are in fact prepared for a network failure. Same class of defect as
the eager-vs-lazy `FakeSql` from flow 010: the fake was not the thing it stood
in for.

**A query match was too broad.** `checkStuckQueue` ends by calling
`forwardStuckMessages`, which also selects from `message_queue`. Programming the
fake on the table name handed it the stuck rows, it forwarded them, and five
tests ended up asserting against the forwarding message instead of the alert.
Matching on `COUNT(*) AS stuck_count` fixed it. Worth remembering as a rule: a
fake matched on a table name answers every query against that table.

**A test used a spinner glyph the detector does not accept.** `isSpinnerLine`
matches `·✶✻`, not the braille frames. The test was wrong, not the code — but it
had been passing its own idea of a spinner to a function with a stricter one.

### What the tests pin that nobody had written down

- The re-injected row must be `delivered = false` — a literal in the statement,
  not a parameter — or the queue reader skips it and the message stays lost.
- The 🔥 reaction is set *before* the already-re-queued check, so an unanswered
  retry is re-marked once per dedup window. Harmless; recorded so that
  reordering those two blocks is a decision rather than an accident.
- The dedup entry is written before the insert is attempted, so a transient
  database error costs the message its whole window with no retry. Current
  behaviour, asserted as such. Whether it is right is a separate question, and
  the point of the test is that changing it has to be deliberate.
- `forceDeliverCallbackData` is keyed by session while `restartCallbackData`
  beside it is keyed by project. Two ids, two meanings, one keyboard — and the
  source still carries the comment from when they were mixed up.

### A false alarm, checked rather than reported

`checkStuckQueue` passes a session id to `ackCallbackData` where
`checkHungSessions` passes a project id. It looked like the same class of bug as
the restart-button incident. It is not: `parseSupervisorCallback` discards the
trailing id for `ack` and the handler only uses the key. Nothing to fix.

### The mutation check

Each loop is wrapped in `catch (err) { console.error(...) }`, so a test that
only checks "it did not throw" passes against a function that does nothing.
Emptying each body in turn: unanswered 8 of 11 fail, hung 7 of 9, queue 6 of 7.
The survivors are the "nothing to do" tests, which an empty function also
satisfies — correctly.

### Numbers

`scripts/supervisor.ts`: 5.55% → **32.07%** of lines, 7.69% → **54.55%** of
functions. Project coverage 19.6% → **25.72%**. Tests 759 → 791. Health 63 → 64.
`bun run dupes` still 1.
- 2026-08-03T13:28:24.271Z - task-done: T1: Collect remaining context
- 2026-08-03T13:28:24.353Z - task-done: T2: Implement per plan
- 2026-08-03T13:28:24.440Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T13:28:24.528Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T13:28:24.610Z - task-done: T5: fake-fetch.ts: recording fetch, programmed by URL, unmatched throws naming the URL
- 2026-08-03T13:28:24.697Z - task-done: T6: preload: network guard — any unfaked fetch throws
- 2026-08-03T13:28:24.789Z - task-done: T7: rewire provider-service.test.ts off its hand-rolled globalThis.fetch swap
- 2026-08-03T13:28:24.875Z - task-done: T8: export checkUnansweredMessages, checkHungSessions, checkStuckQueue — signatures untouched
- 2026-08-03T13:28:24.960Z - task-done: T9: supervisor-unanswered.test.ts: re-injected row, reaction, already-requeued refusal, dedup window
- 2026-08-03T13:28:25.041Z - task-done: T10: supervisor-hung.test.ts: alert and buttons, incident row, already-alerted edit path, spinner, no-RunShell
- 2026-08-03T13:28:25.127Z - task-done: T11: supervisor-queue.test.ts: stuck item alert and log, silence on a healthy queue
- 2026-08-03T13:28:25.212Z - task-done: T12: VERIFY nothing in the suite reaches the network, by the guard's counter
- 2026-08-03T13:28:25.297Z - task-done: T13: VERIFY the tests assert effects: empty each loop body and confirm its tests fail
- 2026-08-03T13:28:25.381Z - task-done: T14: full gate: typecheck, lint, test, dupes=1, health, supervisor uncovered-lines before/after
- 2026-08-03T13:28:38.882Z - ac-confirmed: AC1: tests/fixtures/fake-fetch.ts: requests[] records method/url/headers/parsed JSON body; program() by URL pattern, same match replaces
- 2026-08-03T13:28:38.968Z - ac-confirmed: AC2: unmatched request rejects naming method and URL; asserted in fixtures.test.ts and still recorded so the test can see the attempt
- 2026-08-03T13:28:39.049Z - ac-confirmed: AC3: preload calls installNetworkGuard(); fixtures.test.ts asserts the rejection names the URL and installFakeFetch
- 2026-08-03T13:28:39.138Z - ac-confirmed: AC4: whole suite green with the guard active — 791 pass 0 fail; any real fetch would have rejected
- 2026-08-03T13:28:39.225Z - ac-confirmed: AC5: provider-service.test.ts uses installFakeFetch; the globalThis.fetch swap and its restore are gone
- 2026-08-03T13:28:39.311Z - ac-confirmed: AC6: checkUnansweredMessages, checkHungSessions, checkStuckQueue exported; signatures and bodies unchanged
- 2026-08-03T13:28:39.397Z - ac-confirmed: AC7: re-injected row asserted: session/chat/from_user/content marked, telegram_msg_id carried, delivered false in the statement text
- 2026-08-03T13:28:39.482Z - ac-confirmed: AC8: reaction asserted on chat_id + message_id + emoji, and asserted still set for an already-requeued message — current order
- 2026-08-03T13:28:39.570Z - ac-confirmed: AC9: already-requeued message inserts nothing and sends no alert
- 2026-08-03T13:28:39.652Z - ac-confirmed: AC10: second sweep inside the window does nothing; a failing insert consumes the window and the next sweep inserts nothing
- 2026-08-03T13:28:39.737Z - ac-confirmed: AC11: alert asserts project, path, elapsed; payloads compared against restartCallbackData/paneCallbackData/ackCallbackData; incident row asserted
- 2026-08-03T13:28:39.826Z - ac-confirmed: AC12: already-alerted path: one send total, editMessageText carries the original message_id and appends
- 2026-08-03T13:28:39.913Z - ac-confirmed: AC13: spinner reported and the restart button warns; with no RunShell the session is still alerted, without the pane block
- 2026-08-03T13:28:39.999Z - ac-confirmed: AC14: stuck alert asserts count, wait, preview, pane, force-deliver by session and restart by project; healthy queue sends nothing
- 2026-08-03T13:28:40.088Z - ac-confirmed: AC15: mutation: emptying each loop body fails 8/11, 7/9 and 6/7 of its tests; survivors are the do-nothing cases
- 2026-08-03T13:28:40.179Z - ac-confirmed: AC16: typecheck clean, lint 0 errors, 791 pass, dupes 1, supervisor 5.55% to 32.07% lines and 7.69% to 54.55% funcs, health 64

## Review: a real production bug, and three tests that were not tests

### The alert about a lost message could not be delivered

Operator text went into `parse_mode: "HTML"` sends without escaping, in three
places — the stuck-queue preview, the unanswered-message preview, and the
forwarded message, which pastes the content whole rather than a preview. One
`<` and Telegram rejects the send; `sendAlert` and `tgPost` both swallow the
failure. So the loop whose entire job is to say a message was lost is the one
that goes silent when the lost message contains an angle bracket. `почему <div>
не рендерится` is enough.

The review found two of the three. The third — the forward — was found while
writing the test for the other two, and is the worst of them: it is the
last-resort delivery for a message nothing else managed to deliver.

Mutation-checked: putting the raw interpolations back fails four tests.

### The tests passed twice only by accident

`bun test --rerun-each=2` gave 33 passed, 21 failed. The supervisor keeps its
dedup state in module-level maps; a test file's own counter resets when the file
is re-evaluated, but the supervisor module stays cached and remembers every
project it has already alerted about. A shortened timestamp made it worse — two
runs a few milliseconds apart produced overlapping session ids.

Fixed with `tests/fixtures/unique.ts` and full-precision ids. The whole suite now
runs twice: 1602 passed, 0 failed.

That also exposed a pre-existing one: the jsonb idempotency test asserted the
row it inserted was *first* among the matches, which is true only on a database
nobody has run it against before.

### The fake fetch was not fetch

`fetch` accepts a URL, a `Request`, or both — and only the first puts the
method, headers and body in `init`. Reading `init` alone recorded a fully-formed
POST `Request` as a GET with no headers and no body. Now normalised through
`new Request(input, init)`, with the body read from a clone, an already-aborted
signal honoured, and `lastIndex` reset before a regex match so a `/g` pattern
does not alternate between matching and missing on identical requests.

### Taken, and deferred with a reason

Added a forwarding-candidate case: every other queue test programmed that query
empty, so deleting the `forwardStuckMessages(sql)` call left them all green.

Not taken here: the review is right that `FakeSql` returns programmed rows
without evaluating SQL predicates, so the qualification queries themselves —
age windows, assistant-reply exclusion, fresh-status exclusion — are not pinned.
That needs seeded fixtures on the real database, which exists since flow 010,
and it is the next supervisor flow rather than a patch on this one.

Tests 791 → 801.
