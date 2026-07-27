---
name: entity-skill-creator
description: Use when create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.
---

# entity-skill-creator

## Purpose

Create canonical project-skills from a path, symbol, wiki page, module, component, store, service, or domain entity.

## When To Use

- create skill
- generate project skill
- new entity skill
- создай скил
- создай скилл для <path>

## Workflow

1. Normalize the target into module, entity, files, symbols, and wiki references.
2. Collect evidence from gdgraph, gdctx, gdwiki, health, and memory when available.
3. Run `gd-metapro skills create <target> --module <module> --name <skill-name>`; infer module/name from the target when the user did not provide them.
4. Run `gd-metapro skills route <target>` and `gd-metapro skills inspect <module>/<skill-name>` to confirm registration and routing.
5. Run `gd-metapro skills verify <module>/<skill-name>` and finish with `gd-metapro skills status`.

## Agent Command Contract

When the user asks in natural language to create a skill, for example `создай скил для init.ts`, `создай скилл для src/commands/init.ts`, or `create a skill for <path>`, the agent must run the CLI flow itself. Do not ask the user to run these commands manually.

Required flow:

```bash
gd-metapro skills create <target> --module <module> --name <skill-name>
gd-metapro skills route <target>
gd-metapro skills inspect <module>/<skill-name>
gd-metapro skills verify <module>/<skill-name>
gd-metapro skills status
```

Inference rules:

1. If the user gives only a basename such as `init.ts`, resolve it with graph/search first and use the matching project path.
2. Infer `--module` from the closest stable project area when omitted.
3. Infer `--name` from the entity or file purpose, using kebab-case.
4. If multiple targets match, ask one short clarification question before creating anything.
5. Report created files, verification status, and next recommended action.


## Local-First Rules

1. Start from `.metaproject/index.md` and `.metaproject/skills/catalog.md`.
2. Prefer project-local skills under `.metaproject/project-skills` and `.metaproject/skills/gdskills`.
3. Use `gdgraph`, `gdctx`, `gdwiki`, Code Health, and Documentation Memory when they provide narrower context.
4. Treat external/global skills only as explicit fallback when local Metaproject does not provide the capability.
5. Verify conclusions against source files before reporting or editing.
