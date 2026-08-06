# Implementation Plan

Status: frozen

## Approach

Everything the message needs is already computed somewhere; none of it is
plumbed to the renderer. So the shape of this change is three new optional
fields on `StatusParts` and three short paths that fill them — not new
machinery.

`renderStatus` stays pure and stays the only place that decides what the
message looks like. The new lines go **above** the activity quote rather than
inside it: the quote is trimmed from the front by `tailWithinBudget`, so a
summary line written into it would be the first thing dropped on a busy turn —
exactly when it is most wanted.

Subagent labels come from `TranscriptSession`, which already holds the live set
in `this.agents` and drops entries as agents finish. Exposing it as a getter on
the monitor handle beats widening the status callback: the callback carries a
rendered block, and a count is not that.

The summary is derived, not generated. The last line of activity that looks
like a tool call, stripped of its bullet and its `[label]` prefix and capped —
that is what the session is doing right now, and it costs nothing to know.

## Steps

1. `utils/status-render.ts`: add `idleMs`, `agents` and `summary` to
   `StatusParts`; render idle age in the header, an agents line and a summary
   line above the pane. Keep every existing budget.
2. `utils/status-render.ts`: `summarizeActivity(stage)` — the derivation above,
   exported so it is testable on its own.
3. `utils/transcript-monitor.ts`: `TranscriptSession.agentLabels` and
   `TranscriptMonitorHandle.agents()`, so the labels are readable without
   changing the status callback.
4. `channel/status.ts`: pass the three values through `formatStatusText`, from
   `lastMonitorActivity`, from the monitor handle, and from the stage.
5. Tests for the renderer and for the label getter.

## Risks

- The header has a 64-character budget and now carries one more field. The idle
  age is at most four characters (`59s`, `12m`), and it is appended after the
  existing fields, so a header at its limit loses the new part rather than the
  old.
- The signature that suppresses redundant edits is computed from the rendered
  text. Idle age changes every second, which would defeat it and edit the
  message on every tick. So it is rounded — seconds under a minute, whole
  minutes above — and the dedup keeps working between rounding steps.
