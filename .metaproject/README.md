# Project Metaproject

This folder contains local Metaproject configuration, tools, generated data, and agent instructions.

## Installed Modules

- `gdgraph`: code graph and affected context.
- `gdctx`: compact command/search/read output and raw output archive.
- `gdwiki`: local project knowledge base from business logic to implementation.
- `gdskills`: project-local bundled working skills, orchestration, review, and project-skill lifecycle.
- `health`: code quality aggregation, scoring, and quality gate.
- `testing`: test context, related tests, and normalized test reports.
- `memory`: long-lived lessons, decisions, constraints, and known mistakes.
- `tasks`: agent-first flow lifecycle with frozen acceptance criteria and PR gates.

## Common Commands

```bash
keryx status
keryx gdgraph build
keryx gdgraph query "module pipelines"
keryx ctx status
keryx ctx diff
keryx wiki status
keryx wiki collect
keryx wiki index
keryx skills status
keryx skills catalog --profile recommended
keryx skills install --profile recommended
keryx health run
keryx health gate
keryx test analyze
keryx test run --changed
keryx memory index
keryx memory search "project decisions"
keryx flow list
keryx flow init --title "..."
```

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under `data/*/storage`.
- Regenerate artifacts with CLI commands.
