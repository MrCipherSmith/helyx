# Context

Collected deterministically by `keryx flow init` at 2026-08-02T13:45:38.575Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-02T12:34:08.503Z)
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

### The red state cannot be reached

`sendStatusBroadcast` runs `docker ps --format "{{.Names}}\t{{.Status}}"` —
without `-a`. That lists running, restarting and paused containers only. The
classification is a blacklist against `exited` and `dead`, neither of which
can appear in that output. Every listed container is therefore painted 🟢, and
`hasProblems` — `stuckTotal > 0 || dockerLines.some(l => l.startsWith("🔴"))`
— is left with only its queue term.

The v1.49.0 changelog describes the intended behaviour as "delete+send
(notification) only when stuck queue **or 🔴 docker container** detected". The
second half has never been able to fire.

### States that are listed and misread

| `docker ps` status | Reality | Painted |
|---|---|---|
| `Up 2 minutes (unhealthy)` | healthcheck failing | 🟢 |
| `Restarting (1) 5 seconds ago` | crash loop | 🟢 |
| `Up 3 days (Paused)` | frozen | 🟢 |

### A control decision read out of a rendered string

`hasProblems` greps `dockerLines` for a leading 🔴. The icon is presentation;
changing it silently disables notifications.

### This host, right now

`docker ps -a --format "{{.Status}}" | sort -u` returns only:
`Up 16 hours (healthy)`, `Up 2 days`, `Up 3 days`, `Up 3 days (healthy)` —
all genuinely healthy, which is why nothing has surfaced this in practice.

### Baseline at flow start

- HEAD `7c913d7` on `main`, in sync with origin
- unit tests: 505 pass, 0 fail
- health: WARN, score 59, coverage **17.42%**
- `scripts/supervisor.ts`: still the top hotspot, ~4% covered
