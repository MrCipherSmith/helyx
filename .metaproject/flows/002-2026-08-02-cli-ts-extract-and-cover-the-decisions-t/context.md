# Context

Collected deterministically by `keryx flow init` at 2026-08-02T11:47:38.107Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T11:01:21.785Z)
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

### Targets (verified 2026-08-02, cli.ts at 2082 lines)

| Site | What | Purity |
|---|---|---|
| `cli.ts:168` `parseFlags` | argv → `Record<string,string>` | pure |
| `cli.ts:190` `flag` | reads module-level `FLAGS`; empty string means absent | pure once the map is a parameter |
| `cli.ts:275` `availableMemoryMb` | three files tried in order | reads are impure; each parse is pure |
| `cli.ts:418` preset filter | `mem === null ? all : filter(ramMb <= mem)` | pure |
| `cli.ts:917` `isEphemeralCheckout` | tmpdir prefix, `/tmp/` prefix, `.git` is a file | pure once `statSync`/`existsSync` are parameters |
| `cli.ts:931` `pruneStaleStopHooks` | reverse-splice over `settings.Stop` | pure once `existsSync` is a parameter |

### Why these five

`cli.ts` cannot be imported: the file ends in a top-level `switch` on
`process.argv`, which executes on import. Nothing in it is reachable from the
unit suite today, and coverage of the file is effectively zero.

All three production failures fixed on 2026-08-01 (`0abfe8d`) were in this file
or its sibling supervisor: the window-name prefix match, the second
admin-daemon spawned by `ExecStartPre`, and the restart button given a session
id where a project id was expected.

### Blast radius

`keryx gdgraph affected cli.ts` — cli.ts is an entry point; nothing imports it.
The three new modules will be imported by `cli.ts` only, so the risk is
confined to the rewire itself, which no test covers. Hence AC9's manual run.

### Baseline at flow start

- HEAD `ba35190` on `main`, in sync with origin
- unit tests: 381 pass, 0 fail
- health: WARN, score 58, coverage **16.44%**, findings 266
- `cli.ts`: cyclomatic 360, churn 590, hotspot score 212 400 (2nd)
