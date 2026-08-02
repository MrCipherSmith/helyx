# Implementation Plan

Status: agreed

## Approach

Take the widest of the five existing behaviours — `tmux-watchdog.ts`'s, which
strips CSI, OSC and C0 control characters — as the shared implementation, and
migrate the other four to it. Widest rather than an average: every narrower
variant leaves escapes in text that is then pattern-matched or shown to a
human, and no caller has a reason to want an escape preserved.

Three functions, because that is what the call sites actually do:

- `stripAnsi(s)` — CSI, OSC, C0 controls, keeping `\n` and `\t`.
- `paneLines(raw, n)` — strip, split, drop blanks, take the last `n`. This is
  the supervisor's excerpt and `supervisor-actions`' log dump, spelled the same
  way twice today.
- `isSpinnerLine(line)` / `hasActiveSpinner(raw, lookback)` — the
  `/^[·✶✻]\s/` test, applied to stripped text.

Two smaller corrections ride along because they are the same class of defect —
a format written in one place and re-derived in another:

- `projectFromSessionProblemKey()` in `utils/supervisor-callbacks.ts`, so
  `checkRecovery` stops undoing `sessionProblemKey` with an unanchored
  `.replace("session_problem:", "")`.
- `recoveryDecision()` extracted from `checkRecovery`, so the "two consecutive
  clean ticks" rule can be tested without a database.

`tests/unit/tmux-watchdog.test.ts` drops its local `stripAnsi` copy and imports
the real one.

## Steps

1. Write `utils/terminal.ts` with the three functions and their rationale.
2. Migrate `scripts/tmux-watchdog.ts`, `utils/output-monitor.ts`,
   `bot/commands/codex.ts`, `scripts/supervisor.ts` (two sites) and
   `bot/commands/supervisor-actions.ts`.
3. Add `projectFromSessionProblemKey` and `recoveryDecision`; rewire
   `checkRecovery`.
4. Tests: `tests/unit/terminal.test.ts`, plus cases for the two new supervisor
   helpers in the existing supervisor test files.
5. Point `tmux-watchdog.test.ts` at the shared implementation.
6. `bun run typecheck`, `bun run lint`, `bun test tests/unit/`, `keryx health run`.

## Risks

- **`codex.ts` output is streamed and parsed for login state.** Its regex is
  narrower today; widening it could strip a character the parser keys on. The
  status checks match on lowercase words (`logged in`), not on punctuation, so
  the risk is low — but the codex path is exercised manually, not by tests.
- **`output-monitor.ts` already strips control characters** and its behaviour
  must not change; it is the closest to the shared version, so this is a
  like-for-like swap.
- Escape-stripping is regex work on adversarial input. Mitigated by testing the
  shared function directly against CSI, OSC, control characters, and the
  interleavings tmux actually emits.
