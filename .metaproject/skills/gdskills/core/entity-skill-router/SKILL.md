---
name: entity-skill-router
description: "Use when a known module, component, store, service, or domain entity already has a project-skill that should be loaded instead of searched for from scratch. NOT for: scaffolding a project-skill that does not exist yet (see entity-skill-creator), checking one against current code (see entity-skill-verifier), or applying a finding to one (see entity-skill-learner)."
---

# entity-skill-router

## Purpose

Select relevant project-skills for known modules, components, stores, services, and domain entities.

## When To Use

- project skill
- component pattern
- module-specific work

## Workflow

1. Check `.metaproject/project-skills` for matching module/entity skills.
2. Use gdgraph affected context to find nearby entities when the target is a file.
3. Load only the matching project-skill and directly referenced files.
4. If no project-skill exists, suggest creating one with `keryx skills generate`.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
