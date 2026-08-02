# Context

Collected deterministically by `keryx flow init` at 2026-08-02T12:17:59.620Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T11:58:58.234Z)
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

### The five decisions (verified 2026-08-02, dashboard-api.ts at 1170 lines)

| Site | Decision | Status |
|---|---|---|
| `:832`, `:849` | `resolve(join(DIR, p)).startsWith(DIR)` | **wrong** — prefix, not containment |
| `:22` | `hostToContainerPath` prefix mapping | same shape, same gap |
| `:74` | `parseCookie` | untested |
| `:399` | git ref allowlist | untested |
| `:397` | `file.includes("..")` | untested; a blacklist standing in for containment |

### The escape, demonstrated

With `DIST_DIR = /app/dashboard/dist`:

```
"/index.html"          -> /app/dashboard/dist/index.html      guard: pass
"/../dist-evil/secret" -> /app/dashboard/dist-evil/secret     guard: PASS  <-- escape
"/../../etc/passwd"    -> /app/etc/passwd                     guard: reject
```

Not exploitable in the shipped image only because no sibling of
`dashboard/dist` begins with `dist`. That is a naming accident, not a control.

### Why this file

`mcp/dashboard-api.ts` holds the highest single-function complexity in the
project (118) — a fact recorded in the v1.53.0 changelog when `channel/tools.ts`
gave up the title. It is also the only file taking input straight off the
network.

### Baseline at flow start

- HEAD `43be42f` on `main`, in sync with origin
- unit tests: 450 pass, 0 fail
- health: WARN, score 59, coverage **17.00%**, findings 264
