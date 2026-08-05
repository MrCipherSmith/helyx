# Implementation Plan

Status: formalized

## Approach

### Finding them

Given a resolved parent transcript at `<dir>/<uuid>.jsonl`, its subagents are
in `<dir>/<uuid>/subagents/`. That is a directory read next to a file the
monitor has already located — no new resolution logic, and nothing to guess.

Only files whose mtime is at or after the turn began are read. An old fan-out
from yesterday's session is history, and the same mistake — attaching to a
file that still opens and still reports an end — already cost this repository
a review finding on `TRANSCRIPT_STALE_MS`.

### Reading them

`TranscriptTail` already does incremental reads and is tested. One tail per
active subagent file, created when the file first appears, dropped when the
agent's file stops growing and its parent tool call has returned.

Bounded: at most `MAX_TRACKED_AGENTS` newest agents. A fan-out of thirty would
otherwise be thirty tails and thirty times the lines, and the operator can read
neither.

### Rendering them

A subagent line without a marker reads as the main agent contradicting itself —
two files being edited at once by something that is supposed to be doing one
thing. Each line carries its agent's label, taken from `meta.json`:
`agentType`, falling back to the first words of `description`, falling back to
the agent id.

The existing character budget in `status-render.ts` decides what fits; this
flow only decides what is offered and in what order. Newest first, parent's own
lines never crowded out entirely.

## Steps

1. `utils/subagent-transcripts.ts` — locate, filter by age, read `meta.json`,
   label. Pure but for the reads, and injectable like `transcript-locate.ts`.
2. `utils/transcript-monitor.ts` — tail the tracked agents alongside the parent.
3. Rendering and the bound.
4. Tests over a fake `.claude` tree, CHANGELOG, measurement.

## Risks

- **The layout is Claude Code's, not ours.** If it changes, this goes quiet
  rather than wrong — and the tests state the layout explicitly so the failure
  names itself.
- **Volume.** A fan-out produces many lines quickly; the cap and the newest-first
  order are the answer, and the render budget already exists.
