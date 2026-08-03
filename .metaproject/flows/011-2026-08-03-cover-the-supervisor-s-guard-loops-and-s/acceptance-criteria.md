# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `tests/fixtures/fake-fetch.ts` exports a recording `fetch` that captures method, URL, headers and parsed JSON body for every request, in call order, and returns responses programmed by URL pattern.
- AC2: A request matching no programmed pattern fails with an error naming the URL and the method, rather than returning a default response — a test that reaches an unexpected endpoint must find out.
- AC3: The preload installs a network guard: with no fake installed, any `fetch` throws an error naming the URL attempted and how to install one. A test asserts this by attempting a request and catching it.
- AC4: `bun test` is green with the guard in place, and no test in the suite performs a real network request — verified by running the whole suite with the guard active, not by inspection.
- AC5: `tests/unit/provider-service.test.ts` uses the shared fixture instead of swapping `globalThis.fetch` by hand; the hand-rolled swap and its restore are gone.
- AC6: `checkUnansweredMessages`, `checkHungSessions` and `checkStuckQueue` are exported from `scripts/supervisor.ts` with no change to their behaviour or signatures.
- AC7: A test drives `checkUnansweredMessages` over a message that qualifies and asserts the re-injected row: it lands in `message_queue` with `delivered = false`, carries the original `telegram_msg_id`, and its content is marked as re-queued.
- AC8: A test asserts the 🔥 reaction is set on the original Telegram message before the re-queue decision is taken — including for a message that is then left alone, which is the current behaviour and is asserted as such.
- AC9: A test asserts a message already marked as re-queued is not re-queued again, and that no row is inserted for it — the loop between the channel's guard and this one.
- AC10: A test asserts the dedup window: a second call within it does nothing at all, and the window is consumed even when the insert fails, so a transient database error means no retry until it expires. This is the current behaviour; the journal records whether it is intended.
- AC11: A test drives `checkHungSessions` over a stale session and asserts what was sent — an alert carrying the project, the elapsed time and a restart button whose callback data matches `restartCallbackData` — and that an incident row was logged.
- AC12: A test asserts the already-alerted path: when the dedup key is held, no new alert is sent and the existing message is edited instead. This path has never been exercised.
- AC13: A test asserts `checkHungSessions` reports the spinner state from the captured pane, and that with no `RunShell` it still alerts rather than skipping the session.
- AC14: A test drives `checkStuckQueue` and asserts what it sends and logs for a stuck item, and that it does nothing when the queue is healthy.
- AC15: Every assertion above is about an effect — a row, a request, an incident — not about the absence of a throw. Verified by mutation: emptying the body of each loop under test makes its tests fail.
- AC16: `bun run typecheck`, `bun run lint` and `bun test` pass; `bun run dupes` still reports exactly 1; coverage of `scripts/supervisor.ts` is measurably higher than the 1075 uncovered lines it starts from, and the number is recorded in the journal.
