---
name: flow-orchestrator
description: "Use when Task Manager is enabled and a non-trivial feature, issue, or story should be driven through gd-metapro flow from initialization to done."
triggers:
  - "создай flow"
  - "создай фло"
  - "заведи стори"
  - "implement with flow"
  - "issue to flow"
  - "task manager orchestration"
  - "flow orchestration"
  - "managed implementation"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "orchestration"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Flow Orchestrator

## Purpose

Flow Orchestrator is the Task Manager-aware implementation orchestrator.
It wraps the existing gdskills pipeline with `gd-metapro flow` state.

Use this skill instead of `job-orchestrator` when the user wants a managed
story/issue lifecycle with frozen acceptance criteria, task state, draft PR
gates, Code Health, and a durable flow package in `.metaproject/flows/`.

Do not modify `job-orchestrator` or `task-implementer` behavior. They remain
usable without Task Manager. This skill coordinates them through flow state.

## Hard Preconditions

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json`.
2. Confirm Task Manager is enabled:
   - `.metaproject/metaproject.json` must contain `modules.tasks.enabled: true`;
   - `.metaproject/skills/flow/SKILL.md` should exist.
3. If Task Manager is not enabled, stop and tell the user to run:

```bash
gd-metapro update
```

or initialize with the Task Manager module enabled. Do not emulate flow state by
hand.

## Source Of Truth

Flow state lives in `.metaproject/flows/<flow-id>/`.

CLI-owned files:

- `flow.json` - never edit by hand.
- status transitions - only through `gd-metapro flow ...`.
- task status - only through `gd-metapro flow task done ...`.
- frozen acceptance criteria changes - only through
  `gd-metapro flow ac update <id> --reason "<why>"`.

Agent-editable files:

- `description.md`
- `context.md`
- `plan.md`
- `tasks.md` for task definitions only
- `journal.md`

## Lifecycle

```mermaid
flowchart TD
  A["User issue / feature request"] --> B["flow-orchestrator"]
  B --> C["gd-metapro flow init"]
  C --> D["flow-init context enrichment"]
  D --> E["freeze AC + start flow"]
  E --> F["dispatch tests-creator / task-implementer"]
  F --> G["code-verifier + review-orchestrator"]
  G --> H{"All tasks, checks, review OK?"}
  H -- "no" --> F
  H -- "yes" --> I["draft PR"]
  I --> J["gd-metapro flow implemented --pr"]
  J --> K["confirm AC evidence"]
  K --> L["gd-metapro flow complete"]
