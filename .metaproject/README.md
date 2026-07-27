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
gd-metapro status
gd-metapro gdgraph build
gd-metapro gdgraph query "module pipelines"
gd-metapro ctx status
gd-metapro ctx diff
gd-metapro wiki status
gd-metapro wiki collect
gd-metapro wiki index
gd-metapro skills status
gd-metapro skills catalog --profile recommended
gd-metapro skills install --profile recommended
gd-metapro health run
gd-metapro health gate
gd-metapro test analyze
gd-metapro test run --changed
gd-metapro memory index
gd-metapro memory search "project decisions"
gd-metapro flow list
gd-metapro flow init --title "..."
```

## Editing Policy

- Edit module manifests and skills manually when needed.
- Do not manually edit generated files under `data/*/storage`.
- Regenerate artifacts with CLI commands.
