# Context

Collected deterministically by `keryx flow init` at 2026-08-03T08:26:53.633Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/known-mistake] One rule in several files diverges, and review does not catch it - `.metaproject/memory/known-mistakes/duplicated-knowledge-diverges.md`
- [accepted/known-mistake] A comment that claims agreement is not a mechanism - `.metaproject/memory/known-mistakes/comment-asserts-more-than-code.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T22:59:19.218Z)
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

### What the two files share

Twelve patterns, reported by `bun run dupes` as belonging to exactly this
pair. `parseLine` differs only cosmetically — comments, brace style — plus the
three drifts below. `parseStatus` differs in one line and a comment.

### The three drifts

| # | Drift | Consequence |
|---|---|---|
| 1 | `output-monitor` strips ANSI per line, `tmux-monitor` does not | every pattern is `^`-anchored, so an escape at line start silently fails to match — the flow-001 bug, still standing here |
| 2 | `output-monitor` skips three extra patterns: `/^\x1b/`, `/^Script started/`, `/^Script done/` | the first is dead: `stripAnsi` runs before `isChrome` sees the line |
| 3 | the `Error:` sub-operation branch is first in one file, last in the other | same result — no earlier branch matches a line starting `Error:` — but nothing records that |

### Baseline at flow start

- HEAD `1c8febf` on `main`
- unit tests: 654 pass, 0 fail
- health: WARN, score 61, coverage 18.41%
- `bun run dupes`: 19 duplicated patterns
