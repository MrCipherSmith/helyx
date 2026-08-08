# Summarize before Claude Code folds its own context

Status: formalized
Source: docs/requirements/context-overflow-2026-08-07/prd.md

## Problem

Claude Code compacts its own context when it fills, and Helyx's summariser never
runs at that moment. `forceSummarize()` exists and the supervisor calls it on
one trigger: a session idle for `IDLE_COMPACT_MIN` minutes with ten or more
messages. A session busy enough to fill its window never reaches that trigger,
so the fold lands on exactly the sessions the summary would have been worth
having for.

Nothing measures how full the window is. The `↓ N tokens` in the status line is
`output_tokens` for the current turn — documented as deliberately not the input
or cache counts — and says nothing about the context.

## Expected Outcome

- The context size of a live session is computed from its transcript, where
  `message.usage` already records it, with no terminal scraping.
- A session crossing a configurable threshold is summarised while it is idle,
  before the fold.
- A session crossing it mid-turn is left until it is idle.
- A fold that arrives first still gets one bounded summary attempt through
  `PreCompact`, and never has compaction blocked on it.
- An unknown model falls back to a documented default window rather than
  computing a percentage from a denominator it does not have.

## Out of Scope

- Re-injecting the summary after compaction (`PostCompact` /
  `SessionStart(compact)`). `/resume` covers the manual case; what belongs in a
  fresh context is a separate decision.
- Sending `/compact` on Helyx's initiative.
- Changing what `forceSummarize()` writes.
