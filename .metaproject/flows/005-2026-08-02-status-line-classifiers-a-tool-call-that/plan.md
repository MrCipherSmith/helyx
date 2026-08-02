# Implementation Plan

Status: agreed (revised during T1 — see "What the first plan got wrong")

## What the first plan got wrong

The first version said: if the stage has a `● ` tool line, classify from it and
never consult the surrounding text for permission words.

That would have broken the thing it was protecting. The real Claude Code
permission dialog *includes* the tool bullet — `tests/unit/tmux-watchdog.test.ts`
encodes it as:

```
  ● mcp__docker__docker_container_list (MCP)
  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again
    3. No
```

A rule keyed on "is there a bullet" cannot tell that apart from an ordinary
tool call. Caught before freezing, by reading the fixture rather than assuming
what a prompt looks like.

## Approach

Key the `waiting` phase on the **shape of the dialog**, not on three English
words appearing somewhere in the blob. This project already has a definition
of what a permission prompt is — `scripts/tmux-watchdog.ts` detects one by
`do you want to proceed?` followed by a `❯ 1. Yes` choice — and the status line
should use the same one rather than a looser guess of its own.

`utils/status-format.ts` takes the five pure functions:

- `isPermissionPrompt(stage)` — the dialog signal, mirroring the watchdog's
  definition, exported so the two cannot drift apart silently.
- `detectPhase(stage)` — `waiting` when `isPermissionPrompt` says so; otherwise
  classify from the last `● ` line exactly as today; otherwise the existing
  prose fallbacks.
- `parseTokenCount`, `formatElapsed`, `computeSignature` — moved verbatim.
- `getSpinnerIcon(frame, lastUpdateAt, now)` — clock as a parameter, the way
  `shouldAlertNow` and `recoveryDecision` took theirs in заходы 1 and 4.

The prose fallback keeps a narrow permission check for a stage that is a plain
message rather than pane output — `"waiting for approval"` written as a status
by hand should still read as waiting. It applies only when there is no tool
line at all.

## Steps

1. `utils/status-format.ts` with the six functions.
2. Rewire `channel/status.ts`; delete the local copies.
3. Tests: the four demonstrated misclassifications as regressions, and the
   real dialog text — copied from the watchdog fixture, not paraphrased.
4. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`,
   `keryx health run`.
5. Confirm both watchdog and status agree on the same dialog text, since the
   whole point is that they share a definition.

## Risks

- **Narrowing `waiting` could lose a real prompt.** A false 💬 is noise; a
  missing 💬 is a blocked session nobody notices. Mitigated by using the
  project's existing prompt definition and testing against its own fixture.
- **The dialog may reach `detectPhase` differently than it reaches the
  watchdog** — the watchdog reads raw pane lines, the status line receives
  stage text assembled by `tmux-monitor.ts`, which may have stripped
  indentation or the choice lines. Step 5 checks both shapes.
- `parseTokenCount` accepts several dots and silently truncates; pinned as-is
  and recorded for a separate decision.
