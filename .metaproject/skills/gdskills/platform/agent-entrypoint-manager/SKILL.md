---
name: agent-entrypoint-manager
description: Use when maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.
---

# agent-entrypoint-manager

## Purpose

Maintain AGENTS.md, CLAUDE.md, and local-first Metaproject references.

## When To Use

- agents.md
- claude.md
- entrypoint

## Workflow

1. Find existing root agent entrypoints.
2. Keep managed Metaproject blocks idempotent.
3. Ensure local `.metaproject/index.md` and skill catalog are first-class references.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
