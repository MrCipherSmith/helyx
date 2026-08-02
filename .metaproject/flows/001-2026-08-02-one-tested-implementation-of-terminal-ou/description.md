# One tested implementation of terminal-output parsing

Status: formalized
Source: user description (заход 1 of the coverage programme)

## Problem

Helyx reads raw terminal output in five places, and each one strips ANSI
escapes with its own regex. They do not agree:

| Site | Strips |
|---|---|
| `scripts/tmux-watchdog.ts:93` | CSI (any final letter), OSC, C0 control chars |
| `utils/output-monitor.ts:40` | CSI (any final letter), OSC, C0 control chars |
| `bot/commands/codex.ts:6` | CSI only — no OSC, no control chars |
| `scripts/supervisor.ts:331,429` | **SGR only** (`\x1B[…m`) — inline, no function |
| `bot/commands/supervisor-actions.ts:72` | **SGR only** — inline, no function |

The supervisor's variant is the weakest of the five and feeds two things an
operator relies on during an incident:

1. **Spinner detection** — `spinnerActive` tests `/^[·✶✻]\s/` against the
   stripped pane. The `^` anchor sits directly on text that may still begin
   with a cursor-movement sequence, because only SGR was removed. When that
   happens the alert drops the "⚙️ Claude сейчас работает — возможно, не завис"
   line and the restart button loses its warning label, so the operator is told
   a working session is hung.
2. **The pane excerpt** in the alert body — leftover escapes and control
   characters are sent to Telegram inside `<pre>`.

Nothing tests any of the five. `tests/unit/tmux-watchdog.test.ts` re-implements
`stripAnsi` locally, so it verifies a copy that can drift from every shipped
implementation — the failure mode `memory/db.ts` already warns about in its
`validateMigrationRegistry` comment.

## Expected Outcome

One implementation of terminal-output parsing, in `utils/terminal.ts`, used by
every site above and covered by unit tests that exercise it directly. The
supervisor's spinner detection and pane excerpt operate on fully stripped text.

## Out of Scope

- Changing what any caller *does* with the parsed text — same alerts, same
  message bodies, same thresholds.
- `detectPermissionPrompt` and the rest of `tmux-watchdog.ts`'s parsing; only
  the escape-stripping and pane-line extraction move.
- Raising overall coverage to the 60% floor. This заход moves it by the size of
  what it covers, no more.
- The dashboard's own ANSI handling (separate app, separate bundle).
