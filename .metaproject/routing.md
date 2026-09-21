# Metaproject Index

## Purpose

This `.metaproject` folder contains agent-readable context, tools (module CLIs), rules (`rules/`), skill/worker schemas (`core/gdskills/contracts/`), generated data, and module manifests for this codebase.

Human dashboard: [keryx-dashboard.html](keryx-dashboard.html)

## Enabled Modules

| Module | Purpose | Entry |
|--------|---------|-------|
| gdgraph | Code graph, dependencies, symbols, affected context | modules/gdgraph.md |
| gdctx | Token-aware command output and context compression | modules/gdctx.md |
| gdwiki | Project knowledge base: architecture, domain, rules, decisions | modules/gdwiki.md |
| gdskills | Native bundled working skills, orchestration, review, and project-skill lifecycle | modules/gdskills.md |
| health | Code quality aggregation, scoring, and quality gate | modules/health.md |
| testing | Test context, related tests, execution reports, and test intelligence | modules/testing.md |
| memory | Markdown-canonical memory: pure recall, explicit reports, lifecycle, and accepted/current bounded influence | modules/memory.md |
| tasks | Agent-first flow lifecycle: frozen acceptance criteria, status gates, PR completion | modules/tasks.md |
| security | Policy-based scanning, redaction, guardrails, and audit reports for agent inputs/outputs and artifacts | modules/security.md |
## Rules

| Source | Priority | Purpose | Entry |
|--------|----------|---------|-------|
| AGENTS.md | high | Imported root agent-entrypoint rules; apply before module-specific guidance | rules/agents-md.md |
| CLAUDE.md | high | Imported root agent-entrypoint rules; apply before module-specific guidance | rules/claude-md.md |
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
| memory | Search accepted/current project memory; default recall is pure and bounded | skills/memory/SKILL.md |
| flow | Start/track/finish managed work items (создай фло, create a flow from an issue) | skills/flow/SKILL.md |
| flow-orchestrator | Task Manager implementation orchestrator: flow state + gdskills workers + completion choice/health gates | skills/gdskills/orchestration/flow-orchestrator/SKILL.md |

## Agent Operating Model

- The user does not need to know keryx command names. Treat natural-language requests as intents and route them through this index.
- First choose the capability: graph/navigation, compact context, wiki/domain knowledge, memory, testing, health, security, skills/orchestration, or flow lifecycle.
- If the same capability is available through MCP tools/resources, prefer MCP because it preserves structured inputs and outputs. If MCP is unavailable, use the module skill and `keryx` CLI fallback.
- Load the narrowest relevant skill/rule before reading broad source files. Do not ask the user which internal command to run unless multiple user-level outcomes are genuinely possible.
- When reporting results, name the Metaproject sources used at a high level (for example: graph, wiki, memory, health), not every internal command.
- Once per session, run `keryx version check --json`. Notify the user only when the result is `update-available`; this is an advisory and never installs anything. A timeout, offline registry, `unavailable`, or `unknown-command` result is non-blocking: never block project work on the check.

## Intent Router

| User intent | Capability | Primary entry | Agent action |
|-------------|------------|---------------|--------------|
| Any repository task / unclear request | `metaproject-router` | `skills/gdskills/core/metaproject-router/SKILL.md` | Classify the intent first, then route to the narrowest capability. |
| Need context / where to start | `context-router` | `skills/gdskills/core/context-router/SKILL.md` | Choose graph, wiki, memory, health, testing, or project-skills before raw reads. |
| Find related files, dependencies, blast radius, cycles, or orphans | `gdgraph` | `skills/gdgraph/SKILL.md`; MCP `gdgraph.*` if available | Start with graph/affected context before broad search. |
| Files were added, renamed, deleted or moved; graph answers look stale | `gdgraph` | `modules/gdgraph.md` (Freshness & Refresh) | Run `keryx gdgraph build`, then answer from the rebuilt graph. |
| Understand architecture, domain behavior, business rules, scenarios, integrations, or decisions | `gdwiki` | `skills/gdwiki/SKILL.md`; `wiki/index.md`; MCP `wiki.*` if available | Use knowledge pages first, then jump from wiki concepts to code. |
| Recall past decisions, lessons, constraints, repeated mistakes, or project history | `memory` | `skills/memory/SKILL.md`; MCP `memory.search` if available | Search accepted memory before broad docs or assumptions. |
| Create/change/debug tests or decide what tests to run | `testing` | `skills/testing/SKILL.md`; `data/testing/context.md` | Use test context and related-test intelligence before raw logs. |
| Check quality, gate, regressions, complexity, lint/type/test status | `health` | `skills/health/SKILL.md`; MCP `health.*` if available | Read normalized health artifacts before claiming quality. |
| Check secrets, PII, prompt injection, egress, unsafe external/tool output | `security` | `modules/security.md`; MCP `security.*` if available | Scan or check content before writing it into project artifacts. |
| Implement, review, refactor, document, plan, analyze, or verify | `gdskills` | `skills/catalog.md`; `project-skills/`; `skills/gdskills/` | Route to local orchestrators/reviewers/quality skills before global skills. |
| Start, resume, track, or finish managed work | `flow` / `flow-orchestrator` | `skills/flow/SKILL.md`; `skills/gdskills/orchestration/flow-orchestrator/SKILL.md` | Use Task Manager state and never edit flow files by hand. |

## Agent Workflow

