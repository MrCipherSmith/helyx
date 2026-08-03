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

## Codex review, 2026-08-03

Verdict: REQUEST CHANGES. One major, verified before accepting.

`stripAnsi` removes C0 control characters, and a tab is one. So `●\tBash(ls)`
— a bullet separated from its call by a tab — arrived at the patterns as
`●Bash(ls)` and stopped matching `^●\s+`. Confirmed by running it: the pane
copy returned `● $ ls`, the merged parser returned `null`.

**Parity with both originals is impossible here**, which is worth stating
rather than papering over. The pane copy did not strip and matched the line;
the file copy stripped and did not. Unifying has to pick one. The tie goes to
parsing it: a tab after the bullet is ordinary output, and dropping the line
loses real activity for no gain.

Fixed by turning tabs into spaces before stripping — the patterns depend on
`\s`, and only the tab among the C0 set is whitespace they care about. Other
control characters still go, and a test says so.

T6 re-run after the fix: all three captured panes still byte-identical.

Codex also noted a stale `SKIP_PATTERNS` reference in a comment in
`status-format.test.ts` (the list is `CHROME_PATTERNS` now) — fixed — and that
the "clean input is unaffected" test covered only the spinner. It now covers
every branch, plus the ANSI-decorated prompt boundary in `parseStatus`, which
nothing had exercised.

688 -> 695 tests.

### Second Codex pass — the fix was a third behaviour

All three earlier findings resolved, and a new one that is exactly right:
converting every tab to a space rewrote tabs *inside* the payload too, which
neither original did. `● Some\tTool` was kept as-is by the pane copy, deleted
by the file copy, and my fix turned it into `● Some Tool` — a third answer,
matching neither.

Resolved by keeping the tab rather than converting it: `stripAnsi` gained a
`keepTabs` option, off by default so every existing caller is untouched, and
the parser asks for it. That reproduces the pane copy exactly, payload
included — the copy that parsed the line in the first place.

Widening the shared signature immediately proved the rule that motivated this
flow: `scripts/tmux-watchdog.ts` passed `stripAnsi` point-free to `.map()`, so
the index became the second argument and the file stopped type-checking. Fixed
at both call sites. The typechecker caught it here, which is what "check every
consumer when a shared definition changes" looks like when the language can
help.

T6 re-run again: all three panes byte-identical.
