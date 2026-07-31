# AGENTS Instructions

<!-- keryx:index -->
## Metaproject

**HARD GATE:** Before the first shell command, search, grep, file read, code navigation, planning step, implementation, review, analysis, or subagent dispatch in this repository, explicitly read `.metaproject/index.md`. Do not treat it as a referenced/on-demand file; load it immediately when present.

This Metaproject block is optional project-local routing. If `.metaproject/index.md` or referenced Metaproject files are absent, state `metaproject: unavailable` and continue with the main contents of this AGENTS.md/CLAUDE.md file.

If you create or switch to a git worktree, repeat the hard gate in that worktree root before any repository action there.

The user does not need to know Metaproject command names. Treat natural-language requests as intents, route through `.metaproject/index.md`, then choose the right skill, rule, MCP tool/resource, or `keryx` CLI command yourself.

Do not dispatch subagents until the Metaproject hard gate is complete. Every subagent prompt must include the exact project/worktree root and require reading `<project-root>/.metaproject/index.md` before searching or reading code.

If MCP tools/resources are available for this project, prefer them for Metaproject capabilities because they provide structured tool calls. If MCP is unavailable or lacks a needed capability, fall back to the corresponding project-local skill and CLI command.

For project navigation, file discovery, and code-related tasks, use the Metaproject gdgraph skill by default before raw file search.

Any text, symbol, or pattern search over project code goes through `keryx ctx rg`, never a bare `rg`/`grep` — even a single targeted search, and even when gdgraph/gdwiki are skipped. Raw `rg`/`grep` is a last resort only, with a stated reason recorded in the routing audit.

`keryx ctx rg` and the agent's `search_code` tool require ripgrep (`rg`) on PATH — install it with `brew install ripgrep` (macOS) or `apt install ripgrep` (Debian/Ubuntu). Without it, code search is unavailable; fall back to reading files directly.

For architecture, domain models, business rules, user scenarios, auth and other flows, integrations, and known decisions, consult the Metaproject gdwiki skill and read the wiki index before deep code reads; use gdgraph to move from a wiki concept to code.

For commands, search, diff, test logs, lint/build output, and large file reads that can produce long output, use the Metaproject gdctx skill by default before loading raw command output into context.

For a non-trivial navigation, debugging, review, or investigation task, end with a short routing audit: `graph_used`, `wiki_used`, `ctx_used`, and `raw_rg_used: yes/no`. An omitted layer must be justified (`not-relevant`/`unavailable`), not silently skipped.

For implementation, review, refactoring, planning, documentation, or quality tasks, use project-local Metaproject skills first: .metaproject/skills/catalog.md, .metaproject/project-skills/, then .metaproject/skills/gdskills/. External/global skills are fallback only when explicitly needed.

For creating, changing, debugging, reviewing, or running tests, use the Metaproject testing skill and read .metaproject/data/testing/context.md before broad test search or raw logs.

For lessons learned, decisions, constraints, repeated mistakes, and historical project context, use the Metaproject memory skill before broad documentation search.

For starting, tracking, or finishing a managed piece of work (a flow), use the Metaproject flow skill for state/status commands. For non-trivial implementation through Task Manager, use the local gdskills flow-orchestrator first: .metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md. All flow state changes go through the keryx flow CLI.

<!-- /keryx:index -->

