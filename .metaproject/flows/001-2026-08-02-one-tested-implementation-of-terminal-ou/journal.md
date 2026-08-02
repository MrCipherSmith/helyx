# Flow Journal

- 2026-08-02T10:34:27.806Z - flow created
- 2026-08-02T10:36:43.667Z - frozen: 8 criteria; checksum recorded
- 2026-08-02T10:36:43.750Z - started
- 2026-08-02T10:41:29.292Z - task-done: T1: Collect remaining context
- 2026-08-02T10:41:29.377Z - task-done: T2: Implement per plan
- 2026-08-02T10:41:29.463Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-02T11:00:42.144Z - task-added: T5: Address Codex review findings

## Codex review, 2026-08-02

Six findings. Five accepted and fixed in this flow; one accepted as real but
deferred with reasoning.

| # | Severity | Finding | Outcome |
|---|---|---|---|
| 1 | major | `utils/terminal.ts` CSI regex `[0-9;]*[a-zA-Z]` misses private-mode (`ESC[?25l`), colon-form SGR and intermediate-byte sequences | **Fixed.** Replaced with the ECMA-48 ranges. This one mattered: `ESC[?25l` is what a CLI emits before drawing a spinner, so the exact failure this flow set out to fix was still reachable through a form the regex did not match. |
| 2 | major | OSC regex recognises only BEL termination; ST-terminated titles and OSC-8 hyperlinks leak | **Fixed.** Accepts BEL or ST. OSC now runs before CSI, since an ST terminator is itself an ESC sequence. |
| 3 | major | CR and BS are deleted rather than applied as redraw semantics | **Deferred, documented.** For the pane paths this does not arise: `tmux capture-pane` returns an already-rendered screen, so CR/BS have been applied by tmux before the text is read. It is real for `output-monitor.ts`, which reads a `script`-captured file — but that behaviour is unchanged by this flow (its previous implementation deleted them identically), so fixing it belongs to a flow that can test the file-capture path. |
| 4 | major | `codex.ts` strips each stream chunk independently; a sequence split across chunks leaves fragments that defeat the `\b` in the device-code pattern | **Fixed.** Accumulates raw and strips the buffer. Also noted in `stripAnsi`'s docs that it is not incremental. |
| 5 | major | Pane text is interpolated unescaped into Telegram HTML at three sinks | **Fixed** — out of the flow's stated scope, recorded as task T5. Pre-existing, but in lines this flow touched, and the consequence is that an alert containing a `<` or `&` is rejected outright and the operator never sees it. `escapeHtml` added and applied at all three. |
| 6 | info | `recoveryDecision` differs from the code it replaced for falsy timestamps (`0`, `NaN`) | **Fixed.** Restored `!cleanSince` semantics with an explicit finite check, plus tests. Unreachable in production, but the exported contract should not quietly differ from what it replaced. |

After the fixes: 381 tests pass (from 367), tsc clean, eslint 0 errors, health
score 58, coverage 16.44%.
