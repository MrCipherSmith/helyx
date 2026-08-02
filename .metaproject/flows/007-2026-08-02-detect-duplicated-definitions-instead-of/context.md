# Context

Collected deterministically by `keryx flow init` at 2026-08-02T20:04:57.759Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T18:26:04.702Z)
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

### The prototype earned its place before it was written

Run against `main` at `14d8804`, it reported:

```
/do you want to proceed\?/i   scripts/tmux-watchdog.ts, utils/permission-prompt.ts
/❯\s*1[.)]\s*yes/i            scripts/tmux-watchdog.ts, utils/permission-prompt.ts
/^[a-z][a-z0-9-]{0,63}$/      utils/skill-handlers.ts, utils/skill-distiller.ts, bot/callbacks.ts
```

The first two are the rule flow 005 and flow 006 spent eight review rounds on.
`detectPermissionPrompt` had been switched to the shared predicate; a second
consumer forty lines below it still used local copies. Removed on this branch
before the detector was even finished.

### Noise in the prototype, and why it is a design problem

It also reported `/memory/summ`, `/api.telegram.org/` and `/components/` —
import paths and URLs, matched because a naive scan cannot tell a regex
literal from a division or a path. 55 "duplicates" of which a handful were
real. A checker with that ratio is a checker nobody runs.

### Baseline at flow start

- HEAD `14d8804` on `main`
- unit tests: 618 pass, 0 fail
- health: WARN, score 60, coverage 17.96%
