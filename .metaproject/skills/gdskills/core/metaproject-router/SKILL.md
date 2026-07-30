---
name: metaproject-router
description: Use when choose which Metaproject module, working skill, or project-skill should be used for a user request.
---

# metaproject-router

## Purpose

Choose which Metaproject module, working skill, or project-skill should be used for a user request.

## When To Use

- any repository task
- route context
- which skill should be used
- ordinary product-development request
- agent should decide tools

## Workflow

1. Read `.metaproject/index.md` first.
2. Treat the user's natural-language request as an intent; do not require exact keryx command, skill, or MCP tool names.
3. Classify the user request as navigation, understanding, implementation, review, planning, documentation, quality, testing, security, memory, or workflow.
4. Prefer available MCP tools/resources for the selected Metaproject capability; otherwise use the corresponding project-local skill and `keryx` CLI command.
5. Use the Intent Router in `.metaproject/index.md` to map user intent to capability before reading broad source files.
6. If the request asks to create, run, resume, track, or finish a managed flow and Task Manager is enabled, route implementation work to `gdskills/orchestration/flow-orchestrator/SKILL.md` before `job-orchestrator`.
7. Prefer project-local skills and module manifests before broad raw file search.
8. Route to the narrowest applicable skill and record unavailable modules explicitly.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
