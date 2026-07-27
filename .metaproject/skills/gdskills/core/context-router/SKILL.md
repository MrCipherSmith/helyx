---
name: context-router
description: Use when choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.
---

# context-router

## Purpose

Choose between gdgraph, gdctx, gdwiki, memory, health, and project-skills before raw file reads.

## When To Use

- find files
- understand code
- collect context

## Workflow

1. Use gdgraph for file relationships and affected context.
2. Use gdctx for compact command, search, diff, log, and large-read output.
3. Use gdwiki for architecture, domain, business rules, decisions, and scenarios.
4. Use project-skills for known modules, components, stores, services, and domain entities.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
