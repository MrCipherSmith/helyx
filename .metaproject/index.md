# Metaproject Index

## Purpose

This `.metaproject` folder contains agent-readable context, tools (module CLIs), rules (`rules/`), skill/worker schemas (`core/gdskills/contracts/`), generated data, and module manifests for this codebase.

Human dashboard: [gd-metapro-dashboard.html](gd-metapro-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |
| gdctx | Token-aware command output and context compression | modules/gdctx.md |
| gdwiki | Project knowledge base: architecture, domain, rules, decisions | modules/gdwiki.md |
| gdskills | Native bundled working skills, orchestration, review, and project-skill lifecycle | modules/gdskills.md |
| health | Code quality aggregation, scoring, and quality gate | modules/health.md |
| testing | Test context, related tests, execution reports, and test intelligence | modules/testing.md |
| memory | Long-lived project memory: lessons, decisions, constraints, known mistakes | modules/memory.md |
| tasks | Agent-first flow lifecycle: frozen acceptance criteria, status gates, PR completion | modules/tasks.md |
## Rules

| Source | Priority | Purpose | Entry |
|--------|----------|---------|-------|
| CLAUDE.md | high | Imported root agent-entrypoint rules; apply before module-specific guidance | rules/claude-md.md |
| AGENTS.md | high | Imported root agent-entrypoint rules; apply before module-specific guidance | rules/agents-md.md |
| rules/core | reference | Shared engineering rules library (error-handling, tdd-workflow, subagent-status-protocol, subagent-context-construction, security-baseline, api-contracts, clean-architecture, solid-principles, …) | rules/core/ |

## Skills

| Skill | Purpose | Entry |
|-------|---------|-------|
| project-rules | Use imported repository rules before planning or editing | skills/project-rules/ |

| gdgraph | Default navigation layer for finding relevant project files before broad raw search | skills/gdgraph/SKILL.md |
| gdctx | Use compact command/search/read outputs before loading large raw output | skills/gdctx/SKILL.md |
| gdwiki | Read wiki/index.md first for architecture, domain, business rules, and decisions | skills/gdwiki/SKILL.md |
| gdskills | Use project-local bundled working skills and project-skill routing before external/global skills | skills/catalog.md |
| health | Read data/health/artifacts/latest.md before claiming quality status or gate results | skills/health/SKILL.md |
| testing | Read testing context before creating/changing tests and normalized reports before raw test logs | skills/testing/SKILL.md |
| memory | Search accepted project memory before historical, decision, and repeated-mistake questions | skills/memory/SKILL.md |
| flow | Start/track/finish managed work items (создай фло, create a flow from an issue) | skills/flow/SKILL.md |
| flow-orchestrator | Task Manager implementation orchestrator: flow state + gdskills workers + PR/health gates | skills/gdskills/orchestration/flow-orchestrator/SKILL.md |

## Agent Workflow

1. Read this file first.
2. Check enabled modules.
3. Load relevant rules from `rules/`.
4. Route by question type: structural questions go to gdgraph first; conceptual questions go to gdwiki first; gdctx runs in parallel to keep output compact.
5. For structural questions (where is X, what files are related, what breaks if I change Y, usages, cycles, orphans) use `skills/gdgraph/SKILL.md` first, before broad raw file search. The user does not need to request graph usage explicitly.
6. For conceptual questions (how does X work, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, known decisions) read `wiki/index.md` first via `skills/gdwiki/SKILL.md`, then use gdgraph to jump from the wiki page to code.
7. In parallel, use `skills/gdctx/SKILL.md` for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output. The user does not need to request compact context usage explicitly.
8. For implementation, review, refactoring, planning, documentation, or quality tasks, check `skills/catalog.md` and project-local gdskills before any external/global skill set.
9. For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.
10. When orchestrating multi-agent work, dispatch gdskills workers through the schema contracts in `core/gdskills/contracts/` (subagent-dispatch -> subagent-result) and read `rules/core/subagent-status-protocol.md`; validate a concrete message with `gd-metapro skills contracts validate <file> --schema <name>`.
11. For code quality status (lint, type, test, coverage, complexity, gate, regressions), read `data/health/artifacts/latest.md` or run `gd-metapro health run`; do not claim quality status from raw logs.
12. For creating, changing, debugging, reviewing, or running tests, read `data/testing/context.md` and use `skills/testing/SKILL.md`; read `data/testing/artifacts/latest.md` before raw test logs.
13. For lessons learned, known decisions, constraints, repeated mistakes, historical context, or skill verification signals, use `skills/memory/SKILL.md` and `gd-metapro memory search` before broad documentation reads.
14. When the user asks to start, create, track, or finish a managed piece of work, use `skills/flow/SKILL.md` for state/status commands and use `skills/gdskills/orchestration/flow-orchestrator/SKILL.md` for non-trivial implementation through Task Manager. Never edit flow.json or frozen acceptance criteria by hand.
15. Use relevant skills from `skills/`.
16. Discover tools: each `modules/*.md` manifest lists that module's `gd-metapro` commands; run `gd-metapro --help` for the full CLI surface.
17. Use module manifests before reading raw generated data.
18. Prefer curated artifacts in `data/*/artifacts`.
19. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`
- `data/gdctx/artifacts/latest.md`
- `wiki/index.md`
- `skills/catalog.md`
- `skills/gdskills/`
- `project-skills/`
- `core/gdskills/contracts/` (skill/worker communication schemas: subagent-dispatch, subagent-result, agent-event, orchestrator-state, review-finding)
- `rules/core/` (shared engineering rules library)
- `data/gdskills/artifacts/latest.md`
- `data/health/artifacts/latest.md`
- `data/testing/context.md`
- `data/testing/recommendations.md`
- `data/testing/artifacts/latest.md`
- `memory/index.md`
- `data/memory/index/index.json`
- `data/memory/artifacts/latest.md`
- `flows/` (flow packages)

## Refresh

```bash
gd-metapro index refresh
gd-metapro gdgraph build
gd-metapro test analyze
gd-metapro memory index
```
