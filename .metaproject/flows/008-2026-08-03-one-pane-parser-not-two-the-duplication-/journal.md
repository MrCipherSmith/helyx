# Flow Journal

- 2026-08-03T08:26:53.649Z - flow created
- 2026-08-03T08:27:48.169Z - frozen: 10 criteria; checksum recorded
- 2026-08-03T08:27:48.253Z - started
- 2026-08-03T08:27:48.338Z - task-added: T5: bun run dupes: no pattern shared by the two monitors, total down by twelve
- 2026-08-03T08:27:48.421Z - task-added: T6: Status block byte-identical on real recorded pane output, before vs after
- 2026-08-03T08:27:48.504Z - task-done: T1: Collect remaining context
- 2026-08-03T08:32:23.223Z - task-done: T2: Implement per plan
- 2026-08-03T08:32:23.311Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T08:32:23.401Z - task-done: T5: bun run dupes: no pattern shared by the two monitors, total down by twelve
- 2026-08-03T08:32:23.515Z - task-done: T6: Status block byte-identical on real recorded pane output, before vs after

## Verification (T5, T6) — run, not described

| Task | Result |
|---|---|
| T5: `bun run dupes` | 19 → **5** duplicates. Patterns shared by the two monitors: **0**. The drop is 14, not the twelve predicted — unifying removed two more that had been shared with a third file. |
| T6: status block byte-identical | Three real panes captured from live sessions (`helyx`, `keryx`, `goodai`), parsed before and after: **identical**, all three. |

T6 mattered: `parseStatus` output is hashed to suppress duplicate status edits,
so a one-character change would have made every status appear new once.

These were flow tasks rather than lines in `plan.md`, following the practice
added to the flow-orchestrator skill in keryx PR 221 — which exists because
flow 005 wrote its verification into prose, skipped it, and shipped a change
that could not work.

## What writing the tests found

All three "extra" chrome patterns the file reader carried were already dead:

- `/^\x1b/` cannot match, because `parseLine` strips before `isChrome` sees
  the line;
- `/^Script started/` and `/^Script done/` are prose, and prose falls through
  every branch to `null` regardless.

So the parameter that carries them changes nothing observable today. It is
kept, and the test says exactly that rather than implying the patterns work —
if the parser ever gains a prose fallback the wrapper must not become status
text, and an explicit skip is the cheapest way to hold that.

Found by writing the test and watching it fail against my own expectation. I
had asserted the wrapper would appear in the output without the parameter; it
does not.
