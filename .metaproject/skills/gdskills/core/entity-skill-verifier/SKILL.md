---
name: entity-skill-verifier
description: Use when verify project-skills against current code, graph, wiki, health, memory, tests, and review lessons.
---

# entity-skill-verifier

## Purpose

Verify project-skills against current code, graph, wiki, health, memory, tests, and review lessons.

## When To Use

- verify skill
- skill-verify-skill
- stale skill

## Workflow

1. Resolve candidate skills through ownership and gdgraph affected context.
2. Compare skill claims with current code, wiki decisions, health reports, and memory.
3. Classify each skill as fresh, stale, needs-review, or blocked.
4. Write a verification report and only update generated sections when policy allows it.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
