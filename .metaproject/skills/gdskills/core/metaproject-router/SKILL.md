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

## Workflow

1. Read `.metaproject/index.md` first.
2. Classify the user request as navigation, implementation, review, planning, documentation, quality, memory, or workflow.
3. If the request asks to create, run, resume, track, or finish a managed flow and Task Manager is enabled, route implementation work to `gdskills/orchestration/flow-orchestrator/SKILL.md` before `job-orchestrator`.
4. Prefer project-local skills and module manifests before broad raw file search.
5. Route to the narrowest applicable skill and record unavailable modules explicitly.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
