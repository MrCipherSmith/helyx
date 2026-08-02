# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/terminal.ts` exists and exports `stripAnsi`, `paneLines` and `hasActiveSpinner`; it strips CSI sequences, OSC sequences and C0 control characters while preserving newlines and tabs.
- AC2: No `stripAnsi` definition and no inline ANSI-stripping regex remains outside `utils/terminal.ts` in `scripts/`, `utils/`, `bot/` or `channel/` — verified by a repository search returning only the shared module.
- AC3: The supervisor's spinner detection runs on fully stripped text: a pane whose spinner line is preceded by a cursor-movement sequence is reported as spinner-active, and a test covers that case.
- AC4: `tests/unit/tmux-watchdog.test.ts` imports `stripAnsi` from `utils/terminal.ts` instead of defining its own copy, and still passes.
- AC5: `utils/supervisor-callbacks.ts` exports `projectFromSessionProblemKey`, `checkRecovery` uses it instead of an unanchored `.replace()`, and a test asserts it round-trips `sessionProblemKey` for a project name containing a colon.
- AC6: `recoveryDecision` is exported from `scripts/supervisor.ts`, `checkRecovery` is expressed in terms of it, and tests cover all four outcomes including that a non-clean tick clears a pending clean timer.
- AC7: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
- AC8: `keryx health run` reports coverage strictly above the 16.19% recorded at flow start, and the gate reports no new failure reason beyond the pre-existing coverage warning.
