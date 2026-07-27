---
name: hook-manager
description: Use when create and verify lightweight git hooks for graph, health, and skill verification.
---

# hook-manager

## Purpose

Create and verify lightweight git hooks for graph, health, and skill verification.

## When To Use

- install hook
- git hook
- post-commit

## Workflow

1. Install hooks only when explicitly enabled.
2. Keep hooks lightweight and idempotent.
3. Avoid network and destructive behavior inside hooks.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
