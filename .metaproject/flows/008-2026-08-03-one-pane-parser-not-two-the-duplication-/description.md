# one pane parser, not two — the duplication the detector named

Status: formalized
Source: flow 007's report (заход 8 of the coverage programme)

## Problem

`utils/tmux-monitor.ts` and `utils/output-monitor.ts` both turn Claude Code's
terminal output into a status block, and they do it with two copies of the
same parser. `bun run dupes` reports twelve patterns shared by exactly this
pair — the whole rule set for what that output looks like:

```
/^\? for shortcuts/            /^esc to interrupt/       /^Enter to confirm/
/^[·✶✻]\s+(.+)/                /^(\w+)\((.+)\)/          /^Bash\((.+)\)$/
/^(Read|Edit|Write)\((.+)\)$/  /^\S+\s*-\s*(\w+)\s*\(MCP\)/
/^(Explore|Agent)\((.+)\)/     /^Running \d+ agents?/    /^[├└│][\s─]+(.+)/
/^(Read|Search|Grep|Glob|Write|Edit)\s/
```

Two files that must agree about the same external format, agreeing only by
coincidence. This is the fourth instance of the shape in this repository, and
the first found by a tool rather than by someone reading code.

The copies have already drifted, in three ways:

1. **`output-monitor` strips ANSI per line; `tmux-monitor` does not.** Every
   pattern above is anchored with `^`, so an escape sequence at the start of a
   line makes the match fail — precisely the bug flow 001 fixed in the
   supervisor and left standing here.
2. `output-monitor`'s skip list carries three extra entries: `/^\x1b/` and the
   `script` command's header and footer. The first is dead — by the time
   `isChrome` sees the line, `stripAnsi` has removed the escape.
3. The sub-operation branch checks `Error:` first in one file and last in the
   other. The outcome is the same, but nothing says so.

## Expected Outcome

One parser, in one module, imported by both monitors, with the differences
between them expressed as parameters rather than as separate code. No copy of
any of those patterns left anywhere.

## Out of Scope

- What either monitor does with the parsed result — polling, callbacks,
  file tailing and tmux capture all stay where they are.
- The status block's shape: same lines, same order, same truncation.
- `scripts/tmux-watchdog.ts`, which parses panes for a different purpose with
  a different vocabulary.
