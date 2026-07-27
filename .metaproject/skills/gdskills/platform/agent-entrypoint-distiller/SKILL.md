---
name: agent-entrypoint-distiller
description: Use when the user asks to split, decompose, distill, or refactor a large AGENTS.md or CLAUDE.md into Metaproject rules and project-specific skills while keeping root entrypoints compact.
metadata:
  version: "1.0.0"
  category: platform
---

# Agent Entrypoint Distiller

Use this skill when root agent files (`AGENTS.md`, `CLAUDE.md`) have grown into
large project manuals and should be converted into local Metaproject knowledge.

## Workflow

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json` if they exist.
2. Run:

```bash
gd-metapro rules distill
```

3. Verify the generated outputs:
   - `.metaproject/rules/entrypoints/index.md`
   - `.metaproject/rules/entrypoints/*.md`
   - `.metaproject/project-skills/entrypoints/*/SKILL.md`
   - compact `AGENTS.md` and `CLAUDE.md` still point to `.metaproject/index.md`
4. If the command changed root entrypoints, check that only global/personal or
   highest-priority always-on instructions remain there.
5. Run focused verification:

```bash
gd-metapro rules sync
gd-metapro flow check 001
```

Skip `flow check` when the project has no Task Manager flow.

## Output Contract

Report:

- rules extracted count;
- skills extracted count;
- root sections kept count;
- files changed;
- any sections that looked ambiguous and should be reviewed manually.