```

## Phase 0: Route And Resume

1. Run `gd-metapro flow list`.
2. If an active flow obviously matches the user request, use it.
3. If multiple active flows could match, ask one concise question.
4. If no flow exists and the request is multi-step, create one:

```bash
gd-metapro flow init --issue <url>
```

or:

```bash
gd-metapro flow init --title "<short formalized problem>"
```

5. Run `gd-metapro flow status <id>` and read the flow package.

## Phase 1: Initialize The Flow Package

Use `.metaproject/skills/flow/init.md` as the local flow-init procedure.

Required context sources:

- gdgraph for impacted files and dependency relationships;
- gdctx for compact command/search/diff output;
- gdwiki for architecture, domain rules, business behavior and decisions;
- memory for lessons learned, repeated failures and historical constraints;
- health/testing reports for baseline risk.

Required rules:

- `.metaproject/rules/core/requirements-management.mdc`
- `.metaproject/rules/core/implementation-plans.mdc`
- `.metaproject/rules/core/subagent-context-construction.md`
- `.metaproject/rules/core/subagent-status-protocol.md`
- `.metaproject/rules/core/tdd-workflow.mdc`
- `.metaproject/rules/core/code-style-patterns.mdc`
- `.metaproject/rules/core/error-handling.mdc`
- `.metaproject/rules/core/implementation-doc-mandate.mdc`

Write or update:

- `description.md` - problem, expected outcome, out of scope;
- `context.md` - compact links and findings, not raw dumps;
- `plan.md` - chosen approach and trade-offs;
- `tasks.md` - task definitions grouped by context, test, implement, review, docs;
- `acceptance-criteria.md` - verifiable `ACn` criteria.

Then freeze and start:

```bash
gd-metapro flow freeze <id>
gd-metapro flow start <id>
```

## Phase 2: Execute Tasks

Use existing gdskills as workers. Do not duplicate their internal workflows.

Recommended worker routing:

| Flow task kind | Worker skill |
|---|---|
| `context` | `context-collector` |
| `test` | `tests-creator` or `test-gen` |
| `implement` | `task-implementer` |
| `review` | `review-orchestrator` |
| `docs` | `job-documenter`, `prd-creator`, or documentation-specific project skill |

### Worker communication is schema-governed

Workers do not inherit session state; every dispatch is constructed explicitly
(`.metaproject/rules/core/subagent-context-construction.md`). Each dispatch is a
`subagent-dispatch` object
(`.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json`) and each
worker reply is a `subagent-result` object
(`.metaproject/core/gdskills/contracts/subagent-result.schema.json`) whose first
line is `STATUS: <status>`
(`.metaproject/rules/core/subagent-status-protocol.md`).

Dispatch payload, bound to the flow (map `target_skill` from the routing table):

```json
{
  "contract_version": "1.0.0",
  "run_id": "<flow-id>",
  "dispatch_id": "<flow-id>-<Tn>",
  "orchestrator": "flow-orchestrator",
  "target_skill": "task-implementer",
  "task": { "title": "<Tn title>", "description": "<what to do>", "intent": "implement" },
  "acceptance_criteria": ["<the frozen ACn lines this task must satisfy>"],
  "context_refs": [
    { "path": ".metaproject/flows/<dir>/context.md", "kind": "context", "exists": true },
    { "path": ".metaproject/flows/<dir>/plan.md", "kind": "plan", "exists": true },
    { "path": ".metaproject/flows/<dir>/acceptance-criteria.md", "kind": "custom", "exists": true }
  ],
  "files_to_read": ["<only files gdgraph/gdctx narrowed to>"],
  "constraints": [
    "Never edit flow.json.",
    "Never edit frozen acceptance criteria.",
    "Return a subagent-result; first line must be STATUS:."
  ],
  "allowed_actions": ["read", "write", "run-command", "git"],
  "output_contract": { "schema": "subagent-result", "artifact_path": ".metaproject/flows/<dir>/journal.md" },
  "budget": { "max_output_tokens": null },
  "provenance": { "created_at": "<iso-utc>", "created_by": "flow-orchestrator" }
}
```

After a worker succeeds, the flow-orchestrator marks task progress:

```bash
gd-metapro flow task done <id> <Tn>
```

If new work is discovered:

```bash
gd-metapro flow task add <id> --title "<task>" --kind <kind>
```

### Interpreting worker results (STATUS protocol)

Read the worker's `STATUS:` line first; never infer the outcome from prose. A
reply with no `STATUS:` line is treated as `NEEDS_CONTEXT` — re-request one
properly formatted `subagent-result`.

| Worker `status` | flow-orchestrator action |
|---|---|
| `DONE` | Accept. `gd-metapro flow task done <id> <Tn>`. Continue. |
| `DONE_WITH_CONCERNS` | Accept, record every concern in `journal.md`, decide continue vs. add a fix task, then `flow task done`. Never silently drop concerns. |
| `NEEDS_CONTEXT` | Do not fail. Enrich `context_refs`/`files_to_read` from gdgraph/gdctx/wiki/memory, then re-dispatch the same `dispatch_id`. |
| `BLOCKED` | `gd-metapro flow block <id> --reason "<worker reason>"`; resolve or escalate one concise question, then `flow unblock` and re-dispatch. |
| `FAILED` | Retry once with the same dispatch. If it fails again, block the flow and surface the error to the user. |

Carry `run_id`/`dispatch_id` across retries so the flow journal stays traceable.

## Phase 3: Verification And Review

Before accepting implementation:

1. Run focused tests for touched scope.
2. Run `code-verifier`.
3. Run `gd-metapro health run` when Code Health is enabled.
4. Run `review-orchestrator` with relevant domains.
5. If findings require code changes, dispatch fix work through `task-implementer`
   and record the fix task in the flow.

The implementer never self-accepts. Only flow-orchestrator decides whether the
flow can move to `implemented`.

## Phase 4: Draft PR Gate

When tasks, verification and review are complete:

1. Create or confirm a draft PR in the author's name.
2. Record it through the CLI:

```bash
gd-metapro flow implemented <id> --pr <draft-pr-url>
```

Do not run `flow implemented` without a PR URL. If the user explicitly asks to
skip PR creation, keep the flow in progress and explain that Task Manager's
completion gate requires a PR record.

## Phase 5: Complete The Flow

Use `.metaproject/skills/flow/complete.md`.

For every acceptance criterion, verify evidence and confirm:

```bash
gd-metapro flow ac confirm <id> ACn --note "<evidence>"
```

Then run:

```bash
gd-metapro flow complete <id>
```

If gates fail, the CLI returns the flow to `in-progress`. Add a journal note,
create fix tasks, and repeat Phase 2.

## Completion Report

Finish with:

- flow id and final status;
- PR URL;
- tasks completed;
- acceptance criteria evidence summary;
- verification/review results;
- unresolved risks or blocked gates.

## Contracts

flow-orchestrator communicates through explicit schemas, not free prose:

| Direction | Schema |
|---|---|
| Skill input | `skills/gdskills/orchestration/flow-orchestrator/input-contract.schema.json` |
| Skill output | `skills/gdskills/orchestration/flow-orchestrator/output-contract.schema.json` |
| Worker dispatch | `core/gdskills/contracts/subagent-dispatch.schema.json` |
| Worker result | `core/gdskills/contracts/subagent-result.schema.json` |
| Durable flow state | `.metaproject/flows/<id>/flow.json` (CLI-owned; never agent-written) |

Validate a concrete worker message before trusting it:

```bash
gd-metapro skills contracts validate <file> --schema subagent-dispatch
gd-metapro skills contracts validate <file> --schema subagent-result
```

## Boundaries

- Do not replace `job-orchestrator`. This is the Task Manager variant.
- Do not bypass the flow CLI for state changes.
- Do not let `task-implementer` edit `flow.json`, frozen AC, or decide
  completion.
- Do not read broad source trees when gdgraph/gdctx/wiki/memory can first
  narrow context.
