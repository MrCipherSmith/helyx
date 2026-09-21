---
name: docpack-orchestrator
description: "Use when creating or updating a Metaproject requirements package under docs/requirements: PRD, specification, README, policies/protocols/schemas, roadmap updates, verification, and package review. Use for requests like 'create requirements package', 'prepare module documentation', 'write PRD/spec for module', or 'оформи пакет документации'. Not for reverse-engineering current codebase documentation; use autodoc-orchestrator for that."
triggers:
  - "requirements package"
  - "create requirements package"
  - "module documentation"
  - "documentation package for implementation"
  - "пакет документации"
  - "оформи пакет документации"
  - "подготовь пакет документации"
  - "prepare module documentation"
  - "write PRD and spec"
  - "создай документацию модуля"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
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

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "README, PRD and spec agree with each other, so the implementation status is accurate." | Agreement between three documents is agreement between three documents. Iron Law 6 requires code as the proof. Open the path, or write the status as `planned`. |
| "`docpack-review` came back with warnings only, so the package is done." | Phase 5 permits warnings to remain *only if they are called out clearly* in the Final Response. A warning that lives in the review output and not in `remaining_gaps` has been dropped, not accepted. |
| "This package is small — a specification alone covers it." | Iron Law 4: README, PRD and specification are all required for module packages. "Small" is the most common reason a package ships with no problem statement and no document index. |
| "I rewrote most of the doc, so the `Version` obviously moved." | Nothing bumps it for you. Iron Law 3 is checked file by file in Phase 4, and an unbumped version is what makes a stale copy indistinguishable from the current one. |
| "The user gave me thorough notes, so Phase 1 evidence is redundant." | User notes do not contain the existing package files, `docs/requirements/roadmap.md`, or what a prior version of this package already promised. Skipping Phase 1 is how a package contradicts its own last revision. |
| "Review is its own skill — the user can run `docpack-review` afterwards." | Iron Law 5 makes verification and review mandatory *before* final output. An unreviewed package reported as complete is the failure this pipeline exists to prevent. |

## Exit Criteria

Do not emit the Final Response until all of these hold:

- Every required file for the package kind exists at `docs/requirements/<package_name>/`, and each was written or deliberately left unchanged — not assumed.
- Every Markdown file in the package carries a `Version`, and every file you changed has a bumped one.
- `README.md` links to every file in the package; the specification links to each schema it defines.
- Every `schemas/*.json` parses as valid JSON.
- `docs/requirements/roadmap.md` is updated when the package represents a new module or capability, or the report states why it does not.
- No implementation claim appears that code does not support; anything unbuilt is marked planned or future.
- `docpack-review` has been run in Phase 5 and reports zero blockers. Remaining warnings appear verbatim in `remaining_gaps`.
- Every field of the Final Response block is filled with a real value — no placeholder, and `verification`/`review` are never reported as `pass` when the pass did not run.

## Final Response

Report:

```text
requirements_package: <path>
files_created_or_updated: <list>
verification: pass | pass_with_warnings | fail
review: pass | pass_with_warnings | fail
remaining_gaps: <list>
```
