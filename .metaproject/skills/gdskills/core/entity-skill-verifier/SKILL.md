---
name: entity-skill-verifier
description: "Use when an existing project-skill needs classifying — fresh, needs-review, stale, or blocked — from its required files, metadata, manifest registration, target-path existence, and evidence artifacts (gdgraph, gdctx, gdwiki, Code Health, memory), followed by a manual read of its claims against current code as this skill's next step. NOT for: applying a review, test, or health finding to update a skill (see entity-skill-learner)."
---

# entity-skill-verifier

## Purpose

Run `keryx skills verify` to check a project-skill's required files, SKILL.md metadata, manifest registration, target-path existence, and evidence artifacts (gdgraph, gdctx, validated gdwiki, Code Health, canonical accepted memory), then classify it as fresh, needs-review, stale, or blocked. The command does not read the skill's prose or compare it against current code — that comparison is a manual agent step.

## When To Use

- verify skill
- skill-verify-skill
- stale skill

## Workflow

1. Resolve the target project-skill through gdgraph affected context or `keryx skills route <target>`.
2. Run `keryx skills verify <module>/<skill-name>` (`--dry-run` previews without writing).
3. The command checks required files, SKILL.md metadata (version, target, last-verified), manifest registration, target path existence, and evidence artifacts for gdgraph, gdctx, gdwiki, Code Health, and memory consultation, then classifies the skill fresh, needs-review, stale, or blocked and writes the JSON report plus `verification.md`.
4. Manually read the skill and the code, wiki, and health evidence it points at to check its claims — the command does not do this comparison — then route stale or blocked findings to entity-skill-learner.

## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
