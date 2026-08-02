# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

| ID | Kind | Title |
|----|------|-------|
| T1 | context | Inventory every ANSI-stripping site and its consumers |
| T2 | implement | Write `utils/terminal.ts` and migrate all six call sites |
| T3 | test | Cover the shared parser, the spinner case, and both supervisor helpers |
| T4 | review | Verify, draft PR, Codex review |

## Notes

- T1 is complete: findings are recorded in `context.md`.
- T2 migrates `tmux-watchdog.ts`, `output-monitor.ts`, `codex.ts`,
  `supervisor.ts` (×2) and `supervisor-actions.ts`, and adds
  `projectFromSessionProblemKey` + `recoveryDecision` (same class of defect: a
  format written in one place and re-derived in another).
- T3 includes pointing `tests/unit/tmux-watchdog.test.ts` at the shared
  implementation instead of its local copy (AC4).
- T4 review runs through Codex per the repository's CLAUDE.md, falling back to
  the native review skill if Codex is unavailable.
