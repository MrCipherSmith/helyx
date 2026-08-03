# Cover the supervisor's guard loops, and stop tests from being able to reach the network

Status: formalized
Source: user description

## Problem

`scripts/supervisor.ts` is 1391 lines with 1075 of them uncovered — the largest
single block left, and the one that has broken twice in the last week. It is
also the code that acts on its own: it restarts sessions, re-injects messages
into the queue and sends alerts to a real chat. Everything it does, it does
without anyone watching.

Step 2 built the fixtures that make its database and its status manager
testable. One thing is still missing, and it is not a convenience: **the
supervisor talks to Telegram through bare `fetch`, and `BOT_TOKEN` and
`SUPERVISOR_CHAT_ID` are read from the environment at import.** `.env` is
loaded automatically in tests. So the first test to call one of these loops
without precautions posts to the real bot, in the real supervisor chat.

That is not a hypothetical waiting to happen — it is what the next honest test
does by default. And the pattern of guarding against it by hand already exists
for the third time in this repository: `tests/unit/provider-service.test.ts`
swaps `globalThis.fetch` and swaps it back, exactly as `skill-handlers.test.ts`
kept its own `FakeSql` and `jsonb-cast` kept its own `DATABASE_URL` check.

## Expected Outcome

### A test cannot reach the network by accident

`tests/fixtures/fake-fetch.ts` — a recording `fetch` with programmable
responses, and a request that matches nothing fails loudly naming the URL rather
than being quietly allowed through.

The preload installs a guard: any `fetch` a test has not explicitly faked
throws, with a message saying which URL was attempted and how to fake it. The
existing hand-rolled swap in `provider-service.test.ts` moves onto the fixture.

The reasoning is the same as step 2's for the database. A test that reaches a
real service is not a slightly worse test; it is an action taken by something
nobody is watching, and it can be a message in a real chat.

### The three guard loops that act, covered

By what they do rather than by line count:

- **Loop 7, `checkUnansweredMessages`** — the guard that re-injects a lost
  message into the queue. This is the mechanism behind the incident recorded in
  memory as a reply being lost when the guard fired, and it has never had a
  test. Its interesting behaviour is not the query; it is the order of the
  three decisions after it: the dedup window, the 🔥 reaction, and the refusal
  to re-queue something already marked as re-queued.

- **Loop 1, `checkHungSessions`** — decides a session is hung and offers a
  restart button. It has a second path nobody has ever exercised: when another
  loop has already alerted, it edits that alert instead of sending a new one.

- **Loop 2, `checkStuckQueue`** — the other half of the same story.

Each is currently wrapped in `catch (err) { console.error(...) }`, which
swallows everything. So the tests have to assert what was *done* — the row
inserted, the request posted, the incident logged — because "it did not throw"
is satisfied by a function that did nothing at all.

### Exported for testing, and honest about it

These are module-private. They already take `sql` and an optional `RunShell`,
which is the injectable design; what is missing is only the export. No
behaviour changes.

## Out of Scope

- `checkIdleSessions`, `checkGemmaHealth`, `collectSystemSnapshot`,
  `sendStatusBroadcast`. They are real work and they are the next flow —
  `sendStatusBroadcast` in particular already has its decisions extracted into
  `utils/supervisor-status.ts` and tested there, so the remaining uncovered part
  is the assembly.
- `memory/db.ts` and `claude/client.ts`, the second and third items of step 3.
- Fixing anything the tests reveal about behaviour, unless it is a defect rather
  than a design choice. Where the current behaviour is surprising but
  deliberate, the test records it and the journal says so.
