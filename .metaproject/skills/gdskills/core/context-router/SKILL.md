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
- what should I inspect
- agent routing

## Workflow

1. Start from the user's goal, not from command names.
2. Use gdgraph for file relationships and affected context.
3. Use gdctx for compact command, search, diff, log, and large-read output.
4. Use gdwiki for architecture, domain, business rules, decisions, and scenarios.
5. Use memory for historical decisions, known constraints, lessons, and repeated mistakes.
6. Use health for normalized quality and gate status; use testing for test selection and test context.
7. Prefer MCP tools/resources for these capabilities when connected; otherwise use the matching skill and CLI command.
8. Use project-skills for known modules, components, stores, services, and domain entities.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
