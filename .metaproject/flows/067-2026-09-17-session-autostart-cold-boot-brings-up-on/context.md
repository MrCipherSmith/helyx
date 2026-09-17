# Context

Collected deterministically by `keryx flow init` at 2026-09-17T07:50:57.749Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.627] One rule in several files diverges, and review does not catch it (known-mistake/accepted) - known-mistakes/duplicated-knowledge-diverges.md
   Seven flows in this repository on 2026-08-02, and the underlying defect was the same every time: one piece of knowledge written out in several places, then diverging. Reading the diff does not find it — the copies are outside the diff. Run `bun run dupes` instead of looking.
   claimType: known-mistake | confidence: high | version: 1.0.0
   scope: module:utils, channel, scripts, mcp, entity:terminal parsing, permission prompt detection, status rendering
   provenance: source=manual link=flows 001, 003, 005, 006, 007 in `.metaproject/flows/` author=unknown confirmedBy=unknown
2. [1.556] Coverage programme: the blocker is closed and the numbers are exact (task-note/accepted) - task-notes/coverage-programme-state-2026-08-05.md
   Supersedes `coverage-programme-state.md` (2026-08-03), which records the programme as blocked on a `test-postgres` fixture. That fixture exists and is in use. The measured position on 2026-08-05 is 36.25% of lines (7369 of 20329) with 1540 tests passing, and the remaining work is covering the I/O layer in the order recorded in `docs/requirements/io-layer-coverage-2026-08-05`.
   claimType: task-note | confidence: high | version: 1.0.0
   scope: module:scripts, mcp, bot, utils, memory, entity:coverage, quality gate, test fixtures
   provenance: source=manual link=`docs/requirements/io-layer-coverage-2026-08-05`; `.metaproject/flows/034-2026-08-05-honest-gate` author=unknown confirmedBy=unknown
3. [1.55] A comment that claims agreement is not a mechanism (known-mistake/accepted) - known-mistakes/comment-asserts-more-than-code.md
   The recurring authoring mistake in this repository is not a logic error: it is a doc comment asserting more than the code below it does. It is invisible on re-reading, because the author reads what they meant. Every instance was caught by an independent reviewer, never by the author.
   claimType: known-mistake | confidence: high | version: 1.0.0
   scope: module:utils, channel, entity:permission prompt detection, status rendering
   provenance: source=manual link=flows 005 and 006 in `.metaproject/flows/` author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-05T17:46:21.854Z)
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
- mcp

## Agent Findings

_(flow-init skill appends here)_

## Code Map (collected 2026-09-17, read directly)

| What | Where | Note |
|---|---|---|
| Project list for a start | `cli.ts:1425` `loadProjects` | `SELECT name, path FROM projects` — no filter, 15 rows today |
| Start of the session half | `cli.ts:1585` `tmuxStart` | cold branch 1643-1675 loops all projects; warm branch 1600-1640 starts all missing |
| One window | `cli.ts:1474` `startWindow` | `run-cli.sh <path>` inside the window |
| Teardown | `cli.ts:1749` `tmuxStop` | kills, **then** sets remote `sessions` inactive — destroys the restore set |
| Restart | `cli.ts:2313` `bounce` | `tmuxStop` → wait → `tmuxStart`; lease via `utils/restart-lease.ts` |
| Recovery | `scripts/stack-up.ts:86` | `compose up -d` then `cli up` — reaches the same `tmuxStart` |
| Admin commands | `scripts/admin-daemon.ts` | `tmux_start` 406, `proj_start` 421 (dead-server fallback `up` at 472), `bounce` 477, `stack_up` 554, `host_restart` 574, `full_restart` 612, `proj_stop` 764 |
| Status transitions | `sessions/state-machine.ts` | `transitionSession`; broadcasts, records nothing durable |
| Scope decision, testable shape to copy | `sessions/tmux-server.ts` | `decideTmuxScope`/`verifyStart` — pure, unit-tested |
| Migrations | `memory/db.ts` `migrate()`, called from `main.ts:23` | idempotent DDL, `bun run migrate` |

Runtime facts behind the request, from the host on 2026-09-17: the machine
rebooted at 06:46, no tmux server came back (`helyx-tmux.scope` inactive,
`pgrep tmux` empty), `process_health` carries `tmux:bots | stopped`, and
`sessions` id 3 (`helyx · remote`) still reads `active` with `last_active`
06:46:03 — a stale row, which is why the restore set must come from tmux and
not from `sessions`.

Not touched, deliberately: `scripts/tmux-watchdog.ts` creates no windows (it
observes, and `run-cli.sh` restarts Claude inside an existing window), so
per-window crash recovery is unaffected by this flow.
