# Context

Collected deterministically by `keryx flow init` at 2026-08-02T10:34:27.790Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T10:17:23.031Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdwiki
- gdskills
- memory
- tasks
- health
- testing
- security

## Agent Findings

_(flow-init skill appends here)_

## Agent Findings

### Call sites (verified by search, 2026-08-02)

| File:line | Form | Strips |
|---|---|---|
| `scripts/tmux-watchdog.ts:93` | `function stripAnsi` | CSI any-final-letter, OSC, `[\x00-\x09\x0b-\x1f]` |
| `utils/output-monitor.ts:40` | `function stripAnsi` | same three |
| `bot/commands/codex.ts:6` | `function stripAnsi` | CSI `[mGKHF]` then CSI any-letter (the first is subsumed by the second); no OSC, no controls |
| `scripts/supervisor.ts:331` | inline in `checkHungSessions` | SGR only |
| `scripts/supervisor.ts:429` | inline in `checkStuckQueue` | SGR only |
| `bot/commands/supervisor-actions.ts:72` | inline in the `pane` callback | SGR only |

The widest behaviour is the tmux-watchdog / output-monitor pair; they are
identical. Migrating to it is a no-op for those two, widens codex, and widens
the three supervisor sites.

### Consumers of the stripped text

- `scripts/supervisor.ts:332-333` — last 5 non-empty lines into the alert body,
  and `spinnerActive` via `/^[·✶✻]\s/` over the last 10 lines. The `^` anchor is
  what makes the incomplete strip matter.
- `bot/commands/supervisor-actions.ts:71` — last 20 non-empty lines into a
  Telegram `<pre>` block.
- `utils/output-monitor.ts:47,116` — line classification and a `❯` prompt test.
- `scripts/tmux-watchdog.ts:104,117` — pane capture for the watchdog's own
  parsing.
- `bot/commands/codex.ts:36,80,98` — streamed codex output; login-state checks
  match lowercase words, not punctuation.

### Baseline at flow start

- unit tests: 326 pass, 0 fail (`bun test tests/unit/`)
- health: WARN, score 57, coverage **16.19%**, findings 266
- HEAD: `25442df`, `origin/main` in sync

### Prior art in this repository

`memory/db.ts` exports `validateMigrationRegistry` specifically so tests call
the real implementation "rather than a re-implementation that can drift from
it". `tests/unit/tmux-watchdog.test.ts` is the case that comment warns about:
it defines its own `stripAnsi` and asserts against that.
