---
name: skill-catalog-manager
description: Use when generate `.metaproject/skills/catalog.md` and machine-readable skill registry.
---

# skill-catalog-manager

## Purpose

Generate `.metaproject/skills/catalog.md` and machine-readable skill registry.

## When To Use

- skill catalog
- list skills
- skills registry

## Workflow

1. Read bundled and project-local skill metadata.
2. Generate concise catalog entries grouped by category.
3. Keep catalog deterministic and local-first.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
