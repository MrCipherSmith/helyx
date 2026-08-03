# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `utils/pane-parse.ts` exports the chrome list, `isChrome`, `parseLine` and `parseStatus`, and both monitors import all of them.
- AC2: Neither `utils/tmux-monitor.ts` nor `utils/output-monitor.ts` contains any of the twelve shared patterns, `isChrome`, `parseLine` or `parseStatus`.
- AC3: `bun run dupes` reports no pattern shared by `tmux-monitor.ts` and `output-monitor.ts`, and the total falls by at least twelve.
- AC4: `parseLine` strips ANSI on every path, and a test asserts that a line beginning with an escape sequence still matches an anchored pattern — the drift that made the tmux side fail silently.
- AC5: The extra skip patterns are a parameter; `output-monitor` passes the `script` header and footer, and `/^\x1b/` is gone with a test showing why it could never match.
- AC6: A test records that the `Error:` sub-operation branch gives the same result wherever it sits in the order, so the unification is pinned rather than assumed.
- AC7: `parseLine` is tested for every branch it can take: spinner, each tool shape, sub-operations, the agent tree, "+N more tool uses", the sub-agent line, and the fall-through to null.
- AC8: `parseStatus` is tested for the bottom-up scan, the twelve-line cap, and the prompt-line boundary that stops the scan.
- AC9: The status block produced for real recorded pane output is byte-identical before and after the change, compared as captured text rather than as a hand-written sample.
- AC10: `bun run typecheck` is clean, `bun run lint` reports 0 errors, and the full unit suite passes with no test removed or skipped.
