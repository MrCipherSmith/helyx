---
name: docpack-orchestrator
description: "Use when creating or updating a Metaproject requirements package under docs/requirements: PRD, specification, README, policies/protocols/schemas, roadmap updates, verification, and package review. Use for requests like 'create requirements package', 'prepare module documentation', 'write PRD/spec for module', or 'оформи пакет документации'. Not for reverse-engineering current codebase documentation; use autodoc-orchestrator for that."
triggers:
  - "create requirements package"
  - "requirements package"
  - "prepare module documentation"
  - "write PRD and spec"
  - "оформи пакет документации"
  - "создай документацию модуля"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# docpack-orchestrator

Top-level orchestrator for Metaproject requirements packages under
`docs/requirements/<name>/`.

Use `autodoc-orchestrator` instead when the goal is to reverse-engineer the
current codebase and produce architecture/onboarding/developer documentation.

## Execution metrics (opt-in)

When a USER runs this orchestrator directly (not as a dispatched subagent), at
the start ask "Collect execution statistics for this run? (yes/no)" per
`.metaproject/rules/core/execution-metrics.md`. If yes, append the
`## Execution Metrics` section at the end and save it under the docpack output
dir. Never ask or emit it when dispatched as a subagent.

## Iron Laws

| # | Law |
|---|---|
| 1 | Never create a single loose doc when a package is needed. |
| 2 | Always follow `rules/core/requirements-package-standard.mdc`. |
| 3 | Every Markdown doc must have `Version`. |
| 4 | README, PRD and specification are required for module packages. |
| 5 | Verification and documentation review are mandatory before final output. |
| 6 | Do not claim runtime implementation exists unless code proves it. |

## Pipeline

```text
Phase 0  Scope       -> classify docs type and package name
Phase 1  Evidence    -> collect source notes, decisions, existing docs and code context
Phase 2  Design      -> decide required files and schemas
Phase 3  Write       -> create/update README, PRD, specification and optional docs
Phase 4  Verify      -> structural/version/link/schema checks
Phase 5  Review      -> docpack-review pass
Phase 6  Report      -> concise summary, changed files, gaps and next steps
```

## Phase 0: Scope

Determine:

- `package_name` in kebab-case;
- package kind: `module`, `standard`, `policy`, `implementation-plan`, `report`;
- target path: `docs/requirements/<package_name>/`;
- required optional docs: policies, protocols, lifecycle, schemas, metrics.

If the user already provided enough context, proceed without asking.

## Phase 1: Evidence

Collect only relevant context:

- existing package files;
- `docs/requirements/roadmap.md`;
- module-specific specs;
- related code paths through `gdgraph`/`gdctx` when available;
- source notes from the user;
- accepted decisions and constraints.

Do not broad-read the repository when module artifacts or existing docs are
enough.

## Phase 2: Design File Set

Required for module/standard packages:

```text
README.md
prd.md
specification.md
```

Add optional files only when justified:

- `brainstorm.md` for interview/decision history;
- `policies.md` for policy systems;
- `agent-protocol.md` for agent behavior;
- `ci-protocol.md` for CI behavior;
- `artifact-lifecycle.md` for storage/retention;
- `metrics-and-validation.md` for measurable validation;
- `schemas/*.json` for machine-readable contracts.

## Phase 3: Write

Write concise Markdown with explicit headings. Required contracts:

- README: purpose, status, document index, scope, related modules.
- PRD: problem, goal, users, requirements, success criteria, risks,
  recommendation.
- Specification: identity, structure, manifest/config, CLI/skill surface, data
  contracts, integrations, acceptance criteria.

When updating existing docs, preserve useful content and bump versions.

## Phase 4: Verify

Run a local verification pass:

- required files exist;
- every Markdown file has `Version`;
- README links to every package file;
- schema files are valid JSON;
- specification references schemas when present;
- roadmap is updated for new module/standard capabilities;
- no implementation status is overstated.

## Phase 5: Review

Use `docpack-review` for an adversarial pass. Fix blockers before
final output. Warnings may remain only if called out clearly.

## Final Response

Report:

```text
requirements_package: <path>
files_created_or_updated: <list>
verification: pass | pass_with_warnings | fail
review: pass | pass_with_warnings | fail
remaining_gaps: <list>
```
