# Context

Collected deterministically by `keryx flow init` at 2026-09-02T12:14:21.728Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/task-note] Coverage programme: the blocker is closed and the numbers are exact - `.metaproject/memory/task-notes/coverage-programme-state-2026-08-05.md`
- [accepted/known-mistake] One rule in several files diverges, and review does not catch it - `.metaproject/memory/known-mistakes/duplicated-knowledge-diverges.md`
- [accepted/known-mistake] A comment that claims agreement is not a mechanism - `.metaproject/memory/known-mistakes/comment-asserts-more-than-code.md`

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

## Agent Findings

Primary source for this entire flow:
`docs/report/helyx-telegram-delivery-incident/2026-09-02-report.md`
(read-only investigation, untracked at flow creation time, no source changes
made by that investigation). It already did the equivalent of gdgraph/gdctx
narrowing for the flow's scope:

- Root cause with exact lines: `utils/telegram-rate-budget.ts` `101-110`,
  `141-169`, `226-261` (report section 4.1/4.4).
- Delivery-loss mechanisms with exact lines: `channel/tools.ts` `536-550`,
  `100-131`, `585-643`; `mcp/server.ts` `370-396`; `channel/poller.ts`
  `353-378`, `480-500`; `scripts/supervisor.ts` `~1895-1905`; unique index
  `idx_queue_msgid_dedup` defined in `memory/db.ts` `478-488` (report
  sections 9-10).
- Existing test coverage gap: `tests/unit/telegram-rate-budget.test.ts`
  covers grant/spend, exhaustion, timeout, fail-open, double-spend, and lane
  isolation, but has no scenario for refresh-while-`remaining()>0`, unused
  remainder loss, or idle-process drain (report section 4.3) — T5/T7/T9 in
  this flow close exactly that gap.
- Related, already-shipped flows this one builds on top of without
  revisiting: flow 061 (limit-vs-hang distinction, `PR #107`), flow 064
  (shared rate limiter itself, `PR #115`, commit `3f93fa0`/`7827271`) — this
  flow fixes a defect inside what those shipped, per the report's own
  framing (section 17).
