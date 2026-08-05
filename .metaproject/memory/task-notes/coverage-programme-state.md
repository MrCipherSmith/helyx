# Coverage programme: what is done, what is open, what is next

Version: 1.0.0
Type: task-note
Status: superseded
Confidence: high
Valid-To: 2026-08-05
Superseded-By: task-notes/coverage-programme-state-2026-08-05.md

## Summary

An eight-flow programme run on 2026-08-02/03 to raise test coverage by
extracting decisions into pure modules. Tests 326 → 696, coverage 15.71% →
19.22%, health 37 → 61. It found seven real bugs on the way. The arithmetic
now says extraction is spent: the remaining uncovered code is I/O, and the
next useful step is a fixture layer, not another extraction.

## Details

### Flows completed (all merged, `.metaproject/flows/`)

| # | Subject | Bug found |
|---|---|---|
| 001 | one ANSI stripper instead of five | spinner detection read half-stripped text — a working session reported as hung |
| 002 | five decisions out of `cli.ts`, which cannot be imported | — |
| 003 | request-boundary guards in `dashboard-api.ts` | static path containment used `startsWith`: a sibling sharing a prefix, and symlinks, escaped the root |
| 004 | supervisor status broadcast | the 🔴 container state had been unreachable since v1.49 — a crash loop showed green and notified nobody |
| 005 | status-line classifiers | any tool call mentioning "permission"/"approve"/"waiting" raised the blocked-session signal |
| 006 | latched waiting state | 💬 had never once been true for a real prompt; now it is |
| 007 | `bun run dupes` — duplicate-definition detector | found two leftovers from flows 003 and 006 before it was finished |
| 008 | one pane parser instead of two | the pane copy did not strip ANSI, so `^`-anchored patterns failed silently |

### Mechanisms added after the retrospective

- `bun run dupes` — reports literals carrying a rule that live in more than
  one file. Report is currently at **5**, all reviewed.
- Two `known-mistake` memories: `duplicated-knowledge-diverges` and
  `comment-asserts-more-than-code`.
- keryx PR 221 — verification steps in a flow plan become flow tasks, since
  prose blocks nothing and tasks gate `flow complete`.
- keryx PR 222 — `shared-definitions` rule: connect agreeing places with an
  import, not a comment.

Both keryx PRs were open and awaiting the maintainer's merge as of 2026-08-03.

### The arithmetic that sets the next step

2378 of 12372 lines covered. Reaching the 60% floor needs roughly 5000 more.
The six least-covered files hold 3452 of them:

| File | Uncovered |
|---|---|
| `scripts/supervisor.ts` | 1075 |
| `memory/db.ts` | 578 |
| `utils/tts.ts` | 502 |
| `bot/commands/admin.ts` | 450 |
| `claude/client.ts` | 430 |
| `memory/summarizer.ts` | 417 |

All six are database, network and external processes. **Extraction cannot get
there** — there is little left to extract, and what remains is I/O.

### Agreed plan

1. **Close the last five duplicates** — one cheap flow. Four are genuine
   shared formats: the skill slug rule (3 files), the inline-shell token, the
   duration parser, and the `<think>` tags. Taking the report to zero makes
   any future finding news rather than background.
2. **A fixture layer** — a fake `ctx` for the permission handler and a
   test-postgres helper. Deferred from flow 006 and blocking everything else.
   It adds no coverage itself; it makes coverage possible.
3. **Cover the I/O layer** on top of step 2, by uncovered-lines × risk:
   supervisor first (largest, top hotspot, broke twice this week), then the
   database layer, then the LLM client.
4. **Two decisions for the maintainer**, not work: which containers the
   supervisor is responsible for (blocks moving to `docker ps -a`), and what
   E2E CI should point at (the workflow was deleted in `5bab380`).

## Provenance

- Source: manual
- Link: `.metaproject/flows/001-*` through `008-*`; helyx PRs #37–#44; keryx PRs #221, #222
- Created: 2026-08-03
- Updated: 2026-08-03

## Related Scopes

- Module: utils, channel, scripts, mcp, memory
- Entity: coverage, terminal parsing, permission prompts, status rendering
- Files: scripts/find-duplicate-definitions.ts, utils/pane-parse.ts, utils/terminal.ts, utils/permission-prompt.ts, utils/status-format.ts
- Skills: testing, health, flow-orchestrator

## Tags

coverage, programme-state, roadmap, fixtures, duplication

## Changelog


- Superseded by task-notes/coverage-programme-state-2026-08-05.md on 2026-08-05.
- 1.0.0 - Recorded after flow 008 merged, so the state survives a context reset.
