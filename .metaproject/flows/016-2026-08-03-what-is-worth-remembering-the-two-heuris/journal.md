# Flow Journal

- 2026-08-03T22:33:35.366Z - flow created
- 2026-08-03T22:33:35.458Z - task-added: T5: utils/memory-triage.ts
- 2026-08-03T22:33:35.544Z - task-added: T6: rewire the summarizer
- 2026-08-03T22:33:35.630Z - task-added: T7: tests at the boundaries
- 2026-08-03T22:33:35.721Z - task-added: T8: buildWorkSessionPrompt
- 2026-08-03T22:33:35.810Z - task-added: T9: full gate
- 2026-08-03T22:33:35.896Z - frozen: 10 criteria; checksum recorded
- 2026-08-03T22:33:35.982Z - started

## What happened

Small flow, and the interesting part is not the coverage number.

Writing the tests forced both heuristics to be stated plainly, and stating them
made two properties visible that reading the code had not:

**A single message is always trivial.** `userMsgs.length < 2` returns true
before anything else is considered, so "deploying needs the migration run first,
and never with the cache warm" — one message, complete, important — is discarded
whole, with no summary and no notice. That is not a bug in the sense of a
mistake; it is a threshold chosen for chit-chat that also catches a stated fact.
Pinned with a comment saying so.

**The emptiness patterns are unanchored.** A real summary containing "there were
no changes to the schema" matches `/no (tasks?|work|code|changes|questions)/i`
and is thrown away. Also pinned, also named as the cost of a broad pattern.

Neither was changed. Changing either is a decision about how much noise the
memory should carry, and making it silently inside a test pass would be the
worst way to make it.

### What this flow deliberately did not do

`memory/summarizer.ts` moved from 3.88% to 7.65% of lines. The decisions are at
100% in their own module; the rest of the file is the LLM call, the database
writes and the transcript reader, and covering those wants a module fake for
`claude/client.ts`. That is the next flow. Reporting the small number rather
than dressing it up: the valuable part of this file is covered, and most of the
file is not.

Tests 961 → 981.
- 2026-08-03T22:33:59.361Z - task-done: T1: Collect remaining context
- 2026-08-03T22:33:59.453Z - task-done: T2: Implement per plan
- 2026-08-03T22:33:59.543Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T22:33:59.641Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-03T22:33:59.731Z - task-done: T5: utils/memory-triage.ts
- 2026-08-03T22:33:59.820Z - task-done: T6: rewire the summarizer
- 2026-08-03T22:33:59.908Z - task-done: T7: tests at the boundaries
- 2026-08-03T22:33:59.997Z - task-done: T8: buildWorkSessionPrompt
- 2026-08-03T22:34:00.086Z - ac-confirmed: AC1: isContentTrivial, isSummaryWorthSaving, timerKey; TRIVIAL_AVG_LENGTH, SUBSTANTIAL_LENGTH, SUBSTANTIAL_REQUIRED, MIN_SUMMARY_LENGTH named
- 2026-08-03T22:34:00.172Z - ac-confirmed: AC2: summarizer imports all three; both heuristics removed from it
- 2026-08-03T22:34:00.263Z - ac-confirmed: AC3: boundaries asserted at exactly the threshold and one below
- 2026-08-03T22:34:00.353Z - ac-confirmed: AC4: a 500-char single message asserted trivial, with the comment that it is pinned rather than endorsed
- 2026-08-03T22:34:00.443Z - ac-confirmed: AC5: a short message padded with 100 spaces stays trivial
- 2026-08-03T22:34:00.529Z - ac-confirmed: AC6: an assistant message of 500 chars between two acknowledgements does not rescue the conversation
- 2026-08-03T22:34:00.615Z - ac-confirmed: AC7: leading ok refused, mentioned ok kept; a real summary containing 'no changes' refused, and that cost is stated
- 2026-08-03T22:34:00.705Z - ac-confirmed: AC8: timerKey differs by chat and by session
- 2026-08-03T22:34:00.794Z - ac-confirmed: AC9: both halves present, 500-char truncation asserted exactly, a null response renders no arrow, five section headers asserted
- 2026-08-03T22:34:00.880Z - ac-confirmed: AC10: typecheck clean, lint 0 errors, 981 tests, dupes 2 documented, memory-triage 100% lines

## Review: three findings, all the same one

Every boundary test I wrote failed to pin its boundary — in a flow whose own
acceptance criterion says the thresholds must be asserted *at* the boundary
rather than well inside it.

**The average rule was never the deciding one.** Both of my cases were also
rejected by the substantial-message rule, so deleting the average rule entirely
would have left the test green. Constructing a case where only the average can
decide takes two substantial messages *plus* eight tiny ones — sum 88 over ten,
an average of 8.8 — which the substantial rule would keep and the average rule
rejects.

**The minimum summary length was tested only from below.** `<` becoming `<=`
would have silently rejected every summary of exactly fifty characters.

**The tool-response cap was tested with the same filler as the message cap**, so
it proved only the larger of the two. Changing 200 to 499 would have passed.

All three mutation-checked: delete the average rule, widen the length
comparison, or loosen the response cap, and exactly one test fails each time.

The reviewer also confirmed that pinning the two behavioural risks was the right
call for a behaviour-preserving extraction, and that they deserve a separately
scoped follow-up rather than a silent change here.

Tests 981 → 981; the count is the same and three of them now mean something.
