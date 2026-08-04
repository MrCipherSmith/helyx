# Implementation Plan

Status: chosen

## Approach

A third monitor, reading the session's own transcript, offered first and falling
back to the two that exist.

`channel/status.ts:startProgressMonitorForChat` already has the shape for this:
it tries `startTmuxMonitor`, and if that returns null tries `startOutputMonitor`.
Both return `{ stop() }` and both call back with a rendered status block. The new
reader is a third one in front of them, with the same handle and the same
callback, so the class changes by three lines and nothing downstream moves.

Three modules, split along what each can be tested for on its own:

**`utils/transcript-locate.ts` — which file, and reading it forward.**

Resolution is a scan, not a derivation. `<claude-config>/projects/*/` is listed,
candidates are ordered newest-first by mtime, and each is asked what directory it
belongs to by reading its first line's `cwd`. The first match wins. This is why
the slug encoding never has to be reproduced, and why a changed encoding cannot
break it.

Reading is an offset tail. The offset starts at **end of file**, not zero: these
files reach tens of megabytes and the operator wants what is happening now, not
the session's whole history replayed into a Telegram message. Each poll reads
from the offset to EOF, splits on newlines, and carries an unterminated trailing
line into the next poll — a JSON object written in two `write()` calls must not
be parsed as two halves. A file that shrank or changed identity resets the offset
and re-resolves.

**`utils/transcript-events.ts` — an entry to a display line.**

Pure, and the whole point of the flow: this is where reasoning and prose stop
being discarded.

| Entry | Line |
|---|---|
| `tool_use` | `● <Tool>: <argument summary>` |
| `tool_result` | `  └ <first line>` / `  └ ❌ <error>` |
| `thinking` | `🧠 <preview>` |
| `text` | `💬 <preview>` |
| `usage` | `⏳ … (↓ <n> tokens)` |
| `isSidechain` | prefixed `  │ ` — a subagent, not the main thread |
| anything else | nothing, and no throw |

The vocabulary is deliberately the one `pane-parse.ts` already emits. Four
consumers in `channel/status.ts` and `status-format.ts` key on `● `, on
`● Read|Write|Edit|Create: <path>`, on `  └ `, and on `↓ <n> tokens`; speaking a
new dialect would silently break the tool counter, the file counter, the phase
emoji and the token header at once. The shared shapes are defined once and
imported by both readers rather than restated — `duplicated-knowledge-diverges`
is in this flow's memory for a reason.

**`utils/transcript-monitor.ts` — the loop.**

Polls every 2s (a file tail, not a `tmux` subprocess), keeps a ring buffer of the
last N rendered lines, and hands the joined buffer to the existing callback. On
resolution failure it returns null and the caller falls through to tmux exactly
as today.

Last, `ACTIVITY_LINES` in `status-render.ts` rises from 15. It was sized for a
whitelist that produced almost nothing; the budget in `tailWithinBudget` is what
actually bounds the message, and that stays.

### Rejected

- **`--output-format stream-json`** — the original proposal, and wrong. Requires
  `--print`; a printed session is not an interactive one. Recorded in context.md.
- **`--session-id` in `run-cli.sh`** — makes the path deterministic, costs a
  restart of every session to take effect, and buys nothing that a `cwd` match
  does not already give.
- **Hooks (`PostToolUse` → HTTP)** — real-time and structured, but it is a second
  delivery mechanism for data already on disk, and registering it needs a
  restart.
- **Widening `pane-parse.ts` and polling tmux faster** — the cheap version. Still
  a screen scrape: no scrollback, so whatever redraws between two polls is still
  lost. Buys "more often" without buying "complete".

## Steps

1. `transcript-locate.ts`: resolve by `cwd` match; offset tail with partial-line
   carry and reset-on-shrink.
2. `transcript-events.ts`: entry → line, in the existing vocabulary; unknown
   types are ignored, never fatal.
3. `transcript-monitor.ts`: poll loop, ring buffer, `{ stop() }` handle.
4. `channel/status.ts`: try the transcript monitor first, keep both fallbacks.
5. `status-render.ts`: raise `ACTIVITY_LINES`; leave the character budget alone.
6. Tests for 1–3 against a fixture directory with decoys, a truncated write, an
   oversized file and an unknown entry type.
7. Full gate: typecheck, lint, unit suite.

## Risks

- **The format belongs to Claude Code.** A field can move without notice. Every
  read is defensive: an entry that does not parse, or parses to a shape nobody
  recognises, produces no line and no error. The fallback to tmux stays wired for
  the case where it stops producing anything at all.
- **A subagent fan-out floods the buffer.** `isSidechain` entries are marked and
  the ring buffer is bounded, so a wide fan-out costs lines, not the message.
- **First attach on a large file.** Starting at EOF is the mitigation, and it is
  an acceptance criterion rather than a comment.
- **Two sessions in one directory.** Resolution takes the newest by mtime; the
  older one is not shown. Acceptable — the bot runs one CLI per project.
- **Docker mount missing on some host.** Resolution returns null and the tmux
  path runs, which is today's behaviour exactly.
