# Implementation Plan

Status: formalized

## Approach

The network guard first, before a single supervisor test exists. The order is
not a preference: `BOT_TOKEN` and `SUPERVISOR_CHAT_ID` come from `.env`, so the
first test written against these loops without a guard posts to the real bot in
the real supervisor chat. Writing the tests first and adding the guard after
would mean running exactly the request the guard exists to prevent.

Then export, then cover — highest-consequence loop first, so that if the flow
has to stop early the thing left untested is the least dangerous.

Every verification below is a task. Prose in a plan blocks nothing.

## Steps

1. `tests/fixtures/fake-fetch.ts` — recording `fetch`, programmed by URL
   pattern, unmatched requests throw naming the URL and method. Modelled on the
   two fixtures already built: programs replace on the same match, and the
   recorder captures the parsed JSON body since every caller here posts JSON.

2. Preload — install a guard `fetch` that throws for everything. A test that
   wants the network says so by installing the fixture.

3. Rewire `tests/unit/provider-service.test.ts` off its hand-rolled
   `globalThis.fetch` swap. First real caller; it will say whether the fixture's
   shape is right.

4. Export the three loops from `scripts/supervisor.ts`. Signatures untouched.

5. `tests/unit/supervisor-unanswered.test.ts` — Loop 7. The qualifying message,
   the re-injected row, the 🔥 reaction, the already-re-queued refusal, the
   dedup window, and the window consumed by a failed insert.

6. `tests/unit/supervisor-hung.test.ts` — Loop 1. The alert and its buttons, the
   incident row, the already-alerted edit path, the spinner note, and the
   no-`RunShell` case.

7. `tests/unit/supervisor-queue.test.ts` — Loop 2. What it sends and logs for a
   stuck item, and silence on a healthy queue.

8. **Verify the guard actually guards**: run the full suite and confirm nothing
   reaches the network — by observing the guard's own counter, not by reading
   the code.

9. **Verify the tests assert effects**: empty the body of each of the three
   loops in turn and confirm that loop's tests fail. Each loop swallows its own
   exceptions, so a test that only checks "did not throw" passes against a
   function that does nothing — this is the check that the assertions are real.

10. Full gate: `bun run typecheck`, `bun run lint`, `bun test`, `bun run dupes`,
    `keryx health run`, and record the supervisor's uncovered-line count before
    and after.

## Risks

- **Module state leaks between tests.** `activeAlerts`, `unansweredAlertedAt`
  and `ackedUntil` are module-level maps; a dedup key set by one test silences
  the next. Mitigation: distinct session and chat ids per test, and where a test
  is about the dedup itself, it says so.

- **The guard breaks a test that legitimately fetches.** Nothing in the suite
  should, but "should" is why step 8 is a task rather than a sentence.

- **`checkUnansweredMessages` swallows its query.** The main SELECT ends in
  `.catch(() => [])`, so a fake that fails to match returns no rows and the loop
  does nothing — indistinguishable from a correct decision to do nothing. Every
  test must assert a positive effect, and step 9 is what proves they do.

- **Exporting for tests can drift into changing design for tests.** The line
  held here: exports only, no signature changes, no new parameters. If a test
  cannot be written without changing a signature, the flow says so rather than
  changing it quietly.