1. Read this file first.
2. Treat the user's request as a natural-language intent; do not require the user to remember internal module, skill, MCP tool, or CLI names.
3. Check enabled modules.
4. Load relevant rules from `rules/`.
5. For any non-trivial repository task, start with `skills/gdskills/core/metaproject-router/SKILL.md`; for context selection, use `skills/gdskills/core/context-router/SKILL.md`.
6. Prefer MCP tools/resources for enabled Metaproject capabilities when the connected agent exposes them; otherwise use the matching skill and `keryx` CLI command.
7. Route by question type: structural questions go to gdgraph first; conceptual questions go to gdwiki first; gdctx runs in parallel to keep output compact.
8. Any text, symbol, or pattern search over project code goes through `keryx ctx rg`, never a bare `rg`/`grep` — even a single targeted search, and even when gdgraph/gdwiki are skipped. Raw `rg`/`grep` is a last resort only, with a stated reason.
9. `keryx ctx rg` and the agent's `search_code` tool require ripgrep (`rg`) on PATH — install it with `brew install ripgrep` (macOS) or `apt install ripgrep` (Debian/Ubuntu). Without it, code search is unavailable; fall back to reading files directly.
10. For structural questions (where is X, what files are related, what breaks if I change Y, usages, cycles, orphans) use `skills/gdgraph/SKILL.md` first, before any raw file search. The user does not need to request graph usage explicitly.
11. The graph answers from the last `keryx gdgraph build`, not from the working tree. Rebuild before relying on a graph answer when you added, renamed, deleted or moved files in this session, or when `keryx gdgraph context` reports uncommitted code files — not once per question. If you cannot rebuild, say the graph predates those changes instead of quoting it as current. Contract: `modules/gdgraph.md` (Freshness & Refresh).
12. For conceptual questions (how does X work, why, architecture, domain models, business rules, user scenarios, auth and other flows, integrations, known decisions) read `wiki/index.md` first via `skills/gdwiki/SKILL.md`, then use gdgraph to jump from the wiki page to code.
13. In parallel, use `skills/gdctx/SKILL.md` for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output. The user does not need to request compact context usage explicitly.
14. For implementation, review, refactoring, planning, documentation, or quality tasks, check `skills/catalog.md` and project-local gdskills before any external/global skill set.
15. For Metaproject requirements packages under `docs/requirements` (README, PRD, specification, policies, schemas), use `skills/gdskills/planning/docpack-orchestrator/SKILL.md`; for current-codebase reverse-engineering documentation, use `autodoc-orchestrator` from `skills/catalog.md`.
16. For known modules/components/stores/services/domain entities, check generated project skills under `project-skills/<module>/<entity>/` before generic guidance.
17. When orchestrating multi-agent work, dispatch gdskills workers through the schema contracts in `core/gdskills/contracts/` (subagent-dispatch -> subagent-result) and read `rules/core/subagent-status-protocol.md`; validate a concrete message with `keryx skills contracts validate <file> --schema <name>`.
18. For code quality status (lint, type, test, coverage, complexity, gate, regressions), read `data/health/artifacts/latest.md` or run `keryx health run`; do not claim quality status from raw logs.
19. For creating, changing, debugging, reviewing, or running tests, read `data/testing/context.md` and use `skills/testing/SKILL.md`; read `data/testing/artifacts/latest.md` before raw test logs.
20. For lessons learned, known decisions, constraints, repeated mistakes, historical context, or skill verification signals, use `skills/memory/SKILL.md` and `keryx memory search` before broad documentation reads.
21. When the user asks to start, create, track, or finish a managed piece of work, use `skills/flow/SKILL.md` for state/status commands and use `skills/gdskills/orchestration/flow-orchestrator/SKILL.md` for non-trivial implementation through Task Manager. Never edit flow.json or frozen acceptance criteria by hand.
22. Before writing external/tool content into memory, wiki, reports, or task context, or when scanning artifacts for secrets/PII/prompt-injection/egress, use `modules/security.md` and `keryx security check-output`/`security scan`; read `data/security/artifacts/latest.md` before claiming security status.
23. Use relevant skills from `skills/`.
24. Discover tools: each `modules/*.md` manifest lists that module's `keryx` commands; run `keryx --help` for the full CLI surface.
25. Use module manifests before reading raw generated data.
26. Prefer curated artifacts in `data/*/artifacts`.
27. Run module CLI commands when generated data is stale.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/queries/latest.md`
- `data/gdctx/artifacts/latest.md`
- `wiki/index.md`
- `skills/catalog.md`
- `skills/gdskills/`
- `project-skills/`
- `core/gdskills/contracts/` (skill/worker communication schemas: agent-event, flow-orchestrator-input, review-pr-feedback-input, review-pr-feedback-output, job-orchestrator-state, orchestrator-state, review-finding, subagent-dispatch, subagent-result, task-implementer-input, task-implementer-output)
- `rules/core/` (shared engineering rules library)
- `data/gdskills/artifacts/latest.md`
- `data/health/artifacts/latest.md`
- `data/testing/context.md`
- `data/testing/recommendations.md`
- `data/testing/artifacts/latest.md`
- `memory/index.md`
- `data/memory/index/index.json`
- `data/memory/embeddings/` (disposable cache, when enabled)
- `runtime/memory/search/<run-id>/` (explicit reports only)
- `flows/` (flow packages)
- `data/security/artifacts/latest.md`

## Refresh

```bash
# Use only supported refresh commands:
keryx gdgraph build
keryx wiki index
keryx test analyze
keryx memory index
```
